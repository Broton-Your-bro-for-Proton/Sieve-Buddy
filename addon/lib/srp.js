// Proton SRP-6a client (auth versions 3 and 4), ported from ProtonMail/go-srp (MIT).
// All big numbers are little-endian byte arrays on the wire, as in go-srp.

import { t } from './i18n.js';

const BIT_LENGTH = 2048;
const BYTE_LENGTH = BIT_LENGTH / 8;
const DOT_SLASH = './ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const STANDARD = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToBase64(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

const ascii = (str) => new TextEncoder().encode(str);

// bcrypt's base64 dialect: same bit layout as standard base64, different alphabet, no padding.
function encodeDotSlash(bytes) {
  return bytesToBase64(bytes)
    .replace(/=+$/, '')
    .replace(/./g, (c) => DOT_SLASH[STANDARD.indexOf(c)]);
}

export function toInt(bytes) {
  let hex = '';
  for (let i = bytes.length - 1; i >= 0; i--) hex += bytes[i].toString(16).padStart(2, '0');
  return hex ? BigInt('0x' + hex) : 0n;
}

export function fromInt(num, length = BYTE_LENGTH) {
  const out = new Uint8Array(length);
  for (let i = 0; i < length && num > 0n; i++) {
    out[i] = Number(num & 0xffn);
    num >>= 8n;
  }
  return out;
}

export function modPow(base, exp, mod) {
  let result = 1n;
  base %= mod;
  if (base < 0n) base += mod;
  while (exp > 0n) {
    if (exp & 1n) result = (result * base) % mod;
    base = (base * base) % mod;
    exp >>= 1n;
  }
  return result;
}

const mod = (a, m) => ((a % m) + m) % m;

const bitLength = (n) => n.toString(2).length;

export async function expandHash(data) {
  const parts = [];
  for (let i = 0; i < 4; i++) {
    parts.push(new Uint8Array(await crypto.subtle.digest('SHA-512', concat(data, Uint8Array.of(i)))));
  }
  return concat(...parts);
}

function randomBytes(length) {
  const out = new Uint8Array(length);
  crypto.getRandomValues(out);
  return out;
}

/**
 * Extracts the base64 modulus from Proton's PGP clear-signed message.
 * The signature itself is not verified in this POC (go-srp checks it against Proton's modulus key).
 */
export function readClearSignedModulus(signed) {
  const normalized = signed.replace(/\r\n/g, '\n');
  const match = normalized.match(/-----BEGIN PGP SIGNED MESSAGE-----\n(?:[^\n]+\n)*\n([\s\S]*?)\n-----BEGIN PGP SIGNATURE-----/);
  if (!match) throw new Error(t('SRP: Modulus is not in a valid clear-sign format'));
  return match[1].trim();
}

/** bcrypt(password, salt + "proton") expanded with the modulus: Proton's password hash for auth versions 3/4. */
export async function hashPassword({ version, password, salt, modulusBytes, bcrypt }) {
  if (version !== 3 && version !== 4) {
    throw new Error(t('SRP: Auth version {version} is not supported (only 3 and 4)', { version }));
  }
  const encodedSalt = encodeDotSlash(concat(base64ToBytes(salt), ascii('proton')));
  const crypted = bcrypt.hashSync(password, '$2y$10$' + encodedSalt);
  return expandHash(concat(ascii(crypted), modulusBytes));
}

function checkParams(N, B) {
  if (bitLength(N) !== BIT_LENGTH) throw new Error(t('SRP: Modulus has the wrong length'));
  if (N % 8n !== 3n) throw new Error(t('SRP: Modulus is not 3 mod 8'));
  if (B <= 1n || B >= N - 1n) throw new Error(t('SRP: Server ephemeral is out of range'));
}

/**
 * Computes the client side of Proton's SRP login.
 * @param {object} p
 * @param {number} p.version       AuthInfo.Version
 * @param {string} p.password
 * @param {string} p.salt          AuthInfo.Salt (base64)
 * @param {string} p.signedModulus AuthInfo.Modulus (PGP clear-signed)
 * @param {string} p.serverEphemeral AuthInfo.ServerEphemeral (base64)
 * @param {object} p.bcrypt        bcryptjs instance
 * @param {Uint8Array} [p.clientSecret] fixed secret, only for tests
 */
export async function getSrpProofs({ version, password, salt, signedModulus, serverEphemeral, bcrypt, clientSecret }) {
  const modulusBytes = base64ToBytes(readClearSignedModulus(signedModulus));
  const serverEphemeralBytes = base64ToBytes(serverEphemeral);
  const N = toInt(modulusBytes);
  const B = toInt(serverEphemeralBytes);
  checkParams(N, B);

  const hashedPassword = await hashPassword({ version, password, salt, modulusBytes, bcrypt });
  const x = toInt(hashedPassword);
  const g = 2n;

  const k = mod(toInt(await expandHash(concat(fromInt(g), fromInt(N)))), N);
  if (k <= 1n || k >= N - 1n) throw new Error(t('SRP: Multiplier is out of range'));

  let a, A, u;
  for (;;) {
    a = clientSecret ? toInt(clientSecret) : mod(toInt(randomBytes(BYTE_LENGTH)), N - 1n);
    if (!clientSecret && (a <= BigInt(BIT_LENGTH * 2) || a >= N - 1n)) continue;
    A = fromInt(modPow(g, a, N));
    u = toInt(await expandHash(concat(A, serverEphemeralBytes)));
    if (u !== 0n) break;
    if (clientSecret) throw new Error(t('SRP: Scrambling parameter is 0'));
  }

  const base = mod(B - mod(k * modPow(g, x, N), N), N);
  const exponent = mod(mod(u * x, N - 1n) + a, N - 1n);
  const sharedSecret = fromInt(modPow(base, exponent, N));

  const clientProof = await expandHash(concat(A, serverEphemeralBytes, sharedSecret));
  const expectedServerProof = await expandHash(concat(A, clientProof, sharedSecret));

  return {
    clientEphemeral: bytesToBase64(A),
    clientProof: bytesToBase64(clientProof),
    expectedServerProof: bytesToBase64(expectedServerProof),
  };
}
