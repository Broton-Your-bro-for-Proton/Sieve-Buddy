// Regression tests for the findings of the full repository check (service side).
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createFakeJmap } from '../../scripts/fake-jmap.mjs';
import { createFakeManageSieve } from '../../scripts/fake-managesieve.mjs';
import { startServer } from '../src/index.js';
import { listImapFolders } from '../src/providers/imap-folders.js';
import { JmapProvider } from '../src/providers/jmap-provider.js';
import { ManageSieveConnection } from '../src/providers/managesieve.js';
import { ManageSieveProvider } from '../src/providers/managesieve-provider.js';

const TOKEN = 'full-check-token-0123456789-abcdef';
const MAIN = 'require ["fileinto"];\n\nif address :domain :is "from" ["amazon.de"] {\n    fileinto "Shop";\n}\n';
let fake;
let service;
let dataDir;
let base;

const rest = async (op, body) => {
  const res = await fetch(`${base}/api/ops/${op}`, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) });
  return { status: res.status, body: await res.json() };
};

before(async () => {
  fake = createFakeManageSieve({ scripts: { main: MAIN }, active: 'main' });
  const port = await fake.listen();
  dataDir = await mkdtemp(join(tmpdir(), 'pss-fc-'));
  service = await startServer({
    host: '127.0.0.1',
    port: 0,
    dataDir,
    apiToken: TOKEN,
    allowWrite: true,
    provider: 'managesieve',
    managesieve: { host: '127.0.0.1', port, tls: 'none', user: 'test', password: 'test123', imap: null },
  });
  base = `http://127.0.0.1:${service.port}`;
});

after(async () => {
  await new Promise((r) => service.server.close(r));
  await fake.close();
  await rm(dataDir, { recursive: true, force: true });
});

test('prototype names are no REST operations', async () => {
  for (const op of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
    const r = await rest(op);
    assert.equal(r.status, 404, op);
    assert.ok(!JSON.stringify(r.body).includes('test123'));
  }
});

test('REST validates input like MCP', async () => {
  const rule = { conditions: [{ kind: 'address', header: 'from', match: 'is "x" "y" { discard; stop; } if true', value: 'v' }], actions: { fileinto: 'INBOX' } };
  const r = await rest('plan-rule', { rule });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /Invalid input/);
  assert.equal((await rest('get-filter', {})).status, 400);
});

test('create-filter without enabled keeps the active script', async () => {
  const r = await rest('create-filter', { name: 'new', sieve: '# new\n' });
  assert.equal(r.status, 200);
  assert.equal(fake.state.active, 'main');
  await rest('delete-filter', { id: 'new' });
});

test('create-filter activates the first script when none is active, and says so', async () => {
  const ms = createFakeManageSieve({ scripts: { old: '# old\n' }, active: null });
  const port = await ms.listen();
  const dir = await mkdtemp(join(tmpdir(), 'pss-fc2-'));
  const svc = await startServer({
    host: '127.0.0.1',
    port: 0,
    dataDir: dir,
    apiToken: TOKEN,
    allowWrite: true,
    provider: 'managesieve',
    managesieve: { host: '127.0.0.1', port, tls: 'none', user: 'test', password: 'test123', imap: null },
  });
  try {
    const res = await fetch(`http://127.0.0.1:${svc.port}/api/ops/create-filter`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'first', sieve: 'keep;\n' }),
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).enabled, true);
    assert.equal(ms.state.active, 'first');
  } finally {
    await new Promise((r) => svc.server.close(r));
    await ms.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('update-filter with expectedSieve refuses a script that changed', async () => {
  const before = fake.state.scripts.get('main');
  fake.state.scripts.set('main', `${before}\n# other change\n`);
  const r = await rest('update-filter', { id: 'main', sieve: `${before}\n# mine\n`, expectedSieve: before });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /changed in the meantime/);
  assert.match(fake.state.scripts.get('main'), /# other change/);
  const ok = await rest('update-filter', { id: 'main', sieve: fake.state.scripts.get('main'), expectedSieve: fake.state.scripts.get('main') });
  assert.equal(ok.status, 200);
});

test('apply-rule does not overwrite a change made after the last read', async () => {
  await rest('list-filters'); // fills the cache
  const external = `${fake.state.scripts.get('main')}\n# external change\n`;
  fake.state.scripts.set('main', external);
  const r = await rest('apply-rule', { rule: { conditions: [{ kind: 'address', header: 'from', part: 'domain', value: 'otto.de' }], actions: { fileinto: 'Shop' } } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(fake.state.scripts.get('main'), /# external change/);
  assert.match(fake.state.scripts.get('main'), /otto\.de/);
});

test('apply-rule refuses to save when the script changed between planning and saving', async () => {
  const provider = service.account.provider;
  const check = provider.check.bind(provider);
  provider.check = async (sieve) => {
    fake.state.scripts.set('main', `${fake.state.scripts.get('main')}\n# racing change\n`);
    return check(sieve);
  };
  try {
    const r = await rest('apply-rule', { rule: { conditions: [{ kind: 'address', header: 'from', part: 'domain', value: 'zalando.de' }], actions: { fileinto: 'Shop' } } });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /changed in the meantime/);
    assert.match(fake.state.scripts.get('main'), /# racing change/);
    assert.ok(!fake.state.scripts.get('main').includes('zalando'));
  } finally {
    delete provider.check;
  }
});

test('a line break in a script name cannot inject ManageSieve commands', async () => {
  fake.state.commands.length = 0;
  const r = await rest('create-filter', { name: 'x\r\nDELETESCRIPT "main"', sieve: '# x\n' });
  assert.equal(r.status, 400);
  assert.ok(!fake.state.commands.includes('DELETESCRIPT'));
  assert.ok(fake.state.scripts.has('main'));
});

test('simulate reports a broken script instead of failing', async () => {
  const r = await rest('simulate', { headers: 'Subject: x\n', overrides: [{ id: 'main', sieve: 'if header :is "subject" "x" fileinto "y";' }] });
  assert.equal(r.status, 200);
  assert.ok(r.body.notes.some((n) => n.includes('main')));
});

test('ManageSieve: a failed delete leaves the script active', async () => {
  const ms = createFakeManageSieve({ scripts: { main: MAIN }, active: 'main' });
  const port = await ms.listen();
  const original = ManageSieveConnection.prototype.deleteScript;
  ManageSieveConnection.prototype.deleteScript = async () => {
    throw new Error('boom');
  };
  try {
    const provider = new ManageSieveProvider({ host: '127.0.0.1', port, tls: 'none', user: 'test', password: 'test123', imap: null });
    await provider.init();
    await assert.rejects(provider.deleteScript('main'), /boom/);
    assert.equal(ms.state.active, 'main');
  } finally {
    ManageSieveConnection.prototype.deleteScript = original;
    await ms.close();
  }
});

test('JMAP: a failed delete leaves the script active', async () => {
  const fj = createFakeJmap({ scripts: { main: MAIN }, active: 'main' });
  const port = await fj.listen();
  const realFetch = globalThis.fetch;
  globalThis.fetch = (url, init) => (String(init?.body ?? '').includes('"destroy"') ? Promise.resolve(new Response('', { status: 500 })) : realFetch(url, init));
  try {
    const provider = new JmapProvider({ url: `http://127.0.0.1:${port}/.well-known/jmap`, token: fj.token });
    await provider.init();
    const [script] = await provider.listScripts();
    await assert.rejects(provider.deleteScript(script.id), /HTTP 500/);
    assert.equal([...fj.state.scripts.values()].find((s) => s.name === 'main').isActive, true);
  } finally {
    globalThis.fetch = realFetch;
    await fj.close();
  }
});

test('JMAP: session URLs must not drop from https to http', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    const res = new Response(
      JSON.stringify({
        primaryAccounts: { 'urn:ietf:params:jmap:sieve': 'A' },
        accounts: { A: { accountCapabilities: { 'urn:ietf:params:jmap:sieve': {} } } },
        capabilities: {},
        apiUrl: 'http://evil.example/api',
        uploadUrl: 'https://mail.example/upload/{accountId}/',
        downloadUrl: 'https://mail.example/download/{accountId}/{blobId}/{name}?type={type}',
      }),
    );
    Object.defineProperty(res, 'url', { value: 'https://mail.example/.well-known/jmap' });
    return res;
  };
  try {
    await assert.rejects(new JmapProvider({ url: 'https://mail.example/.well-known/jmap', token: 't' }).init(), /apiUrl/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('IMAP: non-ASCII credentials go as literals', async () => {
  const seen = [];
  const server = net.createServer((socket) => {
    let buffer = '';
    let need = 0;
    socket.write('* OK ready\r\n');
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      while (buffer.includes('\r\n')) {
        const line = buffer.slice(0, buffer.indexOf('\r\n'));
        buffer = buffer.slice(line.length + 2);
        seen.push(line);
        const literal = /\{(\d+)\}$/.exec(line);
        if (literal) {
          need = Number(literal[1]);
          socket.write('+ go\r\n');
        } else if (/^a\d+ LIST/.test(line)) socket.write('* LIST () "/" "INBOX"\r\na2 OK done\r\n');
        else if (/^a\d+ LOGOUT/.test(line)) socket.write('a3 OK bye\r\n');
        else if (need) {
          need = 0;
          socket.write('a1 OK logged in\r\n');
        }
      }
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const folders = await listImapFolders({ host: '127.0.0.1', port: server.address().port, tls: 'none', user: 'bob', password: 'pässwort' });
    assert.deepEqual(folders, ['INBOX']);
    assert.deepEqual(seen.slice(0, 3), ['a1 LOGIN {3}', 'bob {9}', 'pässwort']);
  } finally {
    server.close();
  }
});
