// JMAP for Sieve (RFC 9661, urn:ietf:params:jmap:sieve) as a Sieve provider, same interface as
// ManageSieveProvider. Scripts are identified by their server id; only one script is active at a time.
// Script contents travel as blobs (upload/download), folders come from Mailbox/get when the account has mail.

import { t } from '../../../addon/lib/i18n.js';

const SIEVE = 'urn:ietf:params:jmap:sieve';
const MAIL = 'urn:ietf:params:jmap:mail';
const CORE = 'urn:ietf:params:jmap:core';
const CHECK_NAME = '.proton-sieve-check';

export class JmapError extends Error {
  constructor(message, { type } = {}) {
    super(message);
    this.type = type;
  }
}

const setError = (e) => new JmapError(e.description || e.type, { type: e.type });

/** Stalwart: "Expected token … at line 2, column 1." → [{line: 2, message}] */
const issues = (message) => [{ line: Number(/line (\d+)/i.exec(message)?.[1]) || null, message }];

export class JmapProvider {
  /** @param {{url: string, token: string, user?: string}} config  url = JMAP session resource */
  constructor(config) {
    this.config = config;
    this.kind = 'jmap';
    this.capabilities = {
      dialect: { name: 'rfc', extensions: [] },
      multipleActive: false, // RFC 9661: at most one active script
      ordering: false,
      labels: false,
      serverCheck: true,
      semantics: 'rfc',
      implementation: null,
    };
    this.session = null;
    this.isReady = false;
  }

  #auth() {
    const { user, token } = this.config;
    return user ? `Basic ${Buffer.from(`${user}:${token}`).toString('base64')}` : `Bearer ${token}`;
  }

  async #fetch(url, init = {}) {
    // relative URLs of the session resolve against where the session really came from (after redirects)
    const res = await fetch(new URL(url, this.session?.base ?? this.config.url), { ...init, headers: { Authorization: this.#auth(), ...init.headers } });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      let detail = '';
      try {
        detail = String(JSON.parse(body).detail ?? '');
      } catch {}
      // a proxy's HTML error page is no message
      throw new JmapError(`HTTP ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`, { type: `http${res.status}` });
    }
    return res;
  }

  async #connect() {
    // fetch refuses such URLs with the full URL, password included, in its error message
    const url = new URL(this.config.url);
    if (url.username || url.password) throw new JmapError(t('JMAP_URL must not contain a user name or password, use JMAP_USER and JMAP_TOKEN'));
    const res = await this.#fetch(this.config.url);
    const session = await res.json();
    const accountId = session.primaryAccounts?.[SIEVE];
    const caps = session.accounts?.[accountId]?.accountCapabilities?.[SIEVE];
    if (!caps) throw new JmapError(t('The JMAP server does not offer Sieve (urn:ietf:params:jmap:sieve)'));
    // the token goes along to every URL of the session: never in plain text when the session came over https
    if (new URL(res.url).protocol === 'https:') {
      for (const key of ['apiUrl', 'uploadUrl', 'downloadUrl']) {
        if (session[key] && new URL(session[key].replace(/[{}]/g, ''), res.url).protocol !== 'https:') throw new JmapError(t('JMAP: {key} points to an unencrypted address (behind a TLS proxy, set the public https URL in the server)', { key }));
      }
    }
    this.session = { ...session, base: res.url, accountId, mailAccountId: session.primaryAccounts[MAIL] ?? null };
    this.capabilities = {
      ...this.capabilities,
      dialect: { name: 'rfc', extensions: (caps.sieveExtensions ?? []).map((e) => e.toLowerCase()) },
      implementation: caps.implementation ?? session.capabilities[SIEVE]?.implementation ?? null,
    };
  }

  /** Runs method calls in one request; returns the responses in order, throwing on method errors. */
  async #call(calls, using = [SIEVE]) {
    if (!this.session) await this.#connect();
    const body = { using: [CORE, ...using], methodCalls: calls.map(([name, args], i) => [name, args, `c${i}`]) };
    const res = await this.#fetch(this.session.apiUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const { methodResponses } = await res.json();
    return methodResponses.map(([name, args]) => {
      if (name === 'error') throw new JmapError(args.description || args.type, { type: args.type });
      return args;
    });
  }

  async #upload(sieve) {
    if (!this.session) await this.#connect();
    const url = this.session.uploadUrl.replace('{accountId}', encodeURIComponent(this.session.accountId));
    const res = await this.#fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/sieve' }, body: Buffer.from(sieve, 'utf8') });
    return (await res.json()).blobId;
  }

  async #download(blobId, name) {
    const url = this.session.downloadUrl
      .replace('{accountId}', encodeURIComponent(this.session.accountId))
      .replace('{blobId}', encodeURIComponent(blobId))
      .replace('{type}', encodeURIComponent('application/sieve'))
      .replace('{name}', encodeURIComponent(name || 'script.sieve'));
    return (await this.#fetch(url)).text();
  }

  async #set(args) {
    if (!this.session) await this.#connect();
    const [r] = await this.#call([['SieveScript/set', { accountId: this.session.accountId, ...args }]]);
    for (const group of [r.notCreated, r.notUpdated, r.notDestroyed]) {
      const first = group && Object.values(group)[0];
      if (first) throw setError(first);
    }
    return r;
  }

  async #list() {
    if (!this.session) await this.#connect();
    const [r] = await this.#call([['SieveScript/get', { accountId: this.session.accountId, ids: null }]]);
    return r.list;
  }

  async #find(id) {
    const current = (await this.#list()).find((s) => s.id === id);
    if (!current) throw new JmapError(t('Script “{id}” not found', { id }), { type: 'notFound' });
    return current;
  }

  /** Fetches the session once to learn the capabilities and verify the token. */
  async init() {
    this.session = null;
    await this.#connect();
    this.isReady = true;
    return this.capabilities;
  }

  async listScripts() {
    const scripts = [];
    for (const s of (await this.#list()).filter((x) => x.name !== CHECK_NAME)) {
      scripts.push({ id: s.id, name: s.name, enabled: s.isActive, sieve: await this.#download(s.blobId, s.name) });
    }
    // the active script first: it is the one that runs
    return scripts.sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.name.localeCompare(b.name));
  }

  async createScript({ name, sieve, enabled = false }) {
    if ((await this.#list()).some((s) => s.name === name)) throw new JmapError(t('A script “{name}” already exists', { name }), { type: 'alreadyExists' });
    const blobId = await this.#upload(sieve);
    const r = await this.#set({ create: { new: { name, blobId } }, ...(enabled && { onSuccessActivateScript: '#new' }) });
    return { id: r.created.new.id, name };
  }

  async updateScript(id, { name, sieve, enabled }) {
    const current = await this.#find(id);
    const patch = {};
    if (sieve !== undefined) patch.blobId = await this.#upload(sieve);
    if (name && name !== current.name) patch.name = name;
    const args = Object.keys(patch).length ? { update: { [id]: patch } } : {};
    if (enabled === true && !current.isActive) args.onSuccessActivateScript = id;
    if (enabled === false && current.isActive) args.onSuccessDeactivateScript = true;
    if (Object.keys(args).length) await this.#set(args);
    return { id, name: patch.name ?? current.name };
  }

  async deleteScript(id) {
    const current = await this.#find(id);
    // an active script cannot be destroyed, and onSuccessDeactivateScript only runs after the destroy
    if (current.isActive) await this.#set({ onSuccessDeactivateScript: true });
    try {
      await this.#set({ destroy: [id] });
    } catch (error) {
      // the delete failed: the script must not stay switched off
      if (current.isActive) await this.#set({ onSuccessActivateScript: id }).catch(() => {});
      throw error;
    }
  }

  async setEnabled(id, enabled) {
    const current = await this.#find(id); // an unknown id must fail, not silently change nothing
    if (enabled) await this.#set({ onSuccessActivateScript: id });
    else if (current.isActive) await this.#set({ onSuccessDeactivateScript: true });
  }

  async reorder() {
    throw new Error(t('JMAP Sieve has no ordering: exactly one script is active'));
  }

  async check(sieve) {
    const blobId = await this.#upload(sieve);
    try {
      const [r] = await this.#call([['SieveScript/validate', { accountId: this.session.accountId, blobId }]]);
      return r.error ? issues(r.error.description || r.error.type) : [];
    } catch (error) {
      if (error.type !== 'unknownMethod') throw error;
    }
    // servers without SieveScript/validate: create under a temporary name and remove it again;
    // a leftover from an earlier failed cleanup would block every later check, so it goes first
    const leftover = (await this.#list()).find((s) => s.name === CHECK_NAME);
    if (leftover) await this.#set({ destroy: [leftover.id] });
    try {
      const r = await this.#set({ create: { check: { name: CHECK_NAME, blobId } } });
      await this.#set({ destroy: [r.created.check.id] }).catch(() => {});
      return [];
    } catch (error) {
      if (/^invalid(Sieve|Script)$/.test(error.type)) return issues(error.message);
      throw error;
    }
  }

  /** Folder paths from Mailbox/get, "/"-separated; null when the account has no mail capability. */
  async listFolders() {
    if (!this.session) await this.#connect();
    const accountId = this.session.mailAccountId;
    if (!accountId) return null;
    const [r] = await this.#call([['Mailbox/get', { accountId, ids: null, properties: ['name', 'parentId', 'role'] }]], [MAIL]);
    const byId = new Map(r.list.map((m) => [m.id, m]));
    const path = (m) => (m.parentId && byId.has(m.parentId) ? `${path(byId.get(m.parentId))}/${m.name}` : m.role === 'inbox' ? 'INBOX' : m.name);
    return { folders: r.list.map(path).sort((a, b) => (a === 'INBOX' ? -1 : b === 'INBOX' ? 1 : a.localeCompare(b))), labels: [] };
  }
}
