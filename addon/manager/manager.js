import { DEFAULT_SETTINGS, LABEL_TYPE, ProtonClient } from '../lib/proton-api.js';
import { fixRequire, getCompletions, lintSieve } from '../lib/sieve-analyzer.js';
import { SPAM_GUARD, SPAM_GUARD_REQUIRE, TEMPLATES, formatList, newScript } from '../lib/sieve-dialect.js';

const $ = (id) => document.getElementById(id);
const CodeMirror = window.CodeMirror;

// ---------- Storage (browser.storage.local in Thunderbird, localStorage when opened as a plain page) ----------

const storage = globalThis.browser?.storage?.local
  ? {
      get: async (key) => (await browser.storage.local.get(key))[key] ?? null,
      set: (key, value) => (value === null ? browser.storage.local.remove(key) : browser.storage.local.set({ [key]: value })),
    }
  : {
      get: async (key) => JSON.parse(localStorage.getItem(`proton-sieve:${key}`) ?? 'null'),
      set: async (key, value) =>
        value === null ? localStorage.removeItem(`proton-sieve:${key}`) : localStorage.setItem(`proton-sieve:${key}`, JSON.stringify(value)),
    };

// ---------- State ----------

const state = {
  client: null,
  offline: false,
  filters: [],
  selectedId: null, // null = new, unsaved filter
  dirty: false,
  remoteIssues: [],
  folders: [],
  labels: [],
  pendingLogin: null, // {username, password} while 2FA/captcha is in progress
};

// ---------- Small UI helpers ----------

let toastTimer;
function toast(message, isError = false) {
  const el = $('toast');
  el.textContent = message;
  el.className = isError ? 'toast error' : 'toast';
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), isError ? 7000 : 3000);
}

function show(view) {
  for (const v of ['login', '2fa', 'captcha', 'app']) $(`view-${v}`).hidden = v !== view;
  if (view === 'app') editor.refresh();
}

async function busy(button, fn) {
  button.disabled = true;
  try {
    return await fn();
  } catch (error) {
    console.error(error);
    toast(error.message || String(error), true);
  } finally {
    button.disabled = false;
  }
}

// ---------- Editor ----------

const editor = CodeMirror($('editor'), {
  mode: 'sieve',
  lineNumbers: true,
  lineWrapping: true,
  indentUnit: 4,
  matchBrackets: true,
  autoCloseBrackets: true,
  gutters: ['CodeMirror-lint-markers', 'CodeMirror-linenumbers'],
  lint: { getAnnotations: annotations, delay: 300 },
  extraKeys: {
    'Ctrl-Space': 'autocomplete',
    'Ctrl-S': () => $('save').click(),
    'Cmd-S': () => $('save').click(),
    'Ctrl-/': 'toggleComment',
    Tab: (cm) => (cm.somethingSelected() ? cm.indentSelection('add') : cm.replaceSelection('    ')),
  },
});
editor.setOption('lineComment', '#');

function annotations(text) {
  const toPos = (i) => editor.posFromIndex(i);
  const local = lintSieve(text, { folders: state.offline ? undefined : [...state.folders, ...state.labels] }).map((i) => ({
    from: toPos(i.start),
    to: toPos(Math.max(i.end, i.start + 1)),
    message: i.message,
    severity: i.severity,
  }));
  const remote = state.remoteIssues.map((i) => ({
    from: i.from ?? CodeMirror.Pos(0, 0),
    to: i.to ?? i.from ?? CodeMirror.Pos(0, 1),
    message: `Proton: ${i.message ?? JSON.stringify(i)}`,
    severity: i.severity ?? 'error',
  }));
  const all = [...local, ...remote];
  renderProblems(all);
  return all;
}

function renderProblems(list) {
  const box = $('problems');
  box.replaceChildren(
    ...list.map((p) => {
      const div = document.createElement('div');
      div.className = p.severity;
      div.textContent = `Zeile ${p.from.line + 1}: ${p.message}`;
      div.addEventListener('click', () => {
        editor.focus();
        editor.setSelection(p.from, p.to);
      });
      return div;
    }),
  );
}

CodeMirror.registerHelper('hint', 'sieve', (cm) => {
  const cursor = cm.indexFromPos(cm.getCursor());
  const result = getCompletions(cm.getValue(), cursor, { folders: state.folders, labels: state.labels });
  if (!result.list.length) return null;
  return { list: result.list, from: cm.posFromIndex(result.from), to: cm.posFromIndex(result.to) };
});
editor.setOption('hintOptions', { completeSingle: false });

editor.on('inputRead', (cm, change) => {
  if (change.origin !== '+input') return;
  const ch = change.text[change.text.length - 1].slice(-1);
  if (/[a-zA-Z:"\[]/.test(ch) && !cm.state.completionActive) cm.showHint();
});

let remoteCheckTimer;
editor.on('change', () => {
  state.dirty = true;
  state.remoteIssues = [];
  if (!state.offline && state.client?.isLoggedIn) {
    clearTimeout(remoteCheckTimer);
    remoteCheckTimer = setTimeout(() => checkRemote(false), 1500);
  }
});

async function checkRemote(announce) {
  if (state.offline) {
    toast('Prüfung bei Proton ist nur mit Anmeldung möglich', true);
    return;
  }
  const text = editor.getValue();
  const issues = await state.client.checkSieve(text);
  if (text !== editor.getValue()) return; // changed meanwhile
  state.remoteIssues = issues;
  editor.performLint();
  if (announce) toast(issues.length ? `Proton meldet ${issues.length} Problem(e)` : 'Proton: Skript ist gültig ✓', issues.length > 0);
  return issues;
}

// ---------- Filters ----------

const isEnabled = (f) => f.Status === 1;

function renderFilters() {
  const list = $('filter-list');
  list.replaceChildren(
    ...state.filters.map((f, index) => {
      const li = document.createElement('li');
      li.className = `${f.ID === state.selectedId ? 'selected' : ''} ${isEnabled(f) ? '' : 'disabled'}`;
      li.title = isEnabled(f) ? 'aktiv' : 'deaktiviert';

      const toggle = document.createElement('input');
      toggle.type = 'checkbox';
      toggle.checked = isEnabled(f);
      toggle.title = 'Aktivieren/Deaktivieren';
      toggle.addEventListener('click', (e) => e.stopPropagation());
      toggle.addEventListener('change', () => toggleFilter(f, toggle.checked));

      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = f.Name;

      const order = document.createElement('span');
      order.className = 'order';
      for (const [label, delta] of [['▲', -1], ['▼', 1]]) {
        const b = document.createElement('button');
        b.textContent = label;
        b.disabled = index + delta < 0 || index + delta >= state.filters.length;
        b.addEventListener('click', (e) => {
          e.stopPropagation();
          moveFilter(index, delta);
        });
        order.append(b);
      }

      li.append(toggle, name, order);
      li.addEventListener('click', () => selectFilter(f.ID));
      return li;
    }),
  );
}

function confirmDiscard() {
  return !state.dirty || confirm('Ungespeicherte Änderungen verwerfen?');
}

function loadIntoEditor(filter) {
  state.selectedId = filter?.ID ?? null;
  $('filter-name').value = filter?.Name ?? '';
  $('filter-enabled').checked = filter ? isEnabled(filter) : true;
  state.remoteIssues = [];
  editor.setValue(filter?.Sieve ?? newScript());
  editor.clearHistory();
  state.dirty = false;
  $('delete').disabled = !filter;
  renderFilters();
}

async function selectFilter(id) {
  if (id === state.selectedId || !confirmDiscard()) return;
  let filter = state.filters.find((f) => f.ID === id);
  if (!state.offline && filter && filter.Sieve === undefined) filter = await state.client.getFilter(id);
  loadIntoEditor(filter);
}

async function reloadFilters() {
  if (state.offline) {
    state.filters = (await storage.get('localFilters')) ?? [];
  } else {
    const [filters, folders, labels] = await Promise.all([
      state.client.listFilters(),
      state.client.listLabels(LABEL_TYPE.FOLDER).catch(() => []),
      state.client.listLabels(LABEL_TYPE.LABEL).catch(() => []),
    ]);
    state.filters = filters.sort((a, b) => (a.Priority ?? 0) - (b.Priority ?? 0));
    state.folders = folders.map((l) => l.Path ?? l.Name);
    state.labels = labels.map((l) => l.Path ?? l.Name);
  }
  const current = state.filters.find((f) => f.ID === state.selectedId) ?? state.filters[0] ?? null;
  state.dirty = false;
  loadIntoEditor(current);
}

async function saveLocal(filters) {
  state.filters = filters;
  await storage.set('localFilters', filters);
}

async function saveFilter() {
  const Name = $('filter-name').value.trim();
  if (!Name) throw new Error('Bitte einen Namen für den Filter angeben');
  const Sieve = editor.getValue();
  const Status = $('filter-enabled').checked ? 1 : 0;

  const errors = lintSieve(Sieve).filter((i) => i.severity === 'error');
  if (errors.length && !confirm(`Der Editor findet ${errors.length} Fehler. Trotzdem an Proton senden?`)) return;

  if (state.offline) {
    const ID = state.selectedId ?? `local-${Date.now()}`;
    const filter = { ID, Name, Sieve, Status };
    const exists = state.filters.some((f) => f.ID === ID);
    await saveLocal(exists ? state.filters.map((f) => (f.ID === ID ? filter : f)) : [...state.filters, filter]);
    state.dirty = false;
    loadIntoEditor(filter);
    toast('Lokal gespeichert');
    return;
  }

  const issues = await checkRemote(false);
  if (issues?.length) {
    toast(`Proton lehnt das Skript ab (${issues.length} Problem(e)) – siehe Liste unter dem Editor`, true);
    return;
  }
  const saved = state.selectedId
    ? await state.client.updateFilter(state.selectedId, { Name, Sieve, Status })
    : await state.client.createFilter({ Name, Sieve, Status });
  state.selectedId = saved?.ID ?? state.selectedId;
  state.dirty = false;
  await reloadFilters();
  toast(`„${Name}“ gespeichert`);
}

async function deleteFilter() {
  const filter = state.filters.find((f) => f.ID === state.selectedId);
  if (!filter || !confirm(`Filter „${filter.Name}“ wirklich löschen?`)) return;
  if (state.offline) await saveLocal(state.filters.filter((f) => f.ID !== filter.ID));
  else await state.client.deleteFilter(filter.ID);
  state.selectedId = null;
  state.dirty = false;
  await reloadFilters();
  toast(`„${filter.Name}“ gelöscht`);
}

async function toggleFilter(filter, enabled) {
  try {
    if (state.offline) {
      await saveLocal(state.filters.map((f) => (f.ID === filter.ID ? { ...f, Status: enabled ? 1 : 0 } : f)));
    } else {
      await state.client.setFilterEnabled(filter.ID, enabled);
      filter.Status = enabled ? 1 : 0;
    }
    if (filter.ID === state.selectedId) $('filter-enabled').checked = enabled;
    renderFilters();
  } catch (error) {
    toast(error.message, true);
    renderFilters();
  }
}

async function moveFilter(index, delta) {
  const filters = [...state.filters];
  const [moved] = filters.splice(index, 1);
  filters.splice(index + delta, 0, moved);
  try {
    if (state.offline) await saveLocal(filters);
    else await state.client.reorderFilters(filters.map((f) => f.ID));
    state.filters = filters;
    renderFilters();
  } catch (error) {
    toast(error.message, true);
  }
}

// ---------- Toolbar ----------

for (const [index, tpl] of TEMPLATES.entries()) {
  const opt = document.createElement('option');
  opt.value = String(index);
  opt.textContent = tpl.name;
  $('templates').append(opt);
}

$('templates').addEventListener('change', (e) => {
  const tpl = TEMPLATES[Number(e.target.value)];
  e.target.value = '';
  if (!tpl) return;
  const end = CodeMirror.Pos(editor.lastLine());
  const cursor = editor.getCursor();
  const atEnd = editor.somethingSelected() || cursor.line === 0 ? end : cursor;
  editor.replaceRange(`\n${tpl.body}\n`, atEnd);
  editor.setValue(fixRequire(editor.getValue()));
  editor.focus();
});

$('fix-require').addEventListener('click', () => {
  const fixed = fixRequire(editor.getValue());
  if (fixed === editor.getValue()) toast('require ist bereits vollständig');
  else {
    const cursor = editor.getCursor();
    editor.setValue(fixed);
    editor.setCursor(cursor);
    toast('require ergänzt');
  }
});

$('insert-guard').addEventListener('click', () => {
  const text = editor.getValue();
  if (text.includes('vnd.proton.spam-threshold')) {
    toast('Spam-Schutz ist bereits vorhanden');
    return;
  }
  const withGuard = /^\s*require\b[^;]*;/.test(text)
    ? text.replace(/^(\s*require\b[^;]*;)/, `$1\n\n${SPAM_GUARD}\n`)
    : `require ${formatList(SPAM_GUARD_REQUIRE)};\n\n${SPAM_GUARD}\n\n${text}`;
  // the guard's extensions go first in the single require
  editor.setValue(fixRequire(mergeRequire(withGuard, SPAM_GUARD_REQUIRE)));
});

function mergeRequire(text, extensions) {
  return text.replace(/^(\s*)require\s*(\[[^\]]*\]|"[^"]*")\s*;/, (_, ws, list) => {
    const existing = [...list.matchAll(/"([^"]*)"/g)].map((m) => m[1]);
    const names = [...extensions, ...existing.filter((e) => !extensions.includes(e))];
    return `${ws}require ${formatList(names)};`;
  });
}

$('copy').addEventListener('click', async () => {
  await navigator.clipboard.writeText(editor.getValue());
  toast('Skript in die Zwischenablage kopiert');
});

$('check').addEventListener('click', (e) => busy(e.currentTarget, () => checkRemote(true)));
$('save').addEventListener('click', (e) => busy(e.currentTarget, saveFilter));
$('delete').addEventListener('click', (e) => busy(e.currentTarget, deleteFilter));
$('reload').addEventListener('click', (e) => confirmDiscard() && busy(e.currentTarget, reloadFilters));
$('new-filter').addEventListener('click', () => {
  if (!confirmDiscard()) return;
  loadIntoEditor(null);
  $('filter-name').focus();
});
$('filter-name').addEventListener('input', () => (state.dirty = true));
$('filter-enabled').addEventListener('change', () => (state.dirty = true));

window.addEventListener('beforeunload', (e) => {
  if (state.dirty) e.preventDefault();
});

// ---------- Login flow ----------

function sessionStore() {
  return { load: () => storage.get('session'), save: (s) => storage.set('session', s) };
}

async function makeClient() {
  const settings = { ...DEFAULT_SETTINGS, ...((await storage.get('settings')) ?? {}) };
  return new ProtonClient({ bcrypt: window.dcodeIO.bcrypt, store: sessionStore(), settings });
}

async function enterApp() {
  state.offline = false;
  $('offline-note').hidden = true;
  $('check').hidden = false;
  $('account').textContent = state.client.session?.username ?? '';
  $('logout').hidden = false;
  show('app');
  await reloadFilters();
}

async function enterOffline() {
  state.offline = true;
  $('offline-note').hidden = false;
  $('check').hidden = true;
  $('account').textContent = 'Offline';
  $('logout').hidden = false;
  show('app');
  await reloadFilters();
}

async function attemptLogin(humanVerification) {
  const { username, password } = state.pendingLogin;
  try {
    const { twoFactor } = await state.client.login(username, password, humanVerification);
    if (twoFactor) {
      show('2fa');
      $('totp').value = '';
      $('totp').focus();
      return;
    }
    state.pendingLogin = null;
    await enterApp();
  } catch (error) {
    if (error.needsHumanVerification) {
      startCaptcha(error.details ?? {});
      return;
    }
    throw error;
  }
}

function startCaptcha(details) {
  const methods = details.HumanVerificationMethods ?? [];
  if (!methods.includes('captcha')) {
    show('login');
    toast(`Proton verlangt eine Verifizierung per ${methods.join('/') || 'unbekannter Methode'}. Bitte einmal im Proton-Web-Login anmelden und es danach erneut versuchen.`, true);
    return;
  }
  const dark = matchMedia('(prefers-color-scheme: dark)').matches;
  const url = state.client.captchaUrl(details.HumanVerificationToken, dark);
  const frame = $('captcha-frame');
  frame.src = url.toString();
  show('captcha');

  const onMessage = (event) => {
    if (event.origin !== url.origin || event.source !== frame.contentWindow || !event.data) return;
    if (event.data.type === 'pm_height') frame.style.height = `${event.data.height + 40}px`;
    if (event.data.type === 'pm_captcha') {
      window.removeEventListener('message', onMessage);
      frame.src = 'about:blank';
      attemptLogin({ token: event.data.token, type: 'captcha' }).catch((error) => {
        show('login');
        toast(error.message, true);
      });
    }
  };
  window.addEventListener('message', onMessage);
}

$('login-form').addEventListener('submit', (e) => {
  e.preventDefault();
  busy($('login-submit'), async () => {
    const settings = {
      apiBase: $('api-base').value.trim() || DEFAULT_SETTINGS.apiBase,
      appVersion: $('app-version').value.trim() || DEFAULT_SETTINGS.appVersion,
    };
    await storage.set('settings', settings);
    state.client = await makeClient();
    state.pendingLogin = { username: $('username').value.trim(), password: $('password').value };
    $('password').value = '';
    await attemptLogin();
  });
});

$('totp-form').addEventListener('submit', (e) => {
  e.preventDefault();
  busy(e.submitter ?? e.target.querySelector('button'), async () => {
    await state.client.submitTotp($('totp').value);
    state.pendingLogin = null;
    await enterApp();
  });
});

for (const back of document.querySelectorAll('[data-back]')) {
  back.addEventListener('click', () => {
    state.pendingLogin = null;
    $('captcha-frame').src = 'about:blank';
    show('login');
  });
}

$('offline').addEventListener('click', () => enterOffline().catch((e) => toast(e.message, true)));

$('logout').addEventListener('click', async () => {
  if (!confirmDiscard()) return;
  if (!state.offline) await state.client.logout();
  state.filters = [];
  state.dirty = false;
  $('logout').hidden = true;
  $('account').textContent = '';
  show('login');
});

// ---------- Start ----------

(async () => {
  const settings = { ...DEFAULT_SETTINGS, ...((await storage.get('settings')) ?? {}) };
  $('api-base').value = settings.apiBase;
  $('app-version').value = settings.appVersion;
  state.client = await makeClient();
  if (await state.client.restore()) {
    try {
      await enterApp();
      return;
    } catch (error) {
      toast(`Sitzung konnte nicht fortgesetzt werden: ${error.message}`, true);
    }
  }
  show('login');
})();
