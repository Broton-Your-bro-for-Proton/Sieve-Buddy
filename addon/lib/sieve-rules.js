// Structured rules on top of the AST: describe a rule as conditions + actions, find where it fits into
// existing scripts (append a key to a matching block, extend an anyof, ...) and produce minimal patches.

import { t } from './i18n.js';
import { fixRequire } from './sieve-analyzer.js';
import { applyPatches, lineOf, parseSieve, quoteSieve, sameLineEndings, walkCommands } from './sieve-ast.js';

/**
 * Condition: {kind: 'address', header: 'from', part: 'all'|'domain'|'localpart', match: 'is'|'contains'|'matches', value}
 *          | {kind: 'header',  header: 'subject', match: 'is'|'contains'|'matches', value}
 *          | {kind: 'exists',  header: 'list-unsubscribe'}
 * Actions:   {fileinto?: string, seen?: boolean, flagged?: boolean, expireDays?: number, stop?: boolean}
 */

const ADDRESS_PARTS = new Set([':all', ':domain', ':localpart']);
const MATCH_TYPES = new Set([':is', ':contains', ':matches', ':regex']);

// ---------- Describe existing tests and blocks ----------

const strings = (arg) => (arg?.type === 'list' ? arg.items.map((i) => i.value) : arg?.type === 'string' ? [arg.value] : []);

/** Reduces an address/header/exists test to a comparable form, or null if it is anything else. */
export function describeTest(test) {
  if (!test || !['address', 'header', 'exists'].includes(test.name)) return null;
  let part = 'all';
  let match = 'is';
  let comparator = null;
  const positional = [];
  for (let i = 0; i < test.args.length; i++) {
    const a = test.args[i];
    if (a.type === 'tag') {
      if (ADDRESS_PARTS.has(a.value)) part = a.value.slice(1);
      else if (MATCH_TYPES.has(a.value)) match = a.value.slice(1);
      else if (a.value === ':comparator') comparator = test.args[++i]?.value ?? null;
      else return null; // :value, :count, :list, ... are not merge targets
    } else {
      positional.push(a);
    }
  }
  if (test.name === 'exists') {
    return { kind: 'exists', headers: strings(positional[0]).map((h) => h.toLowerCase()), keysArg: null, test };
  }
  if (positional.length !== 2) return null;
  return {
    kind: test.name,
    part: test.name === 'address' ? part : null,
    match,
    comparator,
    headers: strings(positional[0]).map((h) => h.toLowerCase()),
    keys: strings(positional[1]),
    keysArg: positional[1],
    test,
  };
}

/** Normalises a block made only of simple actions; null for anything with nested logic. */
export function describeActions(block) {
  const actions = { fileinto: null, seen: false, flagged: false, expireDays: null, stop: false };
  for (const c of block.commands) {
    const values = c.args.flatMap(strings);
    switch (c.name) {
      case 'fileinto':
        if (actions.fileinto !== null || values.length !== 1) return null;
        actions.fileinto = values[0];
        break;
      case 'addflag':
      case 'setflag':
        for (const f of values) {
          if (f === '\\Seen') actions.seen = true;
          else if (f === '\\Flagged') actions.flagged = true;
          else return null;
        }
        break;
      case 'expire':
        if (values[0] !== 'day') return null;
        actions.expireDays = Number(c.args[1]?.value ?? values[1]);
        break;
      case 'stop':
        actions.stop = true;
        break;
      default:
        return null;
    }
  }
  return actions;
}

function normaliseActions(a) {
  return {
    fileinto: a.fileinto || null,
    seen: Boolean(a.seen),
    flagged: Boolean(a.flagged),
    expireDays: a.expireDays ? Number(a.expireDays) : null,
    stop: Boolean(a.stop),
  };
}

export const sameActions = (a, b) => JSON.stringify(normaliseActions(a)) === JSON.stringify(normaliseActions(b));
// existing rule a may stop where new rule b does not (its stop stays); a stop b asks for is never dropped
export const sameEffect = (a, b) => (!b.stop || a.stop) && sameActions({ ...a, stop: false }, { ...b, stop: false });

function sameForm(desc, condition) {
  if (desc.kind !== condition.kind) return false;
  if (desc.kind === 'exists') return false; // nothing to append to
  const header = condition.header.toLowerCase();
  return (
    desc.headers.length === 1 &&
    desc.headers[0] === header &&
    desc.match === (condition.match ?? 'is') &&
    (desc.kind !== 'address' || desc.part === (condition.part ?? 'all')) &&
    (desc.comparator === null || desc.comparator === 'i;ascii-casemap')
  );
}

const keyCovered = (desc, value) => desc.keys.some((k) => k.toLowerCase() === value.toLowerCase());

// ---------- Generate code ----------

const MATCHES = ['is', 'contains', 'matches'];
const PARTS = ['all', 'domain', 'localpart'];

export function conditionToSieve(c) {
  // these go into the code unquoted: only known words, never free text
  if (!MATCHES.includes(c.match ?? 'is')) throw new Error(t('Unknown match type “{value}”', { value: c.match }));
  if (!PARTS.includes(c.part ?? 'all')) throw new Error(t('Unknown address part “{value}”', { value: c.part }));
  const match = `:${c.match ?? 'is'}`;
  switch (c.kind) {
    case 'address':
      return `address ${c.part && c.part !== 'all' ? `:${c.part} ` : ''}${match} ${quoteSieve(c.header)} ${quoteSieve(c.value)}`;
    case 'header':
      return `header ${match} ${quoteSieve(c.header)} ${quoteSieve(c.value)}`;
    case 'exists':
      return `exists ${quoteSieve(c.header)}`;
    default:
      throw new Error(t('Unknown condition “{value}”', { value: c.kind }));
  }
}

export function actionsToSieve(actions, indent = '    ') {
  const a = normaliseActions(actions);
  const lines = [];
  // Proton applies flags when fileinto runs, so they go first
  if (a.seen) lines.push('addflag "\\\\Seen";');
  if (a.flagged) lines.push('addflag "\\\\Flagged";');
  if (a.expireDays !== null && !(Number.isInteger(a.expireDays) && a.expireDays > 0)) throw new Error(t('Invalid number of days “{value}”', { value: actions.expireDays }));
  if (a.expireDays) lines.push(`expire "day" "${a.expireDays}";`);
  if (a.fileinto) lines.push(`fileinto ${quoteSieve(a.fileinto)};`);
  if (a.stop) lines.push('stop;');
  return lines.map((l) => indent + l).join('\n');
}

/** For OR rules, conditions of the same form share one test with a key list: ["a.de", "b.de"]. */
function groupConditions(conditions) {
  const groups = new Map();
  for (const c of conditions) {
    const key = c.kind === 'exists' ? `exists:${c.header}` : `${c.kind}:${c.header}:${c.part ?? 'all'}:${c.match ?? 'is'}`;
    if (!groups.has(key)) groups.set(key, { ...c, values: [] });
    if (c.kind !== 'exists') groups.get(key).values.push(c.value);
  }
  return [...groups.values()].map((g) => {
    if (g.kind === 'exists' || g.values.length === 1) return conditionToSieve({ ...g, value: g.values[0] });
    const single = conditionToSieve({ ...g, value: '\u0000' });
    return single.replace(quoteSieve('\u0000'), `[${g.values.map(quoteSieve).join(', ')}]`);
  });
}

export function ruleToSieve({ conditions, combine = 'anyof', actions }) {
  if (combine !== 'anyof' && combine !== 'allof') throw new Error(t('Unknown combination “{value}”', { value: combine }));
  const tests = combine === 'allof' ? conditions.map(conditionToSieve) : groupConditions(conditions);
  const test = tests.length === 1 ? tests[0] : `${combine}(\n    ${tests.join(',\n    ')}\n)`;
  return `if ${test} {\n${actionsToSieve(actions)}\n}`;
}

export function describeRule({ conditions, actions }) {
  const what = conditions
    .map((c) => {
      if (c.kind === 'exists') return t('Header “{header}” present', { header: c.header });
      const part = c.kind === 'address' ? { domain: t('Domain'), localpart: t('Name before @'), all: t('Address') }[c.part ?? 'all'] : t('Header');
      return t('{part} {header} {match} “{value}”', { part, header: c.header, match: { is: t('is'), contains: t('contains'), matches: t('matches') }[c.match ?? 'is'], value: c.value });
    })
    .join(t(' or '));
  const a = normaliseActions(actions);
  const todo = [
    a.fileinto && t('to “{folder}”', { folder: a.fileinto }),
    a.seen && t('mark as read'),
    a.flagged && t('with star'),
    a.expireDays && t('delete after {days} days', { days: a.expireDays }),
    a.stop && t('then stop'),
  ].filter(Boolean);
  return `${what} → ${todo.join(', ') || t('no action')}`;
}

/** Patch adding `value` to a string or string list argument, following the list's own layout. */
function appendKeyPatch(text, arg, value) {
  if (arg.type === 'string') {
    return { start: arg.start, end: arg.end, text: `[${text.slice(arg.start, arg.end)}, ${quoteSieve(value)}]` };
  }
  const last = arg.items[arg.items.length - 1];
  const listText = text.slice(arg.start, arg.end);
  // a list kept in alphabetical order gets the value at its place
  const order = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true }).compare;
  // hand-kept lists are rarely perfect: mostly ascending counts as sorted
  const pairs = arg.items.slice(1).map((item, i) => order(arg.items[i].value, item.value) <= 0);
  const sorted = pairs.length > 1 && pairs.filter(Boolean).length >= pairs.length * 0.75;
  const next = sorted && arg.items.find((item, i) => order(value, item.value) < 0 && (i === 0 || order(arg.items[i - 1].value, value) <= 0));
  if (next) {
    const gap = listText.includes('\n') ? `,\n${indentOf(text, next.start)}` : ', ';
    return { start: next.start, end: next.start, text: quoteSieve(value) + gap };
  }
  if (listText.includes('\n')) {
    const lineStart = text.lastIndexOf('\n', last.start) + 1;
    const indent = text.slice(lineStart, last.start).match(/^\s*/)[0];
    return { start: last.end, end: last.end, text: `,\n${indent}${quoteSieve(value)}` };
  }
  return { start: last.end, end: last.end, text: `, ${quoteSieve(value)}` };
}

function indentOf(text, offset) {
  const lineStart = text.lastIndexOf('\n', offset - 1) + 1;
  return text.slice(lineStart, offset).match(/^\s*/)[0];
}

// ---------- Proposals ----------

/**
 * Finds where a rule fits into the given scripts.
 * @param {Array<{id: string, name: string, sieve: string}>} scripts
 * @param {{conditions: object[], combine?: 'anyof'|'allof', actions: object}} rule
 * @returns {{covered: object[], conflicts: object[], proposals: object[]}}
 *   proposals are sorted best first: {scriptId, scriptName, kind, score, description, line, sieve}
 */
export function proposeRule(scripts, rule) {
  const proposals = [];
  const covered = [];
  const conflicts = [];
  const single = rule.conditions.length === 1 ? rule.conditions[0] : null;

  for (const script of scripts) {
    let ast;
    try {
      ast = parseSieve(script.sieve);
    } catch {
      continue; // unparsable scripts are never patched
    }
    const text = script.sieve;
    const push = (kind, score, patch, node, description) => {
      proposals.push({
        scriptId: script.id,
        scriptName: script.name,
        kind,
        score,
        description,
        line: lineOf(text, node.start),
        sieve: sameLineEndings(text, fixRequire(applyPatches(text, [patch]))),
      });
    };

    for (const { command, depth } of walkCommands(ast.commands)) {
      if (!['if', 'elsif'].includes(command.name) || !command.test || !command.block) continue;
      // only a top-level if decides on its own: inside another block or as elsif the new value
      // would also depend on the conditions around it
      // fileinto :copy keeps the mail in the inbox too, :flags sets other flags: not the plain action
      const tagged = command.block.commands.some((c) => c.args.some((a) => a.type === 'tag' && (a.value === ':copy' || a.value === ':flags')));
      const mergeable = depth === 0 && command.name === 'if' && !tagged;
      const actions = describeActions(command.block);
      const topTests = command.test.name === 'anyof' ? command.test.tests : [command.test];
      const descs = topTests.map(describeTest);

      // conflicts / coverage: the same value already decides somewhere
      if (single && single.kind !== 'exists') {
        for (const d of descs) {
          if (d && sameForm(d, single) && keyCovered(d, single.value)) {
            const entry = { scriptId: script.id, scriptName: script.name, line: lineOf(text, d.test.start) };
            const same = actions && sameEffect(actions, rule.actions);
            // nested, as elsif or with :copy the value does not decide on its own: neither covered nor a conflict
            if (same && mergeable) covered.push(entry);
            else if (!same) conflicts.push({ ...entry, message: t('“{value}” is already handled differently here', { value: single.value }) });
          }
        }
      }

      if (!mergeable || !single || !actions || !sameEffect(actions, rule.actions) || command.test.name === 'allof' || command.test.name === 'not') continue;
      // a rule that matches exactly, stop included, wins over one that differs only in stop
      const penalty = sameActions(actions, rule.actions) ? 0 : 1;

      const target = descs.find((d) => d && sameForm(d, single));
      if (target) {
        if (keyCovered(target, single.value)) continue;
        push(
          command.test.name === 'anyof' ? 'append-key-anyof' : 'append-key',
          (command.test.name === 'anyof' ? 90 : 100) - penalty,
          appendKeyPatch(text, target.keysArg, single.value),
          target.test,
          penalty ? t('Add “{value}” to the existing list (it ends with stop)', { value: single.value }) : t('Add “{value}” to the existing list', { value: single.value }),
        );
      } else if (command.test.name === 'anyof') {
        const lastTest = command.test.tests[command.test.tests.length - 1];
        const multiline = text.slice(command.test.start, command.test.end).includes('\n');
        const sep = multiline ? `,\n${indentOf(text, lastTest.start)}` : ', ';
        push('extend-anyof', 70 - penalty, { start: lastTest.end, end: lastTest.end, text: sep + conditionToSieve(single) }, command.test, t('Add condition to the existing anyof(…)'));
      } else if (descs[0]) {
        const inner = `${indentOf(text, command.start)}    `;
        const original = text.slice(command.test.start, command.test.end);
        push(
          'wrap-anyof',
          60 - penalty,
          { start: command.test.start, end: command.test.end, text: `anyof(\n${inner}${original},\n${inner}${conditionToSieve(single)}\n${indentOf(text, command.start)})` },
          command.test,
          t('Extend the existing rule with the same action to anyof(…)'),
        );
      }
    }

    // always possible: a new block at the end of this script
    const trimmedEnd = text.replace(/\s+$/, '').length;
    push(
      'new-block',
      10,
      { start: trimmedEnd, end: text.length, text: `\n\n${ruleToSieve(rule)}\n` },
      { start: trimmedEnd },
      t('Append as a new block at the end'),
    );
  }

  proposals.sort((a, b) => b.score - a.score);
  return { covered, conflicts, proposals };
}

const singleIf = (code) => {
  try {
    const { commands } = parseSieve(code);
    return commands.length === 1 && commands[0].name === 'if' && code.trimStart().startsWith('if');
  } catch {
    return false;
  }
};

/**
 * Inserts a finished block at `at` ({offset, sep} from sectionInsertPoint) or, without `at`, at the end.
 * A `heading` starts a new section with that title. Returns the script and the line the block starts on.
 */
export function insertBlock(sieve, code, at = null, heading = '') {
  // a title is one comment line: a line break would turn the rest into live Sieve code
  const title = String(heading ?? '').replace(/[\r\n]+/g, ' ').trim();
  const head = title ? `# ===== ${title} =====\n` : '';
  // inside an if/elsif chain the block continues the chain; anything but a single if block would break it
  if (at?.elsif && !title) {
    if (singleIf(code)) code = code.replace(/^if\b/, 'elsif');
    else at = null;
  }
  const before = at ? sieve.slice(0, at.offset) + at.sep : `${sieve.replace(/\s+$/, '')}\n\n`;
  const raw = `${before}${head}${code}${at ? sieve.slice(at.offset) : '\n'}`;
  const fixed = fixRequire(raw);
  // fixRequire only changes the require at the top, so everything after it moves by the same amount
  // placed: false when the block went to the end instead of `at`
  return { sieve: sameLineEndings(sieve, fixed), line: lineOf(fixed, before.length + head.length + fixed.length - raw.length), placed: Boolean(at) };
}

/**
 * Merges a (possibly multi-condition, anyof) rule into one script: each condition goes into the best
 * matching existing block; whatever does not fit becomes one new block at the end, or where `options.place` says.
 * @param {object} [options]
 * @param {(sieve: string) => ({offset: number, sep: string}|null)} [options.place]  where a new block goes
 *   in the (already merged) text, see sectionInsertPoint; null = end of the script
 * @param {(sieve: string, line: number) => boolean} [options.within]  only merge into blocks it accepts
 * @param {string} [options.heading]  put everything into a new section with this title
 * @returns {{sieve: string, steps: Array<{condition: object, kind: string, line?: number}>}}
 */
export function mergeRuleIntoScript(script, rule, options = {}) {
  const { place = null, within = null, heading = '' } = options;
  const insert = (sieve, code) => insertBlock(sieve, code, place?.(sieve) ?? null, heading);
  if ((rule.combine === 'allof' && rule.conditions.length > 1) || heading) {
    const placed = insert(script.sieve, ruleToSieve(rule));
    const steps = rule.combine === 'allof' && rule.conditions.length > 1 ? [{ condition: null, kind: 'new-block' }] : rule.conditions.map((condition) => ({ condition, kind: 'new-block' }));
    return { sieve: placed.sieve, steps: steps.map((st) => ({ ...st, line: placed.line })) };
  }
  let sieve = script.sieve;
  const steps = [];
  const rest = [];
  const inRange = (line) => !within || within(sieve, line);
  for (const condition of rule.conditions) {
    const single = { conditions: [condition], actions: rule.actions };
    const { covered, proposals } = proposeRule([{ ...script, sieve }], single);
    if (covered.length) {
      steps.push({ condition, kind: 'covered', line: covered[0].line });
      continue;
    }
    const best = proposals.find((p) => p.kind !== 'new-block' && inRange(p.line));
    if (best) {
      sieve = best.sieve;
      steps.push({ condition, kind: best.kind, line: best.line });
    } else {
      rest.push(condition);
    }
  }
  if (rest.length) {
    const restRule = { ...rule, conditions: rest };
    let line;
    ({ sieve, line } = insert(sieve, ruleToSieve(restRule)));
    for (const condition of rest) steps.push({ condition, kind: 'new-block', line });
  }
  return { sieve, steps };
}

/**
 * Inserts the rule as a new block right before the top-level command that starts on `line`
 * (used when an earlier block would otherwise catch the mail first, e.g. with `stop`).
 */
export function insertRuleBefore(sieve, line, rule, { stop = false } = {}) {
  const ast = parseSieve(sieve);
  const command = ast.commands.find((c) => lineOf(sieve, c.start) === line);
  if (!command) throw new Error(t('No block starts at line {line}', { line }));
  const indent = indentOf(sieve, command.start);
  const placed = stop ? { ...rule, actions: { ...rule.actions, stop: true } } : rule;
  const block = ruleToSieve(placed).replace(/\n/g, `\n${indent}`);
  return sameLineEndings(sieve, fixRequire(`${sieve.slice(0, command.start)}${block}\n\n${indent}${sieve.slice(command.start)}`));
}

/** Whether a simulation result shows the rule's actions took effect. */
export function ruleReached(result, actions) {
  const a = normaliseActions(actions);
  // rfc results carry copies: folder names are exact there, on Proton they ignore case
  const same = result.copies ? (x) => x === a.fileinto : (x) => x?.toLowerCase() === a.fileinto.toLowerCase();
  const folders = result.folders ?? [result.folder];
  if (a.fileinto && !folders.some(same) && !same(result.folder) && !result.labels.some(same)) return false;
  // each rfc copy has its own flags: the rule's flags count on the copy it stores
  const flags = result.copies?.find((c) => c.folder === (a.fileinto ?? 'INBOX'))?.flags ?? result.flags;
  if (a.seen && !flags.includes('\\Seen')) return false;
  if (a.flagged && !flags.includes('\\Flagged')) return false;
  if (a.expireDays && result.expireDays !== a.expireDays) return false;
  return true;
}

/**
 * Values that appear in more than one block of a script: the same exact value twice (duplicate, or a
 * conflict when the blocks act differently) and addresses already caught by a domain rule elsewhere.
 * Only exact (`:is`) address/header tests are compared.
 * @returns {Array<{kind: 'duplicate'|'conflict'|'domain', value: string, start: number, end: number, line: number, otherLine: number}>}
 */
export function findOverlaps(sieve) {
  let ast;
  try {
    ast = parseSieve(sieve);
  } catch {
    return [];
  }
  const seen = new Map();
  const entries = [];
  for (const { command } of walkCommands(ast.commands)) {
    if (!['if', 'elsif'].includes(command.name) || !command.test || !command.block) continue;
    const actions = describeActions(command.block);
    const tests = command.test.name === 'anyof' ? command.test.tests : command.test.name === 'not' || command.test.name === 'allof' ? [] : [command.test];
    for (const desc of tests.map(describeTest)) {
      if (!desc || desc.kind === 'exists' || desc.match !== 'is' || desc.headers.length !== 1) continue;
      const items = desc.keysArg.type === 'list' ? desc.keysArg.items : [desc.keysArg];
      for (const item of items) {
        const key = `${desc.kind}:${desc.headers[0]}:${desc.part}:${item.value.toLowerCase()}`;
        const entry = { key, desc, item, actions, block: command.start, line: lineOf(sieve, item.start) };
        entries.push(entry);
        if (!seen.has(key)) seen.set(key, entry);
      }
    }
  }
  const differs = (a, b) => !a.actions || !b.actions || !sameActions(a.actions, b.actions);
  const result = [];
  for (const e of entries) {
    const first = seen.get(e.key);
    if (first !== e && first.block !== e.block) {
      result.push({ kind: differs(first, e) ? 'conflict' : 'duplicate', value: e.item.value, start: e.item.start, end: e.item.end, line: e.line, otherLine: first.line });
      continue;
    }
    if (e.desc.kind === 'address' && e.desc.part === 'all' && e.item.value.includes('@')) {
      const domain = seen.get(`address:${e.desc.headers[0]}:domain:${e.item.value.split('@').pop().toLowerCase()}`);
      if (domain && domain.block !== e.block && !differs(domain, e)) {
        result.push({ kind: 'domain', value: e.item.value, start: e.item.start, end: e.item.end, line: e.line, otherLine: domain.line });
      }
    }
  }
  return result;
}
