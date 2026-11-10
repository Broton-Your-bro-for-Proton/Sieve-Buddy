// ManageSieve credentials entered in the web UI: tested before saving, stored encrypted, survive a restart.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createFakeManageSieve } from '../../scripts/fake-managesieve.mjs';
import { startServer } from '../src/index.js';

const TOKEN = 'cred-test-token-0123456789-abcdef';
let fake;
let port;
let dataDir;
let service;
let base;

const start = async (credentials = {}) => {
  if (service) await new Promise((r) => service.server.close(r));
  service = await startServer({
    host: '127.0.0.1',
    port: 0,
    dataDir,
    apiToken: TOKEN,
    secret: 's3cret',
    allowWrite: true,
    provider: 'managesieve',
    managesieve: { host: '127.0.0.1', port, tls: 'none', imap: null, ...credentials },
  });
  base = `http://127.0.0.1:${service.port}`;
};
const post = async (path, body = {}) => {
  const res = await fetch(`${base}${path}`, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
};
const status = async () => (await fetch(`${base}/api/status`, { headers: { Authorization: `Bearer ${TOKEN}` } })).json();
const stored = () => readFile(join(dataDir, 'credentials.json'), 'utf8').catch(() => null);

before(async () => {
  fake = createFakeManageSieve({ scripts: { main: '# main\n' }, active: 'main' });
  port = await fake.listen();
  dataDir = await mkdtemp(join(tmpdir(), 'pss-cred-'));
});

after(async () => {
  await new Promise((r) => service.server.close(r));
  await fake.close();
  await rm(dataDir, { recursive: true, force: true });
});

test('without credentials the service waits for them', async () => {
  await start();
  const s = await status();
  assert.equal(s.loggedIn, false);
  assert.equal(s.credentials, null);
  assert.match(s.error, /No credentials yet/);
});

test('wrong credentials are not stored', async () => {
  const r = await post('/api/credentials', { user: 'test', secret: 'wrong' });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /Authentication failed/);
  assert.equal(await stored(), null);
});

test('right credentials are stored encrypted and survive a restart', async () => {
  const r = await post('/api/credentials', { user: 'test', secret: 'test123' });
  assert.equal(r.status, 200);
  assert.equal(r.body.loggedIn, true);
  assert.equal(r.body.credentials, 'stored');
  const file = await stored();
  assert.ok(file && !file.includes('test123') && !file.includes('"test"'), 'encrypted on disk');
  await start();
  const s = await status();
  assert.equal(s.loggedIn, true);
  assert.equal(s.username, 'test');
  assert.equal((await post('/api/ops/list-filters')).status, 200);
});

test('removing the credentials signs out and deletes the file', async () => {
  await post('/api/logout');
  assert.equal((await status()).credentials, null);
  assert.equal(await stored(), null);
});

test('credentials from the configuration cannot be replaced', async () => {
  await start({ user: 'test', password: 'test123' });
  const s = await status();
  assert.equal(s.credentials, 'config');
  assert.equal(s.loggedIn, true);
  const r = await post('/api/credentials', { user: 'test', secret: 'other' });
  assert.match(r.body.error, /come from the configuration/);
});
