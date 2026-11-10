// SCRAM for SASL (RFC 5802, RFC 7677): the password never crosses the wire, and the server proves that it
// knows it too. Used by the ManageSieve client; the fake ManageSieve server uses scramKeys for its side.

import { createHash, createHmac, pbkdf2, randomBytes, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { t } from '../../../addon/lib/i18n.js';

/** Preferred first. */
export const SCRAM_MECHANISMS = { 'SCRAM-SHA-512': 'sha512', 'SCRAM-SHA-256': 'sha256', 'SCRAM-SHA-1': 'sha1' };

const GS2_HEADER = 'n,,';
// a hostile server must not make the client hash for minutes
const MAX_ITERATIONS = 1_000_000;

const saslName = (s) => s.replace(/=/g, '=3D').replace(/,/g, '=2C');
export const scramAttributes = (message) => Object.fromEntries(message.split(',').map((part) => [part[0], part.slice(2)]));

/** Client and server keys of a password, plus the HMAC and hash of the mechanism. */
export async function scramKeys(hash, password, salt, iterations) {
  const length = createHash(hash).digest().length;
  // SASLprep is approximated by NFKC, which covers the passwords seen in practice
  const salted = await promisify(pbkdf2)(password.normalize('NFKC'), salt, iterations, length, hash);
  const hmac = (key, data) => createHmac(hash, key).update(data).digest();
  return { clientKey: hmac(salted, 'Client Key'), serverKey: hmac(salted, 'Server Key'), hmac, digest: (data) => createHash(hash).update(data).digest() };
}

/**
 * One SCRAM exchange: send `first`, answer the server's challenge with `await final(challenge)`, then
 * `verify(serverFinal)` must be true before the session is trusted. `nonce` is only passed by tests.
 */
export function scramClient(mechanism, user, password, nonce = randomBytes(18).toString('base64')) {
  const hash = SCRAM_MECHANISMS[mechanism];
  const firstBare = `n=${saslName(user)},r=${nonce}`;
  let expected = null;
  return {
    first: GS2_HEADER + firstBare,
    async final(serverFirst) {
      const { r, s, i } = scramAttributes(serverFirst);
      const iterations = Number(i);
      if (!r?.startsWith(nonce) || r === nonce || !s || !Number.isInteger(iterations) || iterations < 1 || iterations > MAX_ITERATIONS) {
        throw new Error(t('Invalid SCRAM challenge from the server'));
      }
      const { clientKey, serverKey, hmac, digest } = await scramKeys(hash, password, Buffer.from(s, 'base64'), iterations);
      const withoutProof = `c=${Buffer.from(GS2_HEADER).toString('base64')},r=${r}`;
      const authMessage = `${firstBare},${serverFirst},${withoutProof}`;
      const signature = hmac(digest(clientKey), authMessage);
      const proof = Buffer.from(clientKey.map((byte, k) => byte ^ signature[k]));
      expected = hmac(serverKey, authMessage);
      return `${withoutProof},p=${proof.toString('base64')}`;
    },
    verify(serverFinal) {
      const v = Buffer.from(scramAttributes(serverFinal ?? '').v ?? '', 'base64');
      return expected !== null && v.length === expected.length && timingSafeEqual(v, expected);
    },
  };
}
