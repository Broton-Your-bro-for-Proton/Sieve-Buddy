// Plans where a rule goes across all filters, verified with the simulator when a sample message is given.
// Shared by the Thunderbird "rule from mail" window and the MCP server.

import { t } from './i18n.js';
import { fixRequire, lintSieve } from './sieve-analyzer.js';
import { lineOf, parseSieve } from './sieve-ast.js';
import { PROTON_DIALECT, newScript } from './sieve-dialect.js';
import { insertRuleBefore, mergeRuleIntoScript, proposeRule, ruleReached, ruleToSieve } from './sieve-rules.js';
import { simulate } from './sieve-sim.js';
import { findSections, resolveSection, sectionNote } from './sieve-sections.js';

const GUARD = 'vnd.proton.spam-threshold';

/**
 * Merge options for a section choice: where a new block goes and, for an explicit section, which blocks
 * may be extended. `chosen` reports the section actually used.
 */
function sectionOptions(section, rule, hints) {
  const out = { chosen: null };
  if (section && typeof section === 'object' && section.new) {
    out.heading = String(section.new).replace(/[\r\n]+/g, ' ').trim();
    out.chosen = { title: out.heading, new: true };
    return out;
  }
  if (section === 'end') return out;
  out.place = (sieve) => {
    const r = resolveSection(sieve, section, rule, hints);
    out.chosen = r.section ? { title: r.section.title, line: r.section.line, displaced: r.displaced } : null;
    out.skipped = r.skipped ?? null;
    return r.at;
  };
  if (section && section !== 'auto') {
    out.within = (sieve, line) => {
      const sections = findSections(sieve);
      const i = sections.findIndex((x) => x.title === section || x.index === section);
      if (i === -1) return true;
      return line >= sections[i].line && line < (sections[i + 1]?.line ?? Infinity);
    };
  }
  return out;
}

function planForScript(script, rule, section, hints, separate = false) {
  const options = sectionOptions(section, rule, hints);
  if (separate) options.within = () => false;
  const merged = mergeRuleIntoScript(script, rule, options);
  const merges = merged.steps.filter((s) => s.kind !== 'new-block' && s.kind !== 'covered').length;
  const covered = merged.steps.filter((s) => s.kind === 'covered').length;
  const sameFolder = rule.actions.fileinto && script.sieve.includes(`fileinto "${rule.actions.fileinto}"`) ? 1 : 0;
  const placed = merged.steps.some((s) => s.kind === 'new-block');
  return {
    targetId: script.id,
    name: script.name,
    before: script.sieve,
    sieve: merged.sieve,
    steps: merged.steps,
    section: placed ? options.chosen : null,
    skipped: placed ? options.skipped : null,
    score: merges * 10 + covered * 5 + sameFolder * 2,
  };
}

const defaultName = (rule) => (rule.actions.fileinto ? `→ ${rule.actions.fileinto}` : t('New rule'));

/**
 * @param {object} p
 * @param {Array<{id: string, name: string, sieve: string, enabled?: boolean}>} p.scripts  filters in Proton order
 * @param {{conditions: object[], combine?: string, actions: object}} p.rule
 * @param {'auto'|'new'|string} [p.target='auto']  a filter id, 'auto' (best place) or 'new' (new filter)
 * @param {string} [p.newName]
 * @param {'auto'|'end'|string|{new: string}} [p.section='auto']  section of the target script for a new block:
 *   best match, end of the file, a section title, or a new section with that title
 * @param {string} [p.category]  hint for the automatic section choice (template category)
 * @param {import('./mail.js').SieveMessage} [p.message]  sample mail to verify the result with
 * @param {string[]} [p.labels]
 * @param {object} [p.dialect]  see makeDialect – template for new scripts, simulation semantics, linting
 * @returns {{plan: object, after: object|null, notes: string[], conflicts: object[], errors: object[]}}
 */
export function planRule({ scripts, rule, target = 'auto', newName, section = 'auto', category, message, labels = [], dialect = PROTON_DIALECT }) {
  const hints = { category };
  if (!rule.conditions?.length) throw new Error(t('Specify at least one condition'));
  if (!dialect.proton && rule.actions?.expireDays) throw new Error(t('Automatic deletion (expire) is only available on Proton'));
  if (!dialect.proton && (rule.actions?.seen || rule.actions?.flagged) && !dialect.extensions.has('imap4flags')) {
    throw new Error(t('The server does not offer imap4flags – “mark as read” and “star” will not work'));
  }
  // a disabled filter never runs: the automatic choice must not add the rule there
  const runnable = scripts.filter((s) => s.enabled !== false);
  let plan;
  if (target === 'new' || (target === 'auto' && !runnable.length)) {
    plan = {
      targetId: null,
      name: newName?.trim() || defaultName(rule),
      before: '',
      sieve: fixRequire(`${newScript('', dialect)}\n${ruleToSieve(rule)}\n`),
      steps: rule.conditions.map((condition) => ({ condition, kind: 'new-block' })),
    };
  } else if (target !== 'auto') {
    const script = scripts.find((s) => s.id === target);
    if (!script) throw new Error(t('Filter {id} not found', { id: target }));
    plan = planForScript(script, rule, section, hints);
  } else {
    plan = runnable.map((s) => planForScript(s, rule, section, hints)).sort((a, b) => b.score - a.score)[0];
  }

  const notes = [];
  const note = sectionNote({ skipped: plan.skipped, section: plan.section, displaced: plan.section?.displaced });
  if (note) notes.push(note);
  let after = null;
  if (message) {
    const run = (p) => {
      const all = scripts.map((s) => (s.id === p.targetId ? { ...s, sieve: p.sieve } : s));
      if (!p.targetId) all.push({ id: 'new', name: p.name, sieve: p.sieve, enabled: true });
      return simulate(all, message, { labels, semantics: dialect.proton ? 'proton' : 'rfc' });
    };
    after = run(plan);
    if (!ruleReached(after, rule.actions)) {
      const fix = stopInPlace(plan, rule, after, run, (r) => planForScript(scripts.find((s) => s.id === plan.targetId), r, section, hints, true)) ?? placeBeforeBlocker(plan, rule, after, run);
      if (fix) {
        plan = fix.plan;
        after = fix.after;
        notes.push(fix.note);
      } else {
        // the rule's own new block fires too; name a block that already existed
        const base = plan.before || plan.sieve;
        const blocker = after.fired.find((f) => !f.test.includes(GUARD) && (f.scriptId !== (plan.targetId ?? 'new') || lineInBase(plan.sieve, base, f.line)));
        notes.push(
          blocker
            ? t('The rule does not apply to this message: filter “{name}” (line {line}) catches it first. Add it there or change the filter order.', { name: blocker.script, line: blocker.line })
            : t('The rule does not apply to this message – check the conditions.'),
        );
      }
    }
  }

  const conflicts = rule.conditions.length === 1 ? proposeRule(scripts, rule).conflicts : [];
  const errors = lintSieve(plan.sieve, { dialect }).filter((i) => i.severity === 'error');
  return { plan, after, notes, conflicts, errors };
}

/**
 * Line of the top-level command starting on `line` of `text`, looked up by its code in `base` (the script
 * before the change, where lines may differ). null when it is new or was changed.
 */
function lineInBase(text, base, line) {
  try {
    const command = parseSieve(text).commands.find((c) => lineOf(text, c.start) === line);
    if (!command) return null;
    const at = base.indexOf(text.slice(command.start, command.end));
    return at === -1 ? null : lineOf(base, at);
  } catch {
    return null;
  }
}

/**
 * When a later block moves the mail elsewhere, the rule stays in its section as its own block ending with
 * `stop` (a stop cannot be added to an existing list it would have joined).
 */
function stopInPlace(plan, rule, after, run, replan) {
  if (!plan.targetId || rule.actions.stop) return null;
  // a separate block may already be enough (the list it would have joined sits before the other block)
  if (plan.steps.some((s) => s.kind !== 'new-block')) {
    const separate = replan(rule);
    const result = run(separate);
    if (ruleReached(result, rule.actions)) {
      return { plan: separate, after: result, note: t('Added as a separate block: in the existing list, a later block would move the mail elsewhere.') };
    }
  }
  const candidate = replan({ ...rule, actions: { ...rule.actions, stop: true } });
  const result = run(candidate);
  if (!ruleReached(result, rule.actions)) return null;
  const base = plan.before;
  const ownLine = candidate.steps.find((s) => s.kind === 'new-block')?.line ?? 0;
  const later = after.fired.find((f) => f.scriptId === plan.targetId && !f.test.includes(GUARD) && lineInBase(plan.sieve, base, f.line) && lineInBase(plan.sieve, candidate.sieve, f.line) > ownLine);
  const note = later
    ? t('Ended with “stop” – otherwise the block “{test}” further down would move the message elsewhere afterward.', { test: later.test })
    : t('Ended with “stop” – otherwise a later block would move the message elsewhere afterward.');
  return { plan: candidate, after: result, note };
}

/**
 * When an earlier block of the same filter catches the mail (stop, or a later fileinto that wins),
 * try the rule as a new block right before that block – first as is, then with `stop`.
 */
function placeBeforeBlocker(plan, rule, after, run) {
  const scriptId = plan.targetId ?? 'new';
  const base = plan.before || plan.sieve;
  // blocker lines refer to the planned text; insert into the original one, so map them back by code
  const blockers = after.fired
    .filter((f) => f.scriptId === scriptId && !f.test.includes(GUARD))
    .map((f) => ({ ...f, line: lineInBase(plan.sieve, base, f.line) }))
    .filter((f) => f.line);
  for (const blocker of blockers) {
    for (const stop of [false, true]) {
      try {
        const sieve = insertRuleBefore(base, blocker.line, rule, { stop });
        const candidate = { ...plan, sieve, steps: rule.conditions.map((condition) => ({ condition, kind: 'new-block', line: blocker.line })) };
        const result = run(candidate);
        if (ruleReached(result, rule.actions)) {
          const note = stop
            ? t('Inserted as a new block before line {line} and ended with “stop” – otherwise the block there would move the message elsewhere.', { line: blocker.line })
            : t('Inserted as a new block before line {line} – otherwise the block there would have caught the message first.', { line: blocker.line });
          return { plan: candidate, after: result, note };
        }
      } catch {
        // the blocker is nested, not a top-level block
      }
    }
  }
  return null;
}
