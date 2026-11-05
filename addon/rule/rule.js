// "Sieve-Regel aus Mail": suggests conditions from the selected mail, finds the best place in the existing
// filters, shows the diff and the simulated result, then saves to Proton.

import { messageFromThunderbird, parseHeaderBlock, senderName, suggestConditions, decodeEncodedWords } from '../lib/mail.js';
import { planRule } from '../lib/rule-planner.js';
import { describeRule } from '../lib/sieve-rules.js';
import { findSections } from '../lib/sieve-sections.js';
import { simulate } from '../lib/sieve-sim.js';
import { SYSTEM_FOLDERS } from '../lib/sieve-dialect.js';
import {
  $,
  asScripts,
  busy,
  describeSimulation,
  el,
  capabilitiesOf,
  dialectOf,
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
  plan: null, // {targetId, sieve, steps, conflicts, before, section}
  sectionsKey: '',
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
  const client = await makeClient();
  if (await client.restore()) {
    state.client = client;
    $('account').textContent = client.session?.username ?? '';
    return loadAccountData(client);
  }
  if (inAddon) return null;
  // preview outside Thunderbird without a session: the manager's offline filters
  const local = (await storage.get('localFilters')) ?? [];
  return { filters: local, folders: ['Einkäufe', 'Newsletter', 'Listen', 'Rechnungen'], labels: ['Wichtig'] };
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
    el('optgroup', { label: 'Ordner' }, ...state.folders.filter((f) => f !== 'INBOX').map((f) => el('option', { value: f }, f))),
    el('optgroup', { label: 'Labels' }, ...state.labels.map((l) => el('option', { value: l }, l))),
    el('optgroup', { label: 'System' }, ...(dialectOf(state.client).proton ? SYSTEM_FOLDERS : ['INBOX']).map((f) => el('option', { value: f }, SYSTEM_LABELS[f] ?? f))),
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
  // one big script: the question is "which section", not "which filter"
  target.hidden = runnableScripts().length === 1;
}

const runnableScripts = () => asScripts(state.filters).filter((x) => capabilitiesOf(state.client).multipleActive || x.enabled);

/** Section choices of the script the plan goes into; rebuilt only when that script's sections change. */
function renderSections(plan) {
  const select = $('section');
  const sections = plan.targetId ? findSections(plan.before) : [];
  const key = plan.targetId ? `${plan.targetId}|${sections.map((x) => x.title).join('|')}` : '';
  if (key !== state.sectionsKey) {
    state.sectionsKey = key;
    const previous = select.value;
    select.replaceChildren(
      el('option', { value: 'auto' }, sections.length ? 'Automatisch – passenden Abschnitt finden' : 'Automatisch – beste Stelle'),
      ...sections.map((x) => el('option', { value: `s:${x.title}` }, `In Abschnitt „${x.title}“`)),
      el('option', { value: 'end' }, 'Ans Ende der Datei'),
      el('option', { value: 'new' }, 'Neuer Abschnitt …'),
    );
    select.value = [...select.options].some((o) => o.value === previous) ? previous : 'auto';
  }
  select.hidden = !plan.targetId;
  $('section-name').hidden = select.hidden || select.value !== 'new';
}

function sectionChoice() {
  const value = $('section').hidden ? 'auto' : $('section').value;
  $('section-name').hidden = value !== 'new';
  if (value === 'new') return $('section-name').value.trim() ? { new: $('section-name').value.trim() } : null;
  return value.startsWith('s:') ? value.slice(2) : value;
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

let updateTimer;
function update() {
  clearTimeout(updateTimer);
  updateTimer = setTimeout(render, 120);
}

function clearPlan(message) {
  $('plan').replaceChildren(el('div', { class: 'warn' }, message));
  $('diff').replaceChildren();
  $('after').textContent = '';
  $('apply').disabled = true;
  state.plan = null;
}

function render() {
  const rule = currentRule();
  if (!rule.conditions.length) return clearPlan('Bitte mindestens eine Bedingung auswählen.');
  const a = rule.actions;
  if (!a.fileinto && !a.seen && !a.flagged && !a.expireDays && !a.stop) return clearPlan('Bitte mindestens eine Aktion wählen.');

  const target = $('target').value;
  $('new-name').hidden = target !== 'new';
  const section = sectionChoice();
  if (section === null) return clearPlan('Bitte einen Namen für den neuen Abschnitt angeben.');
  const { plan, after, notes, conflicts, errors } = planRule({
    dialect: dialectOf(state.client),
    // with a single active script (ManageSieve) only that one runs and is worth changing
    scripts: target !== 'auto' ? asScripts(state.filters) : runnableScripts(),
    rule,
    target,
    newName: $('new-name').value,
    section,
    message: state.message,
    labels: state.labels,
  });
  state.plan = plan;
  renderSections(plan);

  const where = [
    !$('target').hidden || !plan.targetId ? (plan.targetId ? `Filter „${plan.name}“` : `Neuer Filter „${plan.name}“`) : '',
    plan.section ? (plan.section.new ? `neuer Abschnitt „${plan.section.title}“` : `Abschnitt „${plan.section.title}“`) : '',
  ].filter(Boolean);
  $('plan').replaceChildren(
    el('div', {}, el('strong', {}, describeRule(rule))),
    where.length ? el('div', { class: 'muted' }, where.join(' · ')) : '',
    ...plan.steps.map((st) =>
      el(
        'div',
        { class: `step${st.kind === 'covered' ? ' ok' : ''}` },
        `${st.condition ? `„${st.condition.value ?? st.condition.header}“` : 'Regel'} ${KIND_TEXT[st.kind] ?? st.kind}${st.line ? ` (Zeile ${st.line})` : ''}`,
      ),
    ),
    ...notes.map((n) => el('div', { class: 'warn' }, `↪ ${n}`)),
    ...conflicts.map((c) => el('div', { class: 'warn' }, `⚠ ${c.message} – Filter „${c.scriptName}“, Zeile ${c.line}`)),
    ...errors.map((e) => el('div', { class: 'warn' }, `✖ ${e.message}`)),
  );
  const stats = renderDiff($('diff'), plan.before, plan.sieve);
  $('after').textContent = after ? `Danach: ${describeSimulation(after)}` : '';
  $('apply').disabled = errors.length > 0 || (stats.added === 0 && stats.removed === 0);
}

// ---------- save ----------

async function applyPlan() {
  const plan = state.plan;
  if (!plan) return;
  if (!state.client) {
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
    // with a single active script (ManageSieve) a new one must not silently replace the active one
    const caps = capabilitiesOf(state.client);
    const activate = caps.multipleActive || !state.filters.some((f) => f.Status === 1);
    await state.client.createFilter({ Name: plan.name, Sieve: plan.sieve, Status: activate ? 1 : 0 });
    if (!activate) toast('Neues Skript angelegt, aber nicht aktiviert – es läuft nur ein aktives Skript');
  }
  toast('Regel gespeichert ✓');
  setTimeout(() => window.close(), 1200);
}

async function editInManager() {
  const plan = state.plan;
  if (!plan) return;
  const line = plan.steps.find((st) => st.line)?.line;
  await openInManager({ filterId: plan.targetId, name: plan.name, sieve: plan.sieve, line });
}

/** Hands a draft (or just a position) to the manager and opens it. */
async function openInManager(draft) {
  await storage.set('draft', { ...draft, at: Date.now() });
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
    const caps = capabilitiesOf(state.client);
    const runnable = asScripts(state.filters).filter((x) => caps.multipleActive || x.enabled);
    const current = simulate(runnable, state.message, { labels: state.labels, semantics: caps.semantics ?? 'proton' });
    $('current').replaceChildren(
      el('span', {}, `Aktuell: ${describeSimulation(current)}`),
      ...current.fired
        .filter((f) => !f.test.includes('vnd.proton.spam-threshold'))
        .map((f) =>
          el(
            'div',
            { class: 'muted small jump', title: 'Diese Regel im Manager öffnen', onclick: () => busy(null, () => openInManager({ filterId: f.scriptId, line: f.line })) },
            `↳ Filter „${f.script}“, Zeile ${f.line}: ${f.test}`,
          ),
        ),
    );

    state.suggestions = suggestConditions(state.message);
    renderConditions();
    renderFolderSelect();
    renderTargets();
    if (current.folder && !SYSTEM_FOLDERS.includes(current.folder)) $('folder').value = current.folder;

    for (const id of ['combine', 'folder', 'seen', 'flagged', 'expire', 'stop', 'target', 'new-name', 'section', 'section-name']) {
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
