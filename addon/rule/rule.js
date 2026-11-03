// "Sieve-Regel aus Mail": suggests conditions from the selected mail, finds the best place in the existing
// filters, shows the diff and the simulated result, then saves to Proton.

import { messageFromThunderbird, parseHeaderBlock, senderName, suggestConditions, decodeEncodedWords } from '../lib/mail.js';
import { fixRequire, lintSieve } from '../lib/sieve-analyzer.js';
import { describeRule, insertRuleBefore, mergeRuleIntoScript, proposeRule, ruleReached, ruleToSieve } from '../lib/sieve-rules.js';
import { simulate } from '../lib/sieve-sim.js';
import { SYSTEM_FOLDERS, newScript } from '../lib/sieve-dialect.js';
import {
  $,
  asScripts,
  busy,
  describeSimulation,
  el,
  loadAccountData,
  makeClient,
  pushHistory,
  renderDiff,
  storage,
  toast,
} from '../shared/env.js';

const inAddon = Boolean(globalThis.browser?.messages);
const SYSTEM_LABELS = { inbox: 'Posteingang', archive: 'Archiv', trash: 'Papierkorb', spam: 'Spam', starred: 'Markiert (Label)' };
const MATCH_LABELS = { is: 'ist', contains: 'enthält', matches: 'passt auf (*, ?)' };
const KIND_TEXT = {
  covered: 'ist schon abgedeckt',
  'append-key': 'wird zur bestehenden Liste hinzugefügt',
  'append-key-anyof': 'wird zur bestehenden Liste hinzugefügt',
  'extend-anyof': 'kommt ins bestehende anyof(…)',
  'wrap-anyof': 'erweitert die bestehende Regel zu anyof(…)',
  'new-block': 'bekommt einen neuen Block',
};

const state = {
  client: null,
  message: null,
  filters: [],
  folders: [],
  labels: [],
  suggestions: [],
  plan: null, // {targetId, sieve, steps, conflicts, before}
};

// ---------- data ----------

const DEMO_HEADERS = `From: "Example News" <news@example.com>
To: me+shop@proton.me
Subject: Neuigkeiten für Sie #4711
List-Id: Example News <news.example.com>
List-Unsubscribe: <https://example.com/u>
Date: Tue, 03 Nov 2026 10:00:00 +0100
`;

async function loadMessage() {
  if (!inAddon) return { headers: parseHeaderBlock(DEMO_HEADERS), size: 24000 };
  const id = Number(new URLSearchParams(location.search).get('message'));
  const [full, header] = await Promise.all([browser.messages.getFull(id), browser.messages.get(id)]);
  return messageFromThunderbird(full, { size: header.size });
}

async function loadAccount() {
  if (!inAddon) {
    const local = (await storage.get('localFilters')) ?? [];
    return { filters: local, folders: ['Einkäufe', 'Newsletter', 'Listen', 'Rechnungen'], labels: ['Wichtig'] };
  }
  state.client = await makeClient();
  if (!(await state.client.restore())) return null;
  $('account').textContent = state.client.session?.username ?? '';
  return loadAccountData(state.client);
}

// ---------- form ----------

function renderConditions() {
  const box = $('conditions');
  box.replaceChildren(
    ...state.suggestions.map((s, i) => {
      const c = s.condition;
      const check = el('input', { type: 'checkbox', checked: Boolean(s.recommended), onchange: () => update() });
      const row = el('div', { class: `condition${s.recommended ? '' : ' off'}` });
      check.addEventListener('change', () => row.classList.toggle('off', !check.checked));
      const what = el('span', { class: 'what' }, labelFor(c));
      const children = [check, what];
      if (c.kind === 'exists') {
        children.push(el('span', { class: 'muted' }, 'vorhanden'), el('span'));
      } else {
        const match = el(
          'select',
          { class: 'match', onchange: () => update() },
          ...Object.entries(MATCH_LABELS).map(([v, t]) => el('option', { value: v, selected: (c.match ?? 'is') === v }, t)),
        );
        const value = el('input', { type: 'text', value: c.value, oninput: () => update() });
        children.push(match, value);
        row.match = match;
        row.value = value;
      }
      row.check = check;
      row.suggestion = s;
      row.append(...children);
      row.dataset.index = String(i);
      return row;
    }),
  );
}

function labelFor(c) {
  if (c.kind === 'exists') return `Header ${c.header}`;
  if (c.kind === 'address') {
    const who = c.header === 'from' ? 'Absender' : 'Empfänger';
    return c.part === 'domain' ? `${who}-Domain` : `${who}-Adresse`;
  }
  return { 'list-id': 'Mailingliste', subject: 'Betreff' }[c.header] ?? `Header ${c.header}`;
}

function renderFolderSelect() {
  const select = $('folder');
  const options = [
    el('option', { value: '' }, '— nicht verschieben —'),
    el('optgroup', { label: 'Ordner' }, ...state.folders.map((f) => el('option', { value: f }, f))),
    el('optgroup', { label: 'Labels' }, ...state.labels.map((l) => el('option', { value: l }, l))),
    el('optgroup', { label: 'System' }, ...SYSTEM_FOLDERS.map((f) => el('option', { value: f }, SYSTEM_LABELS[f] ?? f))),
  ];
  select.replaceChildren(...options);
}

function renderTargets() {
  const target = $('target');
  target.replaceChildren(
    el('option', { value: 'auto' }, 'Automatisch – beste Stelle finden'),
    ...state.filters.map((f) => el('option', { value: f.ID }, `In Filter „${f.Name}“${f.Status === 1 ? '' : ' (deaktiviert)'}`)),
    el('option', { value: 'new' }, 'Als neuen Filter anlegen'),
  );
}

function currentRule() {
  const conditions = [...$('conditions').children]
    .filter((row) => row.check.checked)
    .map((row) => {
      const c = { ...row.suggestion.condition };
      if (row.value) {
        c.value = row.value.value.trim();
        c.match = row.match.value;
      }
      return c;
    })
    .filter((c) => c.kind === 'exists' || c.value);
  $('combine-row').hidden = conditions.length < 2;
  return {
    conditions,
    combine: $('combine').value,
    actions: {
      fileinto: $('folder').value || null,
      seen: $('seen').checked,
      flagged: $('flagged').checked,
      expireDays: $('expire').value ? Number($('expire').value) : null,
      stop: $('stop').checked,
    },
  };
}

// ---------- planning ----------

function planFor(filter, rule) {
  const script = { id: filter.ID, name: filter.Name, sieve: filter.Sieve };
  const merged = mergeRuleIntoScript(script, rule);
  const merges = merged.steps.filter((s) => s.kind !== 'new-block' && s.kind !== 'covered').length;
  const covered = merged.steps.filter((s) => s.kind === 'covered').length;
  const sameFolder = rule.actions.fileinto && filter.Sieve.includes(`fileinto "${rule.actions.fileinto}"`) ? 1 : 0;
  return { targetId: filter.ID, name: filter.Name, before: filter.Sieve, sieve: merged.sieve, steps: merged.steps, score: merges * 10 + covered * 5 + sameFolder * 2 + (filter.Status === 1 ? 1 : 0) };
}

function computePlan(rule) {
  const target = $('target').value;
  $('new-name').hidden = target !== 'new';
  if (target === 'new' || !state.filters.length) {
    const sieve = fixRequire(`${newScript()}\n${ruleToSieve(rule)}\n`);
    return { targetId: null, name: $('new-name').value.trim() || defaultName(rule), before: '', sieve, steps: rule.conditions.map((condition) => ({ condition, kind: 'new-block' })) };
  }
  if (target !== 'auto') return planFor(state.filters.find((f) => f.ID === target), rule);
  const plans = state.filters.map((f) => planFor(f, rule));
  return plans.sort((a, b) => b.score - a.score)[0];
}

function defaultName(rule) {
  return rule.actions.fileinto ? `→ ${rule.actions.fileinto}` : 'Neue Regel';
}

let updateTimer;
function update() {
  clearTimeout(updateTimer);
  updateTimer = setTimeout(render, 120);
}

function render() {
  const rule = currentRule();
  const planBox = $('plan');
  const apply = $('apply');
  if (!rule.conditions.length) {
    planBox.replaceChildren(el('div', { class: 'warn' }, 'Bitte mindestens eine Bedingung auswählen.'));
    $('diff').replaceChildren();
    $('after').textContent = '';
    apply.disabled = true;
    state.plan = null;
    return;
  }
  const actions = rule.actions;
  if (!actions.fileinto && !actions.seen && !actions.flagged && !actions.expireDays && !actions.stop) {
    planBox.replaceChildren(el('div', { class: 'warn' }, 'Bitte mindestens eine Aktion wählen.'));
    $('diff').replaceChildren();
    $('after').textContent = '';
    apply.disabled = true;
    state.plan = null;
    return;
  }

  // plan, then check with the simulator that the mail really ends up where the rule says
  const plan = computePlan(rule);
  let after = simulateWith(plan);
  const notes = [];
  if (!ruleReached(after, rule.actions)) {
    const fix = placeBeforeBlocker(plan, rule, after);
    if (fix) {
      Object.assign(plan, fix.plan);
      after = fix.after;
      notes.push(`↪ ${fix.note}`);
    } else {
      const blocker = after.fired.find((f) => !f.test.includes('vnd.proton.spam-threshold'));
      notes.push(
        blocker
          ? `⚠ Die Regel greift bei dieser Mail nicht: Filter „${blocker.script}“ (Zeile ${blocker.line}) fängt sie vorher ab. Dort eintragen oder die Filterreihenfolge ändern.`
          : '⚠ Die Regel greift bei dieser Mail nicht – Bedingungen prüfen.',
      );
    }
  }
  state.plan = plan;
  const conflicts = rule.conditions.length === 1 ? proposeRule(asScripts(state.filters), rule).conflicts : [];
  const errors = lintSieve(plan.sieve).filter((i) => i.severity === 'error');

  planBox.replaceChildren(
    el('div', {}, el('strong', {}, describeRule(rule))),
    el('div', { class: 'muted' }, plan.targetId ? `Filter „${plan.name}“` : `Neuer Filter „${plan.name}“`),
    ...plan.steps.map((s) =>
      el('div', { class: `step${s.kind === 'covered' ? ' ok' : ''}` }, `${s.condition ? `„${s.condition.value ?? s.condition.header}“` : 'Regel'} ${KIND_TEXT[s.kind] ?? s.kind}${s.line ? ` (Zeile ${s.line})` : ''}`),
    ),
    ...notes.map((n) => el('div', { class: 'warn' }, n)),
    ...conflicts.map((c) => el('div', { class: 'warn' }, `⚠ ${c.message} – Filter „${c.scriptName}“, Zeile ${c.line}`)),
    ...errors.map((e) => el('div', { class: 'warn' }, `✖ ${e.message}`)),
  );
  const stats = renderDiff($('diff'), plan.before, plan.sieve);
  $('after').textContent = `Danach: ${describeSimulation(after)}`;
  apply.disabled = errors.length > 0 || (stats.added === 0 && stats.removed === 0);
}

/** Simulates the mail against all filters with the plan applied. */
function simulateWith(plan) {
  const scripts = asScripts(state.filters).map((s) => (s.id === plan.targetId ? { ...s, sieve: plan.sieve } : s));
  if (!plan.targetId) scripts.push({ id: 'new', name: plan.name, sieve: plan.sieve, enabled: true });
  return simulate(scripts, state.message, { labels: state.labels });
}

/**
 * When an earlier block of the same filter catches the mail (stop, or a later fileinto that wins),
 * try the rule as a new block right before that block – first as is, then with `stop`.
 */
function placeBeforeBlocker(plan, rule, after) {
  const scriptId = plan.targetId ?? 'new';
  const blockers = after.fired.filter((f) => f.scriptId === scriptId && !f.test.includes('vnd.proton.spam-threshold'));
  for (const blocker of blockers) {
    for (const stop of [false, true]) {
      try {
        const sieve = insertRuleBefore(plan.before || plan.sieve, blocker.line, rule, { stop });
        const candidate = { ...plan, sieve, steps: rule.conditions.map((condition) => ({ condition, kind: 'new-block', line: blocker.line })) };
        const result = simulateWith(candidate);
        if (ruleReached(result, rule.actions)) {
          const note = stop
            ? `Als neuer Block vor Zeile ${blocker.line} eingefügt und mit „stop“ beendet – sonst würde der Block dort die Mail woandershin verschieben.`
            : `Als neuer Block vor Zeile ${blocker.line} eingefügt – der Block dort hätte die Mail sonst vorher abgefangen.`;
          return { plan: candidate, after: result, note };
        }
      } catch {
        // blocker is nested, not a top-level block
      }
    }
  }
  return null;
}

// ---------- save ----------

async function applyPlan() {
  const plan = state.plan;
  if (!plan) return;
  if (!inAddon) {
    const local = (await storage.get('localFilters')) ?? [];
    const next = plan.targetId
      ? local.map((f) => (f.ID === plan.targetId ? { ...f, Sieve: plan.sieve } : f))
      : [...local, { ID: `local-${Date.now()}`, Name: plan.name, Sieve: plan.sieve, Status: 1 }];
    await storage.set('localFilters', next);
    toast('Lokal gespeichert (Vorschau-Modus)');
    return;
  }
  const issues = await state.client.checkSieve(plan.sieve);
  if (issues.length) throw new Error(`Proton lehnt das Skript ab: ${issues.map((i) => i.message).join('; ')}`);
  if (plan.targetId) {
    const filter = state.filters.find((f) => f.ID === plan.targetId);
    await pushHistory(filter.ID, filter.Name, filter.Sieve);
    await state.client.updateFilter(filter.ID, { Name: filter.Name, Sieve: plan.sieve, Status: filter.Status });
  } else {
    await state.client.createFilter({ Name: plan.name, Sieve: plan.sieve, Status: 1 });
  }
  toast('Regel gespeichert ✓');
  setTimeout(() => window.close(), 1200);
}

async function editInManager() {
  const plan = state.plan;
  if (!plan) return;
  await storage.set('draft', { filterId: plan.targetId, name: plan.name, sieve: plan.sieve, at: Date.now() });
  if (inAddon) {
    await browser.runtime.openOptionsPage();
    window.close();
  } else {
    location.href = '../manager/manager.html';
  }
}

// ---------- start ----------

(async () => {
  try {
    const account = await loadAccount();
    if (!account) {
      $('loading').hidden = true;
      $('need-login').hidden = false;
      return;
    }
    state.filters = account.filters;
    state.folders = account.folders;
    state.labels = account.labels;
    state.message = await loadMessage();

    const subject = decodeEncodedWords(state.message.headers.subject?.[0] ?? '(kein Betreff)');
    $('mail-subject').textContent = subject;
    $('mail-from').textContent = `${senderName(state.message) || ''} ${state.message.headers.from?.[0] ? `<${state.message.headers.from[0].replace(/^.*<|>.*$/g, '')}>` : ''}`.trim();
    const current = simulate(asScripts(state.filters), state.message, { labels: state.labels });
    $('current').replaceChildren(
      el('span', {}, `Aktuell: ${describeSimulation(current)}`),
      ...current.fired.filter((f) => !f.test.includes('vnd.proton.spam-threshold')).map((f) => el('div', { class: 'muted small' }, `↳ Filter „${f.script}“, Zeile ${f.line}: ${f.test}`)),
    );

    state.suggestions = suggestConditions(state.message);
    renderConditions();
    renderFolderSelect();
    renderTargets();
    if (current.folder && !SYSTEM_FOLDERS.includes(current.folder)) $('folder').value = current.folder;

    for (const id of ['combine', 'folder', 'seen', 'flagged', 'expire', 'stop', 'target', 'new-name']) {
      $(id).addEventListener('input', update);
      $(id).addEventListener('change', update);
    }
    $('apply').addEventListener('click', (e) => busy(e.currentTarget, applyPlan));
    $('edit').addEventListener('click', (e) => busy(e.currentTarget, editInManager));
    $('cancel').addEventListener('click', () => window.close());

    $('loading').hidden = true;
    $('form').hidden = false;
    render();
  } catch (error) {
    console.error(error);
    $('loading').replaceChildren(el('p', { class: 'warn' }, `Fehler: ${error.message}`));
  }
})();

$('open-manager').addEventListener('click', () => browser.runtime.openOptionsPage().then(() => window.close()));
