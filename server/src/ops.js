// Operations of the service. Each takes (account, args) and returns plain JSON; used by the MCP tools
// and the REST API alike, so both always behave the same.

import { diffHunks, diffStats, lineDiff } from '../../addon/lib/diff.js';
import { parseHeaderBlock, suggestConditions } from '../../addon/lib/mail.js';
import { planRule as planRuleCore } from '../../addon/lib/rule-planner.js';
import { fixRequire, lintSieve as lintCore } from '../../addon/lib/sieve-analyzer.js';
import { formatSieve as formatCore, lineOf } from '../../addon/lib/sieve-ast.js';
import { describeRule } from '../../addon/lib/sieve-rules.js';
import { simulate as simulateCore } from '../../addon/lib/sieve-sim.js';
import { newScript } from '../../addon/lib/sieve-dialect.js';
import { RULE_TEMPLATES, buildTemplate as buildTemplateCore, templateDefaults } from '../../addon/lib/sieve-templates.js';

// ---------- helpers ----------

export function unifiedDiff(before, after) {
  const diff = lineDiff(before, after);
  const text = diffHunks(diff, 2)
    .map((hunk) => hunk.map((d) => `${d.type === 'add' ? '+' : d.type === 'del' ? '-' : ' '} ${d.text}`).join('\n'))
    .join('\n@@\n');
  return { ...diffStats(diff), text };
}

function toMessage(headers, size) {
  if (!headers) return null;
  if (typeof headers === 'string') return { headers: parseHeaderBlock(headers), size };
  const normalized = {};
  for (const [k, v] of Object.entries(headers)) normalized[k.toLowerCase()] = Array.isArray(v) ? v : [v];
  return { headers: normalized, size };
}

function withLines(text, issues) {
  return issues.map((i) => ({ line: lineOf(text, i.start), severity: i.severity, message: i.message }));
}

const filterSummary = (f, includeSieve) => ({
  id: f.ID,
  name: f.Name,
  enabled: f.Status === 1,
  ...(includeSieve ? { sieve: f.Sieve } : {}),
});

function planToJson(result) {
  const { plan, after, notes, conflicts, errors } = result;
  return {
    target: plan.targetId ? { id: plan.targetId, name: plan.name } : { id: null, name: plan.name, newFilter: true },
    steps: plan.steps.map((s) => ({ kind: s.kind, line: s.line ?? null, condition: s.condition })),
    notes,
    conflicts,
    errors: withLines(plan.sieve, errors),
    diff: unifiedDiff(plan.before, plan.sieve),
    result: after ? { location: after.location, labels: after.labels, flags: after.flags, expireDays: after.expireDays } : null,
    sieve: plan.sieve,
  };
}

// ---------- read ----------

export const status = (account) => account.status();

export async function listFilters(account, { includeSieve = false } = {}) {
  const data = await account.data();
  return { filters: data.filters.map((f) => filterSummary(f, includeSieve)) };
}

export async function getFilter(account, { id }) {
  const data = await account.data();
  const f = data.filters.find((x) => x.ID === id);
  if (!f) throw new Error(`Filter ${id} nicht gefunden`);
  return { ...filterSummary(f, true), issues: withLines(f.Sieve, lintCore(f.Sieve, { folders: [...data.folders, ...data.labels] })) };
}

export async function listFolders(account) {
  const { folders, labels } = await account.data();
  return { folders, labels, system: ['inbox', 'archive', 'trash', 'spam', 'starred'] };
}

export async function lintSieve(account, { sieve }) {
  let known;
  try {
    const data = account.client.isLoggedIn ? await account.data() : null;
    known = data ? [...data.folders, ...data.labels] : undefined;
  } catch {
    known = undefined;
  }
  return { issues: withLines(sieve, lintCore(sieve, { folders: known })), fixedRequire: fixRequire(sieve) !== sieve ? fixRequire(sieve) : null };
}

export async function checkSieve(account, { sieve }) {
  account.requireLogin();
  return { issues: await account.client.checkSieve(sieve) };
}

export const formatSieve = (_account, { sieve }) => ({ sieve: formatCore(sieve) });

export async function simulateMessage(account, { headers, size, spamScore, overrides = [] }) {
  const data = await account.data();
  const scripts = account.scripts(data).map((s) => {
    const o = overrides.find((x) => x.id === s.id);
    return o ? { ...s, sieve: o.sieve } : s;
  });
  const r = simulateCore(scripts, toMessage(headers, size), { labels: data.labels, spamScore });
  return { ...r, fired: r.fired.filter((f) => !f.test.includes('vnd.proton.spam-threshold')) };
}

export function suggestRule(_account, { headers }) {
  return { suggestions: suggestConditions(toMessage(headers)) };
}

export const listTemplates = () => ({
  templates: RULE_TEMPLATES.map((t) => ({
    id: t.id,
    category: t.category,
    name: t.name,
    description: t.description,
    mergeable: !t.code,
    params: t.params.map((p) => ({ id: p.id, label: p.label, type: p.type, default: p.default })),
  })),
});

// ---------- planning ----------

export async function planRule(account, { rule, target = 'auto', newName, headers, size }) {
  const data = await account.data();
  const result = planRuleCore({
    scripts: account.scripts(data),
    rule,
    target,
    newName,
    message: toMessage(headers, size) ?? undefined,
    labels: data.labels,
  });
  return { description: describeRule(rule), ...planToJson(result) };
}

export async function buildTemplate(account, { templateId, params = {}, target = 'auto', newName }) {
  const template = RULE_TEMPLATES.find((t) => t.id === templateId);
  if (!template) throw new Error(`Vorlage ${templateId} nicht gefunden – siehe list_templates`);
  const built = buildTemplateCore(template, { ...templateDefaults(template), ...params });
  if (built.rule) return { rule: built.rule, ...(await planRule(account, { rule: built.rule, target, newName })) };

  // finished snippets are appended to the chosen (or first) filter, or become a new filter
  const data = await account.data();
  const filter = target === 'new' ? null : data.filters.find((f) => f.ID === target) ?? (target === 'auto' ? data.filters[0] : null);
  const before = filter?.Sieve ?? '';
  const base = filter ? before.replace(/\s+$/, '') : newScript().replace(/\s+$/, '');
  const sieve = fixRequire(`${base}\n\n${built.code}\n`);
  return {
    target: filter ? { id: filter.ID, name: filter.Name } : { id: null, name: newName || template.name, newFilter: true },
    steps: [{ kind: 'new-block' }],
    notes: [],
    conflicts: [],
    errors: withLines(sieve, lintCore(sieve).filter((i) => i.severity === 'error')),
    diff: unifiedDiff(before, sieve),
    result: null,
    sieve,
  };
}

// ---------- write ----------

async function savePlanned(account, planned) {
  if (planned.errors.length) throw new Error(`Das Skript hat Fehler: ${planned.errors.map((e) => `Zeile ${e.line}: ${e.message}`).join('; ')}`);
  if (planned.diff.added === 0 && planned.diff.removed === 0) return { saved: false, reason: 'Keine Änderung nötig – die Regel ist schon vorhanden', ...planned };
  return account.write(async () => {
    await account.checkOrThrow(planned.sieve);
    if (planned.target.id) {
      const data = await account.data({ fresh: true });
      const filter = data.filters.find((f) => f.ID === planned.target.id);
      if (!filter) throw new Error('Der Zielfilter existiert nicht mehr');
      await account.client.updateFilter(filter.ID, { Name: filter.Name, Sieve: planned.sieve, Status: filter.Status });
      return { saved: true, ...planned };
    }
    const created = await account.client.createFilter({ Name: planned.target.name, Sieve: planned.sieve, Status: 1 });
    return { saved: true, ...planned, target: { id: created?.ID ?? null, name: planned.target.name } };
  });
}

export async function applyRule(account, args) {
  account.requireWrite();
  return savePlanned(account, await planRule(account, args));
}

export async function applyTemplate(account, args) {
  account.requireWrite();
  return savePlanned(account, await buildTemplate(account, args));
}

export async function createFilter(account, { name, sieve, enabled = true }) {
  return account.write(async () => {
    await account.checkOrThrow(sieve);
    const created = await account.client.createFilter({ Name: name, Sieve: sieve, Status: enabled ? 1 : 0 });
    return { id: created?.ID ?? null, name };
  });
}

export async function updateFilter(account, { id, name, sieve, enabled }) {
  return account.write(async () => {
    const data = await account.data({ fresh: true });
    const filter = data.filters.find((f) => f.ID === id);
    if (!filter) throw new Error(`Filter ${id} nicht gefunden`);
    const next = { Name: name ?? filter.Name, Sieve: sieve ?? filter.Sieve, Status: enabled === undefined ? filter.Status : enabled ? 1 : 0 };
    if (sieve !== undefined) await account.checkOrThrow(next.Sieve);
    await account.client.updateFilter(id, next);
    return { id, name: next.Name, enabled: next.Status === 1, diff: unifiedDiff(filter.Sieve, next.Sieve) };
  });
}

export async function deleteFilter(account, { id }) {
  return account.write(async () => {
    await account.client.deleteFilter(id);
    return { deleted: id };
  });
}

export async function setFilterEnabled(account, { id, enabled }) {
  return account.write(async () => {
    await account.client.setFilterEnabled(id, enabled);
    return { id, enabled };
  });
}

export async function reorderFilters(account, { ids }) {
  return account.write(async () => {
    await account.client.reorderFilters(ids);
    return { order: ids };
  });
}
