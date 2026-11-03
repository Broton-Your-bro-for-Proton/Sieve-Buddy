// Sieve parser (RFC 5228 grammar) producing an AST in which every node keeps its exact text offsets,
// so callers can patch a script in place without reformatting it.

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
    const t = next();
    if (!t || t.type !== 'punct' || t.value !== value) fail(`„${value}“ erwartet`, t);
    return t;
  };

  function parseStringList() {
    const open = next(); // '['
    const items = [];
    for (;;) {
      const t = next();
      if (!t || t.type !== 'string') fail('Zeichenkette in der Liste erwartet', t);
      items.push({ type: 'string', value: t.value, start: t.start, end: t.end });
      const sep = next();
      if (sep?.value === ']') return { type: 'list', items, start: open.start, end: sep.end };
      if (sep?.value !== ',') fail('„,“ oder „]“ erwartet', sep);
    }
  }

  function parseArguments() {
    const args = [];
    for (;;) {
      const t = peek();
      if (!t) return args;
      if (t.type === 'tag' || t.type === 'number' || t.type === 'string') {
        next();
        args.push({ type: t.type, value: t.value, start: t.start, end: t.end });
      } else if (t.value === '[') {
        args.push(parseStringList());
      } else {
        return args;
      }
    }
  }

  function parseTest() {
    const t = next();
    if (!t || t.type !== 'identifier') fail('Test erwartet', t);
    const test = { type: 'test', name: t.value, args: parseArguments(), tests: [], start: t.start, end: t.end };
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
        if (sep?.value !== ',') fail('„,“ oder „)“ erwartet', sep);
      }
    } else if (after?.type === 'identifier') {
      test.tests.push(parseTest()); // `not <test>`
    }
    const last = test.tests.length ? Math.max(test.tests[test.tests.length - 1].end, test.listEnd ?? 0) : null;
    test.end = Math.max(last ?? 0, test.args.length ? test.args[test.args.length - 1].end : t.end, test.listEnd ?? 0);
    return test;
  }

  function parseCommands(closing) {
    const commands = [];
    while (pos < tokens.length) {
      const t = peek();
      if (closing && t.value === '}') return commands;
      if (t.type !== 'identifier') fail('Befehl erwartet', t);
      next();
      const command = { type: 'command', name: t.value, args: parseArguments(), test: null, block: null, start: t.start, end: t.end };
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
        fail('„;“ oder „{“ erwartet', end);
      }
      commands.push(command);
    }
    if (closing) fail('„}“ fehlt');
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

/** Applies non-overlapping {start, end, text} patches. */
export function applyPatches(text, patches) {
  let out = text;
  for (const p of [...patches].sort((a, b) => b.start - a.start)) out = out.slice(0, p.start) + p.text + out.slice(p.end);
  return out;
}

/**
 * Re-indents a script by brace/paren depth (4 spaces), keeping everything else as written.
 * Proton's spam guard is kept byte for byte.
 */
export function formatSieve(text) {
  const guardAt = text.indexOf(SPAM_GUARD);
  if (guardAt !== -1) {
    const before = reindent(text.slice(0, guardAt));
    const after = reindent(text.slice(guardAt + SPAM_GUARD.length));
    return before + SPAM_GUARD + after;
  }
  return reindent(text);
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
