// Against a real Stalwart (JMAP for Sieve, RFC 9661). Skipped unless STALWART_TEST=host:port is set:
//   docker run -d --name sieve-stalwart -e STALWART_RECOVERY_ADMIN=admin:test12345 -p 127.0.0.1:18480:8080 stalwartlabs/stalwart:v1.0.3
//   STALWART_TEST=127.0.0.1:18480 npm test
// The container stays in bootstrap mode; the recovery admin has a full JMAP account, which is all the test needs.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { JmapProvider } from '../src/providers/jmap-provider.js';
import { planRule } from '../../addon/lib/rule-planner.js';
import { makeDialect } from '../../addon/lib/sieve-dialect.js';
import { parseHeaderBlock } from '../../addon/lib/mail.js';

const target = process.env.STALWART_TEST;
const skip = !target && 'STALWART_TEST nicht gesetzt';
const config = { url: `http://${target}/.well-known/jmap`, user: 'admin', token: 'test12345' };

test('session, capabilities and wrong password', { skip }, async () => {
  const p = new JmapProvider(config);
  const caps = await p.init();
  assert.match(caps.implementation, /Stalwart/);
  assert.ok(caps.dialect.extensions.includes('fileinto'));
  await assert.rejects(new JmapProvider({ ...config, token: 'falsch' }).init(), /HTTP 401/);
  assert.ok((await p.listFolders()).folders.includes('INBOX'));
});

test('full script lifecycle on Stalwart', { skip }, async () => {
  const p = new JmapProvider(config);
  await p.init();
  for (const s of await p.listScripts()) await p.deleteScript(s.id); // clean slate

  const main = 'require ["fileinto"];\n\n# Shops\nif address :domain :is "from" ["amazon.de"] {\n    fileinto "Shop";\n}\n';
  const { id } = await p.createScript({ name: 'main', sieve: main, enabled: true });
  assert.deepEqual((await p.listScripts()).map((s) => [s.name, s.enabled, s.sieve]), [['main', true, main]]);

  // Stalwart's own checker through SieveScript/validate
  const issues = await p.check('require ["fileinto"];\nfoo "bar";\n');
  assert.equal(issues[0].line, 2);
  assert.deepEqual(await p.check(main), []);
  assert.deepEqual(await p.check('require ["fileinto"];\nif header :contains "subject" "Grüße" { fileinto "Entwürfe"; }\n'), []);

  // plan with Stalwart's real capabilities, save, read back
  const dialect = makeDialect(p.capabilities.dialect);
  const rule = { conditions: [{ kind: 'address', header: 'from', part: 'domain', match: 'is', value: 'otto.de' }], actions: { fileinto: 'Shop', seen: true } };
  const r = planRule({ scripts: await p.listScripts(), rule, dialect, message: { headers: parseHeaderBlock('From: a@otto.de\n') } });
  assert.deepEqual(r.errors, []);
  assert.deepEqual(await p.check(r.plan.sieve), [], 'Stalwart accepts the merged script');
  await p.updateScript(id, { sieve: r.plan.sieve });
  const saved = (await p.listScripts())[0].sieve;
  assert.match(saved, /require \["fileinto", "imap4flags"\];/);
  assert.match(saved, /addflag "\\\\Seen"/);

  // second script, activation switch, rename, delete of the active one
  const second = await p.createScript({ name: 'zweit', sieve: '# zweit\n' });
  assert.equal((await p.listScripts()).find((s) => s.name === 'zweit').enabled, false);
  await assert.rejects(p.createScript({ name: 'zweit', sieve: '#\n' }), /gibt es schon/);
  await p.setEnabled(second.id, true);
  assert.deepEqual((await p.listScripts()).filter((s) => s.enabled).map((s) => s.name), ['zweit']);
  await p.updateScript(second.id, { name: 'dritt' });
  assert.ok((await p.listScripts()).some((s) => s.name === 'dritt' && s.enabled));
  await p.deleteScript(second.id);
  assert.deepEqual((await p.listScripts()).map((s) => [s.name, s.enabled]), [['main', false]]);
  await p.setEnabled(id, true);
  await p.deleteScript(id);
  assert.deepEqual(await p.listScripts(), []);
});
