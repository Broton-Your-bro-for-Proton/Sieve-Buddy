// One Proton account per service instance: login flow (SRP, TOTP, captcha), cached account data and writes.

import { createRequire } from 'node:module';
import { join } from 'node:path';

import { LoginGuard } from '../../addon/lib/login-guard.js';
import { LABEL_TYPE, ProtonClient } from '../../addon/lib/proton-api.js';
import { encryptedFileStore, jsonFileStore } from './store.js';

const bcrypt = createRequire(import.meta.url)('bcryptjs');
const CACHE_MS = 30_000;
const PENDING_MS = 10 * 60_000;

export class Account {
  constructor(config) {
    this.config = config;
    this.store = encryptedFileStore(join(config.dataDir, 'session.json'), config.secret);
    this.guard = new LoginGuard(jsonFileStore(join(config.dataDir, 'login-guard.json')));
    this.client = new ProtonClient({
      bcrypt,
      store: this.store,
      settings: config.proton,
      guard: this.guard,
      onApiError: ({ method, path, status, code, message }) => console.warn(`[proton] ${method} ${path} → HTTP ${status}, Code ${code ?? '-'}: ${message ?? ''}`),
    });
    this.pending = null; // {username, password, hv?, expires}
    this.cache = null;
    this.writeLock = Promise.resolve();
  }

  async init() {
    await this.client.restore();
  }

  async status() {
    return {
      loginGuard: await this.guard.status(),
      loggedIn: this.client.isLoggedIn,
      username: this.client.session?.username ?? null,
      pending: this.pending && Date.now() < this.pending.expires ? this.pending.step : null,
      captchaUrl: this.pending?.step === 'captcha' ? this.pending.webUrl : null,
      allowWrite: this.config.allowWrite,
    };
  }

  // ---------- login ----------

  async login(username, password) {
    this.pending = { username, password, step: 'password', expires: Date.now() + PENDING_MS };
    return this.#attempt();
  }

  async submitTotp(code) {
    if (this.pending?.step !== 'totp') throw new Error('Keine Anmeldung wartet auf einen 2FA-Code');
    await this.client.submitTotp(code);
    this.pending = null;
    return { step: 'done' };
  }

  async continueAfterCaptcha() {
    if (this.pending?.step !== 'captcha' || Date.now() > this.pending.expires) throw new Error('Keine Anmeldung wartet auf das Captcha');
    return this.#attempt(this.pending.hv);
  }

  async #attempt(hv) {
    const { username, password } = this.pending;
    try {
      const { twoFactor } = await this.client.login(username, password, hv);
      if (twoFactor) {
        this.pending = { username, step: 'totp', expires: Date.now() + PENDING_MS }; // password no longer needed
        return { step: 'totp' };
      }
      this.pending = null;
      this.cache = null;
      return { step: 'done' };
    } catch (error) {
      if (error.needsHumanVerification && (error.details?.HumanVerificationMethods ?? []).includes('captcha')) {
        const token = error.details.HumanVerificationToken;
        this.pending = {
          ...this.pending,
          step: 'captcha',
          hv: { token, type: error.details.HumanVerificationMethods.join(',') },
          webUrl: error.details.WebUrl || `https://verify.proton.me/?methods=captcha&token=${encodeURIComponent(token)}`,
          expires: Date.now() + PENDING_MS,
        };
        return { step: 'captcha', webUrl: this.pending.webUrl };
      }
      this.pending = null;
      throw error;
    }
  }

  async logout() {
    this.pending = null;
    this.cache = null;
    await this.client.logout();
  }

  // ---------- data ----------

  requireLogin() {
    if (!this.client.isLoggedIn) throw new Error('Nicht bei Proton angemeldet – bitte zuerst in der Weboberfläche des Dienstes anmelden');
  }

  requireWrite() {
    if (!this.config.allowWrite) throw new Error('Schreibzugriffe sind deaktiviert (ALLOW_WRITE=false)');
  }

  /** Filters (with Sieve text) in Proton order, plus folder and label paths. Cached briefly. */
  async data({ fresh = false } = {}) {
    this.requireLogin();
    if (!fresh && this.cache && Date.now() - this.cache.at < CACHE_MS) return this.cache;
    const [filters, folders, labels] = await Promise.all([
      this.client.listFilters(),
      this.client.listLabels(LABEL_TYPE.FOLDER).catch(() => []),
      this.client.listLabels(LABEL_TYPE.LABEL).catch(() => []),
    ]);
    const full = await Promise.all(filters.map(async (f) => (f.Sieve === undefined ? this.client.getFilter(f.ID) : f)));
    this.cache = {
      at: Date.now(),
      filters: full.sort((a, b) => (a.Priority ?? 0) - (b.Priority ?? 0)),
      folders: folders.map((l) => l.Path ?? l.Name),
      labels: labels.map((l) => l.Path ?? l.Name),
    };
    return this.cache;
  }

  scripts(data) {
    return data.filters.map((f) => ({ id: f.ID, name: f.Name, sieve: f.Sieve ?? '', enabled: f.Status === 1 }));
  }

  /** Serialises writes and invalidates the cache afterwards. */
  async write(fn) {
    this.requireLogin();
    this.requireWrite();
    const run = this.writeLock.then(fn, fn);
    this.writeLock = run.catch(() => {});
    try {
      return await run;
    } finally {
      this.cache = null;
    }
  }

  /** Validates with Proton before saving; throws with the issues when Proton rejects the script. */
  async checkOrThrow(sieve) {
    const issues = await this.client.checkSieve(sieve);
    if (issues.length) {
      const err = new Error(`Proton lehnt das Skript ab: ${issues.map((i) => i.message ?? JSON.stringify(i)).join('; ')}`);
      err.issues = issues;
      throw err;
    }
  }
}
