// Shared by the manager and the rule-from-mail page: storage, Proton session, toasts, diff rendering.

import { diffHunks, diffStats, lineDiff } from '../lib/diff.js';
import { LoginGuard } from '../lib/login-guard.js';
import { DEFAULT_SETTINGS, LABEL_TYPE, ProtonClient } from '../lib/proton-api.js';
import { ServiceClient } from '../lib/service-client.js';
import { makeDialect } from '../lib/sieve-dialect.js';

export const $ = (id) => document.getElementById(id);

// browser.storage.local in Thunderbird, localStorage when a page is opened outside the add-on (preview)
export const storage = globalThis.browser?.storage?.local
  ? {
      get: async (key) => (await browser.storage.local.get(key))[key] ?? null,
      set: (key, value) => (value === null ? browser.storage.local.remove(key) : browser.storage.local.set({ [key]: value })),
    }
  : {
      get: async (key) => JSON.parse(localStorage.getItem(`proton-sieve:${key}`) ?? 'null'),
      set: async (key, value) =>
        value === null ? localStorage.removeItem(`proton-sieve:${key}`) : localStorage.setItem(`proton-sieve:${key}`, JSON.stringify(value)),
    };

export async function loadSettings() {
  return { ...DEFAULT_SETTINGS, ...((await storage.get('settings')) ?? {}) };
}

/**
 * The connection the add-on uses: Proton directly (default) or the user's Sieve service
 * (settings.mode === 'service'), which may be connected to Proton or to any ManageSieve server.
 */
export async function makeClient() {
  const settings = await loadSettings();
  if (settings.mode === 'service' && settings.serviceUrl) {
    return new ServiceClient({ baseUrl: settings.serviceUrl, token: settings.serviceToken ?? '' });
  }
  return new ProtonClient({
    bcrypt: window.dcodeIO.bcrypt,
    store: { load: () => storage.get('session'), save: (s) => storage.set('session', s) },
    settings,
    guard: new LoginGuard({ load: () => storage.get('loginGuard'), save: (s) => storage.set('loginGuard', s) }),
    onApiError: ({ method, path, status, code, message }) => console.warn(`[proton] ${method} ${path} → HTTP ${status}, Code ${code ?? '-'}: ${message ?? ''}`),
  });
}

/** Switches the add-on to "through my service" (or back to Proton directly with null). */
export async function setServiceMode(service) {
  const settings = await loadSettings();
  if (service) await storage.set('settings', { ...settings, mode: 'service', serviceUrl: service.url, serviceToken: service.token });
  else await storage.set('settings', { ...settings, mode: 'proton' });
}

/** Asks Thunderbird for access to the service's origin (optional host permission). */
export async function requestOrigin(url) {
  const origin = new URL(url).origin;
  if (!globalThis.browser?.permissions) return origin; // preview outside Thunderbird
  if (!(await browser.permissions.request({ origins: [`${origin}/*`] }))) throw new Error('Zugriff auf den Dienst wurde nicht erlaubt');
  return origin;
}

/** The Sieve dialect of the current connection (Proton unless the service reports another server). */
export const dialectOf = (client) => makeDialect(client?.capabilities?.dialect ?? { name: 'proton' });

/** How the connection behaves: several active filters? ordering? labels? */
export const capabilitiesOf = (client) => client?.capabilities ?? { multipleActive: true, ordering: true, labels: true, semantics: 'proton' };

/** Filters with their Sieve text (the list endpoint may omit it) plus folder and label paths. */
export async function loadAccountData(client) {
  if (client.loadAccountData) return client.loadAccountData();
  const [filters, folders, labels] = await Promise.all([
    client.listFilters(),
    client.listLabels(LABEL_TYPE.FOLDER).catch(() => []),
    client.listLabels(LABEL_TYPE.LABEL).catch(() => []),
  ]);
  const full = await Promise.all(filters.map(async (f) => (f.Sieve === undefined ? client.getFilter(f.ID) : f)));
  return {
    filters: full.sort((a, b) => (a.Priority ?? 0) - (b.Priority ?? 0)),
    folders: folders.map((l) => l.Path ?? l.Name),
    labels: labels.map((l) => l.Path ?? l.Name),
  };
}

/** Filters in the shape the simulator and merge logic expect. */
export const asScripts = (filters) => filters.map((f) => ({ id: f.ID, name: f.Name, sieve: f.Sieve ?? '', enabled: f.Status === 1 }));

// ---------- versions ----------

const HISTORY_LIMIT = 25;

export async function pushHistory(filterId, name, sieve) {
  if (!filterId || !sieve) return;
  const key = `history:${filterId}`;
  const list = (await storage.get(key)) ?? [];
  if (list[0]?.sieve === sieve) return;
  list.unshift({ at: new Date().toISOString(), name, sieve });
  await storage.set(key, list.slice(0, HISTORY_LIMIT));
}

export const getHistory = async (filterId) => (filterId ? ((await storage.get(`history:${filterId}`)) ?? []) : []);

// ---------- UI helpers ----------

let toastTimer;
export function toast(message, isError = false) {
  const el = $('toast');
  el.textContent = message;
  el.className = isError ? 'toast error' : 'toast';
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), isError ? 7000 : 3000);
}

export async function busy(button, fn) {
  if (button) button.disabled = true;
  try {
    return await fn();
  } catch (error) {
    console.error(error);
    toast(error.message || String(error), true);
  } finally {
    if (button) button.disabled = false;
  }
}

export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (k in node) node[k] = v;
    else node.setAttribute(k, v);
  }
  node.append(...children.flat().filter((c) => c !== null && c !== undefined && c !== false));
  return node;
}

/** Renders a compact diff (changed lines with context) into a container. Returns {added, removed}. */
export function renderDiff(container, before, after) {
  const diff = lineDiff(before, after);
  const stats = diffStats(diff);
  const hunks = diffHunks(diff, 2);
  container.replaceChildren(
    ...(hunks.length
      ? hunks.flatMap((hunk, i) => [
          i ? el('div', { class: 'diff-gap' }, '⋯') : null,
          ...hunk.map((d) =>
            el(
              'div',
              { class: `diff-line diff-${d.type}` },
              el('span', { class: 'diff-num' }, String(d.newLine ?? d.oldLine ?? '')),
              el('span', { class: 'diff-sign' }, d.type === 'add' ? '+' : d.type === 'del' ? '−' : ' '),
              el('span', { class: 'diff-text' }, d.text || ' '),
            ),
          ),
        ]).filter(Boolean)
      : [el('div', { class: 'muted' }, 'Keine Änderungen')]),
  );
  return stats;
}

/** Minimal modal built on <dialog>. Resolves with the value passed to close(), or null when cancelled. */
export function openModal({ title, body, actions = [], wide = false }) {
  return new Promise((resolve) => {
    const dialog = el('dialog', { class: `modal${wide ? ' wide' : ''}` });
    const close = (value = null) => {
      dialog.close();
      dialog.remove();
      resolve(value);
    };
    const buttons = actions.map((a) =>
      el('button', { class: a.class ?? '', type: 'button', onclick: () => (a.onClick ? a.onClick(close) : close(a.value ?? null)) }, a.label),
    );
    dialog.append(
      el('header', { class: 'modal-head' }, el('h2', {}, title), el('button', { class: 'ghost small', type: 'button', onclick: () => close(null) }, '✕')),
      el('div', { class: 'modal-body' }, body),
      buttons.length ? el('footer', { class: 'modal-foot' }, buttons) : '',
    );
    dialog.addEventListener('cancel', (e) => {
      e.preventDefault();
      close(null);
    });
    document.body.append(dialog);
    dialog.showModal();
  });
}

/** Describes a simulation result in one line. */
export function describeSimulation(result) {
  const parts = [`landet in „${result.location}“`];
  if (result.labels.length) parts.push(`Labels: ${result.labels.join(', ')}`);
  if (result.flags.includes('\\Seen')) parts.push('als gelesen');
  if (result.flags.includes('\\Flagged')) parts.push('mit Stern');
  if (result.expireDays) parts.push(`wird nach ${result.expireDays} Tagen gelöscht`);
  if (result.vacation) parts.push('Abwesenheitsnotiz wird gesendet');
  return parts.join(' · ');
}
