// Talks to the Sieve service (Docker) instead of Proton directly. Offers the same methods the manager uses
// on ProtonClient, so the UI works unchanged – for Proton behind the service as well as ManageSieve servers.

import { t } from './i18n.js';

export class ServiceClient {
  /** @param {{baseUrl: string, token: string}} options */
  constructor({ baseUrl, token }) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.token = token;
    this.status = null;
    this.capabilities = null;
    this.viaService = true;
  }

  get isLoggedIn() {
    return Boolean(this.status?.loggedIn);
  }

  get session() {
    return this.status ? { username: this.status.username ?? this.status.server ?? t('Dienst') } : null;
  }

  async #call(path, body) {
    let res;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (error) {
      throw new Error(t('Dienst unter {url} nicht erreichbar ({message})', { url: this.baseUrl, message: error.message }));
    }
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) throw new Error(t('API-Token des Dienstes ist falsch'));
    if (!res.ok) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { issues: data.issues });
    return data;
  }

  op(name, args = {}) {
    return this.#call(`/api/ops/${name}`, args);
  }

  /** Loads status and capabilities; resolves to whether the service is connected to its mail server. */
  async restore() {
    this.status = await this.#call('/api/status');
    this.capabilities = this.status.capabilities ?? null;
    return this.isLoggedIn;
  }

  get kind() {
    return this.status?.provider ?? 'proton';
  }

  // ---------- the subset of ProtonClient the manager uses (Proton-shaped objects) ----------

  static #toFilter(s, index = 0) {
    return { ID: s.id, Name: s.name, Status: s.enabled ? 1 : 0, Sieve: s.sieve, Priority: index + 1 };
  }

  /** Filters with their Sieve text plus folders and labels in one go (see shared/env.js loadAccountData). */
  async loadAccountData() {
    const [{ filters }, folders] = await Promise.all([this.op('list-filters', { includeSieve: true }), this.op('list-folders')]);
    return {
      filters: filters.map((s, i) => ServiceClient.#toFilter(s, i)),
      folders: folders.folders ?? [],
      labels: folders.labels ?? [],
      foldersKnown: folders.known !== false,
    };
  }

  async getFilter(id) {
    return ServiceClient.#toFilter(await this.op('get-filter', { id }));
  }

  async createFilter({ Name, Sieve, Status = 1 }) {
    const created = await this.op('create-filter', { name: Name, sieve: Sieve, enabled: Status === 1 });
    return { ID: created.id, Name };
  }

  /** `expected`: the service saves only if the script still has this text (its cache may be older). */
  async updateFilter(id, { Name, Sieve, Status }, expected) {
    const r = await this.op('update-filter', { id, name: Name, sieve: Sieve, enabled: Status === undefined ? undefined : Status === 1, expectedSieve: expected });
    return { ID: r.id, Name: r.name };
  }

  deleteFilter(id) {
    return this.op('delete-filter', { id });
  }

  setFilterEnabled(id, enabled) {
    return this.op('set-filter-enabled', { id, enabled });
  }

  reorderFilters(ids) {
    return this.op('reorder-filters', { ids });
  }

  /** Server-side check, as CodeMirror annotations like Proton's check endpoint returns them. */
  async checkSieve(sieve) {
    const { issues } = await this.op('check', { sieve });
    return issues.map((i) => {
      if (i.raw?.from) return i.raw;
      const line = Math.max(0, (i.line ?? 1) - 1);
      return { from: { line, ch: 0 }, to: { line, ch: 500 }, message: i.message, severity: 'error' };
    });
  }

  /** The add-on only forgets the service; the service keeps its own connection. */
  async logout() {
    this.status = null;
  }
}
