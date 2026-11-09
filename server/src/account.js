// One mail account per service instance, behind a Sieve provider:
//   proton      – Proton's web API; session handed over from the add-on (or, if enabled, a password login)
//   managesieve – any ManageSieve server (Dovecot/Pigeonhole, Stalwart, Cyrus, …), credentials from the config
//   jmap        – any JMAP server with JMAP for Sieve (RFC 9661, e.g. Stalwart), URL and token from the config

import { createRequire } from 'node:module';
import { join } from 'node:path';

import { LoginGuard } from '../../addon/lib/login-guard.js';
import { LABEL_TYPE, ProtonClient } from '../../addon/lib/proton-api.js';
import { ProtonProvider } from '../../addon/lib/providers/proton-provider.js';
import { makeDialect } from '../../addon/lib/sieve-dialect.js';
import { JmapProvider } from './providers/jmap-provider.js';
import { ManageSieveProvider } from './providers/managesieve-provider.js';
import { encryptedFileStore, jsonFileStore } from './store.js';
import { t } from '../../addon/lib/i18n.js';

const bcrypt = createRequire(import.meta.url)('bcryptjs');
const CACHE_MS = 30_000;
const PENDING_MS = 10 * 60_000;
// the JMAP URL without credentials or query, which may carry a token
const jmapServer = (url) => {
  const u = new URL(url);
  return u.origin + u.pathname;
};

export class Account {
  constructor(config) {
    this.config = config;
    this.kind = config.provider ?? 'proton';
    this.cache = null;
    this.writeLock = Promise.resolve();
    this.pending = null; // proton password login in progress: {username, password, step, hv?, expires}
    this.initError = null;

    if (this.kind === 'managesieve') {
      this.provider = new ManageSieveProvider(config.managesieve);
    } else if (this.kind === 'jmap') {
      this.provider = new JmapProvider(config.jmap);
    } else {
      this.store = encryptedFileStore(join(config.dataDir, 'session.json'), config.secret);
      this.guard = new LoginGuard(jsonFileStore(join(config.dataDir, 'login-guard.json')));
      this.client = new ProtonClient({
        bcrypt,
        store: this.store,
        settings: config.proton,
        guard: this.guard,
        onApiError: ({ method, path, status, code, message }) => console.warn(`[proton] ${method} ${path} → HTTP ${status}, Code ${code ?? '-'}: ${message ?? ''}`),
      });
      this.provider = new ProtonProvider(this.client);
    }
  }

  async init() {
    if (this.kind !== 'proton') {
      try {
        await this.provider.init();
        this.initError = null;
      } catch (error) {
        this.initError = error.message;
        console.warn(`[${this.kind}] ${t('connection failed')}: ${error.message}`);
      }
    } else {
      await this.client.restore();
    }
  }

  dialect() {
    return makeDialect(this.provider.capabilities.dialect);
  }

  async status() {
    const base = {
      provider: this.kind,
      loggedIn: this.provider.isReady,
      allowWrite: this.config.allowWrite,
      capabilities: this.provider.capabilities,
    };
    if (this.kind === 'managesieve') {
      const { host, port, user } = this.config.managesieve;
      return { ...base, username: user, server: `${host}:${port ?? 4190}`, error: this.initError };
    }
    if (this.kind === 'jmap') {
      return { ...base, username: this.provider.session?.username ?? this.config.jmap.user ?? null, server: jmapServer(this.config.jmap.url), error: this.initError };
    }
    return {
      ...base,
      username: this.client.session?.username ?? null,
      allowPasswordLogin: this.config.allowPasswordLogin,
      loginGuard: await this.guard.status(),
      pending: this.pending && Date.now() < this.pending.expires ? this.pending.step : null,
      captchaUrl: this.pending?.step === 'captcha' ? this.pending.webUrl : null,
    };
  }

  // ---------- Proton: password login (off by default) and session hand-over ----------

  #requireProton() {
    if (this.kind !== 'proton') throw new Error(t('Only available with PROVIDER=proton'));
  }

  async login(username, password) {
    this.#requireProton();
    if (!this.config.allowPasswordLogin) {
      throw new Error(t('Password login in the service is disabled. Sign in to the Thunderbird add-on and use “Hand over to service” there (or set ALLOW_PASSWORD_LOGIN=true).'));
    }
    this.pending = { username, password, step: 'password', expires: Date.now() + PENDING_MS };
    return this.#attempt();
  }

  async submitTotp(code) {
    this.#requireProton();
    if (this.pending?.step !== 'totp') throw new Error(t('No login is waiting for a 2FA code'));
    await this.client.submitTotp(code);
    this.pending = null;
    return { step: 'done' };
  }

  async continueAfterCaptcha() {
    this.#requireProton();
    if (this.pending?.step !== 'captcha' || Date.now() > this.pending.expires) throw new Error(t('No sign-in is waiting for the captcha'));
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
    this.#requireProton();
    this.pending = null;
    this.cache = null;
    await this.client.logout();
  }

  /**
   * Takes over a session from the Thunderbird add-on, so the service never has to do a password login.
   * Proton rotates refresh tokens, so the sender must stop using it afterwards. Checked with one call first.
   */
  async importSession({ UID, AccessToken, RefreshToken, username }) {
    this.#requireProton();
    if (typeof UID !== 'string' || typeof RefreshToken !== 'string' || !UID || !RefreshToken) {
      throw new Error(t('The session UID and RefreshToken are missing'));
    }
    const previous = this.client.session;
    this.client.session = { UID, AccessToken: AccessToken ?? null, RefreshToken, username: username ?? null, pending2FA: false };
    try {
      // without an access token the first call refreshes, which also takes ownership of the session
      await this.client.listLabels(LABEL_TYPE.FOLDER);
    } catch (error) {
      this.client.session = previous;
      // a refresh during the check may already have stored the rejected session
      await this.store.save(previous ?? null).catch(() => {});
      throw new Error(t('Proton did not accept the session: {message}', { message: error.message }));
    }
    await this.store.save(this.client.session);
    this.pending = null;
    this.cache = null;
    return { imported: true, username: this.client.session.username };
  }

  // ---------- data ----------

  requireReady() {
    if (this.provider.isReady) return;
    if (this.kind === 'managesieve') throw new Error(
        this.initError
          ? t('ManageSieve server unreachable or sign-in failed: {error}', { error: this.initError })
          : t('ManageSieve server unreachable or sign-in failed'),
      );
    if (this.kind === 'jmap') throw new Error(t('JMAP server unreachable or sign-in failed: {error}', { error: this.initError ?? '-' }));
    throw new Error(t('Not signed in to Proton. Transfer the session from the Thunderbird add-on with “Hand over to service”'));
  }

  requireWrite() {
    if (!this.config.allowWrite) throw new Error(t('Write access is disabled (ALLOW_WRITE=false)'));
  }

  /** Scripts (in execution order) and folders; folders/labels are null when the server cannot list them. */
  async data({ fresh = false } = {}) {
    if (this.kind !== 'proton' && !this.provider.isReady) await this.init();
    this.requireReady();
    if (!fresh && this.cache && Date.now() - this.cache.at < CACHE_MS) return this.cache;
    const [scripts, folderInfo] = await Promise.all([
      this.provider.listScripts(),
      this.provider.listFolders().catch((error) => {
        console.warn(`[folders] ${error.message}`);
        return null;
      }),
    ]);
    this.cache = {
      at: Date.now(),
      scripts,
      folders: folderInfo?.folders ?? null,
      labels: folderInfo?.labels ?? [],
      capabilities: this.provider.capabilities,
      dialect: this.dialect(),
    };
    return this.cache;
  }

  /** Serialises writes and invalidates the cache afterwards. */
  async write(fn) {
    this.requireReady();
    this.requireWrite();
    const run = this.writeLock.then(fn, fn);
    this.writeLock = run.catch(() => {});
    try {
      return await run;
    } finally {
      this.cache = null;
    }
  }

  /** Validates with the server before saving; throws with the issues when the server rejects the script. */
  async checkOrThrow(sieve) {
    const issues = await this.provider.check(sieve);
    if (issues.length) {
      const list = issues.map((i) => (i.line ? t('Line {line}: {message}', { line: i.line, message: i.message }) : i.message)).join('; ');
      const err = new Error(this.kind === 'proton' ? t('Proton rejects the script: {list}', { list }) : t('The server rejects the script: {list}', { list }));
      err.issues = issues;
      throw err;
    }
  }
}
