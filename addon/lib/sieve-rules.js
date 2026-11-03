// Structured rules on top of the AST: describe a rule as conditions + actions, find where it fits into
// existing scripts (append a key to a matching block, extend an anyof, ...) and produce minimal patches.

import { fixRequire } from './sieve-analyzer.js';
import { applyPatches, lineOf, parseSieve, quoteSieve, walkCommands } from './sieve-ast.js';

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

const sameActions = (a, b) => JSON.stringify(normaliseActions(a)) === JSON.stringify(normaliseActions(b));

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

export function conditionToSieve(c) {
  const match = `:${c.match ?? 'is'}`;
  switch (c.kind) {
    case 'address':
      return `address ${c.part && c.part !== 'all' ? `:${c.part} ` : ''}${match} ${quoteSieve(c.header)} ${quoteSieve(c.value)}`;
    case 'header':
      return `header ${match} ${quoteSieve(c.header)} ${quoteSieve(c.value)}`;
    case 'exists':
      return `exists ${quoteSieve(c.header)}`;
    default:
      throw new Error(`Unbekannte Bedingung ${c.kind}`);
  }
}

export function actionsToSieve(actions, indent = '    ') {
  const a = normaliseActions(actions);
  const lines = [];
  // Proton applies flags when fileinto runs, so they go first
  if (a.seen) lines.push('addflag "\\\\Seen";');
  if (a.flagged) lines.push('addflag "\\\\Flagged";');
  if (a.expireDays) lines.push(`expire "day" "${a.expireDays}";`);
  if (a.fileinto) lines.push(`fileinto ${quoteSieve(a.fileinto)};`);
  if (a.stop) lines.push('stop;');
  return lines.map((l) => indent + l).join('\n');
}

export function ruleToSieve({ conditions, combine = 'anyof', actions }) {
  const tests = conditions.map(conditionToSieve);
  const test = tests.length === 1 ? tests[0] : `${combine}(\n    ${tests.join(',\n    ')}\n)`;
  return `if ${test} {\n${actionsToSieve(actions)}\n}`;
}

export function describeRule({ conditions, actions }) {
  const what = conditions
    .map((c) => {
      if (c.kind === 'exists') return `Header „${c.header}“ vorhanden`;
      const part = c.kind === 'address' ? { domain: 'Domain', localpart: 'Name vor @', all: 'Adresse' }[c.part ?? 'all'] : 'Header';
      return `${part} ${c.header} ${{ is: 'ist', contains: 'enthält', matches: 'passt auf' }[c.match ?? 'is']} „${c.value}“`;
    })
    .join(' oder ');
  const a = normaliseActions(actions);
  const todo = [
    a.fileinto && `nach „${a.fileinto}“`,
    a.seen && 'als gelesen',
    a.flagged && 'mit Stern',
    a.expireDays && `nach ${a.expireDays} Tagen löschen`,
    a.stop && 'danach stoppen',
  ].filter(Boolean);
  return `${what} → ${todo.join(', ') || 'keine Aktion'}`;
}

/** Patch adding `value` to a string or string list argument, following the list's own layout. */
function appendKeyPatch(text, arg, value) {
  if (arg.type === 'string') {
    return { start: arg.start, end: arg.end, text: `[${text.slice(arg.start, arg.end)}, ${quoteSieve(value)}]` };
  }
  const last = arg.items[arg.items.length - 1];
  const listText = text.slice(arg.start, arg.end);
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
        sieve: fixRequire(applyPatches(text, [patch])),
      });
    };

    for (const { command } of walkCommands(ast.commands)) {
      if (!['if', 'elsif'].includes(command.name) || !command.test || !command.block) continue;
      const actions = describeActions(command.block);
      const topTests = command.test.name === 'anyof' ? command.test.tests : [command.test];
      const descs = topTests.map(describeTest);

      // conflicts / coverage: the same value already decides somewhere
      if (single && single.kind !== 'exists') {
        for (const d of descs) {
          if (d && sameForm(d, single) && keyCovered(d, single.value)) {
            const entry = { scriptId: script.id, scriptName: script.name, line: lineOf(text, d.test.start) };
            if (actions && sameActions(actions, rule.actions)) covered.push(entry);
            else conflicts.push({ ...entry, message: `„${single.value}“ wird hier bereits anders behandelt` });
          }
        }
      }

      if (!single || !actions || !sameActions(actions, rule.actions) || command.test.name === 'allof' || command.test.name === 'not') continue;

      const target = descs.find((d) => d && sameForm(d, single));
      if (target) {
        if (keyCovered(target, single.value)) continue;
        push(
          command.test.name === 'anyof' ? 'append-key-anyof' : 'append-key',
          command.test.name === 'anyof' ? 90 : 100,
          appendKeyPatch(text, target.keysArg, single.value),
          target.test,
          `„${single.value}“ zur bestehenden Liste hinzufügen`,
        );
      } else if (command.test.name === 'anyof') {
        const lastTest = command.test.tests[command.test.tests.length - 1];
        const multiline = text.slice(command.test.start, command.test.end).includes('\n');
        const sep = multiline ? `,\n${indentOf(text, lastTest.start)}` : ', ';
        push('extend-anyof', 70, { start: lastTest.end, end: lastTest.end, text: sep + conditionToSieve(single) }, command.test, 'Bedingung zum bestehenden anyof(…) hinzufügen');
      } else if (descs[0]) {
        const inner = `${indentOf(text, command.start)}    `;
        const original = text.slice(command.test.start, command.test.end);
        push(
          'wrap-anyof',
          60,
          { start: command.test.start, end: command.test.end, text: `anyof(\n${inner}${original},\n${inner}${conditionToSieve(single)}\n${indentOf(text, command.start)})` },
          command.test,
          'Bestehende Regel mit gleicher Aktion zu anyof(…) erweitern',
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
      'Als neuen Block am Ende anhängen',
    );
  }

  proposals.sort((a, b) => b.score - a.score);
  return { covered, conflicts, proposals };
}

/**
 * Merges a (possibly multi-condition, anyof) rule into one script: each condition goes into the best
 * matching existing block; whatever does not fit becomes one new block at the end.
 * @returns {{sieve: string, steps: Array<{condition: object, kind: string, line?: number}>}}
 */
export function mergeRuleIntoScript(script, rule) {
  if (rule.combine === 'allof' && rule.conditions.length > 1) {
    const { proposals } = proposeRule([script], rule);
    return { sieve: proposals[0].sieve, steps: [{ condition: null, kind: 'new-block' }] };
  }
  let sieve = script.sieve;
  const steps = [];
  const rest = [];
  for (const condition of rule.conditions) {
    const single = { conditions: [condition], actions: rule.actions };
    const { covered, proposals } = proposeRule([{ ...script, sieve }], single);
    if (covered.length) {
      steps.push({ condition, kind: 'covered', line: covered[0].line });
      continue;
    }
    const best = proposals[0];
    if (best && best.kind !== 'new-block') {
      sieve = best.sieve;
      steps.push({ condition, kind: best.kind, line: best.line });
    } else {
      rest.push(condition);
    }
  }
  if (rest.length) {
    const { proposals } = proposeRule([{ ...script, sieve }], { ...rule, conditions: rest });
    const block = proposals.find((p) => p.kind === 'new-block');
    sieve = block.sieve;
    for (const condition of rest) steps.push({ condition, kind: 'new-block', line: block.line });
  }
  return { sieve, steps };
}
