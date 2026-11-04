// Operations of the service. Each takes (account, args) and returns plain JSON; used by the MCP tools
// and the REST API alike, so both always behave the same. Provider-neutral: Proton or any ManageSieve server.

import { diffHunks, diffStats, lineDiff } from '../../addon/lib/diff.js';
import { parseHeaderBlock, suggestConditions } from '../../addon/lib/mail.js';
import { planRule as planRuleCore } from '../../addon/lib/rule-planner.js';
import { fixRequire, lintSieve as lintCore } from '../../addon/lib/sieve-analyzer.js';
import { formatSieve as formatCore, lineOf } from '../../addon/lib/sieve-ast.js';
import { newScript } from '../../addon/lib/sieve-dialect.js';
import { describeRule } from '../../addon/lib/sieve-rules.js';
import { simulate as simulateCore } from '../../addon/lib/sieve-sim.js';
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

const withLines = (text, issues) => issues.map((i) => ({ line: lineOf(text, i.start), severity: i.severity, message: i.message }));
const knownFolders = (data) => (data.folders ? [...data.folders, ...data.labels] : undefined);
const summary = (s, includeSieve) => ({ id: s.id, name: s.name, enabled: s.enabled, ...(includeSieve ? { sieve: s.sieve } : {}) });

function planToJson(result) {
  const { plan, after, notes, conflicts, errors } = result;
  return {
    target: plan.targetId ? { id: plan.targetId, name: plan.name } : { id: null, name: plan.name, newFilter: true },
    steps: plan.steps.map((s) => ({ kind: s.kind, line: s.line ?? null, condition: s.condition })),
    notes,
    conflicts,
    errors: withLines(plan.sieve, errors),
    diff: unifiedDiff(plan.before, plan.sieve),
    result: after
      ? { location: after.location, folders: after.folders, labels: after.labels, flags: after.flags, expireDays: after.expireDays }
      : null,
    sieve: plan.sieve,
  };
}

// ---------- read ----------

export const status = (account) => account.status();

export async function listFilters(account, { includeSieve = false } = {}) {
  const data = await account.data();
  return { provider: account.provider.kind, filters: data.scripts.map((s) => summary(s, includeSieve)) };
}

export async function getFilter(account, { id }) {
  const data = await account.data();
  const s = data.scripts.find((x) => x.id === id);
  if (!s) throw new Error(`Filter/Skript ${id} nicht gefunden`);
  return { ...summary(s, true), issues: withLines(s.sieve, lintCore(s.sieve, { folders: knownFolders(data), dialect: data.dialect })) };
}

export async function listFolders(account) {
  const data = await account.data();
  return {
    folders: data.folders,
    labels: data.labels,
    system: data.dialect.proton ? ['inbox', 'archive', 'trash', 'spam', 'starred'] : ['INBOX'],
    known: data.folders !== null,
  };
}

export async function capabilities(account) {
  const data = await account.data();
  return { provider: account.provider.kind, ...data.capabilities, extensions: [...data.dialect.extensions].sort() };
}

export async function lintSieve(account, { sieve }) {
  let data = null;
  try {
    data = account.provider.isReady ? await account.data() : null;
  } catch {
    data = null;
  }
  const issues = lintCore(sieve, { folders: data ? knownFolders(data) : undefined, dialect: data?.dialect ?? account.dialect() });
  const fixed = fixRequire(sieve);
  return { issues: withLines(sieve, issues), fixedRequire: fixed !== sieve ? fixed : null };
}

export async function checkSieve(account, { sieve }) {
  account.requireReady();
  return { issues: await account.provider.check(sieve) };
}

export const formatSieve = (_account, { sieve }) => ({ sieve: formatCore(sieve) });

export async function simulateMessage(account, { headers, size, spamScore, overrides = [] }) {
  const data = await account.data();
  const scripts = data.scripts.map((s) => {
    const o = overrides.find((x) => x.id === s.id);
    return o ? { ...s, sieve: o.sieve } : s;
  });
  const r = simulateCore(scripts, toMessage(headers, size), { labels: data.labels, spamScore, semantics: data.capabilities.semantics });
  return { ...r, fired: r.fired.filter((f) => !f.test.includes('vnd.proton.spam-threshold')) };
}

export function suggestRule(_account, { headers }) {
  return { suggestions: suggestConditions(toMessage(headers)) };
}

const templatesFor = (dialect) => RULE_TEMPLATES.filter((t) => dialect.proton || !t.protonOnly);

export function listTemplates(account) {
  return {
    templates: templatesFor(account.dialect()).map((t) => ({
      id: t.id,
      category: t.category,
      name: t.name,
      description: t.description,
      mergeable: !t.code,
      params: t.params
        .filter((p) => account.dialect().proton || p.id !== 'expireDays')
        .map((p) => ({ id: p.id, label: p.label, type: p.type, default: p.default })),
    })),
  };
}

// ---------- planning ----------

/**
 * fileinto into a folder that does not exist is silently ignored (Proton) or fails delivery (most servers),
 * and agents may invent names – so targets are checked against the real folders, with close matches.
 */
function assertFolderExists(data, folder) {
  if (!folder || folder.includes('${') || !data.folders) return;
  const known = [...data.folders, ...data.labels];
  const system = data.dialect.proton ? ['inbox', 'archive', 'trash', 'spam', 'starred'] : ['inbox'];
  if (known.includes(folder) || system.includes(folder.toLowerCase())) return;
  const norm = (s) =>
    s
      .toLowerCase()
      .replace(/ä/g, 'ae')
      .replace(/ö/g, 'oe')
      .replace(/ü/g, 'ue')
      .replace(/ß/g, 'ss')
      .normalize('NFKD')
      .replace(/[^\p{L}\p{N}/.]/gu, '');
  const similar = known.filter((k) => norm(k).includes(norm(folder)) || norm(folder).includes(norm(k)));
  throw new Error(
    `Ordner/Label „${folder}“ existiert nicht${similar.length ? ` – meintest du ${similar.map((s) => `„${s}“`).join(', ')}?` : ''} (siehe list_folders; der Ordner muss vorher angelegt werden)`,
  );
}

/** Scripts the planner may change: on servers with a single active script only that one runs. */
function planningScripts(data) {
  if (data.capabilities.multipleActive) return data.scripts;
  return data.scripts.filter((s) => s.enabled);
}

export async function planRule(account, { rule, target = 'auto', newName, headers, size }) {
  const data = await account.data();
  assertFolderExists(data, rule.actions?.fileinto);
  const scripts = planningScripts(data);
  const result = planRuleCore({
    scripts: target !== 'auto' && target !== 'new' ? data.scripts : scripts,
    rule,
    target: target === 'auto' && !scripts.length ? 'new' : target,
    newName,
    message: toMessage(headers, size) ?? undefined,
    labels: data.labels,
    dialect: data.dialect,
  });
  const json = planToJson(result);
  if (!json.target.id && !data.capabilities.multipleActive) {
    json.notes.push(
      scripts.length
        ? 'Neues Skript wird angelegt, aber nicht aktiviert – auf diesem Server läuft nur ein aktives Skript.'
        : 'Neues Skript wird angelegt und aktiviert (bisher war kein Skript aktiv).',
    );
    json.activate = !scripts.length;
  }
  return { description: describeRule(rule), ...json };
}

export async function buildTemplate(account, { templateId, params = {}, target = 'auto', newName }) {
  const data = await account.data();
  const template = templatesFor(data.dialect).find((t) => t.id === templateId);
  if (!template) throw new Error(`Vorlage ${templateId} nicht gefunden – siehe list_templates`);
  const merged = { ...templateDefaults(template), ...params };
  if (!data.dialect.proton) delete merged.expireDays;
  const built = buildTemplateCore(template, merged);
  if (built.rule) return { rule: built.rule, ...(await planRule(account, { rule: built.rule, target, newName })) };
  if (template.params.some((p) => p.type === 'folder')) assertFolderExists(data, merged.folder);

  // finished snippets are appended to the chosen (or first runnable) script, or become a new one
  const runnable = planningScripts(data);
  const script = target === 'new' ? null : data.scripts.find((s) => s.id === target) ?? (target === 'auto' ? runnable[0] : null);
  const before = script?.sieve ?? '';
  const base = (script ? before : newScript('', data.dialect)).replace(/\s+$/, '');
  const sieve = fixRequire(`${base}\n\n${built.code}\n`);
  return {
    target: script ? { id: script.id, name: script.name } : { id: null, name: newName || template.name, newFilter: true },
    steps: [{ kind: 'new-block' }],
    notes: [],
    conflicts: [],
    errors: withLines(sieve, lintCore(sieve, { dialect: data.dialect }).filter((i) => i.severity === 'error')),
    diff: unifiedDiff(before, sieve),
    result: null,
    sieve,
    activate: !script && !data.capabilities.multipleActive && !runnable.length,
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
      if (!data.scripts.some((s) => s.id === planned.target.id)) throw new Error('Der Zielfilter existiert nicht mehr');
      await account.provider.updateScript(planned.target.id, { sieve: planned.sieve });
      return { saved: true, ...planned };
    }
    const enabled = account.provider.capabilities.multipleActive ? true : Boolean(planned.activate);
    const created = await account.provider.createScript({ name: planned.target.name, sieve: planned.sieve, enabled });
    return { saved: true, ...planned, target: { id: created?.id ?? null, name: planned.target.name, enabled } };
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
    return account.provider.createScript({ name, sieve, enabled });
  });
}

export async function updateFilter(account, { id, name, sieve, enabled }) {
  return account.write(async () => {
    const data = await account.data({ fresh: true });
    const current = data.scripts.find((s) => s.id === id);
    if (!current) throw new Error(`Filter/Skript ${id} nicht gefunden`);
    if (sieve !== undefined) await account.checkOrThrow(sieve);
    const result = await account.provider.updateScript(id, { name, sieve, enabled });
    return { id: result?.id ?? id, name: name ?? current.name, enabled: enabled ?? current.enabled, diff: unifiedDiff(current.sieve, sieve ?? current.sieve) };
  });
}

export async function deleteFilter(account, { id }) {
  return account.write(async () => {
    await account.provider.deleteScript(id);
    return { deleted: id };
  });
}

export async function setFilterEnabled(account, { id, enabled }) {
  return account.write(async () => {
    await account.provider.setEnabled(id, enabled);
    return { id, enabled };
  });
}

export async function reorderFilters(account, { ids }) {
  return account.write(async () => {
    await account.provider.reorder(ids);
    return { order: ids };
  });
}
