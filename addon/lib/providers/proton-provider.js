// Proton as a Sieve provider. Every provider offers the same small interface, so the service, the MCP server
// and the add-on do not care where the scripts live:
//
//   kind, capabilities
//   listScripts()                      → [{id, name, enabled, sieve}] in execution order
//   createScript({name, sieve, enabled}) → {id, name}
//   updateScript(id, {name?, sieve?, enabled?})
//   deleteScript(id), setEnabled(id, enabled), reorder(ids)
//   check(sieve)                        → [{message, line?}]  (empty = valid)
//   listFolders()                       → {folders, labels} | null (unknown)

import { LABEL_TYPE } from '../proton-api.js';
import { t } from '../i18n.js';

const TOO_MANY_ACTIVE_FILTERS = 50016;

export const PROTON_CAPABILITIES = {
  dialect: { name: 'proton' },
  multipleActive: true, // several filters run one after another
  ordering: true,
  labels: true,
  serverCheck: true,
  semantics: 'proton',
};

export class ProtonProvider {
  /** @param {import('../proton-api.js').ProtonClient} client */
  constructor(client) {
    this.client = client;
    this.kind = 'proton';
    this.capabilities = PROTON_CAPABILITIES;
  }

  get isReady() {
    return this.client.isLoggedIn;
  }

  async listScripts() {
    const filters = await this.client.listFilters();
    const full = await Promise.all(filters.map(async (f) => (f.Sieve === undefined ? this.client.getFilter(f.ID) : f)));
    return full
      .sort((a, b) => (a.Priority ?? 0) - (b.Priority ?? 0))
      .map((f) => ({ id: f.ID, name: f.Name, enabled: f.Status === 1, sieve: f.Sieve ?? '' }));
  }

  async createScript({ name, sieve, enabled = true }) {
    const before = new Set((await this.client.listFilters()).map((f) => f.ID));
    try {
      const created = await this.client.createFilter({ Name: name, Sieve: sieve, Status: enabled ? 1 : 0 });
      return { id: created?.ID ?? null, name, enabled };
    } catch (error) {
      // Proton answers 50016 ("too many active filters", free plan) but still creates the filter – disabled.
      // Report it as created, so callers do not retry and pile up duplicates.
      if (error.code !== TOO_MANY_ACTIVE_FILTERS) throw error;
      const added = (await this.client.listFilters()).find((f) => !before.has(f.ID) && f.Name === name);
      if (!added) throw error;
      return { id: added.ID, name, enabled: false, warning: t('Angelegt, aber deaktiviert: {message}', { message: error.message }) };
    }
  }

  async updateScript(id, { name, sieve, enabled }) {
    const current = await this.client.getFilter(id);
    if (!current) throw new Error(t('Filter {id} nicht gefunden', { id }));
    await this.client.updateFilter(id, {
      Name: name ?? current.Name,
      Sieve: sieve ?? current.Sieve,
      Status: enabled === undefined ? current.Status : enabled ? 1 : 0,
    });
  }

  deleteScript(id) {
    return this.client.deleteFilter(id);
  }

  setEnabled(id, enabled) {
    return this.client.setFilterEnabled(id, enabled);
  }

  reorder(ids) {
    return this.client.reorderFilters(ids);
  }

  async check(sieve) {
    const issues = await this.client.checkSieve(sieve);
    return issues.map((i) => ({ message: i.message ?? JSON.stringify(i), line: i.from?.line !== undefined ? i.from.line + 1 : null, raw: i }));
  }

  async listFolders() {
    const [folders, labels] = await Promise.all([
      this.client.listLabels(LABEL_TYPE.FOLDER).catch(() => []),
      this.client.listLabels(LABEL_TYPE.LABEL).catch(() => []),
    ]);
    return { folders: folders.map((l) => l.Path ?? l.Name), labels: labels.map((l) => l.Path ?? l.Name) };
  }
}
