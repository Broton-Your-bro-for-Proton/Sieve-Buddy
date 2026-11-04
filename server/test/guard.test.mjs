// Proton's "unusual activity" block stops further password logins for 24 h – they never reach Proton.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createFakeProton } from '../../scripts/fake-proton.mjs';
import { startServer } from '../src/index.js';

const TOKEN = 'guard-test-token-0123456789-abcdef';
let fake;
let service;
let base;
let dataDir;

const post = async (path, body = {}) => {
  const res = await fetch(`${base}${path}`, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
};

before(async () => {
  fake = createFakeProton({ abuse: true });
  const apiBase = await fake.listen();
  dataDir = await mkdtemp(join(tmpdir(), 'pss-guard-'));
  service = await startServer({ host: '127.0.0.1', port: 0, dataDir, apiToken: TOKEN, secret: 's', allowWrite: true, proton: { apiBase, appVersion: 'Other' } });
  base = `http://127.0.0.1:${service.port}`;
});

after(async () => {
  await new Promise((r) => service.server.close(r));
  await fake.close();
  await rm(dataDir, { recursive: true, force: true });
});

test('abuse response pauses logins; retries never reach Proton', async () => {
  const first = await post('/api/login', { username: 'test@proton.local', password: 'test123' });
  assert.equal(first.status, 400);
  assert.match(first.body.error, /unusual activity/);
  assert.equal(first.body.proton.code, 2028);

  const authCalls = () => fake.state.requests.filter((r) => r.path === 'core/v4/auth').length;
  const before = authCalls();
  const second = await post('/api/login', { username: 'test@proton.local', password: 'test123' });
  assert.equal(second.status, 400);
  assert.match(second.body.error, /Anmeldung pausiert bis/);
  assert.equal(authCalls(), before, 'blocked attempt must not contact Proton');
  assert.equal(fake.state.requests.filter((r) => r.path === 'core/v4/auth/info').length, 1);

  const status = await (await fetch(`${base}/api/status`, { headers: { Authorization: `Bearer ${TOKEN}` } })).json();
  assert.ok(status.loginGuard.blockedUntil > Date.now() + 23 * 3600_000);
  assert.equal(status.loginGuard.lastError.code, 2028);

  const reset = await post('/api/login/reset-guard');
  assert.equal(reset.body.loginGuard.blockedUntil, null);
});
