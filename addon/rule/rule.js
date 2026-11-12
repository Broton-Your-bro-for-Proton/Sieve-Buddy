// "Sieve rule from mail": suggests conditions from the selected mail, finds the best place in the existing
// filters, shows the diff and the simulated result, then saves to Proton.

import { t } from '../lib/i18n.js';
import { messageFromThunderbird, parseHeaderBlock, senderName, suggestConditions, decodeEncodedWords } from '../lib/mail.js';
import { planRule } from '../lib/rule-planner.js';
import { describeRule } from '../lib/sieve-rules.js';
import { findSections } from '../lib/sieve-sections.js';
import { simulate } from '../lib/sieve-sim.js';
import { changedActions, findFolder, mailActions } from '../lib/mail-actions.js';
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
const SYSTEM_LABELS = { inbox: t('Inbox'), archive: t('Archive'), trash: t('Trash'), spam: t('Spam'), starred: t('Starred (label)') };
const MATCH_LABELS = { is: t('is'), contains: t('contains'), matches: t('matches (*, ?)') };
const KIND_TEXT = {
  covered: t('is already covered'),
  'append-key': t('is added to the existing list'),
  'append-key-anyof': t('is added to the existing list'),
  'extend-anyof': t('goes into the existing anyof(…)'),
  'wrap-anyof': t('extends the existing rule to anyof(…)'),
  'new-block': t('gets a new block'),
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
Subject: News for you #4711
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
  return { filters: local, folders: ['Einkäufe', 'Newsletter', 'Lists', 'Invoices'], labels: ['Important'] };
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
        children.push(el('span', { class: 'muted' }, t('exists')), el('span'));
      } else {
        const match = el(
          'select',
          { class: 'match', onchange: () => update() },
          ...Object.entries(MATCH_LABELS).map(([v, text]) => el('option', { value: v, selected: (c.match ?? 'is') === v }, text)),
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
  if (c.kind === 'exists') return t('Header {header}', { header: c.header });
  if (c.kind === 'address') {
    const sender = c.header === 'from';
    if (c.part === 'domain') return sender ? t('Sender domain') : t('Recipient domain');
    return sender ? t('Sender address') : t('Recipient address');
  }
  return { 'list-id': t('Mailing list'), subject: t('Subject') }[c.header] ?? t('Header {header}', { header: c.header });
}

/** Folder, label and system targets; the input filters them while typing (empty = don't move). */
function folderChoices() {
  return [
    ...state.folders.filter((f) => f !== 'INBOX').map((f) => [f, t('Folders')]),
    ...state.labels.map((l) => [l, t('Labels')]),
    ...(dialectOf(state.client).proton ? SYSTEM_FOLDERS : ['INBOX']).map((f) => [f, SYSTEM_LABELS[f] ?? t('System')]),
  ];
}

/** Own list instead of a datalist, whose popup in Thunderbird stops at six rows. It reaches down to the window's edge. */
function showFolders(filter = '') {
  const list = $('folder-list');
  const query = filter.trim().toLowerCase();
  list.replaceChildren(
    ...folderChoices()
      .filter(([name]) => name.toLowerCase().includes(query))
      .map(([name, kind]) => el('span', { role: 'option', 'data-value': name }, name, name === kind ? null : el('span', { class: 'muted small' }, kind))),
  );
  list.style.maxHeight = `${Math.max(120, innerHeight - $('folder').getBoundingClientRect().bottom - 12)}px`;
  list.hidden = !list.children.length;
}

function pickFolder(name) {
  $('folder').value = name;
  $('folder-list').hidden = true;
  update();
}

function folderKey(e) {
  const list = $('folder-list');
  const options = [...list.children];
  const at = options.findIndex((o) => o.hasAttribute('aria-selected'));
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    if (list.hidden) return showFolders();
    options[at]?.removeAttribute('aria-selected');
    const next = options[e.key === 'ArrowDown' ? (at + 1) % options.length : at <= 0 ? options.length - 1 : at - 1];
    next?.setAttribute('aria-selected', 'true');
    next?.scrollIntoView({ block: 'nearest' });
  } else if (e.key === 'Enter' && at >= 0 && !list.hidden) {
    pickFolder(options[at].dataset.value);
  } else if (e.key === 'Escape') {
    list.hidden = true;
  }
}

/** The folder as the account spells it; Proton matches case-insensitively, so "invoices" finds "Invoices". */
function knownFolder(name) {
  const proton = dialectOf(state.client).proton;
  return folderChoices().find(([f]) => (proton ? f.toLowerCase() === name.toLowerCase() : f === name))?.[0];
}

function renderTargets() {
  const target = $('target');
  target.replaceChildren(
    el('option', { value: 'auto' }, t('Automatic: find the best position')),
    ...runnableScripts().map((s) => el('option', { value: s.id }, t('In filter “{name}”', { name: s.name }))),
    el('option', { value: 'new' }, t('Create as a new filter')),
  );
  // one big script: the question is "which section", not "which filter"
  target.hidden = runnableScripts().length === 1;
}

// disabled filters never run, so they are neither simulated nor offered as a target
const runnableScripts = () => asScripts(state.filters).filter((x) => x.enabled);

/** Section choices of the script the plan goes into; rebuilt only when that script's sections change. */
function renderSections(plan) {
  const select = $('section');
  const sections = plan.targetId ? findSections(plan.before) : [];
  const key = plan.targetId ? `${plan.targetId}|${sections.map((x) => x.title).join('|')}` : '';
  if (key !== state.sectionsKey) {
    state.sectionsKey = key;
    const previous = select.value;
    select.replaceChildren(
      el('option', { value: 'auto' }, sections.length ? t('Automatic: find a matching section') : t('Automatic: best position')),
      ...sections.map((x) => el('option', { value: `s:${x.title}` }, t('In section “{title}”', { title: x.title }))),
      el('option', { value: 'end' }, t('At the end of the file')),
      el('option', { value: 'new' }, t('New section …')),
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
  const folder = $('folder').value.trim();
  return {
    conditions,
    combine: $('combine').value,
    actions: {
      fileinto: folder ? (knownFolder(folder) ?? folder) : null,
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
  $('apply').disabled = $('apply-run').disabled = true;
  state.plan = null;
}

function render() {
  const rule = currentRule();
  if (!rule.conditions.length) return clearPlan(t('Please select at least one condition.'));
  const a = rule.actions;
  if (!a.fileinto && !a.seen && !a.flagged && !a.expireDays && !a.stop) return clearPlan(t('Please choose at least one action.'));
  if (a.fileinto && !knownFolder(a.fileinto)) return clearPlan(t('Folder/label “{name}” does not exist', { name: a.fileinto }));

  const target = $('target').value;
  $('new-name').hidden = target !== 'new';
  const section = sectionChoice();
  if (section === null) return clearPlan(t('Please enter a name for the new section.'));
  let planned;
  try {
    planned = planRule({
      dialect: dialectOf(state.client),
      // with a single active script (ManageSieve) only that one runs and is worth changing
      scripts: runnableScripts(),
      rule,
      target,
      newName: $('new-name').value,
      section,
      message: state.message,
      labels: state.labels,
    });
  } catch (error) {
    // never leave the previous plan applicable when the current input cannot be planned
    return clearPlan(error.message);
  }
  const { plan, after, notes, conflicts, errors } = planned;
  state.plan = plan;
  renderSections(plan);

  const where = [
    !$('target').hidden || !plan.targetId ? (plan.targetId ? t('Filter “{name}”', { name: plan.name }) : t('New filter “{name}”', { name: plan.name })) : '',
    plan.section ? (plan.section.new ? t('new section “{title}”', { title: plan.section.title }) : t('Section “{title}”', { title: plan.section.title })) : '',
  ].filter(Boolean);
  $('plan').replaceChildren(
    el('div', {}, el('strong', {}, describeRule(rule))),
    where.length ? el('div', { class: 'muted' }, where.join(' · ')) : '',
    ...plan.steps.map((st) =>
      el(
        'div',
        { class: `step${st.kind === 'covered' ? ' ok' : ''}` },
        `${st.condition ? t('“{s}”', { s: st.condition.value ?? st.condition.header }) : t('Rule')} ${KIND_TEXT[st.kind] ?? st.kind}${st.line ? ` ${t('(line {line})', { line: st.line })}` : ''}`,
      ),
    ),
    ...notes.map((n) => el('div', { class: 'warn' }, `↪ ${n}`)),
    ...conflicts.map((c) => el('div', { class: 'warn' }, t('⚠ {message}: filter “{script}”, line {line}', { message: c.message, script: c.scriptName, line: c.line }))),
    ...errors.map((e) => el('div', { class: 'warn' }, `✖ ${e.message}`)),
  );
  // the whole script fills the code pane; it opens at the change
  const stats = renderDiff($('diff'), plan.before, plan.sieve, Infinity);
  const first = $('diff').querySelector('.diff-add, .diff-del');
  if (first) $('diff').scrollTop = first.offsetTop - $('diff').clientHeight / 3;
  $('after').textContent = after ? t('Afterwards: {result}', { result: describeSimulation(after) }) : '';
  $('apply').disabled = $('apply-run').disabled = errors.length > 0 || (stats.added === 0 && stats.removed === 0);
}

// ---------- save ----------

async function applyPlan(run = false) {
  const plan = state.plan;
  if (!plan) return;
  // the inbox is checked against the plan before saving, so a cancel still leaves everything as it was
  let inbox = [];
  if ($('inbox-run').checked) {
    $('apply').disabled = $('apply-run').disabled = true;
    try {
      inbox = await scanInbox(plan, run);
    } finally {
      $('apply').disabled = $('apply-run').disabled = false;
    }
    if (inbox.length && !confirm(t('{count} messages in the inbox will be processed: {actions}. Continue?', { count: inbox.length, actions: summarize(inbox) }))) return;
  }
  const after = async () => {
    if (run) await runOnMessage(plan);
    if (inbox.length) await runOnInbox(inbox);
  };
  if (!state.client) {
    const local = (await storage.get('localFilters')) ?? [];
    const next = plan.targetId
      ? local.map((f) => (f.ID === plan.targetId ? { ...f, Sieve: plan.sieve } : f))
      : [...local, { ID: `local-${Date.now()}`, Name: plan.name, Sieve: plan.sieve, Status: 1 }];
    await storage.set('localFilters', next);
    toast(t('Saved locally (preview mode)'));
    await after();
    return;
  }
  const issues = await state.client.checkSieve(plan.sieve);
  if (issues.length) throw new Error(t('Proton rejects the script: {issues}', { issues: issues.map((i) => i.message).join('; ') }));
  if (plan.targetId) {
    // the plan is based on the state when the window opened: never overwrite a change made since then
    const filter = await state.client.getFilter(plan.targetId);
    if (filter?.Sieve !== plan.before) throw new Error(t('The filter was changed in the meantime, please plan again'));
    await pushHistory(filter.ID, filter.Name, filter.Sieve);
    // through the service its own fresh copy is compared once more (Proton's client ignores the extra argument)
    await state.client.updateFilter(filter.ID, { Name: filter.Name, Sieve: plan.sieve, Status: filter.Status }, plan.before);
  } else {
    // with a single active script (ManageSieve) a new one must not silently replace the active one
    const caps = capabilitiesOf(state.client);
    const activate = caps.multipleActive || !state.filters.some((f) => f.Status === 1);
    const created = await state.client.createFilter({ Name: plan.name, Sieve: plan.sieve, Status: activate ? 1 : 0 });
    if (created?.warning) {
      // the filter exists (disabled): another Apply would only create a duplicate
      clearPlan(created.warning);
      setTimeout(() => window.close(), 4000);
      return;
    }
    if (!activate) toast(t('New script created but not activated: only one script can be active'));
  }
  toast(t('Rule saved ✓'));
  await after();
  setTimeout(() => window.close(), run || inbox.length ? 4000 : 1200);
}

/** "move to Bills (12), mark as read (3)" */
function summarize(hits) {
  const counts = new Map();
  const add = (text) => counts.set(text, (counts.get(text) ?? 0) + 1);
  for (const { actions: a } of hits) {
    if (a.trash) add(t('move to the trash'));
    else if (a.move) add(t('move to {folder}', { folder: a.move }));
    a.copies.forEach((c) => add(t('copy to {folder}', { folder: c })));
    if (a.read) add(t('mark as read'));
    if (a.flagged) add(t('with star'));
  }
  return [...counts].map(([text, n]) => `${text} (${n})`).join(', ');
}

const plannedScripts = (plan) => {
  const scripts = runnableScripts().map((s) => (s.id === plan.targetId ? { ...s, sieve: plan.sieve } : s));
  if (!plan.targetId) scripts.push({ id: 'new', name: plan.name, sieve: plan.sieve, enabled: true });
  return scripts;
};
const simulateWith = (scripts, message) => simulate(scripts, message, { labels: state.labels, semantics: capabilitiesOf(state.client).semantics ?? 'proton' });
const openMessageId = () => Number(new URLSearchParams(location.search).get('message'));

/** All folders of an account, flat, for findFolder. */
async function accountFolders(accountId) {
  const account = await browser.accounts.get(accountId, true);
  const all = [];
  const walk = (list) => list?.forEach((f) => (all.push(f), walk(f.subFolders)));
  walk(account.folders);
  return all;
}

/** Runs mailActions on one message; folder names Thunderbird does not know go into `missing`. */
async function perform(id, current, actions, folders, missing) {
  const target = (name) => findFolder(folders, name) ?? (missing.add(name), null);
  if (actions.read || actions.flagged) await browser.messages.update(id, { ...(actions.read && { read: true }), ...(actions.flagged && { flagged: true }) });
  for (const name of actions.copies) {
    const folder = target(name);
    if (folder) await browser.messages.copy([id], folder);
  }
  if (actions.trash) await browser.messages.delete([id], false);
  else if (actions.move) {
    const folder = target(actions.move);
    if (folder && folder.path !== current.path) await browser.messages.move([id], folder);
  }
}

function report(done, missing, skipped) {
  const notes = [];
  if (missing.size) notes.push(t('Folder not found in Thunderbird: {names}', { names: [...missing].join(', ') }));
  if (skipped.size) notes.push(t('Not run here: {actions}', { actions: [...skipped].join(', ') }));
  toast(notes.length ? notes.join(' · ') : done, notes.length > 0);
}

/** Does to the open message what the saved filters would do to it on arrival. */
async function runOnMessage(plan) {
  const actions = mailActions(simulateWith(plannedScripts(plan), state.message));
  if (!inAddon) {
    toast(t('Preview mode: would run {actions}', { actions: JSON.stringify(actions) }));
    return;
  }
  const id = openMessageId();
  const { folder: current } = await browser.messages.get(id);
  const missing = new Set();
  await perform(id, current, actions, await accountFolders(current.accountId), missing);
  report(t('Applied to this message ✓'), missing, new Set(actions.skipped));
}

/** Messages in the inbox of the open message's account that the change treats differently, with their new actions. */
async function scanInbox(plan, run) {
  if (!inAddon) return [];
  const { folder: current } = await browser.messages.get(openMessageId());
  const folders = await accountFolders(current.accountId);
  const inbox = folders.find((f) => f.specialUse?.includes('inbox'));
  if (!inbox) return [];
  const before = runnableScripts();
  const after = plannedScripts(plan);
  const hits = [];
  let checked = 0;
  try {
    let page = await browser.messages.list(inbox);
    for (;;) {
      for (const header of page.messages) {
        // with run the open message is handled on its own
        if (run && header.id === openMessageId()) continue;
        $('inbox-progress').textContent = t('Checking the inbox: {count}', { count: ++checked });
        const message = messageFromThunderbird(await browser.messages.getFull(header.id), { size: header.size });
        const actions = changedActions(simulateWith(before, message), simulateWith(after, message));
        if (!actions) continue;
        // flags Thunderbird already shows change nothing
        if (header.read) actions.read = false;
        if (header.flagged) actions.flagged = false;
        if (actions.move || actions.trash || actions.copies.length || actions.read || actions.flagged) hits.push({ id: header.id, actions });
      }
      if (!page.id) break;
      page = await browser.messages.continueList(page.id);
    }
  } finally {
    $('inbox-progress').textContent = '';
  }
  return hits.map((h) => ({ ...h, inbox, folders }));
}

async function runOnInbox(hits) {
  const missing = new Set();
  const skipped = new Set();
  let failed = 0;
  for (const { id, actions, inbox, folders } of hits) {
    actions.skipped.forEach((x) => skipped.add(x));
    // a message moved or deleted since the scan must not stop the rest
    try {
      await perform(id, inbox, actions, folders, missing);
    } catch {
      failed++;
    }
  }
  if (failed) skipped.add(t('{count} messages could not be processed', { count: failed }));
  report(t('Applied to {count} messages in the inbox ✓', { count: hits.length - failed }), missing, skipped);
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

    const subject = decodeEncodedWords(state.message.headers.subject?.[0] ?? t('(no subject)'));
    $('mail-subject').textContent = subject;
    $('mail-from').textContent = `${senderName(state.message) || ''} ${state.message.headers.from?.[0] ? `<${state.message.headers.from[0].replace(/^.*<|>.*$/g, '')}>` : ''}`.trim();
    const caps = capabilitiesOf(state.client);
    const current = simulate(runnableScripts(), state.message, { labels: state.labels, semantics: caps.semantics ?? 'proton' });
    $('current').replaceChildren(
      el('span', {}, t('Currently: {result}', { result: describeSimulation(current) })),
      ...current.fired
        .filter((f) => !f.test.includes('vnd.proton.spam-threshold'))
        .map((f) =>
          el(
            'div',
            { class: 'muted small jump', title: t('Open this rule in the manager'), onclick: () => busy(null, () => openInManager({ filterId: f.scriptId, line: f.line })) },
            t('↳ Filter “{script}”, line {line}: {test}', { script: f.script, line: f.line, test: f.test }),
          ),
        ),
    );

    state.suggestions = suggestConditions(state.message);
    renderConditions();
    renderTargets();
    if (current.folder && !SYSTEM_FOLDERS.includes(current.folder)) $('folder').value = current.folder;

    for (const id of ['combine', 'folder', 'seen', 'flagged', 'expire', 'stop', 'target', 'new-name', 'section', 'section-name']) {
      $(id).addEventListener('input', update);
      $(id).addEventListener('change', update);
    }
    // opens like a datalist: on click, while typing and with the arrow keys
    $('folder').addEventListener('mousedown', () => $('folder-list').hidden && showFolders());
    $('folder').addEventListener('input', (e) => showFolders(e.target.value));
    $('folder').addEventListener('keydown', folderKey);
    $('folder').addEventListener('blur', () => ($('folder-list').hidden = true));
    $('folder-list').addEventListener('mousedown', (e) => {
      e.preventDefault(); // keeps the focus in the input
      const option = e.target.closest('[role=option]');
      if (option) pickFolder(option.dataset.value);
    });
    $('apply').addEventListener('click', (e) => busy(e.currentTarget, () => applyPlan()));
    $('apply-run').addEventListener('click', (e) => busy(e.currentTarget, () => applyPlan(true)));
    $('edit').addEventListener('click', (e) => busy(e.currentTarget, editInManager));
    $('cancel').addEventListener('click', () => window.close());

    $('loading').hidden = true;
    $('form').hidden = false;
    render();
  } catch (error) {
    console.error(error);
    $('loading').replaceChildren(el('p', { class: 'warn' }, t('Error: {message}', { message: error.message })));
  }
})();

$('open-manager').addEventListener('click', () => browser.runtime.openOptionsPage().then(() => window.close()));
