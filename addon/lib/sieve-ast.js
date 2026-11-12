// Sieve parser (RFC 5228 grammar) producing an AST in which every node keeps its exact text offsets,
// so callers can patch a script in place without reformatting it.

import { t } from './i18n.js';
import { tokenize } from './sieve-analyzer.js';
import { SPAM_GUARD } from './sieve-dialect.js';

export class SieveParseError extends Error {
  constructor(message, start, end = start + 1) {
    super(message);
    this.name = 'SieveParseError';
    this.start = start;
    this.end = end;
  }
}

/**
 * AST shapes:
 *   Script   {type: 'script', commands: Command[]}
 *   Command  {type: 'command', name, args: Arg[], test: Test|null, block: Block|null, start, end}
 *   Block    {type: 'block', commands: Command[], start, end}            (start = '{', end after '}')
 *   Test     {type: 'test', name, args: Arg[], tests: Test[], start, end} (tests: for not/anyof/allof)
 *   Arg      {type: 'tag'|'number'|'string', value, start, end}
 *          | {type: 'list', items: {type:'string'}[], start, end}
 *   Tests in a test-list additionally carry `listStart`/`listEnd` on the parent (the parentheses).
 */
export function parseSieve(text) {
  const { tokens, errors } = tokenize(text);
  if (errors.length) throw new SieveParseError(errors[0].message, errors[0].start, errors[0].end);
  let pos = 0;

  const peek = () => tokens[pos];
  const next = () => tokens[pos++];
  const fail = (message, token = peek()) => {
    const at = token ?? { start: text.length, end: text.length };
    throw new SieveParseError(message, at.start, at.end);
  };
  const expectPunct = (value) => {
    const tok = next();
    if (!tok || tok.type !== 'punct' || tok.value !== value) fail(t('“{value}” expected', { value }), tok);
    return tok;
  };

  function parseStringList() {
    const open = next(); // '['
    const items = [];
    for (;;) {
      const tok = next();
      if (!tok || tok.type !== 'string') fail(t('String in the list expected'), tok);
      items.push({ type: 'string', value: tok.value, start: tok.start, end: tok.end });
      const sep = next();
      if (sep?.value === ']') return { type: 'list', items, start: open.start, end: sep.end };
      if (sep?.value !== ',') fail(t('“,” or “]” expected'), sep);
    }
  }

  function parseArguments() {
    const args = [];
    for (;;) {
      const tok = peek();
      if (!tok) return args;
      if (tok.type === 'tag' || tok.type === 'number' || tok.type === 'string') {
        next();
        args.push({ type: tok.type, value: tok.value, start: tok.start, end: tok.end });
      } else if (tok.value === '[') {
        args.push(parseStringList());
      } else {
        return args;
      }
    }
  }

  function parseTest() {
    const tok = next();
    if (!tok || tok.type !== 'identifier') fail(t('Test expected'), tok);
    const test = { type: 'test', name: tok.value, args: parseArguments(), tests: [], start: tok.start, end: tok.end };
    const after = peek();
    if (after?.value === '(') {
      const open = next();
      test.listStart = open.start;
      for (;;) {
        test.tests.push(parseTest());
        const sep = next();
        if (sep?.value === ')') {
          test.listEnd = sep.end;
          break;
        }
        if (sep?.value !== ',') fail(t('“,” or “)” expected'), sep);
      }
    } else if (after?.type === 'identifier') {
      test.tests.push(parseTest()); // `not <test>`
    }
    const last = test.tests.length ? Math.max(test.tests[test.tests.length - 1].end, test.listEnd ?? 0) : null;
    test.end = Math.max(last ?? 0, test.args.length ? test.args[test.args.length - 1].end : tok.end, test.listEnd ?? 0);
    return test;
  }

  function parseCommands(closing) {
    const commands = [];
    while (pos < tokens.length) {
      const tok = peek();
      if (closing && tok.value === '}') return commands;
      if (tok.type !== 'identifier') fail(t('Command expected'), tok);
      next();
      const command = { type: 'command', name: tok.value, args: parseArguments(), test: null, block: null, start: tok.start, end: tok.end };
      if (peek()?.type === 'identifier') command.test = parseTest();
      const end = next();
      if (end?.value === ';') {
        command.end = end.end;
      } else if (end?.value === '{') {
        const block = { type: 'block', commands: parseCommands(true), start: end.start, end: end.end };
        const close = expectPunct('}');
        block.end = close.end;
        command.block = block;
        command.end = close.end;
      } else {
        fail(t('“;” or “{” expected'), end);
      }
      // the simulator and the merge logic rely on this shape
      if ((command.name === 'if' || command.name === 'elsif') && !command.test) fail(t('“{name}” needs a condition', { name: command.name }), tok);
      if (['if', 'elsif', 'else'].includes(command.name) && !command.block) fail(t('“{name}” needs a block', { name: command.name }), tok);
      commands.push(command);
    }
    if (closing) fail(t('“}” is missing'));
    return commands;
  }

  return { type: 'script', commands: parseCommands(false) };
}

/** Depth-first walk over commands (including nested blocks). */
export function* walkCommands(commands, depth = 0, parent = null) {
  for (const command of commands) {
    yield { command, depth, parent };
    if (command.block) yield* walkCommands(command.block.commands, depth + 1, command);
  }
}

export function quoteSieve(value) {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export function lineOf(text, offset) {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i++) if (text[i] === '\n') line++;
  return line;
}

/**
 * Sorts the string lists in tests alphabetically, only those touching [from, to] when given.
 * A test matches if any list entry matches, so the order never changes what a filter does.
 * Exception: with "variables", :matches and :regex take ${1} from the first entry that matches; those stay.
 * Each entry keeps its slot, so line breaks, indentation and comments stay where they were.
 */
export function sortSieveLists(text, from = 0, to = text.length) {
  const ast = parseSieve(text);
  const variables = ast.commands.some((c) => c.name === 'require' && c.args.some((a) => (a.type === 'list' ? a.items : [a]).some((i) => i.value === 'variables')));
  const order = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true }).compare;
  const patches = [];
  const visit = (test) => {
    if (!test) return;
    test.tests.forEach(visit);
    if (variables && test.args.some((a) => a.type === 'tag' && /^:(matches|regex)$/i.test(a.value))) return;
    for (const arg of test.args) {
      if (arg.type !== 'list' || arg.end < from || arg.start > to) continue;
      const sorted = [...arg.items].sort((a, b) => order(a.value, b.value));
      sorted.forEach((item, i) => {
        const slot = arg.items[i];
        if (item !== slot) patches.push({ start: slot.start, end: slot.end, text: text.slice(item.start, item.end) });
      });
    }
  };
  for (const { command } of walkCommands(ast.commands)) visit(command.test);
  return applyPatches(text, patches);
}

/** Applies non-overlapping {start, end, text} patches. */
export function applyPatches(text, patches) {
  let out = text;
  for (const p of [...patches].sort((a, b) => b.start - a.start)) out = out.slice(0, p.start) + p.text + out.slice(p.end);
  return out;
}

/**
 * Gives an edited script the line endings of the original: a pure CRLF file stays CRLF throughout.
 * A file with mixed endings is left as the edit made it, so untouched lines keep theirs.
 */
const pureCrlf = (s) => s.includes('\r\n') && !/(^|[^\r])\n/.test(s);
export const sameLineEndings = (original, out) => (pureCrlf(original) ? out.replace(/\r?\n/g, '\r\n') : out);

/**
 * Re-indents a script by brace/paren depth (4 spaces), keeping everything else as written.
 * Proton's spam guard is kept byte for byte (also in a CRLF file).
 */
export function formatSieve(text) {
  const lf = pureCrlf(text) ? text.replace(/\r\n/g, '\n') : text;
  const guardAt = lf.indexOf(SPAM_GUARD);
  const out =
    guardAt === -1 ? reindent(lf) : reindent(lf.slice(0, guardAt)) + SPAM_GUARD + reindent(lf.slice(guardAt + SPAM_GUARD.length));
  return sameLineEndings(text, out);
}

function reindent(text) {
  const { tokens } = tokenize(text);
  // depth at the start of each line, from the tokens (so braces in strings/comments are ignored)
  const lines = text.split('\n');
  const lineStarts = [];
  let offset = 0;
  for (const l of lines) {
    lineStarts.push(offset);
    offset += l.length + 1;
  }
  const depthAt = new Array(lines.length).fill(0);
  const insideString = new Array(lines.length).fill(false);
  let depth = 0;
  let ti = 0;
  for (let li = 0; li < lines.length; li++) {
    const lineStart = lineStarts[li];
    const lineEnd = lineStart + lines[li].length;
    // tokens starting before this line that end after its start are multi-line strings
    while (ti < tokens.length && tokens[ti].end <= lineStart) ti++;
    if (ti < tokens.length && tokens[ti].start < lineStart && tokens[ti].end > lineStart) insideString[li] = true;
    let firstClosers = 0;
    let seenOther = false;
    for (let k = ti; k < tokens.length && tokens[k].start < lineEnd; k++) {
      const v = tokens[k].value;
      if (tokens[k].type === 'punct' && (v === '}' || v === ')' || v === ']')) {
        if (!seenOther) firstClosers++;
      } else {
        seenOther = true;
      }
    }
    depthAt[li] = Math.max(0, depth - firstClosers);
    for (let k = ti; k < tokens.length && tokens[k].start < lineEnd; k++) {
      if (tokens[k].type !== 'punct') continue;
      if ('{(['.includes(tokens[k].value)) depth++;
      if ('})]'.includes(tokens[k].value)) depth = Math.max(0, depth - 1);
    }
  }
  return lines
    .map((line, i) => {
      if (insideString[i]) return line;
      const trimmed = line.trim();
      return trimmed ? '    '.repeat(depthAt[i]) + trimmed : '';
    })
    .join('\n');
}
