// Tokenizer, linter, autocompletion and require-fixer for Proton's Sieve dialect.
// Pure functions on plain text and character offsets, so they run in Node tests and in the add-on.

import {
  COMMANDS,
  DATE_PARTS,
  EXPIRE_UNITS,
  EXTENSIONS,
  FLAGS,
  HEADERS,
  LIST_SPECS,
  RELATIONAL_OPS,
  SYSTEM_FOLDERS,
  TAGS,
  TEMPLATES,
  formatList,
} from './sieve-dialect.js';

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
        errors.push({ start: i, end: text.length, message: 'Kommentar /* … */ wird nicht geschlossen' });
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
      if (!closed) errors.push({ start, end: i, message: 'Zeichenkette wird nicht mit " geschlossen' });
    } else if (text.startsWith('text:', i) && /^text:[ \t]*(#.*)?\r?\n/.test(text.slice(i, i + 200))) {
      const start = i;
      const bodyStart = text.indexOf('\n', i) + 1;
      const endMatch = /\r?\n\.\r?\n|\r?\n\.$/.exec(text.slice(bodyStart - 1));
      if (!endMatch) {
        errors.push({ start, end: text.length, message: 'Mehrzeiliger text: wird nicht mit "." beendet' });
        tokens.push({ type: 'string', value: text.slice(bodyStart), start, end: text.length, open: true });
        i = text.length;
      } else {
        const bodyEnd = bodyStart - 1 + endMatch.index;
        tokens.push({ type: 'string', value: text.slice(bodyStart, bodyEnd), start, end: bodyEnd + endMatch[0].length });
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
      errors.push({ start: i, end: i + 1, message: `Unerwartetes Zeichen „${c}“` });
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
function analyze(tokens) {
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
    const t = tokens[i];
    const firstVisit = !reread;
    reread = false;

    // brackets are checked independently of the statement state
    if (firstVisit && t.type === 'punct' && '([{'.includes(t.value)) parens.push(t);
    if (firstVisit && t.type === 'punct' && ')]}'.includes(t.value)) {
      const open = parens.pop();
      const pair = { ')': '(', ']': '[', '}': '{' }[t.value];
      if (!open || open.value !== pair) issue(t, `„${t.value}“ ohne passende öffnende Klammer`);
    }

    if (firstVisit && t.type === 'string') {
      if (t.value.includes('${')) need('variables', t);
      if (t.value === 'i;ascii-numeric' && tokens[i - 1]?.value === ':comparator') need('comparator-i;ascii-numeric', t);
    }

    if (firstVisit && t.type === 'tag') {
      const tag = TAGS[t.value];
      if (!tag) issue(t, `Unbekanntes Argument ${t.value}`, 'warning');
      else need(tag.ext, t);
      if (current) current.tags.push(t.value);
    }

    if (expect === 'statement') {
      if (t.type === 'punct' && t.value === '}') {
        blocks.pop();
        if (!blocks.length) blocks.push({ sawFileinto: false });
        continue;
      }
      if (t.type === 'punct' && t.value === ';') {
        issue(t, 'Überflüssiges ;', 'warning');
        continue;
      }
      if (t.type !== 'identifier') {
        issue(t, 'Hier wird ein Befehl erwartet');
        continue;
      }
      const cmd = COMMANDS[t.value];
      if (!cmd) {
        issue(t, `Unbekannter Befehl „${t.value}“`);
        expect = 'args';
        current = { command: t.value, token: t, tags: [], argsStart: i + 1 };
        continue;
      }
      if (cmd.kind === 'test') {
        issue(t, `„${t.value}“ ist ein Test und nur in einer Bedingung (if/elsif) erlaubt`);
        expect = 'args';
        current = { command: t.value, token: t, tags: [], argsStart: i + 1 };
        continue;
      }
      need(cmd.ext, t);
      if (t.value === 'require') {
        if (sawNonRequire) issue(t, 'require muss am Anfang des Skripts stehen');
        requireStatements.push(t);
        for (const s of stringsOf(tokens, i + 1)) {
          if (!EXTENSIONS[s.value]) issue(s, `Erweiterung „${s.value}“ wird von Proton nicht unterstützt`);
          required.set(s.value, s);
        }
      } else {
        sawNonRequire = true;
      }
      current = { command: t.value, token: t, tags: [], argsStart: i + 1 };
      if (t.value === 'if' || t.value === 'elsif') expect = 'test';
      else if (t.value === 'else') expect = 'block';
      else expect = 'args';
      continue;
    }

    if (expect === 'test') {
      if (t.type === 'identifier') {
        const cmd = COMMANDS[t.value];
        if (!cmd) issue(t, `Unbekannter Test „${t.value}“`);
        else if (cmd.kind !== 'test') issue(t, `„${t.value}“ ist kein Test – fehlt die { nach der Bedingung?`);
        else {
          need(cmd.ext, t);
          if (t.value === 'header' || t.value === 'address') current.lastTest = t.value;
        }
        current.tests = [...(current.tests ?? []), { name: t.value, index: i }];
      } else if (t.value === '{') {
        const open = parens.filter((p) => p.value === '(').length;
        if (open) issue(t, 'Bedingung hat eine nicht geschlossene „(“');
        finishStatement();
        blocks.push({ sawFileinto: false });
        expect = 'statement';
      } else if (t.value === ';') {
        issue(t, 'Nach einer Bedingung wird { erwartet, nicht ;');
        finishStatement();
        expect = 'statement';
      }
      continue;
    }

    if (expect === 'block') {
      if (t.value === '{') {
        blocks.push({ sawFileinto: false });
      } else {
        issue(t, 'Nach else wird { erwartet');
      }
      finishStatement();
      expect = 'statement';
      continue;
    }

    // expect === 'args'
    if (t.value === ';') {
      current.argsEnd = i;
      const block = blocks[blocks.length - 1];
      if (current.command === 'fileinto' || current.command === 'keep') block.sawFileinto = true;
      if (['addflag', 'setflag', 'removeflag'].includes(current.command) && block.sawFileinto) {
        issue(current.token, 'Flag-Änderungen nach fileinto/keep werden von Proton ignoriert – vorher setzen', 'warning');
      }
      finishStatement();
      expect = 'statement';
    } else if (t.type === 'identifier' || t.value === '{' || t.value === '}') {
      const prev = tokens[i - 1];
      issues.push({ start: prev.start, end: prev.end, message: 'Fehlendes ; am Ende des Befehls', severity: 'error' });
      finishStatement();
      expect = 'statement';
      i--; // re-read this token as the start of the next statement
      reread = true;
    }
  }

  if (current && expect === 'args') {
    const last = tokens[tokens.length - 1];
    issues.push({ start: last.start, end: last.end, message: 'Fehlendes ; am Ende des Befehls', severity: 'error' });
    statements.push(current);
  } else if (current && expect === 'test') {
    issue(current.token, 'Bedingung ohne { … }-Block');
  }
  for (const open of parens) issue(open, `„${open.value}“ wird nicht geschlossen`);

  return { issues, used, required, requireStatements, statements };
}

function statementChecks(tokens, statements, { folders } = {}) {
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
        if (lower === 'drafts' || lower === 'sent') issue(target, `„${name}“ wird von Proton bei fileinto ignoriert`);
        else if (folders && !name.includes('${') && !SYSTEM_FOLDERS.includes(lower) && !folders.includes(name)) {
          issue(target, `Ordner/Label „${name}“ existiert in Proton nicht – fileinto würde nichts tun`);
        }
        break;
      }
      case 'addflag':
      case 'removeflag':
      case 'setflag':
        for (const s of strings) {
          if (!s.value.includes('${') && s.value !== '\\Seen' && s.value !== '\\Flagged') {
            issue(s, `Proton unterstützt nur die Flags \\\\Seen und \\\\Flagged, nicht „${s.value}“`);
          }
        }
        break;
      case 'expire': {
        const [unit, amount] = strings;
        if (unit && !EXPIRE_UNITS.includes(unit.value)) issue(unit, `Einheit muss eine von ${EXPIRE_UNITS.join(', ')} sein`, 'error');
        if (unit?.value === 'day' && amount && Number(amount.value) > MAX_EXPIRE_DAYS) {
          issue(amount, `Proton begrenzt expire auf ${MAX_EXPIRE_DAYS} Tage`);
        }
        break;
      }
      case 'keep':
        issue(st.token, 'keep hebt bei Proton nur ein discard auf – es legt keine Kopie im Posteingang ab', 'info');
        break;
      case 'discard':
        issue(st.token, 'Nach discard laufen keine weiteren Proton-Filter mehr', 'info');
        break;
      case 'stop':
        issue(st.token, 'stop beendet auch alle nachfolgenden Filter', 'info');
        break;
      default:
        break;
    }
  }

  // :regex shorthands Proton does not support
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].value !== ':regex') continue;
    for (let j = i + 1; j < tokens.length && tokens[j].value !== '{' && tokens[j].value !== ';'; j++) {
      const t = tokens[j];
      if (t.type === 'string' && /\\[dwWb]/.test(t.value)) {
        issue(t, 'Proton-Regex kennt \\d, \\w, \\W und \\b nicht – z. B. [0-9] verwenden', 'error');
      }
    }
  }

  // :value / :count need a valid operator
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].value !== ':value' && tokens[i].value !== ':count') continue;
    const op = tokens[i + 1];
    if (op?.type === 'string' && !RELATIONAL_OPS.includes(op.value)) {
      issue(op, `Operator muss einer von ${RELATIONAL_OPS.join(', ')} sein`, 'error');
    }
  }
  return issues;
}

/**
 * Lints a Proton Sieve script.
 * @param {string} text
 * @param {{folders?: string[]}} [options] known Proton folder/label paths, to flag unknown fileinto targets
 * @returns {Array<{start: number, end: number, message: string, severity: 'error'|'warning'|'info'}>}
 */
export function lintSieve(text, options = {}) {
  const { tokens, errors } = tokenize(text);
  const issues = errors.map((e) => ({ ...e, severity: 'error' }));
  if (!tokens.length) return issues;

  const result = analyze(tokens);
  issues.push(...result.issues);
  issues.push(...statementChecks(tokens, result.statements, options));

  for (const [ext, token] of result.used) {
    if (!result.required.has(ext)) {
      issues.push({
        start: token.start,
        end: token.end,
        message: `Benötigt require "${ext}" – mit „require ergänzen“ automatisch beheben`,
        severity: 'error',
      });
    }
  }
  if (result.requireStatements.length > 1) {
    const second = result.requireStatements[1];
    issues.push({ start: second.start, end: second.end, message: 'Proton erwartet ein einziges require – mit „require ergänzen“ zusammenführen', severity: 'warning' });
  }
  if (!text.includes('vnd.proton.spam-threshold')) {
    issues.push({ start: 0, end: Math.min(text.length, 1), message: 'Spam-Schutz-Block fehlt – der Filter läuft dann auch auf Spam', severity: 'warning' });
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
    const tags = Object.entries(TAGS).map(([tag, info]) => item(tag + ' ', `${tag} — ${info.doc}`, 'cm-hint-tag'));
    return { from, to: cursor, list: tags.filter((t) => t.text.startsWith(prefix.toLowerCase())) };
  }

  // just typed "[" or "," inside require: offer quoted extension names
  const prevTokens = prefix ? tokens.slice(0, -1) : tokens;
  const statementCmd = currentCommand(prevTokens);
  if (statementCmd === 'require' && prevTokens.length && ['[', ','].includes(prevTokens[prevTokens.length - 1].value)) {
    return {
      from,
      to: cursor,
      list: Object.entries(EXTENSIONS).map(([ext, doc]) => item(`"${ext}"`, `${ext} — ${doc}`, 'cm-hint-ext')),
    };
  }

  const inTest = isInTest(prevTokens);
  const candidates = Object.entries(COMMANDS)
    .filter(([, info]) => (inTest ? info.kind === 'test' : info.kind !== 'test'))
    .map(([name, info]) => item(name, `${name} — ${info.doc}`, `cm-hint-${info.kind}`));
  if (!inTest) {
    for (const tpl of TEMPLATES) candidates.push(item(tpl.body, `Vorlage: ${tpl.name}`, 'cm-hint-template'));
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
function stringCandidates(tokens, index, { folders = [], labels = [] }) {
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
      return Object.entries(EXTENSIONS).map(([ext, doc]) => item(ext, `${ext} — ${doc}`, 'cm-hint-ext'));
    case 'fileinto':
      return [
        ...SYSTEM_FOLDERS.map((f) => item(f, `${f} (System)`, 'cm-hint-folder')),
        ...folders.map((f) => item(f, `${f} (Ordner)`, 'cm-hint-folder')),
        ...labels.map((l) => item(l, `${l} (Label)`, 'cm-hint-label')),
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

