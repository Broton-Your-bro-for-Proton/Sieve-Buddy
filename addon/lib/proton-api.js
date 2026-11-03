// Minimal client for the (undocumented) Proton web API: SRP login, 2FA, token refresh and mail filters.
// Endpoints follow ProtonMail/WebClients (packages/shared/lib/api/{auth,filters}.ts).

import { getSrpProofs } from './srp.js';

export const DEFAULT_SETTINGS = {
  apiBase: 'https://mail.proton.me/api',
  appVersion: 'Other',
};

export const FILTER_VERSION = 2;
const SUCCESS_CODES = new Set([1000, 1001]);
const HUMAN_VERIFICATION_CODE = 9001;
const TWO_FACTOR_TOTP = 1;

export const LABEL_TYPE = { LABEL: 1, FOLDER: 3 };

export class ProtonApiError extends Error {
  constructor(message, { status, code, details } = {}) {
    super(message);
    this.name = 'ProtonApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }

  get needsHumanVerification() {
    return this.code === HUMAN_VERIFICATION_CODE;
  }
}

export class ProtonClient {
  /**
   * @param {object} options
   * @param {object} options.bcrypt  bcryptjs instance
   * @param {{load: () => Promise<object|null>, save: (session: object|null) => Promise<void>}} options.store
   */
  constructor({ bcrypt, store, settings = {} }) {
    this.bcrypt = bcrypt;
    this.store = store;
    this.settings = { ...DEFAULT_SETTINGS, ...settings };
    this.session = null;
    this.refreshing = null;
  }

  get isLoggedIn() {
    return Boolean(this.session?.UID && this.session?.RefreshToken && !this.session.pending2FA);
  }

  async restore() {
    this.session = await this.store.load();
    return this.isLoggedIn;
  }

  async request(method, path, { body, query, auth = true, headers = {}, retry = true } = {}) {
    const url = new URL(`${this.settings.apiBase.replace(/\/$/, '')}/${path}`);
    for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, value);

    const allHeaders = {
      Accept: 'application/vnd.protonmail.v1+json',
      'x-pm-appversion': this.settings.appVersion,
      ...headers,
    };
    if (body !== undefined) allHeaders['Content-Type'] = 'application/json';
    if (auth && this.session?.UID) {
      allHeaders['x-pm-uid'] = this.session.UID;
      if (this.session.AccessToken) allHeaders.Authorization = `Bearer ${this.session.AccessToken}`;
    }

    const response = await fetch(url, {
      method,
      headers: allHeaders,
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'omit',
    });

    if (response.status === 401 && auth && retry && this.session?.RefreshToken && !this.session.pending2FA) {
      await this.refresh();
      return this.request(method, path, { body, query, auth, headers, retry: false });
    }

    let data = null;
    try {
      data = await response.json();
    } catch {
      // empty or non-JSON body
    }

    if (!response.ok || (data && 'Code' in data && !SUCCESS_CODES.has(data.Code))) {
      throw new ProtonApiError(data?.Error || `HTTP ${response.status}`, {
        status: response.status,
        code: data?.Code,
        details: data?.Details,
      });
    }
    return data;
  }

  // ---------- Authentication ----------

  /**
   * Starts an SRP login. Resolves to {twoFactor: true} when a TOTP code is still needed.
   * Throws ProtonApiError with needsHumanVerification when Proton asks for a captcha.
   */
  async login(username, password, humanVerification) {
    const hvHeaders = humanVerification
      ? {
          'x-pm-human-verification-token': humanVerification.token,
          'x-pm-human-verification-token-type': humanVerification.type,
        }
      : {};

    this.session = null;
    const info = await this.request('POST', 'core/v4/auth/info', {
      body: { Username: username },
      auth: false,
      headers: hvHeaders,
    });

    const proofs = await getSrpProofs({
      version: info.Version,
      password,
      salt: info.Salt,
      signedModulus: info.Modulus,
      serverEphemeral: info.ServerEphemeral,
      bcrypt: this.bcrypt,
    });

    const auth = await this.request('POST', 'core/v4/auth', {
      body: {
        Username: username,
        ClientEphemeral: proofs.clientEphemeral,
        ClientProof: proofs.clientProof,
        SRPSession: info.SRPSession,
        PersistentCookies: 0,
      },
      auth: false,
      headers: hvHeaders,
    });

    if (auth.ServerProof !== proofs.expectedServerProof) {
      throw new ProtonApiError('Server-Beweis ungültig – Anmeldung abgebrochen');
    }

    const twoFactor = auth['2FA']?.Enabled ?? auth.TwoFactor ?? 0;
    this.session = {
      UID: auth.UID,
      AccessToken: auth.AccessToken,
      RefreshToken: auth.RefreshToken,
      username,
      pending2FA: Boolean(twoFactor),
    };

    if (twoFactor && !(twoFactor & TWO_FACTOR_TOTP)) {
      this.session = null;
      throw new ProtonApiError('Nur Sicherheitsschlüssel (FIDO2) als 2FA aktiv – das unterstützt das Add-on noch nicht');
    }
    if (twoFactor) return { twoFactor: true };

    await this.store.save(this.session);
    return { twoFactor: false };
  }

  async submitTotp(code) {
    if (!this.session?.pending2FA) throw new ProtonApiError('Keine Anmeldung wartet auf einen 2FA-Code');
    await this.request('POST', 'core/v4/auth/2fa', { body: { TwoFactorCode: code.trim() }, retry: false });
    this.session.pending2FA = false;
    await this.store.save(this.session);
  }

  async refresh() {
    if (!this.refreshing) {
      this.refreshing = (async () => {
        try {
          const res = await this.request('POST', 'auth/v4/refresh', {
            body: {
              UID: this.session.UID,
              RefreshToken: this.session.RefreshToken,
              ResponseType: 'token',
              GrantType: 'refresh_token',
              RedirectURI: 'https://protonmail.ch',
            },
            headers: { 'x-pm-uid': this.session.UID },
            auth: false,
          });
          this.session = {
            ...this.session,
            AccessToken: res.AccessToken,
            RefreshToken: res.RefreshToken,
          };
          await this.store.save(this.session);
        } catch (error) {
          if (error.status === 400 || error.status === 401 || error.status === 422) {
            this.session = null;
            await this.store.save(null);
          }
          throw error;
        } finally {
          this.refreshing = null;
        }
      })();
    }
    return this.refreshing;
  }

  async logout() {
    try {
      if (this.session) await this.request('DELETE', 'core/v4/auth', { retry: false });
    } catch {
      // the session may already be gone on Proton's side
    }
    this.session = null;
    await this.store.save(null);
  }

  captchaUrl(token, dark = false) {
    const url = new URL(`${this.settings.apiBase.replace(/\/$/, '')}/core/v4/captcha`);
    url.searchParams.set('Token', token);
    url.searchParams.set('ForceWebMessaging', '1');
    if (dark) url.searchParams.set('Dark', 'true');
    return url;
  }

  // ---------- Filters ----------

  async listFilters() {
    const { Filters = [] } = await this.request('GET', 'mail/v4/filters');
    return Filters;
  }

  async getFilter(id) {
    const { Filter } = await this.request('GET', `mail/v4/filters/${encodeURIComponent(id)}`);
    return Filter;
  }

  async createFilter({ Name, Sieve, Status = 1 }) {
    const { Filter } = await this.request('POST', 'mail/v4/filters', {
      body: { Name, Sieve, Status, Version: FILTER_VERSION },
    });
    return Filter;
  }

  async updateFilter(id, { Name, Sieve, Status }) {
    const { Filter } = await this.request('PUT', `mail/v4/filters/${encodeURIComponent(id)}`, {
      body: { Name, Sieve, Status, Version: FILTER_VERSION },
    });
    return Filter;
  }

  async deleteFilter(id) {
    await this.request('DELETE', `mail/v4/filters/${encodeURIComponent(id)}`);
  }

  async setFilterEnabled(id, enabled) {
    await this.request('PUT', `mail/v4/filters/${encodeURIComponent(id)}/${enabled ? 'enable' : 'disable'}`);
  }

  async reorderFilters(filterIds) {
    await this.request('PUT', 'mail/v4/filters/order', { body: { FilterIDs: filterIds } });
  }

  /** Returns CodeMirror-style annotations ({from, to, message, severity}); empty when the script is valid. */
  async checkSieve(sieve) {
    const { Issues = [] } = await this.request('PUT', 'mail/v4/filters/check', {
      body: { Sieve: sieve, Version: FILTER_VERSION },
    });
    return Issues;
  }

  async listLabels(type) {
    const { Labels = [] } = await this.request('GET', 'core/v4/labels', { query: { Type: type } });
    return Labels;
  }
}
