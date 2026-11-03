// Full login flow through the service against the fake Proton: SRP + captcha + TOTP, session persisted
// encrypted, survives a restart, wrong credentials and wrong codes are rejected.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createFakeProton } from '../../scripts/fake-proton.mjs';
import { startServer } from '../src/index.js';

const TOKEN = 'login-test-token-0123456789-abcdef';
let fake;
let apiBase;
let dataDir;
let service;
let base;

const config = () => ({ host: '127.0.0.1', port: 0, dataDir, apiToken: TOKEN, secret: 's3cret', allowWrite: true, proton: { apiBase, appVersion: 'Other' } });
const post = async (path, body = {}) => {
  const res = await fetch(`${base}${path}`, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
};
const status = async () => (await fetch(`${base}/api/status`, { headers: { Authorization: `Bearer ${TOKEN}` } })).json();

before(async () => {
  fake = createFakeProton({ totp: '123456', captcha: true });
  apiBase = await fake.listen();
  dataDir = await mkdtemp(join(tmpdir(), 'pss-login-'));
  service = await startServer(config());
  base = `http://127.0.0.1:${service.port}`;
});

after(async () => {
  await new Promise((r) => service.server.close(r));
  await fake.close();
  await rm(dataDir, { recursive: true, force: true });
});

test('wrong password is rejected after the captcha', async () => {
  const first = await post('/api/login', { username: 'test@proton.local', password: 'falsch' });
  assert.equal(first.body.step, 'captcha');
  await fetch(first.body.webUrl); // "solve" the captcha
  const second = await post('/api/login/continue');
  assert.equal(second.status, 400);
  assert.match(second.body.error, /Incorrect login credentials/);
  assert.equal((await status()).loggedIn, false);
});

test('captcha → TOTP → logged in, and the password is never stored', async () => {
  const first = await post('/api/login', { username: 'test@proton.local', password: 'test123' });
  assert.equal(first.body.step, 'captcha', 'captcha already solved earlier stays solved, so Proton may skip it');
  assert.equal((await status()).pending, 'captcha');
  await fetch(first.body.webUrl);
  const second = await post('/api/login/continue');
  assert.equal(second.body.step, 'totp');
  assert.equal((await status()).pending, 'totp');

  const wrong = await post('/api/login/totp', { code: '000000' });
  assert.equal(wrong.status, 400);
  const ok = await post('/api/login/totp', { code: '123456' });
  assert.equal(ok.body.step, 'done');

  const s = await status();
  assert.equal(s.loggedIn, true);
  assert.equal(s.username, 'test@proton.local');

  const stored = await readFile(join(dataDir, 'session.json'), 'utf8');
  assert.ok(!stored.includes('test123'), 'password must not be stored');
  assert.ok(!stored.includes('test@proton.local'), 'session file is encrypted');
  const filters = await post('/api/ops/list-filters');
  assert.equal(filters.body.filters.length, 2);
});

test('session survives a service restart', async () => {
  await new Promise((r) => service.server.close(r));
  service = await startServer(config());
  base = `http://127.0.0.1:${service.port}`;
  assert.equal((await status()).loggedIn, true);
  const filters = await post('/api/ops/list-filters');
  assert.equal(filters.status, 200);
});

test('a different secret cannot read the session', async () => {
  await new Promise((r) => service.server.close(r));
  service = await startServer({ ...config(), secret: 'other' });
  base = `http://127.0.0.1:${service.port}`;
  assert.equal((await status()).loggedIn, false);
});

test('logout clears the session', async () => {
  await new Promise((r) => service.server.close(r));
  service = await startServer(config());
  base = `http://127.0.0.1:${service.port}`;
  assert.equal((await status()).loggedIn, true);
  await post('/api/logout');
  assert.equal((await status()).loggedIn, false);
  await assert.rejects(readFile(join(dataDir, 'session.json')));
});

test('ALLOW_WRITE=false blocks writes but allows planning', async () => {
  await new Promise((r) => service.server.close(r));
  service = await startServer({ ...config(), allowWrite: false });
  base = `http://127.0.0.1:${service.port}`;
  // log in again (captcha already solved in this fake)
  const r = await post('/api/login', { username: 'test@proton.local', password: 'test123' });
  if (r.body.step === 'captcha') {
    await fetch(r.body.webUrl);
    await post('/api/login/continue');
  }
  await post('/api/login/totp', { code: '123456' });
  const rule = { conditions: [{ kind: 'address', header: 'from', part: 'domain', match: 'is', value: 'otto.de' }], actions: { fileinto: 'Einkäufe', seen: true } };
  const plan = await post('/api/ops/plan-rule', { rule });
  assert.equal(plan.status, 200);
  assert.equal(plan.body.steps[0].kind, 'append-key');
  const apply = await post('/api/ops/apply-rule', { rule });
  assert.equal(apply.status, 400);
  assert.match(apply.body.error, /ALLOW_WRITE=false/);
});
