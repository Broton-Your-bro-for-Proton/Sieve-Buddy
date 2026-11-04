// A local stand-in for Proton's web API, for development and end-to-end tests.
// Real SRP (go-srp server logic with go-srp's test modulus), optional TOTP and captcha (Code 9001),
// token refresh, filters and labels. Check emulates Proton by rejecting scripts the linter finds errors in.
//
//   node scripts/fake-proton.mjs            → http://127.0.0.1:8790/api, user "test@proton.local" / "test123"
//   FAKE_TOTP=1 FAKE_CAPTCHA=1 node scripts/fake-proton.mjs

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { base64ToBytes, bytesToBase64, expandHash, fromInt, hashPassword, modPow, readClearSignedModulus, toInt } from '../addon/lib/srp.js';
import { lintSieve } from '../addon/lib/sieve-analyzer.js';
import { newScript } from '../addon/lib/sieve-dialect.js';

const require = createRequire(import.meta.url);
const bcrypt = require('bcryptjs');
const fixtures = JSON.parse(readFileSync(new URL('../test/fixtures.json', import.meta.url), 'utf8'));

const concat = (...parts) => Uint8Array.from(parts.flatMap((p) => [...p]));
const id = () => randomBytes(8).toString('hex');

const withExtensions = (rules, exts) => newScript(rules).replace('"spamtest"]', `"spamtest", ${exts.map((e) => `"${e}"`).join(', ')}]`);

export function defaultFilters() {
  return [
    {
      ID: 'f-shops',
      Name: 'Einkäufe',
      Status: 1,
      Priority: 1,
      Version: 2,
      Sieve: withExtensions('# Shops\nif address :domain :is "from" ["amazon.de", "ebay.de"] {\n    addflag "\\\\Seen";\n    fileinto "Einkäufe";\n}', ['fileinto', 'imap4flags']),
    },
    {
      ID: 'f-lists',
      Name: 'Listen',
      Status: 1,
      Priority: 2,
      Version: 2,
      Sieve: withExtensions('if exists "list-id" {\n    fileinto "Listen";\n    stop;\n}', ['fileinto']),
    },
  ];
}

/**
 * @param {{username?: string, password?: string, totp?: string|null, captcha?: boolean, abuse?: boolean, maxActive?: number, filters?: object[]}} [options]
 */
export function createFakeProton(options = {}) {
  const username = options.username ?? 'test@proton.local';
  const password = options.password ?? 'test123';
  const totp = options.totp ?? null; // e.g. '123456'
  const state = {
    filters: structuredClone(options.filters ?? defaultFilters()),
    folders: ['Einkäufe', 'Listen', 'Newsletter', 'Rechnungen', 'Archiv/2026'],
    labels: ['Wichtig'],
    sessions: new Map(), // UID → {access, refresh, scope}
    srp: new Map(), // SRPSession → {b, B}
    hv: { required: Boolean(options.captcha), token: null, solved: false },
    requests: [],
  };
  const modulusBytes = base64ToBytes(readClearSignedModulus(fixtures.signedModulus));
  const N = toInt(modulusBytes);
  let verifier;
  let k;

  async function init() {
    const x = toInt(await hashPassword({ version: 4, password, salt: fixtures.salt, modulusBytes, bcrypt }));
    verifier = modPow(2n, x, N);
    k = toInt(await expandHash(concat(fromInt(2n), fromInt(N)))) % N;
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const path = url.pathname.replace(/^\/api\//, '');
    const chunks = [];
    for await (const c of req) chunks.push(c);
    let body = {};
    try {
      body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    } catch {
      body = {};
    }
    const cors = {
      'Access-Control-Allow-Origin': req.headers.origin ?? '*',
      'Access-Control-Allow-Headers': 'content-type, authorization, x-pm-uid, x-pm-appversion, x-pm-human-verification-token, x-pm-human-verification-token-type',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    };
    const reply = (status, data) => {
      res.writeHead(status, { 'Content-Type': 'application/json', ...cors });
      res.end(JSON.stringify(data));
    };
    if (req.method === 'OPTIONS') return reply(204, {});
    state.requests.push({ method: req.method, path, appVersion: req.headers['x-pm-appversion'] });
    if (!req.headers['x-pm-appversion'] && path !== 'verify') return reply(400, { Code: 5001, Error: 'Missing app version' });

    try {
      // ---------- human verification page (stands in for verify.proton.me) ----------
      if (path === 'verify') {
        if (url.searchParams.get('token') === state.hv.token) state.hv.solved = true;
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end('<!doctype html><title>Fake verify</title><p>Captcha gelöst ✓ – zurück zur App.</p>');
      }

      // ---------- auth ----------
      if (path === 'core/v4/auth/info') {
        if (body.Username !== username) return reply(422, { Code: 8002, Error: 'Incorrect login credentials' });
        const b = toInt(randomBytes(256)) % (N - 1n);
        const B = fromInt((k * verifier + modPow(2n, b, N)) % N);
        const session = id();
        state.srp.set(session, { b, B });
        return reply(200, { Code: 1000, Version: 4, Modulus: fixtures.signedModulus, ServerEphemeral: bytesToBase64(B), Salt: fixtures.salt, SRPSession: session });
      }
      if (path === 'core/v4/auth' && options.abuse) {
        return reply(422, { Code: 2028, Error: 'Our systems detected unusual activity targeting your account. To protect you from potential compromise, we have temporarily limited access to it. If this persists or you believe this is in error, please contact us at https://proton.me/support/appeal-abuse' });
      }
      if (path === 'core/v4/auth') {
        // like Proton: 9001 until the token was solved on the verify page and is sent back as a header
        if (state.hv.required) {
          const token = (state.hv.token ??= id());
          const sent = req.headers['x-pm-human-verification-token'] === token && req.headers['x-pm-human-verification-token-type'] === 'captcha';
          if (!(state.hv.solved && sent)) {
            const port = server.address().port;
            return reply(422, {
              Code: 9001,
              Error: 'For security reasons, please complete CAPTCHA',
              Details: { HumanVerificationToken: token, HumanVerificationMethods: ['captcha'], WebUrl: `http://127.0.0.1:${port}/api/verify?methods=captcha&token=${token}` },
            });
          }
        }
        const srp = state.srp.get(body.SRPSession);
        state.srp.delete(body.SRPSession);
        if (!srp) return reply(422, { Code: 8002, Error: 'Invalid SRP session' });
        const A = base64ToBytes(body.ClientEphemeral);
        const u = toInt(await expandHash(concat(A, srp.B)));
        const S = fromInt(modPow((toInt(A) * modPow(verifier, u, N)) % N, srp.b, N));
        const expected = await expandHash(concat(A, srp.B, S));
        if (bytesToBase64(expected) !== body.ClientProof) return reply(422, { Code: 8002, Error: 'Incorrect login credentials' });
        const serverProof = bytesToBase64(await expandHash(concat(A, base64ToBytes(body.ClientProof), S)));
        const UID = id();
        const tokens = { access: id(), refresh: id(), scope: totp ? 'twofactor' : 'full' };
        state.sessions.set(UID, tokens);
        return reply(200, { Code: 1000, UID, AccessToken: tokens.access, RefreshToken: tokens.refresh, ServerProof: serverProof, Scope: tokens.scope, '2FA': { Enabled: totp ? 1 : 0 } });
      }
      if (path === 'auth/v4/refresh') {
        const s = state.sessions.get(body.UID);
        if (!s || s.refresh !== body.RefreshToken) return reply(422, { Code: 10013, Error: 'Invalid refresh token' });
        s.access = id();
        s.refresh = id();
        return reply(200, { Code: 1000, AccessToken: s.access, RefreshToken: s.refresh });
      }

      // everything below needs a session
      const uid = req.headers['x-pm-uid'];
      const session = state.sessions.get(uid);
      if (!session || req.headers.authorization !== `Bearer ${session.access}`) return reply(401, { Code: 401, Error: 'Invalid access token' });

      if (path === 'core/v4/auth/2fa') {
        if (body.TwoFactorCode !== totp) return reply(422, { Code: 8002, Error: 'Incorrect 2FA code' });
        session.scope = 'full';
        return reply(200, { Code: 1000, Scope: 'full' });
      }
      if (path === 'core/v4/auth' && req.method === 'DELETE') {
        state.sessions.delete(uid);
        return reply(200, { Code: 1000 });
      }
      if (session.scope !== 'full') return reply(403, { Code: 9101, Error: 'Two-factor authentication required' });

      if (path === 'core/v4/labels') {
        const list = url.searchParams.get('Type') === '3' ? state.folders : state.labels;
        return reply(200, { Code: 1000, Labels: list.map((p) => ({ ID: id(), Name: p.split('/').pop(), Path: p })) });
      }
      if (path === 'mail/v4/filters' && req.method === 'GET') return reply(200, { Code: 1000, Filters: state.filters });
      if (path === 'mail/v4/filters/check') {
        const errors = lintSieve(body.Sieve ?? '').filter((i) => i.severity === 'error');
        const text = body.Sieve ?? '';
        const pos = (offset) => {
          const before = text.slice(0, offset).split('\n');
          return { line: before.length - 1, ch: before.at(-1).length };
        };
        return reply(200, { Code: 1000, Issues: errors.map((e) => ({ from: pos(e.start), to: pos(e.end), message: e.message, severity: 'error' })) });
      }
      if (path === 'mail/v4/filters/order') {
        state.filters.sort((a, b) => body.FilterIDs.indexOf(a.ID) - body.FilterIDs.indexOf(b.ID));
        state.filters.forEach((f, i) => (f.Priority = i + 1));
        return reply(200, { Code: 1000 });
      }
      if (path === 'mail/v4/filters' && req.method === 'POST') {
        if (lintSieve(body.Sieve ?? '').some((i) => i.severity === 'error')) return reply(422, { Code: 2001, Error: 'Invalid sieve' });
        const f = { ID: `f-${id()}`, Name: body.Name, Status: body.Status ?? 1, Priority: state.filters.length + 1, Version: 2, Sieve: body.Sieve };
        // like Proton's free plan: over the limit the filter is still created, but disabled, and 50016 is returned
        if (options.maxActive !== undefined && state.filters.filter((x) => x.Status === 1).length >= options.maxActive) {
          state.filters.push({ ...f, Status: 0 });
          return reply(422, { Code: 50016, Error: 'Too many active filters' });
        }
        state.filters.push(f);
        return reply(200, { Code: 1000, Filter: f });
      }
      const m = /^mail\/v4\/filters\/([^/]+)(?:\/(enable|disable))?$/.exec(path);
      if (m) {
        const f = state.filters.find((x) => x.ID === m[1]);
        if (!f) return reply(422, { Code: 2501, Error: 'Filter not found' });
        if (m[2]) f.Status = m[2] === 'enable' ? 1 : 0;
        else if (req.method === 'PUT') {
          if (lintSieve(body.Sieve ?? '').some((i) => i.severity === 'error')) return reply(422, { Code: 2001, Error: 'Invalid sieve' });
          Object.assign(f, { Name: body.Name, Sieve: body.Sieve, Status: body.Status });
        } else if (req.method === 'DELETE') state.filters = state.filters.filter((x) => x !== f);
        return reply(200, { Code: 1000, Filter: f });
      }
      return reply(404, { Code: 404, Error: `Unknown ${req.method} ${path}` });
    } catch (error) {
      return reply(500, { Code: 500, Error: error.message });
    }
  });

  return {
    state,
    server,
    async listen(port = 0, host = '127.0.0.1') {
      await init();
      await new Promise((r) => server.listen(port, host, r));
      return `http://${host}:${server.address().port}/api`;
    },
    close: () => new Promise((r) => server.close(r)),
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const fake = createFakeProton({ totp: process.env.FAKE_TOTP ? '123456' : null, captcha: Boolean(process.env.FAKE_CAPTCHA) });
  const base = await fake.listen(Number(process.env.PORT ?? 8790), process.env.HOST ?? '127.0.0.1');
  console.log(`Fake Proton API: ${base}  (user test@proton.local / test123${process.env.FAKE_TOTP ? ', TOTP 123456' : ''}${process.env.FAKE_CAPTCHA ? ', captcha on' : ''})`);
}
