// The service with PROVIDER=managesieve, driven through a real MCP client.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { createFakeManageSieve } from '../../scripts/fake-managesieve.mjs';
import { startServer } from '../src/index.js';

const TOKEN = 'ms-service-token-0123456789-abcdef';
const MAIN = 'require ["fileinto"];\n\n# Shops\nif address :domain :is "from" ["amazon.de", "ebay.de"] {\n    fileinto "Shop";\n}\n';
let fake;
let service;
let mcp;
let dataDir;
let base;

const call = async (name, args = {}) => {
  const r = await mcp.callTool({ name, arguments: args });
  if (r.isError) throw new Error(r.content[0].text);
  return JSON.parse(r.content[0].text);
};

before(async () => {
  fake = createFakeManageSieve({ scripts: { main: MAIN, alt: '# alt\n' }, active: 'main' });
  const port = await fake.listen();
  dataDir = await mkdtemp(join(tmpdir(), 'pss-ms-'));
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
  mcp = new Client({ name: 'test', version: '1.0.0' });
  await mcp.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } } }));
});

after(async () => {
  await mcp?.close();
  await new Promise((r) => service.server.close(r));
  await fake.close();
  await rm(dataDir, { recursive: true, force: true });
});

test('status and capabilities come from the server', async () => {
  const s = await call('sieve_status');
  assert.equal(s.provider, 'managesieve');
  assert.equal(s.loggedIn, true);
  const caps = await call('sieve_capabilities');
  assert.equal(caps.multipleActive, false);
  assert.ok(caps.extensions.includes('copy'));
  const { filters } = await call('list_filters');
  assert.deepEqual(filters, [{ id: 'main', name: 'main', enabled: true }, { id: 'alt', name: 'alt', enabled: false }]);
});

test('apply_rule merges into the active script only, verified with RFC semantics', async () => {
  const rule = { conditions: [{ kind: 'address', header: 'from', part: 'domain', match: 'is', value: 'otto.de' }], actions: { fileinto: 'Shop' } };
  const plan = await call('plan_rule', { rule, headers: 'From: Otto <a@otto.de>' });
  assert.equal(plan.target.id, 'main');
  assert.equal(plan.steps[0].kind, 'append-key');
  assert.equal(plan.result.location, 'Shop');
  const r = await call('apply_rule', { rule });
  assert.equal(r.saved, true);
  assert.match(fake.state.scripts.get('main'), /\["amazon\.de", "ebay\.de", "otto\.de"\]/);
  assert.ok(!fake.state.scripts.get('alt').includes('otto'));
});

test('Proton-only features are rejected, standard extensions are fine', async () => {
  const bad = await mcp.callTool({ name: 'plan_rule', arguments: { rule: { conditions: [{ kind: 'address', header: 'from', value: 'a@b.de' }], actions: { expireDays: 3 } } } });
  assert.equal(bad.isError, true);
  assert.match(bad.content[0].text, /nur bei Proton/);
  const lint = await call('lint_sieve', { sieve: 'require ["fileinto", "copy"];\nfileinto :copy "Shop";\n' });
  assert.deepEqual(lint.issues.filter((i) => i.severity === 'error'), []);
  const { templates } = await call('list_templates');
  assert.ok(!templates.some((t) => t.id === 'expire-non-contacts'));
  assert.ok(!templates.find((t) => t.id === 'github').params.some((p) => p.id === 'expireDays'));
});

test('server-side check rejects invalid scripts', async () => {
  const r = await mcp.callTool({ name: 'create_filter', arguments: { name: 'kaputt', sieve: 'foo;' } });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /Der Server lehnt das Skript ab: Zeile 1/);
  const check = await call('check_sieve', { sieve: MAIN });
  assert.deepEqual(check.issues, []);
});

test('new scripts stay inactive unless enabled; reorder is not supported', async () => {
  await call('create_filter', { name: 'zz-test', sieve: '# test\n', enabled: false });
  assert.equal(fake.state.active, 'main');
  await call('set_filter_enabled', { id: 'zz-test', enabled: true });
  assert.equal(fake.state.active, 'zz-test');
  await call('set_filter_enabled', { id: 'main', enabled: true });
  await call('delete_filter', { id: 'zz-test' });
  assert.equal(fake.state.scripts.has('zz-test'), false);
  const r = await mcp.callTool({ name: 'reorder_filters', arguments: { ids: ['main'] } });
  assert.equal(r.isError, true);
});

test('simulate uses only the active script', async () => {
  const r = await call('simulate_message', { headers: { From: 'x@ebay.de' } });
  assert.equal(r.location, 'Shop');
  const none = await call('simulate_message', { headers: { From: 'x@other.de' } });
  assert.equal(none.location, 'INBOX');
});
