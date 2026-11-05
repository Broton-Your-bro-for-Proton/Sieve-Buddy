import { t } from '../lib/i18n.js';
import { fixRequire, getCompletions, lintSieve } from '../lib/sieve-analyzer.js';
import { PROTON_DIALECT, SPAM_GUARD, SPAM_GUARD_REQUIRE, formatList, newScript } from '../lib/sieve-dialect.js';
import { findOverlaps } from '../lib/sieve-rules.js';
import {
  $,
  busy,
  capabilitiesOf,
  dialectOf,
  loadAccountData,
  loadSettings,
  makeClient,
  pushHistory,
  requestOrigin,
  setServiceMode,
  storage,
  toast,
} from '../shared/env.js';
import { DEFAULT_SETTINGS } from '../lib/proton-api.js';
import { installHandover } from './handover.js';
import { confirmDiff, installTools } from './tools.js';

const CodeMirror = window.CodeMirror;

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
  dialect: PROTON_DIALECT, // Proton, or the server behind the service
  caps: capabilitiesOf(null),
  foldersKnown: true,
};

function show(view) {
  for (const v of ['login', '2fa', 'captcha', 'app']) $(`view-${v}`).hidden = v !== view;
  if (view === 'app') editor.refresh();
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

const tools = installTools(editor, state);

function annotations(text) {
  const toPos = (i) => editor.posFromIndex(i);
  const folders = state.offline || !state.foldersKnown ? undefined : [...state.folders, ...state.labels];
  const local = lintSieve(text, { folders, dialect: state.dialect }).map((i) => ({
    from: toPos(i.start),
    to: toPos(Math.max(i.end, i.start + 1)),
    message: i.message,
    severity: i.severity,
  }));
  const remote = state.remoteIssues.map((i) => ({
    from: i.from ?? CodeMirror.Pos(0, 0),
    to: i.to ?? i.from ?? CodeMirror.Pos(0, 1),
    message: `${state.dialect.proton ? 'Proton' : 'Server'}: ${i.message ?? JSON.stringify(i)}`,
    severity: i.severity ?? 'error',
  }));
  const overlaps = findOverlaps(text).map((o) => ({
    from: toPos(o.start),
    to: toPos(o.end),
    severity: 'warning',
    message: {
      duplicate: t('„{value}“ steht schon in Zeile {line} mit derselben Aktion (doppelt)', { value: o.value, line: o.otherLine }),
      conflict: t('„{value}“ steht schon in Zeile {line} mit anderer Aktion – das Ergebnis hängt von der Reihenfolge ab', { value: o.value, line: o.otherLine }),
      domain: t('„{value}“ ist schon durch die Domain-Regel in Zeile {line} abgedeckt', { value: o.value, line: o.otherLine }),
    }[o.kind],
  }));
  const all = [...local, ...overlaps, ...remote];
  renderProblems(all);
  return all;
}

function renderProblems(list) {
  const box = $('problems');
  box.replaceChildren(
    ...list.map((p) => {
      const div = document.createElement('div');
      div.className = p.severity;
      div.textContent = t('Zeile {line}: {message}', { line: p.from.line + 1, message: p.message });
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
  const result = getCompletions(cm.getValue(), cursor, { folders: state.folders, labels: state.labels, dialect: state.dialect });
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
    toast(t('Prüfung bei Proton ist nur mit Anmeldung möglich'), true);
    return;
  }
  const text = editor.getValue();
  const issues = await state.client.checkSieve(text);
  if (text !== editor.getValue()) return; // changed meanwhile
  state.remoteIssues = issues;
  editor.performLint();
  if (announce) toast(issues.length ? t('Proton meldet {count} Problem(e)', { count: issues.length }) : t('Proton: Skript ist gültig ✓'), issues.length > 0);
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
      li.title = isEnabled(f) ? t('aktiv') : t('deaktiviert');

      const toggle = document.createElement('input');
      toggle.type = 'checkbox';
      toggle.checked = isEnabled(f);
      toggle.title = t('Aktivieren/Deaktivieren');
      toggle.addEventListener('click', (e) => e.stopPropagation());
      toggle.addEventListener('change', () => toggleFilter(f, toggle.checked));

      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = f.Name;

      const order = document.createElement('span');
      order.className = 'order';
      order.hidden = !state.caps.ordering;
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
  return !state.dirty || confirm(t('Ungespeicherte Änderungen verwerfen?'));
}

function loadIntoEditor(filter) {
  state.selectedId = filter?.ID ?? null;
  $('filter-name').value = filter?.Name ?? '';
  // with a single active script (ManageSieve) a new script would replace the running one – so not by default
  $('filter-enabled').checked = filter ? isEnabled(filter) : state.caps.multipleActive;
  state.remoteIssues = [];
  editor.setValue(filter?.Sieve ?? newScript('', state.dialect));
  editor.clearHistory();
  state.dirty = false;
  $('delete').disabled = !filter;
  renderFilters();
  tools.renderOutline();
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
    const account = await loadAccountData(state.client);
    state.filters = account.filters;
    state.folders = account.folders;
    state.labels = account.labels;
    state.foldersKnown = account.foldersKnown !== false;
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
  if (!Name) throw new Error(t('Bitte einen Namen für den Filter angeben'));
  const Sieve = editor.getValue();
  const Status = $('filter-enabled').checked ? 1 : 0;

  const errors = lintSieve(Sieve, { dialect: state.dialect }).filter((i) => i.severity === 'error');
  if (errors.length && !confirm(t('Der Editor findet {count} Fehler. Trotzdem an Proton senden?', { count: errors.length }))) return;

  const previous = state.filters.find((f) => f.ID === state.selectedId);
  if (previous && previous.Sieve !== Sieve && !(await confirmDiff(previous.Sieve ?? '', Sieve, t('„{name}“ speichern', { name: Name })))) return;
  if (previous) await pushHistory(previous.ID, previous.Name, previous.Sieve);

  if (state.offline) {
    const ID = state.selectedId ?? `local-${Date.now()}`;
    const filter = { ID, Name, Sieve, Status };
    const exists = state.filters.some((f) => f.ID === ID);
    await saveLocal(exists ? state.filters.map((f) => (f.ID === ID ? filter : f)) : [...state.filters, filter]);
    state.dirty = false;
    loadIntoEditor(filter);
    toast(t('Lokal gespeichert'));
    return;
  }

  const issues = await checkRemote(false);
  if (issues?.length) {
    toast(t('Proton lehnt das Skript ab ({count} Problem(e)) – siehe Liste unter dem Editor', { count: issues.length }), true);
    return;
  }
  const saved = state.selectedId
    ? await state.client.updateFilter(state.selectedId, { Name, Sieve, Status })
    : await state.client.createFilter({ Name, Sieve, Status });
  state.selectedId = saved?.ID ?? state.selectedId;
  state.dirty = false;
  await reloadFilters();
  toast(t('„{name}“ gespeichert', { name: Name }));
}

async function deleteFilter() {
  const filter = state.filters.find((f) => f.ID === state.selectedId);
  if (!filter || !confirm(t('Filter „{name}“ wirklich löschen?', { name: filter.Name }))) return;
  if (state.offline) await saveLocal(state.filters.filter((f) => f.ID !== filter.ID));
  else await state.client.deleteFilter(filter.ID);
  state.selectedId = null;
  state.dirty = false;
  await reloadFilters();
  toast(t('„{name}“ gelöscht', { name: filter.Name }));
}

async function toggleFilter(filter, enabled) {
  try {
    if (state.offline) {
      await saveLocal(state.filters.map((f) => (f.ID === filter.ID ? { ...f, Status: enabled ? 1 : 0 } : f)));
    } else {
      await state.client.setFilterEnabled(filter.ID, enabled);
      filter.Status = enabled ? 1 : 0;
      // ManageSieve: activating one script deactivates the others
      if (!state.caps.multipleActive) {
        await reloadFilters();
        return;
      }
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

$('fix-require').addEventListener('click', () => {
  const fixed = fixRequire(editor.getValue());
  if (fixed === editor.getValue()) toast(t('require ist bereits vollständig'));
  else {
    const cursor = editor.getCursor();
    editor.setValue(fixed);
    editor.setCursor(cursor);
    toast(t('require ergänzt'));
  }
});

$('insert-guard').addEventListener('click', () => {
  const text = editor.getValue();
  if (text.includes('vnd.proton.spam-threshold')) {
    toast(t('Spam-Schutz ist bereits vorhanden'));
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
  toast(t('Skript in die Zwischenablage kopiert'));
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

// ---------- Drafts from "Sieve-Regel aus Mail" ----------

async function loadDraft() {
  const draft = await storage.get('draft');
  if (!draft || Date.now() - draft.at > 30 * 60 * 1000) return;
  await storage.set('draft', null);
  const filter = state.filters.find((f) => f.ID === draft.filterId) ?? null;
  if (draft.sieve === undefined) {
    // only a position: open the filter at that rule
    if (!filter) return;
    if (filter.ID !== state.selectedId) loadIntoEditor(filter);
  } else {
    loadIntoEditor(filter);
    if (!filter) $('filter-name').value = draft.name ?? '';
    editor.setValue(draft.sieve);
    state.dirty = true;
    toast(t('Entwurf aus „Sieve-Regel aus Mail“ geladen – prüfen und speichern'));
  }
  if (draft.line) {
    const pos = { line: draft.line - 1, ch: 0 };
    editor.focus();
    editor.setCursor(pos);
    editor.scrollIntoView(pos, 120);
  }
}

globalThis.browser?.storage?.onChanged.addListener((changes) => {
  if (changes.draft?.newValue && !$('view-app').hidden && confirmDiscard()) loadDraft();
});

// ---------- Login flow ----------

async function enterApp() {
  state.offline = false;
  state.dialect = dialectOf(state.client);
  state.caps = capabilitiesOf(state.client);
  const via = state.client.viaService;
  const serverName = via ? (state.client.kind === 'managesieve' ? 'ManageSieve' : 'Proton') : 'Proton';
  $('offline-note').hidden = true;
  $('check').hidden = false;
  $('check').textContent = serverName === 'Proton' ? t('Bei Proton prüfen') : t('Bei Server prüfen');
  $('insert-guard').hidden = !state.dialect.proton;
  $('account').textContent = `${state.client.session?.username ?? ''}${via ? ` · ${t('über Dienst ({server})', { server: serverName })}` : ''}`;
  $('logout').hidden = false;
  $('logout').textContent = via ? t('Dienst trennen') : t('Abmelden');
  $('handover').hidden = via;
  show('app');
  await reloadFilters();
  await loadDraft();
}

async function enterOffline() {
  state.offline = true;
  state.dialect = PROTON_DIALECT;
  state.caps = capabilitiesOf(null);
  $('offline-note').hidden = false;
  $('check').hidden = true;
  $('account').textContent = t('Offline');
  $('logout').hidden = false;
  $('handover').hidden = true;
  show('app');
  await reloadFilters();
  await loadDraft();
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
    toast(
      methods.length
        ? t('Proton verlangt eine Verifizierung per {method}. Bitte einmal im Proton-Web-Login anmelden und es danach erneut versuchen.', { method: methods.join('/') })
        : t('Proton verlangt eine Verifizierung per unbekannter Methode. Bitte einmal im Proton-Web-Login anmelden und es danach erneut versuchen.'),
      true,
    );
    return;
  }
  // Like Proton Bridge: the user solves the captcha on verify.proton.me in the system browser,
  // which marks the HumanVerificationToken as verified; then we retry the login with that token.
  captcha.token = details.HumanVerificationToken;
  captcha.type = methods.join(',');
  captcha.url = details.WebUrl || `https://verify.proton.me/?methods=captcha&token=${encodeURIComponent(captcha.token)}`;
  show('captcha');
  openVerification().catch((error) => toast(t('Verifizierungsseite konnte nicht geöffnet werden: {message}', { message: error.message }), true));
}

const captcha = { token: null, type: null, url: null };

async function openVerification() {
  if (globalThis.browser?.windows?.openDefaultBrowser) await browser.windows.openDefaultBrowser(captcha.url);
  else window.open(captcha.url, '_blank', 'noopener');
}

function resetCaptcha() {
  captcha.token = captcha.type = captcha.url = null;
}

$('login-form').addEventListener('submit', (e) => {
  e.preventDefault();
  busy($('login-submit'), async () => {
    const settings = {
      ...(await loadSettings()),
      mode: 'proton',
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
    resetCaptcha();
    show('login');
  });
}

$('captcha-reopen').addEventListener('click', () => {
  if (captcha.url) openVerification().catch((e) => toast(e.message, true));
});

$('captcha-continue').addEventListener('click', (e) =>
  busy(e.currentTarget, async () => {
    if (!captcha.token) return;
    const hv = { token: captcha.token, type: captcha.type };
    resetCaptcha();
    await attemptLogin(hv);
  }),
);

$('offline').addEventListener('click', () => enterOffline().catch((e) => toast(e.message, true)));

async function connectService(url, token) {
  const origin = await requestOrigin(url);
  await setServiceMode({ url: origin, token });
  state.client = await makeClient();
  if (!(await state.client.restore())) {
    const why = state.client.status?.error ?? (state.client.kind === 'proton' ? t('Der Dienst hat noch keine Proton-Sitzung – erst hier anmelden und „An Dienst übergeben“') : t('Der Dienst ist nicht mit seinem Mailserver verbunden'));
    throw new Error(why);
  }
  await enterApp();
}

$('service-form').addEventListener('submit', (e) => {
  e.preventDefault();
  busy($('service-submit'), () => connectService($('service-url').value.trim(), $('service-token').value.trim()));
});

installHandover({
  getClient: () => state.client,
  // after the hand-over the add-on keeps working – now through the service that holds the session
  onHandedOver: async ({ url, token }) => {
    state.dirty = false;
    try {
      await connectService(url, token);
    } catch (error) {
      toast(error.message, true);
      show('login');
    }
  },
});

$('logout').addEventListener('click', async () => {
  if (!confirmDiscard()) return;
  if (state.client?.viaService) await setServiceMode(null);
  else if (!state.offline) await state.client.logout();
  state.client = await makeClient();
  state.filters = [];
  state.dirty = false;
  $('logout').hidden = true;
  $('handover').hidden = true;
  $('account').textContent = '';
  show('login');
});

// ---------- Start ----------

(async () => {
  const settings = await loadSettings();
  $('api-base').value = settings.apiBase;
  $('app-version').value = settings.appVersion;
  $('service-url').value = settings.serviceUrl ?? 'http://localhost:8080';
  $('service-token').value = settings.serviceToken ?? '';
  state.client = await makeClient();
  let restored = false;
  try {
    restored = await state.client.restore();
  } catch (error) {
    toast(error.message, true);
  }
  if (restored) {
    try {
      await enterApp();
      return;
    } catch (error) {
      toast(t('Sitzung konnte nicht fortgesetzt werden: {message}', { message: error.message }), true);
    }
  }
  show('login');
})();
