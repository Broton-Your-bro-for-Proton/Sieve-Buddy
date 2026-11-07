// JmapProvider against the fake JMAP server (scripts/fake-jmap.mjs), directly and through the service's MCP.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { createFakeJmap } from '../../scripts/fake-jmap.mjs';
import { JmapProvider } from '../src/providers/jmap-provider.js';
import { startServer } from '../src/index.js';

const MAIN = 'require ["fileinto"];\n\n# Shops\nif address :domain :is "from" ["amazon.de", "ebay.de"] {\n    fileinto "Shop";\n}\n';

async function withFake(options, fn) {
  const fake = createFakeJmap(options);
  const port = await fake.listen();
  try {
    await fn(fake, { url: `http://127.0.0.1:${port}/.well-known/jmap`, token: fake.token });
  } finally {
    await fake.close();
  }
}

test('capabilities, scripts and folders come from the session and blobs', () =>
  withFake({ scripts: { main: MAIN, alt: '# alt\n' }, active: 'main' }, async (fake, config) => {
    const p = new JmapProvider(config);
    const caps = await p.init();
    assert.equal(caps.implementation, 'Fake JMAP');
    assert.equal(caps.multipleActive, false);
    assert.ok(caps.dialect.extensions.includes('fileinto'));
    const scripts = await p.listScripts();
    assert.deepEqual(scripts.map((s) => [s.name, s.enabled]), [['main', true], ['alt', false]]);
    assert.equal(scripts[0].sieve, MAIN);
    assert.deepEqual((await p.listFolders()).folders, ['INBOX', 'Archiv', 'Archiv/2026', 'Shop']);
  }));

test('wrong token is rejected', () =>
  withFake({}, async (fake, config) => {
    await assert.rejects(new JmapProvider({ ...config, token: 'wrong' }).init(), /HTTP 401: Unauthorized/);
  }));

test('create, update, rename, activate and delete', () =>
  withFake({ scripts: { main: MAIN }, active: 'main' }, async (fake, config) => {
    const p = new JmapProvider(config);
    const { id } = await p.createScript({ name: 'zweit', sieve: '# zweit\n' });
    assert.equal(fake.state.active(), 'main', 'new scripts stay inactive');
    await assert.rejects(p.createScript({ name: 'zweit', sieve: '#\n' }), /gibt es schon/);

    await p.updateScript(id, { name: 'dritt', sieve: '# dritt\n', enabled: true });
    assert.equal(fake.state.active(), 'dritt');
    assert.equal(fake.state.text('dritt'), '# dritt\n');

    // deleting the active script deactivates it first
    await p.deleteScript(id);
    assert.equal(fake.state.active(), null);
    assert.deepEqual([...fake.state.scripts.values()].map((s) => s.name), ['main']);

    const main = [...fake.state.scripts.values()][0].id;
    await p.setEnabled(main, true);
    assert.equal(fake.state.active(), 'main');
    await p.setEnabled(main, false);
    assert.equal(fake.state.active(), null);
    const created = await p.createScript({ name: 'live', sieve: '# live\n', enabled: true });
    assert.equal(fake.state.active(), 'live');
    assert.equal(created.name, 'live');
    await assert.rejects(p.reorder([main]), /keine Reihenfolge/);
  }));

test('check uses SieveScript/validate and reports the line', () =>
  withFake({}, async (fake, config) => {
    const p = new JmapProvider(config);
    assert.deepEqual(await p.check(MAIN), []);
    const issues = await p.check('require ["fileinto"];\nfoo;\n');
    assert.equal(issues[0].line, 2);
    assert.ok(fake.state.calls.includes('SieveScript/validate'));
    assert.equal(fake.state.scripts.size, 0);
  }));

test('check falls back to a temporary script without SieveScript/validate', () =>
  withFake({ validate: false }, async (fake, config) => {
    const p = new JmapProvider(config);
    assert.deepEqual(await p.check(MAIN), []);
    assert.equal(fake.state.scripts.size, 0, 'temporary script removed');
    assert.equal((await p.check('foo;\n'))[0].line, 1);
    assert.equal(fake.state.scripts.size, 0);
  }));

// ---------- the service with PROVIDER=jmap, driven through a real MCP client ----------

const TOKEN = 'jmap-service-token-0123456789-abcdef';
let fake;
let service;
let mcp;
let dataDir;

const call = async (name, args = {}) => {
  const r = await mcp.callTool({ name, arguments: args });
  if (r.isError) throw new Error(r.content[0].text);
  return JSON.parse(r.content[0].text);
};

before(async () => {
  fake = createFakeJmap({ scripts: { main: MAIN, alt: '# alt\n' }, active: 'main' });
  const port = await fake.listen();
  dataDir = await mkdtemp(join(tmpdir(), 'pss-jmap-'));
  service = await startServer({
    host: '127.0.0.1',
    port: 0,
    dataDir,
    apiToken: TOKEN,
    allowWrite: true,
    provider: 'jmap',
    jmap: { url: `http://127.0.0.1:${port}/.well-known/jmap`, token: fake.token },
  });
  mcp = new Client({ name: 'test', version: '1.0.0' });
  await mcp.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${service.port}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } } }));
});

after(async () => {
  await mcp?.close();
  await new Promise((r) => service.server.close(r));
  await fake.close();
  await rm(dataDir, { recursive: true, force: true });
});

test('service: status, apply_rule into the active script, server check', async () => {
  const s = await call('sieve_status');
  assert.equal(s.provider, 'jmap');
  assert.equal(s.loggedIn, true);
  assert.equal(s.username, 'test');

  const rule = { conditions: [{ kind: 'address', header: 'from', part: 'domain', match: 'is', value: 'otto.de' }], actions: { fileinto: 'Shop' } };
  const r = await call('apply_rule', { rule });
  assert.equal(r.saved, true);
  assert.match(fake.state.text('main'), /\["amazon\.de", "ebay\.de", "otto\.de"\]/);
  assert.ok(!fake.state.text('alt').includes('otto'));

  const bad = await mcp.callTool({ name: 'create_filter', arguments: { name: 'kaputt', sieve: 'foo;' } });
  assert.equal(bad.isError, true);
  assert.match(bad.content[0].text, /Der Server lehnt das Skript ab: Zeile 1/);
});
