// Every address the user can enter must be encrypted. Plain http is accepted only for this computer
// (localhost, 127.0.0.1, [::1]), where the traffic never leaves the machine.

import { t } from './i18n.js';

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/** The URL when it is https, or http on this computer; throws otherwise. */
export function secureUrl(value) {
  const url = new URL(value);
  if (url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK.has(url.hostname))) return url;
  throw new Error(t('Only https:// addresses are allowed (http:// only for localhost): {url}', { url: url.origin }));
}

/**
 * The captcha page the API names, opened in the browser: only an https (or local) address, else Proton's
 * own verification page. A changed API base must not open arbitrary links or schemes.
 */
export function verificationUrl(webUrl, token) {
  try {
    if (webUrl) return secureUrl(webUrl).href;
  } catch {
    // falls back to Proton's page below
  }
  return `https://verify.proton.me/?methods=captcha&token=${encodeURIComponent(token)}`;
}
