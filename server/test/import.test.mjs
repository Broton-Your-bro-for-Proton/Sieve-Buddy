// The add-on hands its session to the service: no password login by the service at all.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

import { ProtonClient } from '../../addon/lib/proton-api.js';
import { createFakeProton } from '../../scripts/fake-proton.mjs';
import { startServer } from '../src/index.js';

const bcrypt = createRequire(import.meta.url)('bcryptjs');
const TOKEN = 'import-test-token-0123456789-abcdef';
let fake;
let apiBase;
let service;
let base;
let dataDir;
let addonSession;

const memory = () => {
  let v = null;
  return { load: async () => v, save: async (s) => (v = s) };
};
const call = async (path, body, headers = {}) => {
  const res = await fetch(`${base}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, headers: res.headers, body: res.status === 204 ? null : await res.json() };
};

before(async () => {
  fake = createFakeProton();
  apiBase = await fake.listen();
  // the "add-on" logs in once
  const addon = new ProtonClient({ bcrypt, store: memory(), settings: { apiBase } });
  await addon.login('test@proton.local', 'test123');
  addonSession = addon.session;
  dataDir = await mkdtemp(join(tmpdir(), 'pss-import-'));
  service = await startServer({ host: '127.0.0.1', port: 0, dataDir, apiToken: TOKEN, secret: 's', allowWrite: true, proton: { apiBase, appVersion: 'Other' } });
  base = `http://127.0.0.1:${service.port}`;
});

after(async () => {
  await new Promise((r) => service.server.close(r));
  await fake.close();
  await rm(dataDir, { recursive: true, force: true });
});

test('import needs the API token', async () => {
  const res = await fetch(`${base}/api/session/import`, { method: 'POST', body: '{}' });
  assert.equal(res.status, 401);
});

test('an invalid session is rejected and nothing is stored', async () => {
  const r = await call('/api/session/import', { UID: 'nope', RefreshToken: 'nope' });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /nicht angenommen/);
  assert.equal((await call('/api/status')).body.loggedIn, false);
});

test('a valid session is taken over without any password login', async () => {
  const logins = () => fake.state.requests.filter((x) => x.path === 'core/v4/auth').length;
  const before = logins();
  const r = await call('/api/session/import', { ...addonSession, AccessToken: null });
  assert.equal(r.status, 200);
  assert.equal(r.body.username, 'test@proton.local');
  assert.equal(logins(), before, 'service must not log in itself');
  const filters = await call('/api/ops/list-filters', {});
  assert.equal(filters.body.filters.length, 2);
});

test('CORS allows the add-on origin only for import and status', async () => {
  const pre = await fetch(`${base}/api/session/import`, { method: 'OPTIONS', headers: { Origin: 'moz-extension://abc', 'Access-Control-Request-Method': 'POST' } });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get('access-control-allow-origin'), 'moz-extension://abc');
  const other = await fetch(`${base}/api/ops/list-filters`, { method: 'OPTIONS', headers: { Origin: 'moz-extension://abc' } });
  assert.equal(other.headers.get('access-control-allow-origin'), null);
  const web = await fetch(`${base}/api/session/import`, { method: 'OPTIONS', headers: { Origin: 'https://evil.example' } });
  assert.equal(web.headers.get('access-control-allow-origin'), null);
});
