// End-to-end: service + fake Proton API + real MCP client over Streamable HTTP.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { newScript } from '../../addon/lib/sieve-dialect.js';
import { startServer } from '../src/index.js';
import { encryptedFileStore } from '../src/store.js';

const TOKEN = 'test-token-0123456789-abcdefghij';
const SECRET = 'test-secret';

const withRules = (rules) => newScript(rules).replace('"spamtest"]', '"spamtest", "fileinto", "imap4flags"]');

// ---------- fake Proton ----------

const proton = {
  access: 'a2',
  refreshes: 0,
  filters: [
    {
      ID: 'f1',
      Name: 'Hauptfilter',
      Status: 1,
      Priority: 1,
      Version: 2,
      Sieve: withRules('if address :domain :is "from" ["amazon.de", "ebay.de"] {\n    addflag "\\\\Seen";\n    fileinto "Einkäufe";\n}'),
    },
  ],
};

function fakeProton() {
  return createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const path = url.pathname.replace(/^\/api\//, '');
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    const reply = (status, data) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    };
    if (path === 'auth/v4/refresh') {
      if (body.RefreshToken !== 'r1' && body.RefreshToken !== 'r2') return reply(400, { Code: 10013, Error: 'invalid refresh' });
      proton.refreshes++;
      return reply(200, { Code: 1000, AccessToken: proton.access, RefreshToken: 'r2' });
    }
    if (req.headers.authorization !== `Bearer ${proton.access}` || req.headers['x-pm-uid'] !== 'uid1') return reply(401, { Code: 401, Error: 'expired' });

    if (path === 'core/v4/labels') {
      const type = url.searchParams.get('Type');
      return reply(200, { Code: 1000, Labels: type === '3' ? [{ Name: 'Einkäufe', Path: 'Einkäufe' }, { Name: 'Listen', Path: 'Listen' }] : [{ Name: 'Wichtig', Path: 'Wichtig' }] });
    }
    if (path === 'mail/v4/filters' && req.method === 'GET') return reply(200, { Code: 1000, Filters: proton.filters });
    if (path === 'mail/v4/filters/check') {
      return reply(200, { Code: 1000, Issues: body.Sieve.includes('BAD') ? [{ message: 'unknown command BAD' }] : [] });
    }
    if (path === 'mail/v4/filters' && req.method === 'POST') {
      const f = { ID: `f${proton.filters.length + 1}`, Name: body.Name, Status: body.Status, Sieve: body.Sieve, Priority: proton.filters.length + 1 };
      proton.filters.push(f);
      return reply(200, { Code: 1000, Filter: f });
    }
    const m = /^mail\/v4\/filters\/([^/]+)(?:\/(enable|disable))?$/.exec(path);
    if (m) {
      const f = proton.filters.find((x) => x.ID === m[1]);
      if (!f) return reply(404, { Code: 2501, Error: 'not found' });
      if (m[2]) f.Status = m[2] === 'enable' ? 1 : 0;
      else if (req.method === 'PUT') Object.assign(f, { Name: body.Name, Sieve: body.Sieve, Status: body.Status });
      else if (req.method === 'DELETE') proton.filters = proton.filters.filter((x) => x !== f);
      return reply(200, { Code: 1000, Filter: f });
    }
    return reply(404, { Code: 404, Error: `unknown ${req.method} ${path}` });
  });
}

// ---------- setup ----------

let fake;
let service;
let dataDir;
let base;
let mcp;

before(async () => {
  fake = fakeProton();
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  dataDir = await mkdtemp(join(tmpdir(), 'pss-'));
  // a stored session with an expired access token, so the first call has to refresh
  await encryptedFileStore(join(dataDir, 'session.json'), SECRET).save({ UID: 'uid1', AccessToken: 'expired', RefreshToken: 'r1', username: 'test@proton.me' });

  service = await startServer({
    host: '127.0.0.1',
    port: 0,
    dataDir,
    apiToken: TOKEN,
    secret: SECRET,
    allowWrite: true,
    proton: { apiBase: `http://127.0.0.1:${fake.address().port}/api`, appVersion: 'Other' },
  });
  base = `http://127.0.0.1:${service.port}`;
  mcp = new Client({ name: 'test', version: '1.0.0' });
  await mcp.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } } }));
});

after(async () => {
  await mcp?.close();
  await new Promise((r) => service.server.close(r));
  await new Promise((r) => fake.close(r));
  await rm(dataDir, { recursive: true, force: true });
});

const call = async (name, args = {}) => {
  const r = await mcp.callTool({ name, arguments: args });
  if (r.isError) throw new Error(r.content[0].text);
  return JSON.parse(r.content[0].text);
};

const rest = (path, body, token = TOKEN) =>
  fetch(`${base}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

// ---------- tests ----------

test('health is public, API needs the token', async () => {
  assert.equal((await fetch(`${base}/health`)).status, 200);
  assert.equal((await rest('/api/status', undefined, 'wrong')).status, 401);
  assert.equal((await fetch(`${base}/mcp`, { method: 'POST', body: '{}' })).status, 401);
  const status = await (await rest('/api/status')).json();
  assert.equal(status.loggedIn, true);
  assert.equal(status.username, 'test@proton.me');
});

test('MCP lists all tools', async () => {
  const { tools } = await mcp.listTools();
  const names = tools.map((t) => t.name);
  for (const n of ['list_filters', 'plan_rule', 'apply_rule', 'simulate_message', 'suggest_rule', 'apply_template', 'delete_filter']) assert.ok(names.includes(n), n);
  assert.equal(tools.find((t) => t.name === 'delete_filter').annotations.destructiveHint, true);
});

test('list_filters refreshes the expired session transparently', async () => {
  const { filters } = await call('list_filters');
  assert.deepEqual(filters, [{ id: 'f1', name: 'Hauptfilter', enabled: true }]);
  assert.equal(proton.refreshes, 1);
});

test('suggest + plan_rule merges into the existing list and verifies with the mail', async () => {
  const headers = 'From: Otto <service@otto.de>\nTo: me@proton.me\nSubject: Ihre Bestellung 123\n';
  const { suggestions } = await call('suggest_rule', { headers });
  const domain = suggestions.find((s) => s.id === 'domain').condition;
  const plan = await call('plan_rule', { rule: { conditions: [domain], actions: { fileinto: 'Einkäufe', seen: true } }, headers });
  assert.equal(plan.target.id, 'f1');
  assert.equal(plan.steps[0].kind, 'append-key');
  assert.match(plan.diff.text, /\+ if address :domain :is "from" \["amazon\.de", "ebay\.de", "otto\.de"\]/);
  assert.equal(plan.result.location, 'Einkäufe');
  assert.deepEqual(plan.errors, []);
});

test('apply_rule saves the merged script at Proton', async () => {
  const r = await call('apply_rule', {
    rule: { conditions: [{ kind: 'address', header: 'from', part: 'domain', match: 'is', value: 'otto.de' }], actions: { fileinto: 'Einkäufe', seen: true } },
  });
  assert.equal(r.saved, true);
  assert.match(proton.filters[0].Sieve, /"otto\.de"\]/);
  const again = await call('apply_rule', {
    rule: { conditions: [{ kind: 'address', header: 'from', part: 'domain', match: 'is', value: 'otto.de' }], actions: { fileinto: 'Einkäufe', seen: true } },
  });
  assert.equal(again.saved, false);
});

test('templates can be applied as a new filter', async () => {
  const { templates } = await call('list_templates');
  assert.ok(templates.length >= 16);
  const r = await call('apply_template', { templateId: 'github', params: { folder: 'Listen' }, target: 'new', newName: 'GitHub' });
  assert.equal(r.saved, true);
  assert.equal(proton.filters.at(-1).Name, 'GitHub');
  assert.match(proton.filters.at(-1).Sieve, /notifications@github\.com/);
});

test('Proton rejecting a script is reported as a tool error', async () => {
  const r = await mcp.callTool({ name: 'create_filter', arguments: { name: 'Kaputt', sieve: 'BAD;' } });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /Proton lehnt das Skript ab/);
});

test('REST simulate uses the live filters', async () => {
  const res = await rest('/api/ops/simulate', { headers: { From: 'Otto <service@otto.de>' } });
  const r = await res.json();
  assert.equal(r.location, 'Einkäufe');
  assert.ok(r.flags.includes('\\Seen'));
});

test('lint and format work without Proton', async () => {
  const { issues, fixedRequire } = await call('lint_sieve', { sieve: 'fileinto "X";' });
  assert.ok(issues.some((i) => /require "fileinto"/.test(i.message)));
  assert.match(fixedRequire, /^require \["fileinto"\];/);
  const { sieve } = await call('format_sieve', { sieve: 'if true {\nstop;\n}' });
  assert.equal(sieve, 'if true {\n    stop;\n}');
});
