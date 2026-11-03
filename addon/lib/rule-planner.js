// Plans where a rule goes across all filters, verified with the simulator when a sample message is given.
// Shared by the Thunderbird "rule from mail" window and the MCP server.

import { fixRequire, lintSieve } from './sieve-analyzer.js';
import { newScript } from './sieve-dialect.js';
import { insertRuleBefore, mergeRuleIntoScript, proposeRule, ruleReached, ruleToSieve } from './sieve-rules.js';
import { simulate } from './sieve-sim.js';

const GUARD = 'vnd.proton.spam-threshold';

function planForScript(script, rule) {
  const merged = mergeRuleIntoScript(script, rule);
  const merges = merged.steps.filter((s) => s.kind !== 'new-block' && s.kind !== 'covered').length;
  const covered = merged.steps.filter((s) => s.kind === 'covered').length;
  const sameFolder = rule.actions.fileinto && script.sieve.includes(`fileinto "${rule.actions.fileinto}"`) ? 1 : 0;
  return {
    targetId: script.id,
    name: script.name,
    before: script.sieve,
    sieve: merged.sieve,
    steps: merged.steps,
    score: merges * 10 + covered * 5 + sameFolder * 2 + (script.enabled === false ? 0 : 1),
  };
}

const defaultName = (rule) => (rule.actions.fileinto ? `→ ${rule.actions.fileinto}` : 'Neue Regel');

/**
 * @param {object} p
 * @param {Array<{id: string, name: string, sieve: string, enabled?: boolean}>} p.scripts  filters in Proton order
 * @param {{conditions: object[], combine?: string, actions: object}} p.rule
 * @param {'auto'|'new'|string} [p.target='auto']  a filter id, 'auto' (best place) or 'new' (new filter)
 * @param {string} [p.newName]
 * @param {import('./mail.js').SieveMessage} [p.message]  sample mail to verify the result with
 * @param {string[]} [p.labels]
 * @returns {{plan: object, after: object|null, notes: string[], conflicts: object[], errors: object[]}}
 */
export function planRule({ scripts, rule, target = 'auto', newName, message, labels = [] }) {
  if (!rule.conditions?.length) throw new Error('Mindestens eine Bedingung angeben');
  let plan;
  if (target === 'new' || !scripts.length) {
    plan = {
      targetId: null,
      name: newName?.trim() || defaultName(rule),
      before: '',
      sieve: fixRequire(`${newScript()}\n${ruleToSieve(rule)}\n`),
      steps: rule.conditions.map((condition) => ({ condition, kind: 'new-block' })),
    };
  } else if (target !== 'auto') {
    const script = scripts.find((s) => s.id === target);
    if (!script) throw new Error(`Filter ${target} nicht gefunden`);
    plan = planForScript(script, rule);
  } else {
    plan = scripts.map((s) => planForScript(s, rule)).sort((a, b) => b.score - a.score)[0];
  }

  const notes = [];
  let after = null;
  if (message) {
    const run = (p) => {
      const all = scripts.map((s) => (s.id === p.targetId ? { ...s, sieve: p.sieve } : s));
      if (!p.targetId) all.push({ id: 'new', name: p.name, sieve: p.sieve, enabled: true });
      return simulate(all, message, { labels });
    };
    after = run(plan);
    if (!ruleReached(after, rule.actions)) {
      const fix = placeBeforeBlocker(plan, rule, after, run);
      if (fix) {
        plan = fix.plan;
        after = fix.after;
        notes.push(fix.note);
      } else {
        const blocker = after.fired.find((f) => !f.test.includes(GUARD));
        notes.push(
          blocker
            ? `Die Regel greift bei dieser Mail nicht: Filter „${blocker.script}“ (Zeile ${blocker.line}) fängt sie vorher ab. Dort eintragen oder die Filterreihenfolge ändern.`
            : 'Die Regel greift bei dieser Mail nicht – Bedingungen prüfen.',
        );
      }
    }
  }

  const conflicts = rule.conditions.length === 1 ? proposeRule(scripts, rule).conflicts : [];
  const errors = lintSieve(plan.sieve).filter((i) => i.severity === 'error');
  return { plan, after, notes, conflicts, errors };
}

/**
 * When an earlier block of the same filter catches the mail (stop, or a later fileinto that wins),
 * try the rule as a new block right before that block – first as is, then with `stop`.
 */
function placeBeforeBlocker(plan, rule, after, run) {
  const scriptId = plan.targetId ?? 'new';
  const blockers = after.fired.filter((f) => f.scriptId === scriptId && !f.test.includes(GUARD));
  for (const blocker of blockers) {
    for (const stop of [false, true]) {
      try {
        const sieve = insertRuleBefore(plan.before || plan.sieve, blocker.line, rule, { stop });
        const candidate = { ...plan, sieve, steps: rule.conditions.map((condition) => ({ condition, kind: 'new-block', line: blocker.line })) };
        const result = run(candidate);
        if (ruleReached(result, rule.actions)) {
          const note = stop
            ? `Als neuer Block vor Zeile ${blocker.line} eingefügt und mit „stop“ beendet – sonst würde der Block dort die Mail woandershin verschieben.`
            : `Als neuer Block vor Zeile ${blocker.line} eingefügt – der Block dort hätte die Mail sonst vorher abgefangen.`;
          return { plan: candidate, after: result, note };
        }
      } catch {
        // the blocker is nested, not a top-level block
      }
    }
  }
  return null;
}
