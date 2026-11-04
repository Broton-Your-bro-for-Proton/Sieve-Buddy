// ManageSieve client and provider against the fake ManageSieve server.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';

import { createFakeManageSieve } from '../../scripts/fake-managesieve.mjs';
import { ManageSieveConnection } from '../src/providers/managesieve.js';
import { ManageSieveProvider } from '../src/providers/managesieve-provider.js';
import { decodeModifiedUtf7 } from '../src/providers/imap-folders.js';

let fake;
let port;
const MAIN = 'require ["fileinto"];\n\nif address :domain :is "from" ["amazon.de"] {\n    fileinto "Shop";\n}\n';
const provider = () => new ManageSieveProvider({ host: '127.0.0.1', port, tls: 'none', user: 'test', password: 'test123' });

before(async () => {
  fake = createFakeManageSieve({ scripts: { main: MAIN, alt: '# alt\n' }, active: 'main' });
  port = await fake.listen();
});
after(() => fake.close());

test('capabilities and authentication', async () => {
  const conn = await ManageSieveConnection.open({ host: '127.0.0.1', port, tls: 'none' });
  assert.equal(conn.capabilities.implementation, 'Fake ManageSieve');
  assert.ok(conn.capabilities.sieve.includes('fileinto'));
  await assert.rejects(conn.authenticate('test', 'wrong'), /Authentication failed/);
  await conn.logout();
  const p = new ManageSieveProvider({ host: '127.0.0.1', port, tls: 'none', user: 'test', password: 'test123' });
  const caps = await p.init();
  assert.equal(caps.dialect.name, 'rfc');
  assert.ok(caps.dialect.extensions.includes('copy'));
});

test('STARTTLS is required by default', async () => {
  const p = new ManageSieveProvider({ host: '127.0.0.1', port, user: 'test', password: 'test123' });
  await assert.rejects(p.init(), /kein STARTTLS/);
});

test('list, read, create, update with literal, rename, activate, delete', async () => {
  const p = provider();
  let scripts = await p.listScripts();
  assert.deepEqual(scripts.map((s) => [s.name, s.enabled]), [['main', true], ['alt', false]]);
  assert.equal(scripts[0].sieve, MAIN);

  const umlauts = 'require ["fileinto"];\n# Einkäufe – „Quotes“ \\ und "Anführungszeichen"\nfileinto "Einkäufe";\n';
  await p.createScript({ name: 'neu', sieve: umlauts });
  assert.equal(fake.state.scripts.get('neu'), umlauts, 'UTF-8 literal must arrive byte-exact');
  await assert.rejects(p.createScript({ name: 'neu', sieve: '#' }), /gibt es schon/);

  await p.updateScript('neu', { name: 'umbenannt', enabled: true });
  assert.equal(fake.state.active, 'umbenannt');
  scripts = await p.listScripts();
  assert.deepEqual(scripts.find((s) => s.enabled).name, 'umbenannt');

  await p.setEnabled('main', true);
  assert.equal(fake.state.active, 'main');
  await p.setEnabled('main', false);
  assert.equal(fake.state.active, null);

  await p.setEnabled('umbenannt', true);
  await p.deleteScript('umbenannt'); // active → deactivated first
  assert.equal(fake.state.scripts.has('umbenannt'), false);
  await assert.rejects(p.reorder(['a']), /keine Reihenfolge/);
});

test('check reports server errors with line numbers', async () => {
  const p = provider();
  assert.deepEqual(await p.check(MAIN), []);
  const issues = await p.check('require ["fileinto"];\n\nfoo "x";\n');
  assert.equal(issues[0].line, 3);
  assert.match(issues[0].message, /Unbekannter Befehl/);
});

test('servers without CHECKSCRIPT are checked via a temporary script', async () => {
  const old = createFakeManageSieve({ checkscript: false });
  const oldPort = await old.listen();
  try {
    const p = new ManageSieveProvider({ host: '127.0.0.1', port: oldPort, tls: 'none', user: 'test', password: 'test123' });
    assert.deepEqual(await p.check(MAIN), []);
    assert.equal(old.state.scripts.size, 0, 'temporary script removed again');
    assert.ok(!old.state.commands.includes('CHECKSCRIPT'));
  } finally {
    await old.close();
  }
});

test('modified UTF-7 folder names', () => {
  assert.equal(decodeModifiedUtf7('Entw&APw-rfe'), 'Entwürfe');
  assert.equal(decodeModifiedUtf7('Gel&APY-scht'), 'Gelöscht');
  assert.equal(decodeModifiedUtf7('A&-B'), 'A&B');
});
