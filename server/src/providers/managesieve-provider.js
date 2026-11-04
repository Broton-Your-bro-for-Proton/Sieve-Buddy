// ManageSieve servers (Dovecot/Pigeonhole, Stalwart, Cyrus, …) as a Sieve provider – same interface as
// ProtonProvider. Scripts are identified by name; only one script is active at a time.

import { ManageSieveConnection, ManageSieveError } from './managesieve.js';
import { listImapFolders } from './imap-folders.js';

const CHECK_NAME = '.proton-sieve-check';

/** "line 3: error: unknown command 'foo'" → {line: 3, message} */
function parseIssues(message) {
  const issues = [];
  for (const raw of String(message).split(/\r?\n/)) {
    const m = /line (\d+):\s*(?:error:\s*)?(.*)/i.exec(raw);
    if (m) issues.push({ line: Number(m[1]), message: m[2].trim() });
    // Dovecot ends with a summary line ("error: validation failed." / "error: parse failed.") that adds nothing
    else if (raw.trim() && !/^error: (validation|parse) failed\.?$/i.test(raw.trim())) issues.push({ line: null, message: raw.trim() });
  }
  return issues.length ? issues : [{ line: null, message: String(message) }];
}

export class ManageSieveProvider {
  /**
   * @param {{host: string, port?: number, tls?: 'starttls'|'tls'|'none', user: string, password: string,
   *          rejectUnauthorized?: boolean, imap?: {host: string, port?: number, tls?: string, user?: string, password?: string} | null}} config
   */
  constructor(config) {
    this.config = config;
    this.kind = 'managesieve';
    this.capabilities = {
      dialect: { name: 'rfc', extensions: [] },
      multipleActive: false, // exactly one script is active
      ordering: false,
      labels: false,
      serverCheck: true,
      semantics: 'rfc',
      implementation: null,
    };
    this.isReady = false;
  }

  async #with(fn) {
    const { host, port, tls, user, password, rejectUnauthorized } = this.config;
    const conn = await ManageSieveConnection.open({ host, port, tls, rejectUnauthorized });
    try {
      await conn.authenticate(user, password);
      this.#learn(conn.capabilities);
      return await fn(conn);
    } finally {
      await conn.logout();
    }
  }

  #learn(caps) {
    this.capabilities = {
      ...this.capabilities,
      dialect: { name: 'rfc', extensions: caps.sieve.map((e) => e.toLowerCase()) },
      serverCheck: true,
      hasCheckScript: Boolean(caps.version),
      implementation: caps.implementation,
    };
  }

  /** Connects once to learn the capabilities and verify the credentials. */
  async init() {
    await this.#with(async () => {});
    this.isReady = true;
    return this.capabilities;
  }

  listScripts() {
    return this.#with(async (conn) => {
      const list = await conn.listScripts();
      const scripts = [];
      for (const s of list.filter((x) => x.name !== CHECK_NAME)) {
        scripts.push({ id: s.name, name: s.name, enabled: s.active, sieve: await conn.getScript(s.name) });
      }
      // the active script first: it is the one that runs
      return scripts.sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.name.localeCompare(b.name));
    });
  }

  createScript({ name, sieve, enabled = false }) {
    return this.#with(async (conn) => {
      const existing = await conn.listScripts();
      if (existing.some((s) => s.name === name)) throw new ManageSieveError(`Ein Skript „${name}“ gibt es schon`, { code: 'ALREADYEXISTS' });
      await conn.putScript(name, sieve);
      if (enabled) await conn.setActive(name);
      return { id: name, name };
    });
  }

  updateScript(id, { name, sieve, enabled }) {
    return this.#with(async (conn) => {
      const list = await conn.listScripts();
      const current = list.find((s) => s.name === id);
      if (!current) throw new ManageSieveError(`Skript „${id}“ nicht gefunden`, { code: 'NONEXISTENT' });
      if (sieve !== undefined) await conn.putScript(id, sieve);
      let finalName = id;
      if (name && name !== id) {
        await conn.renameScript(id, name);
        finalName = name;
      }
      if (enabled === true && !current.active) await conn.setActive(finalName);
      if (enabled === false && current.active) await conn.setActive('');
      return { id: finalName, name: finalName };
    });
  }

  deleteScript(id) {
    return this.#with(async (conn) => {
      const current = (await conn.listScripts()).find((s) => s.name === id);
      if (current?.active) await conn.setActive(''); // an active script cannot be deleted
      await conn.deleteScript(id);
    });
  }

  setEnabled(id, enabled) {
    return this.#with(async (conn) => {
      if (enabled) await conn.setActive(id);
      else {
        const current = (await conn.listScripts()).find((s) => s.name === id);
        if (current?.active) await conn.setActive('');
      }
    });
  }

  async reorder() {
    throw new Error('ManageSieve kennt keine Reihenfolge – es läuft genau ein aktives Skript');
  }

  check(sieve) {
    return this.#with(async (conn) => {
      try {
        if (conn.capabilities.version) await conn.checkScript(sieve);
        else {
          // servers without CHECKSCRIPT: upload under a temporary name and remove it again
          await conn.putScript(CHECK_NAME, sieve);
          await conn.deleteScript(CHECK_NAME).catch(() => {});
        }
        return [];
      } catch (error) {
        if (error instanceof ManageSieveError && error.status === 'NO') return parseIssues(error.message);
        throw error;
      }
    });
  }

  async listFolders() {
    const imap = this.config.imap;
    if (!imap?.host) return null;
    const folders = await listImapFolders({
      host: imap.host,
      port: imap.port,
      tls: imap.tls,
      user: imap.user ?? this.config.user,
      password: imap.password ?? this.config.password,
      rejectUnauthorized: this.config.rejectUnauthorized,
    });
    return { folders, labels: [] };
  }
}
