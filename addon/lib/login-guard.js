// Keeps password logins rare. Proton's abuse protection reacts to repeated logins from unknown clients,
// so: at most a few attempts per window, growing pauses after failures, and a long stop after Proton
// reports unusual activity. Refreshing an existing session is not affected.

import { dateLocale, t } from './i18n.js';
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const WINDOW = 15 * MINUTE;
const MAX_ATTEMPTS = 3;
const ABUSE_BLOCK = 24 * HOUR;
const BACKOFF_BASE = 5 * MINUTE;
const BACKOFF_MAX = 6 * HOUR;

// Codes that are part of a normal login conversation and must not cause a pause
const NEUTRAL_CODES = new Set([
  8002, // wrong credentials / wrong 2FA code (still counted as an attempt)
  9001, // human verification required
]);

export class LoginBlockedError extends Error {
  constructor(until, reason) {
    const when = new Date(until).toLocaleString(dateLocale(), { dateStyle: 'short', timeStyle: 'short' });
    super(t('Login paused until {when}: {reason}', { when, reason }));
    this.name = 'LoginBlockedError';
    this.until = until;
    this.reason = reason;
  }
}

export function isAbuseError(error) {
  return /unusual activity|appeal-abuse|ungewöhnliche aktivität|temporarily limited/i.test(`${error?.message ?? ''} ${JSON.stringify(error?.details ?? '')}`);
}

export class LoginGuard {
  /**
   * @param {{load: () => Promise<object|null>, save: (state: object) => Promise<void>}} store
   * @param {() => number} [now]
   */
  constructor(store, now = () => Date.now()) {
    this.store = store;
    this.now = now;
  }

  async #state() {
    return { attempts: [], failures: 0, blockedUntil: 0, reason: null, lastError: null, ...((await this.store.load()) ?? {}) };
  }

  async status() {
    const s = await this.#state();
    const now = this.now();
    return {
      blockedUntil: s.blockedUntil > now ? s.blockedUntil : null,
      reason: s.blockedUntil > now ? s.reason : null,
      recentAttempts: s.attempts.filter((t) => now - t < WINDOW).length,
      lastError: s.lastError,
    };
  }

  /** Call before a new password login (not for the captcha/2FA continuation of one). */
  async beforeAttempt() {
    const s = await this.#state();
    const now = this.now();
    if (s.blockedUntil > now) throw new LoginBlockedError(s.blockedUntil, s.reason);
    s.attempts = s.attempts.filter((t) => now - t < WINDOW);
    if (s.attempts.length >= MAX_ATTEMPTS) {
      const until = s.attempts[0] + WINDOW;
      throw new LoginBlockedError(until, t('at most {max} login attempts in {minutes} minutes', { max: MAX_ATTEMPTS, minutes: WINDOW / MINUTE }));
    }
    s.attempts.push(now);
    await this.store.save(s);
  }

  async onSuccess() {
    const s = await this.#state();
    await this.store.save({ ...s, failures: 0, blockedUntil: 0, reason: null });
  }

  /** Records a failed login (or a refresh/API error that looks like an abuse block). */
  async onError(error) {
    const s = await this.#state();
    const now = this.now();
    s.lastError = { at: now, status: error?.status ?? null, code: error?.code ?? null, message: String(error?.message ?? error).slice(0, 300) };
    if (isAbuseError(error)) {
      s.blockedUntil = now + ABUSE_BLOCK;
      s.reason = t('Proton reports unusual activity – first check in the official Proton login whether the account is available');
    } else if (!NEUTRAL_CODES.has(error?.code) && error?.name !== 'LoginBlockedError') {
      s.failures += 1;
      const pause = Math.min(BACKOFF_MAX, BACKOFF_BASE * 2 ** (s.failures - 1));
      s.blockedUntil = now + pause;
      s.reason = t('Paused after {count} failed logins ({code})', { count: s.failures, code: error?.code ?? error?.status ?? t('Error') });
    }
    await this.store.save(s);
  }

  /** Manual reset, e.g. after the user checked the account in Proton's own login. */
  async reset() {
    await this.store.save({ attempts: [], failures: 0, blockedUntil: 0, reason: null, lastError: null });
  }
}

/** A guard that never blocks – for tests or callers that do their own limiting. */
export const noopGuard = { beforeAttempt: async () => {}, onSuccess: async () => {}, onError: async () => {}, status: async () => ({}) };
