// Regression tests for the findings of the third review that concern the service.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createFakeManageSieve } from '../../scripts/fake-managesieve.mjs';
import { startServer } from '../src/index.js';

const TOKEN = 'review-3-token-0123456789-abcdef';
const MAIN = 'require ["fileinto"];\nif header :contains "subject" "x" {\n    fileinto "A";\n}\n';
const CHANGED = '# changed\n';
const cleanup = [];

/** A service on a fake ManageSieve server without CHECKSCRIPT. */
async function service({ allowWrite }) {
  const fake = createFakeManageSieve({ scripts: { main: MAIN, other: '# other\n' }, active: 'main', checkscript: false });
  const port = await fake.listen();
  const dataDir = await mkdtemp(join(tmpdir(), 'pss-r3-'));
  const running = await startServer({
    host: '127.0.0.1',
    port: 0,
    dataDir,
    apiToken: TOKEN,
    allowWrite,
    provider: 'managesieve',
    managesieve: { host: '127.0.0.1', port, tls: 'none', user: 'test', password: 'test123', imap: null },
  });
  cleanup.push(async () => {
    await new Promise((r) => running.server.close(r));
    await fake.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${running.port}`;
  const op = async (name, body) => {
    const res = await fetch(`${base}/api/ops/${name}`, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  return { fake, running, base, op };
}

let writable;
let readOnly;
before(async () => {
  writable = await service({ allowWrite: true });
  readOnly = await service({ allowWrite: false });
});
after(async () => {
  for (const done of cleanup) await done();
});

test('a request for an invalid path is answered with 400 and the service keeps running', async () => {
  const { port } = writable.running;
  const status = await new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: '//', method: 'GET' }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('error', reject);
    req.end();
  });
  assert.equal(status, 400);
  assert.equal((await fetch(`${writable.base}/health`)).status, 200);
});

test('the page of the service carries a Content-Security-Policy that allows its own inline script only', async () => {
  const res = await fetch(`${writable.base}/`);
  const csp = res.headers.get('content-security-policy') ?? '';
  assert.match(csp, /script-src 'self' 'sha256-[A-Za-z0-9+/=]+'/);
  assert.match(csp, /connect-src 'self'/);
  assert.doesNotMatch(csp, /unsafe-eval/);
});

test('renaming onto an existing script fails before the content is written', async () => {
  const res = await writable.op('update-filter', { id: 'main', name: 'other', sieve: '# replaced\n' });
  assert.equal(res.status >= 400, true);
  assert.match(res.body.error, /already exists/);
  assert.equal((await writable.op('get-filter', { id: 'main' })).body.sieve, MAIN);
});

test('without write access a server without CHECKSCRIPT is not checked by uploading', async () => {
  const res = await readOnly.op('check', { sieve: 'keep;\n' });
  assert.equal(res.status >= 400, true);
  assert.match(res.body.error, /CHECKSCRIPT/);
  const { filters } = (await readOnly.op('list-filters', {})).body;
  assert.deepEqual(filters.map((f) => f.name).sort(), ['main', 'other']);
});

test('a read that overlaps a write does not put the old state back into the cache', async () => {
  const { account } = writable.running;
  const original = account.provider.listScripts.bind(account.provider);
  let release = null;
  account.provider.listScripts = async () => {
    const scripts = await original();
    await new Promise((resolve) => (release = resolve));
    return scripts;
  };
  account.cache = null;
  const reading = account.data(); // fetched before the write, answered after it
  while (!release) await new Promise((r) => setTimeout(r, 5));
  account.provider.listScripts = original;
  const write = await writable.op('update-filter', { id: 'other', sieve: CHANGED });
  assert.equal(write.status, 200, JSON.stringify(write.body));
  release();
  await reading;
  const after = await account.data();
  assert.equal(after.scripts.find((x) => x.id === 'other').sieve, CHANGED);
});
