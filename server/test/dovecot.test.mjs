// Against a real Dovecot/Pigeonhole (test/dovecot). Skipped unless DOVECOT_TEST=host[:sievePort[:imapsPort]] is set:
//   docker build -t sieve-test-dovecot test/dovecot
//   docker run -d --name sieve-dovecot -p 127.0.0.1:14190:4190 -p 127.0.0.1:10993:993 sieve-test-dovecot
//   DOVECOT_TEST=127.0.0.1:14190:10993 npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ManageSieveConnection } from '../src/providers/managesieve.js';
import { ManageSieveProvider } from '../src/providers/managesieve-provider.js';
import { listImapFolders } from '../src/providers/imap-folders.js';
import { planRule } from '../../addon/lib/rule-planner.js';
import { makeDialect } from '../../addon/lib/sieve-dialect.js';
import { parseHeaderBlock } from '../../addon/lib/mail.js';

const [host, sievePort = '4190', imapsPort = '993'] = (process.env.DOVECOT_TEST ?? '').split(':');
const skip = !host && 'DOVECOT_TEST is not set';
const creds = { user: 'test@example.test', password: 'test123' };
const config = { host, port: Number(sievePort), tls: 'starttls', rejectUnauthorized: false, ...creds, imap: { host, port: Number(imapsPort), tls: 'tls' } };

test('STARTTLS, capabilities and wrong password', { skip }, async () => {
  const conn = await ManageSieveConnection.open({ host, port: Number(sievePort), tls: 'starttls', rejectUnauthorized: false });
  assert.match(conn.capabilities.implementation, /Dovecot/);
  assert.ok(conn.capabilities.sieve.includes('fileinto'));
  assert.ok(conn.socket.encrypted, 'connection must be TLS after STARTTLS');
  await assert.rejects(conn.authenticate(creds.user, 'wrong'), /Authentication failed/i);
  await conn.logout();
});

test('certificate is verified unless disabled', { skip }, async () => {
  await assert.rejects(ManageSieveConnection.open({ host, port: Number(sievePort), tls: 'starttls' }), /self[- ]signed|certificate/i);
});

test('IMAP folder list over TLS incl. modified UTF-7', { skip }, async () => {
  const folders = await listImapFolders({ host, port: Number(imapsPort), tls: 'tls', rejectUnauthorized: false, ...creds });
  for (const f of ['INBOX', 'Shop', 'Newsletter', 'Invoices', 'Archive/2026', 'Entwürfe']) assert.ok(folders.includes(f), `${f} in ${folders}`);
});

test('full script lifecycle on Dovecot', { skip }, async () => {
  const p = new ManageSieveProvider(config);
  const caps = await p.init();
  assert.equal(caps.dialect.name, 'rfc');
  for (const s of await p.listScripts()) await p.deleteScript(s.id); // clean slate

  const main = 'require ["fileinto"];\n\n# Shops\nif address :domain :is "from" ["amazon.de"] {\n    fileinto "Shop";\n}\n';
  await p.createScript({ name: 'main', sieve: main, enabled: true });
  assert.deepEqual((await p.listScripts()).map((s) => [s.name, s.enabled]), [['main', true]]);
  assert.equal((await p.listScripts())[0].sieve, main);

  // Dovecot's own checker
  const issues = await p.check('require ["fileinto"];\nfoo "bar";\n');
  assert.ok(issues.length > 0);
  assert.equal(issues[0].line, 2);
  assert.deepEqual(await p.check(main), []);
  const umlaut = 'require ["fileinto"];\nif header :contains "subject" "Grüße" { fileinto "Entwürfe"; }\n';
  assert.deepEqual(await p.check(umlaut), []);

  // plan with Dovecot's real capabilities, save, read back
  const data = { scripts: await p.listScripts(), folders: (await p.listFolders()).folders };
  const dialect = makeDialect(p.capabilities.dialect);
  const rule = { conditions: [{ kind: 'address', header: 'from', part: 'domain', match: 'is', value: 'otto.de' }], actions: { fileinto: 'Shop', seen: true } };
  const r = planRule({ scripts: data.scripts, rule, dialect, message: { headers: parseHeaderBlock('From: a@otto.de\n') } });
  assert.deepEqual(r.errors, []);
  assert.equal(r.after.location, 'Shop');
  assert.deepEqual(await p.check(r.plan.sieve), [], 'Dovecot accepts the merged script');
  await p.updateScript('main', { sieve: r.plan.sieve });
  const saved = (await p.listScripts())[0].sieve;
  assert.match(saved, /require \["fileinto", "imap4flags"\];/);
  assert.match(saved, /addflag "\\\\Seen"/);

  // second script, activation switch, rename, delete
  await p.createScript({ name: 'second', sieve: '# second\n' });
  assert.equal((await p.listScripts()).find((s) => s.name === 'second').enabled, false);
  await p.setEnabled('second', true);
  assert.deepEqual((await p.listScripts()).filter((s) => s.enabled).map((s) => s.name), ['second']);
  await p.updateScript('second', { name: 'third' });
  assert.ok((await p.listScripts()).some((s) => s.name === 'third' && s.enabled));
  await p.deleteScript('third');
  await p.setEnabled('main', true);
  assert.deepEqual((await p.listScripts()).map((s) => [s.name, s.enabled]), [['main', true]]);
});

// Delivers mails through Pigeonhole (dovecot-lda in the container) and compares where they really land with
// the simulator. Needs DOVECOT_CONTAINER=<name> in addition to DOVECOT_TEST.
const container = process.env.DOVECOT_CONTAINER;
test('simulator matches real Pigeonhole delivery', { skip: skip || (!container && 'DOVECOT_CONTAINER is not set') }, async () => {
  const { execFileSync } = await import('node:child_process');
  const { simulate } = await import('../../addon/lib/sieve-sim.js');
  const dockerExec = (script, input) =>
    execFileSync('docker', ['exec', '-i', '-u', 'vmail', container, 'sh', '-c', script], { input, encoding: 'utf8', env: { ...process.env, MSYS_NO_PATHCONV: '1' } });

  const p = new ManageSieveProvider(config);
  await p.init();
  for (const s of await p.listScripts()) await p.deleteScript(s.id);
  // String.raw keeps the Sieve escapes: "\\Seen" in Sieve is the system flag \Seen ("\Seen" would be a keyword "Seen")
  const sieve = String.raw`require ["fileinto", "imap4flags", "copy"];
if address :domain :is "from" ["shop.de", "otto.de"] { fileinto "Shop"; }
if address :domain :is "from" "otto.de" { addflag "\\Seen"; fileinto "Shop"; }
if header :contains "list-id" "news.example.com" { fileinto :copy "Newsletter"; }
if header :contains "subject" "Invoice" { setflag "\\Flagged"; fileinto "Invoices"; stop; }
if exists "x-discard" { discard; }
`;
  await p.createScript({ name: 'cmp', sieve, enabled: true });

  const mails = {
    shop: 'From: a@shop.de\nSubject: Hello\n',
    otto: 'From: b@otto.de\nSubject: Order\n',
    list: 'From: c@example.com\nList-Id: <news.example.com>\nSubject: News\n',
    invoice: 'From: d@shop.de\nSubject: Your invoice\n',
    discard: 'From: e@x.de\nX-Discard: yes\nSubject: gone\n',
    plain: 'From: f@x.de\nSubject: normal\n',
  };
  const home = '/srv/mail/test@example.test/Maildir';
  dockerExec(`find ${home} -path '*/new/*' -delete; find ${home} -path '*/cur/*' -delete`);
  for (const [id, headers] of Object.entries(mails)) {
    dockerExec(`/usr/lib/dovecot/dovecot-lda -d test@example.test -f sender@x.de 2>/dev/null`, `${headers}Message-ID: <${id}@test>\n\nbody\n`);
  }
  // where did each mail land, with which flags? (maildir flags: S = Seen, F = Flagged)
  const listing = dockerExec(`cd ${home} && for f in $(find . -path '*/new/*' -o -path '*/cur/*'); do printf '%s %s\n' "$f" "$(grep -m1 '^Message-ID:' "$f")"; done`);
  const real = {};
  for (const line of listing.trim().split('\n').filter(Boolean)) {
    const [path, , mid] = line.split(' ');
    const id = /<([^@]+)@/.exec(mid)[1];
    const folder = path.split('/')[1] === 'new' || path.split('/')[1] === 'cur' ? 'INBOX' : path.split('/')[1].slice(1);
    const flags = (/:2,([A-Z]*)$/.exec(path)?.[1] ?? '').split('').map((f) => ({ S: '\\Seen', F: '\\Flagged' })[f]).filter(Boolean);
    (real[id] ??= []).push(`${folder}[${flags.sort().join(' ')}]`);
  }
  for (const [id, headers] of Object.entries(mails)) {
    const r = simulate([{ id: 'cmp', name: 'cmp', sieve }], { headers: parseHeaderBlock(headers) }, { semantics: 'rfc' });
    const predicted = r.copies.map((c) => `${c.folder}[${[...c.flags].sort().join(' ')}]`).sort();
    assert.deepEqual(predicted, (real[id] ?? []).sort(), `${id}: Simulator ${predicted} vs. Dovecot ${real[id] ?? '(nothing)'}`);
  }
  await p.deleteScript('cmp');
});
