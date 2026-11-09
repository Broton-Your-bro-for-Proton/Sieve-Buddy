// Tokenizer, linter, autocompletion and require-fixer for Sieve (Proton's dialect or a standard server's).
// Pure functions on plain text and character offsets, so they run in Node tests and in the add-on.

import {
  COMMANDS,
  DATE_PARTS,
  EXPIRE_UNITS,
  ALL_EXTENSIONS,
  PROTON_DIALECT,
  PROTON_ONLY_COMMANDS,
  FLAGS,
  HEADERS,
  LIST_SPECS,
  RELATIONAL_OPS,
  SYSTEM_FOLDERS,
  TAGS,
  TEMPLATES,
  formatList,
} from './sieve-dialect.js';
import { t } from './i18n.js';

const PUNCTUATION = new Set([';', ',', '(', ')', '[', ']', '{', '}']);
const COMPARATORS = ['i;ascii-numeric', 'i;ascii-casemap', 'i;octet'];
const MAX_EXPIRE_DAYS = 730;

// ---------- Tokenizer ----------

/**
 * @returns {{tokens: Array<{type: string, value: string, start: number, end: number, open?: boolean}>,
 *            errors: Array<{start: number, end: number, message: string}>}}
 * Token types: identifier, tag, string, number, punct.
 */
export function tokenize(text) {
  const tokens = [];
  const errors = [];
  let i = 0;

  while (i < text.length) {
    const c = text[i];

    if (/\s/.test(c)) {
      i++;
    } else if (c === '#') {
      while (i < text.length && text[i] !== '\n') i++;
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      if (end === -1) {
        errors.push({ start: i, end: text.length, message: t('Comment /* … */ is not closed') });
        i = text.length;
      } else {
        i = end + 2;
      }
    } else if (c === '"') {
      const start = i;
      let value = '';
      i++;
      let closed = false;
      while (i < text.length) {
        if (text[i] === '\\' && i + 1 < text.length) {
          value += text[i + 1];
          i += 2;
        } else if (text[i] === '"') {
          closed = true;
          i++;
          break;
        } else {
          value += text[i++];
        }
      }
      tokens.push({ type: 'string', value, start, end: i, open: !closed });
      if (!closed) errors.push({ start, end: i, message: t('String is not closed with "') });
    } else if (text.startsWith('text:', i) && /^text:[ \t]*(#.*)?\r?\n/.test(text.slice(i, i + 200))) {
      const start = i;
      const bodyStart = text.indexOf('\n', i) + 1;
      const endMatch = /\r?\n\.\r?\n|\r?\n\.$/.exec(text.slice(bodyStart - 1));
      if (!endMatch) {
        errors.push({ start, end: text.length, message: t('Multiline text: is not terminated with "."') });
        tokens.push({ type: 'string', value: text.slice(bodyStart), start, end: text.length, open: true });
        i = text.length;
      } else {
        const bodyEnd = bodyStart - 1 + endMatch.index;
        // dot-stuffing (RFC 5228 2.4.2): a line starting with ".." stands for one "."
        tokens.push({ type: 'string', value: text.slice(bodyStart, bodyEnd).replace(/^\.\./gm, '.'), start, end: bodyEnd + endMatch[0].length });
        i = bodyEnd + endMatch[0].length;
      }
    } else if (c === ':' && /[a-zA-Z_]/.test(text[i + 1] ?? '')) {
      const start = i++;
      while (i < text.length && /[a-zA-Z0-9_]/.test(text[i])) i++;
      tokens.push({ type: 'tag', value: text.slice(start, i).toLowerCase(), start, end: i });
    } else if (/[0-9]/.test(c)) {
      const start = i;
      while (i < text.length && /[0-9]/.test(text[i])) i++;
      if (/[KMGkmg]/.test(text[i] ?? '')) i++;
      tokens.push({ type: 'number', value: text.slice(start, i), start, end: i });
    } else if (/[a-zA-Z_]/.test(c)) {
      const start = i;
      while (i < text.length && /[a-zA-Z0-9_]/.test(text[i])) i++;
      tokens.push({ type: 'identifier', value: text.slice(start, i).toLowerCase(), start, end: i });
    } else if (PUNCTUATION.has(c)) {
      tokens.push({ type: 'punct', value: c, start: i, end: i + 1 });
      i++;
    } else {
      errors.push({ start: i, end: i + 1, message: t('Unexpected character “{char}”', { char: c }) });
      i++;
    }
  }
  return { tokens, errors };
}

// ---------- Analysis ----------

function stringsOf(tokens, from) {
  // the string(s) of a single argument: "a" or ["a", "b"]
  const out = [];
  let i = from;
  if (tokens[i]?.value === '[') {
    i++;
    while (i < tokens.length && tokens[i].value !== ']') {
      if (tokens[i].type === 'string') out.push(tokens[i]);
      i++;
    }
  } else if (tokens[i]?.type === 'string') {
    out.push(tokens[i]);
  }
  return out;
}

/** Splits the token stream into statements and records which extensions each feature needs. */
function analyze(tokens, dialect = PROTON_DIALECT) {
  const issues = [];
  const used = new Map(); // extension -> first token using it
  const required = new Map(); // extension -> token
  const requireStatements = [];
  const statements = [];
  const blocks = [{ sawFileinto: false }];
  const parens = [];

  const need = (ext, token) => {
    if (ext && !used.has(ext)) used.set(ext, token);
  };
  const issue = (token, message, severity = 'error', end = token.end) =>
    issues.push({ start: token.start, end, message, severity });

  let expect = 'statement'; // statement | test | args | block
  let current = null; // current statement {command, token, args: []}
  let sawNonRequire = false;

  const finishStatement = () => {
    if (current) statements.push(current);
    current = null;
  };

  let reread = false;
  for (let i = 0; i < tokens.length; i++) {
    const tk = tokens[i];
    const firstVisit = !reread;
    reread = false;

    // brackets are checked independently of the statement state
    if (firstVisit && tk.type === 'punct' && '([{'.includes(tk.value)) parens.push(tk);
    if (firstVisit && tk.type === 'punct' && ')]}'.includes(tk.value)) {
      const open = parens.pop();
      const pair = { ')': '(', ']': '[', '}': '{' }[tk.value];
      if (!open || open.value !== pair) issue(tk, t('“{char}” without a matching opening bracket', { char: tk.value }));
    }

    if (firstVisit && tk.type === 'string') {
      // ${hex:41} and ${unicode:41} belong to encoded-character, not to variables
      if (/\$\{(?!hex:|unicode:)/i.test(tk.value)) need('variables', tk);
      if (/\$\{(hex|unicode):/i.test(tk.value)) need('encoded-character', tk);
      if (tk.value === 'i;ascii-numeric' && tokens[i - 1]?.value === ':comparator') need('comparator-i;ascii-numeric', tk);
    }

    if (firstVisit && tk.type === 'tag') {
      const tag = TAGS[tk.value];
      if (!tag) issue(tk, t('Unknown argument {name}', { name: tk.value }), 'warning');
      else need(tag.ext, tk);
      if (current) current.tags.push(tk.value);
    }

    if (expect === 'statement') {
      if (tk.type === 'punct' && tk.value === '}') {
        blocks.pop();
        if (!blocks.length) blocks.push({ sawFileinto: false });
        continue;
      }
      if (tk.type === 'punct' && tk.value === ';') {
        issue(tk, t('Superfluous ;'), 'warning');
        continue;
      }
      if (tk.type !== 'identifier') {
        issue(tk, t('A command is expected here'));
        continue;
      }
      const cmd = COMMANDS[tk.value];
      if (!cmd) {
        issue(tk, t('Unknown command “{name}”', { name: tk.value }));
        expect = 'args';
        current = { command: tk.value, token: tk, tags: [], argsStart: i + 1 };
        continue;
      }
      if (cmd.kind === 'test') {
        issue(tk, t('“{name}” is a test and only allowed in a condition (if/elsif)', { name: tk.value }));
        expect = 'args';
        current = { command: tk.value, token: tk, tags: [], argsStart: i + 1 };
        continue;
      }
      need(cmd.ext, tk);
      if (tk.value === 'require') {
        if (sawNonRequire) issue(tk, t('require must be at the start of the script'));
        requireStatements.push(tk);
        for (const s of stringsOf(tokens, i + 1)) {
          if (!dialect.extensions.has(s.value.toLowerCase())) {
            issue(s, dialect.proton ? t('Extension “{name}” is not supported by Proton', { name: s.value }) : t('Extension “{name}” is not offered by this server', { name: s.value }));
          }
          required.set(s.value, s);
        }
      } else {
        sawNonRequire = true;
      }
      current = { command: tk.value, token: tk, tags: [], argsStart: i + 1 };
      if (tk.value === 'if' || tk.value === 'elsif') expect = 'test';
      else if (tk.value === 'else') expect = 'block';
      else expect = 'args';
      continue;
    }

    if (expect === 'test') {
      if (tk.type === 'identifier') {
        const cmd = COMMANDS[tk.value];
        if (!cmd) issue(tk, t('Unknown test “{name}”', { name: tk.value }));
        else if (cmd.kind !== 'test') issue(tk, t('“{name}” is not a test – is the { missing after the condition?', { name: tk.value }));
        else {
          need(cmd.ext, tk);
          if (tk.value === 'header' || tk.value === 'address') current.lastTest = tk.value;
        }
        current.tests = [...(current.tests ?? []), { name: tk.value, index: i }];
      } else if (tk.value === '{') {
        const open = parens.filter((p) => p.value === '(').length;
        if (open) issue(tk, t('Condition has an unclosed “(”'));
        finishStatement();
        blocks.push({ sawFileinto: false });
        expect = 'statement';
      } else if (tk.value === ';') {
        issue(tk, t('A { is expected after a condition, not ;'));
        finishStatement();
        expect = 'statement';
      }
      continue;
    }

    if (expect === 'block') {
      if (tk.value === '{') {
        blocks.push({ sawFileinto: false });
      } else {
        issue(tk, t('A { is expected after else'));
      }
      finishStatement();
      expect = 'statement';
      continue;
    }

    // expect === 'args'
    if (tk.value === ';') {
      current.argsEnd = i;
      const block = blocks[blocks.length - 1];
      if (current.command === 'fileinto' || current.command === 'keep') block.sawFileinto = true;
      if (dialect.proton && ['addflag', 'setflag', 'removeflag'].includes(current.command) && block.sawFileinto) {
        issue(current.token, t('Flag changes after fileinto/keep are ignored by Proton – set them first'), 'warning');
      }
      finishStatement();
      expect = 'statement';
    } else if (tk.type === 'identifier' || tk.value === '{' || tk.value === '}') {
      const prev = tokens[i - 1];
      issues.push({ start: prev.start, end: prev.end, message: t('Missing ; at the end of the command'), severity: 'error' });
      finishStatement();
      expect = 'statement';
      i--; // re-read this token as the start of the next statement
      reread = true;
    }
  }

  if (current && expect === 'args') {
    const last = tokens[tokens.length - 1];
    issues.push({ start: last.start, end: last.end, message: t('Missing ; at the end of the command'), severity: 'error' });
    statements.push(current);
  } else if (current && expect === 'test') {
    issue(current.token, t('Condition without a { … } block'));
  }
  for (const open of parens) issue(open, t('“{char}” is not closed', { char: open.value }));

  return { issues, used, required, requireStatements, statements };
}

function statementChecks(tokens, statements, { folders, dialect = PROTON_DIALECT } = {}) {
  const issues = [];
  const issue = (token, message, severity = 'warning') =>
    issues.push({ start: token.start, end: token.end, message, severity });

  for (const st of statements) {
    const args = tokens.slice(st.argsStart, st.argsEnd ?? tokens.length);
    const strings = args.filter((a) => a.type === 'string');

    switch (st.command) {
      case 'fileinto': {
        const target = strings[0];
        if (!target) break;
        const name = target.value;
        const lower = name.toLowerCase();
        const createsIt = dialect.proton ? false : st.tags.includes(':create');
        // Proton matches folder/label names case-insensitively ("eBay" files into "Ebay")
        const exists = dialect.proton ? folders?.some((f) => f.toLowerCase() === lower) : folders?.includes(name);
        if (dialect.proton && (lower === 'drafts' || lower === 'sent')) issue(target, t('“{name}” is ignored by Proton in fileinto', { name }));
        else if (folders && !createsIt && !name.includes('${') && !(dialect.proton ? SYSTEM_FOLDERS.includes(lower) : lower === 'inbox') && !exists) {
          issue(target, dialect.proton ? t('Folder/label “{name}” does not exist in Proton – fileinto would do nothing', { name }) : t('Folder “{name}” does not exist – add :create or create the folder', { name }));
        }
        break;
      }
      case 'addflag':
      case 'removeflag':
      case 'setflag':
        if (!dialect.proton) break;
        for (const s of strings) {
          if (!s.value.includes('${') && s.value !== '\\Seen' && s.value !== '\\Flagged') {
            issue(s, t('Proton only supports the flags \\\\Seen and \\\\Flagged, not “{name}”', { name: s.value }));
          }
        }
        break;
      case 'expire': {
        if (!dialect.proton) break;
        const [unit, amount] = strings;
        if (unit && !EXPIRE_UNITS.includes(unit.value)) issue(unit, t('Unit must be one of {units}', { units: EXPIRE_UNITS.join(', ') }), 'error');
        if (unit?.value === 'day' && amount && Number(amount.value) > MAX_EXPIRE_DAYS) {
          issue(amount, t('Proton limits expire to {days} days', { days: MAX_EXPIRE_DAYS }));
        }
        break;
      }
      case 'keep':
        if (dialect.proton) issue(st.token, t('keep only cancels a discard on Proton – it does not store a copy in the inbox'), 'info');
        break;
      case 'discard':
        if (dialect.proton) issue(st.token, t('No further Proton filters run after discard'), 'info');
        break;
      case 'stop':
        if (dialect.proton) issue(st.token, t('stop also ends all following filters'), 'info');
        break;
      default:
        break;
    }
  }

  // :regex shorthands Proton does not support
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].value !== ':regex' || !dialect.proton) continue;
    for (let j = i + 1; j < tokens.length && tokens[j].value !== '{' && tokens[j].value !== ';'; j++) {
      const tk = tokens[j];
      if (tk.type === 'string' && /\\[dwWb]/.test(tk.value)) {
        issue(tk, t('Proton regex does not support \\d, \\w, \\W and \\b – use e.g. [0-9] instead'), 'error');
      }
    }
  }

  // :value / :count need a valid operator
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].value !== ':value' && tokens[i].value !== ':count') continue;
    const op = tokens[i + 1];
    if (op?.type === 'string' && !RELATIONAL_OPS.includes(op.value)) {
      issue(op, t('Operator must be one of {ops}', { ops: RELATIONAL_OPS.join(', ') }), 'error');
    }
  }
  return issues;
}

/**
 * Lints a Proton Sieve script.
 * @param {string} text
 * @param {{folders?: string[], dialect?: object}} [options] known folder/label paths (flags unknown fileinto targets) and the dialect (see makeDialect)
 * @returns {Array<{start: number, end: number, message: string, severity: 'error'|'warning'|'info'}>}
 */
export function lintSieve(text, options = {}) {
  const { tokens, errors } = tokenize(text);
  const issues = errors.map((e) => ({ ...e, severity: 'error' }));
  if (!tokens.length) return issues;

  const dialect = options.dialect ?? PROTON_DIALECT;
  const result = analyze(tokens, dialect);
  issues.push(...result.issues);
  issues.push(...statementChecks(tokens, result.statements, { ...options, dialect }));
  if (!dialect.proton) {
    for (const st of result.statements) {
      if (PROTON_ONLY_COMMANDS.has(st.command)) issues.push({ start: st.token.start, end: st.token.end, message: t('“{name}” is only available on Proton', { name: st.command }), severity: 'error' });
    }
    for (const tk of tokens) {
      if (tk.type === 'identifier' && PROTON_ONLY_COMMANDS.has(tk.value) && !result.statements.some((st) => st.token === tk)) {
        issues.push({ start: tk.start, end: tk.end, message: t('“{name}” is only available on Proton', { name: tk.value }), severity: 'error' });
      }
    }
  }

  for (const [ext, token] of result.used) {
    if (!result.required.has(ext)) {
      issues.push({
        start: token.start,
        end: token.end,
        message: t('Requires require "{name}" – fix automatically with “Complete require”', { name: ext }),
        severity: 'error',
      });
    }
  }
  if (dialect.proton && result.requireStatements.length > 1) {
    const second = result.requireStatements[1];
    issues.push({ start: second.start, end: second.end, message: t('Proton expects a single require – merge them with “Complete require”'), severity: 'warning' });
  }
  if (dialect.proton && !text.includes('vnd.proton.spam-threshold')) {
    issues.push({ start: 0, end: Math.min(text.length, 1), message: t('Spam guard block is missing – the filter would then also run on spam'), severity: 'warning' });
  }

  return issues.sort((a, b) => a.start - b.start);
}

/** Merges every needed extension into a single require at the top. Returns the unchanged text when nothing is missing. */
export function fixRequire(text) {
  const { tokens } = tokenize(text);
  const result = analyze(tokens);
  const names = [...result.required.keys()];
  for (const ext of result.used.keys()) if (!names.includes(ext)) names.push(ext);

  const missing = [...result.used.keys()].some((ext) => !result.required.has(ext));
  if (!missing && result.requireStatements.length <= 1) return text;

  // remove every existing require statement (with its trailing ; and newline), then insert one at the top
  let out = text;
  const spans = result.requireStatements.map((t) => {
    const idx = tokens.indexOf(t);
    let j = idx;
    while (j < tokens.length && tokens[j].value !== ';') j++;
    let end = tokens[j]?.end ?? t.end;
    while (out[end] === ' ' || out[end] === '\t') end++;
    if (out[end] === '\r') end++;
    if (out[end] === '\n') end++;
    return [t.start, end];
  });
  const insertAt = spans.length ? spans[0][0] : 0;
  for (const [start, end] of [...spans].reverse()) out = out.slice(0, start) + out.slice(end);
  const line = `require ${formatList(names)};\n${spans.length ? '' : '\n'}`;
  return out.slice(0, insertAt) + line + out.slice(insertAt);
}

// ---------- Autocompletion ----------

const item = (text, displayText, className) => ({ text, displayText: displayText ?? text, className });

const extensionsFor = (context) =>
  [...(context.dialect ?? PROTON_DIALECT).extensions].sort().map((ext) => [ext, ALL_EXTENSIONS[ext] ?? t('Server extension')]);

function filterByPrefix(items, prefix) {
  const p = prefix.toLowerCase();
  return items.filter((i) => i.text.toLowerCase().replace(/^"/, '').startsWith(p) || i.displayText.toLowerCase().includes(p));
}

/**
 * Completion candidates at a cursor offset.
 * @param {string} text
 * @param {number} cursor
 * @param {{folders?: string[], labels?: string[]}} [context]
 * @returns {{from: number, to: number, list: Array<{text: string, displayText: string, className?: string}>}}
 */
export function getCompletions(text, cursor, context = {}) {
  const before = text.slice(0, cursor);
  const { tokens } = tokenize(before);
  const last = tokens[tokens.length - 1];

  // inside an open string: complete its value
  if (last?.type === 'string' && last.open && last.end === cursor) {
    const prefix = last.value;
    const from = last.start + 1;
    return { from, to: cursor, list: filterByPrefix(stringCandidates(tokens, tokens.length - 1, context), prefix).map(closeString(text, cursor)) };
  }

  const wordMatch = /:?[a-zA-Z_][a-zA-Z0-9_]*$|:$/.exec(before);
  const prefix = wordMatch ? wordMatch[0] : '';
  const from = cursor - prefix.length;

  if (prefix.startsWith(':')) {
    const tags = Object.entries(TAGS).map(([tag, info]) => item(tag + ' ', `${tag}: ${info.doc}`, 'cm-hint-tag'));
    return { from, to: cursor, list: tags.filter((t) => t.text.startsWith(prefix.toLowerCase())) };
  }

  // just typed "[" or "," inside require: offer quoted extension names
  const prevTokens = prefix ? tokens.slice(0, -1) : tokens;
  const statementCmd = currentCommand(prevTokens);
  if (statementCmd === 'require' && prevTokens.length && ['[', ','].includes(prevTokens[prevTokens.length - 1].value)) {
    return {
      from,
      to: cursor,
      list: extensionsFor(context).map(([ext, doc]) => item(`"${ext}"`, `${ext}: ${doc}`, 'cm-hint-ext')),
    };
  }

  const inTest = isInTest(prevTokens);
  const candidates = Object.entries(COMMANDS)
    .filter(([, info]) => (inTest ? info.kind === 'test' : info.kind !== 'test'))
    .map(([name, info]) => item(name, `${name}: ${info.doc}`, `cm-hint-${info.kind}`));
  if (!inTest) {
    for (const tpl of TEMPLATES) candidates.push(item(tpl.body, t('Template: {name}', { name: tpl.name }), 'cm-hint-template'));
  }
  return {
    from,
    to: cursor,
    list: prefix ? candidates.filter((c) => c.text.startsWith(prefix.toLowerCase()) || c.displayText.toLowerCase().includes(prefix.toLowerCase())) : candidates,
  };
}

function closeString(text, cursor) {
  const closed = text[cursor] === '"';
  return (c) => ({ ...c, text: closed ? c.text : `${c.text}"` });
}

function currentCommand(tokens) {
  for (let i = tokens.length - 1; i >= 0; i--) {
    const t = tokens[i];
    if (t.value === ';' || t.value === '{' || t.value === '}') return null;
    if (t.type === 'identifier' && COMMANDS[t.value]?.kind !== 'test' && COMMANDS[t.value]) return t.value;
  }
  return null;
}

function isInTest(tokens) {
  for (let i = tokens.length - 1; i >= 0; i--) {
    const t = tokens[i];
    if (t.value === ';' || t.value === '{' || t.value === '}') return false;
    if (t.type === 'identifier' && (t.value === 'if' || t.value === 'elsif')) return true;
  }
  return false;
}

/** Candidates for the string being typed at tokens[index]. */
function stringCandidates(tokens, index, context) {
  const { folders = [], labels = [] } = context;
  const prev = tokens[index - 1];
  if (prev?.value === ':value' || prev?.value === ':count') return RELATIONAL_OPS.map((op) => item(op));
  if (prev?.value === ':comparator') return COMPARATORS.map((c) => item(c));

  // find the command/test this string belongs to and count the strings already given to it
  let owner = null;
  let position = 0;
  let inList = false;
  for (let i = index - 1; i >= 0; i--) {
    const t = tokens[i];
    if (t.type === 'identifier') {
      owner = t.value;
      break;
    }
    if (t.value === ';' || t.value === '{' || t.value === '}' || t.value === '(' || t.value === ',') {
      if (t.value === ',' && tokens.slice(0, i).reverse().find((x) => x.value === '[' || x.value === ']')?.value === '[') {
        inList = true;
        continue;
      }
      break;
    }
    if (t.value === '[') inList = true;
    if (t.value === ']') position++;
    if (t.type === 'string' && !inList) {
      const before = tokens[i - 1];
      if (before?.value !== ':comparator' && before?.value !== ':value' && before?.value !== ':count') position++;
    }
  }
  const tagsOf = () => {
    const tags = [];
    for (let i = index - 1; i >= 0 && tokens[i].type !== 'identifier'; i--) if (tokens[i].type === 'tag') tags.push(tokens[i].value);
    return tags;
  };

  switch (owner) {
    case 'require':
      return extensionsFor(context).map(([ext, doc]) => item(ext, `${ext}: ${doc}`, 'cm-hint-ext'));
    case 'fileinto':
      return [
        ...((context.dialect ?? PROTON_DIALECT).proton ? SYSTEM_FOLDERS : ['INBOX']).map((f) => item(f, t('{name} (system)', { name: f }), 'cm-hint-folder')),
        ...folders.map((f) => item(f, t('{name} (folder)', { name: f }), 'cm-hint-folder')),
        ...labels.map((l) => item(l, t('{name} (label)', { name: l }), 'cm-hint-label')),
      ];
    case 'addflag':
    case 'removeflag':
    case 'setflag':
    case 'hasflag':
      return FLAGS.map((f) => item(f, f.replace(/\\\\/g, '\\')));
    case 'header':
      if (tagsOf().includes(':list') && position === 1) return LIST_SPECS.map((l) => item(l));
      return position === 0 ? HEADERS.map((h) => item(h)) : [];
    case 'address':
    case 'exists':
      return position === 0 ? HEADERS.map((h) => item(h)) : [];
    case 'envelope':
      return position === 0 ? [item('from'), item('to')] : [];
    case 'date':
      if (position === 0) return [item('date'), item('received'), ...HEADERS.map((h) => item(h))];
      return position === 1 ? DATE_PARTS.map((d) => item(d)) : [];
    case 'currentdate':
      return position === 0 ? DATE_PARTS.map((d) => item(d)) : [];
    case 'expire':
    case 'expiration':
      return position === 0 ? EXPIRE_UNITS.map((u) => item(u)) : [];
    default:
      return [];
  }
}

