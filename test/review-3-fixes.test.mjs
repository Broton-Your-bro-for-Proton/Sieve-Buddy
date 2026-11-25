// Regression tests for the findings of the third review that concern the add-on.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseHeaderBlock } from '../addon/lib/mail.js';
import { accountHasAddress, changedActions, findFolder, isSpecial, mailActions } from '../addon/lib/mail-actions.js';
import { verificationUrl } from '../addon/lib/secure-url.js';
import { fixRequire } from '../addon/lib/sieve-analyzer.js';
import { ruleToSieve } from '../addon/lib/sieve-rules.js';
import { simulate } from '../addon/lib/sieve-sim.js';

const message = { headers: parseHeaderBlock('From: Max Mustermann <max@example.com>\nTo: me@example.org\nSubject: Hello\n'), size: 1000 };
const run = (sieve) => simulate([{ id: '1', name: 'f', sieve, enabled: true }], message, { semantics: 'rfc' });

test('"$" in the values of a grouped OR rule stays literal', () => {
  const subject = (value) => ({ kind: 'header', header: 'subject', match: 'contains', value });
  for (const value of ['Save $$ now', 'A $& B', "x $' y", 'x $` y']) {
    const sieve = ruleToSieve({ conditions: [subject(value), subject('Sale')], actions: { fileinto: 'Deals' } });
    assert.ok(sieve.includes(`["${value}", "Sale"]`), sieve);
    assert.ok(!sieve.includes('\u0000'), sieve);
  }
});

test('a message is not moved or deleted when the simulator had to guess a test', () => {
  const guessed = run('require ["extlists"];\nif not header :list "from" ":addrbook:personal" {\n    discard;\n}\n');
  assert.equal(guessed.uncertain, true);
  const actions = mailActions(guessed);
  assert.deepEqual([actions.trash, actions.move, actions.copies], [false, null, []]);
  assert.equal(changedActions(run('keep;\n'), guessed), null);
  assert.equal(run('discard;\n').uncertain, false);
  assert.equal(mailActions(run('discard;\n')).trash, true);
});

test('system folders are found by the older folder type before Thunderbird 121', () => {
  const folders = [
    { path: '/INBOX', name: 'Inbox', type: 'inbox' },
    { path: '/Junk', name: 'Junk', type: 'junk' },
    { path: '/Archives', name: 'Archives', type: 'archives' },
  ];
  assert.ok(isSpecial(folders[0], 'inbox'));
  assert.equal(findFolder(folders, 'spam')?.path, '/Junk');
  assert.equal(findFolder(folders, 'archive')?.path, '/Archives');
  assert.ok(!isSpecial({ specialUse: ['junk'], type: 'inbox' }, 'inbox'), 'specialUse wins when present');
});

test('a mail account matches the filters only when an identity has their address', () => {
  assert.ok(accountHasAddress([{ email: 'Max@Example.com' }], 'max@example.com'));
  assert.ok(!accountHasAddress([{ email: 'other@example.org' }], 'max@example.com'));
  assert.ok(!accountHasAddress([], 'max@example.com'));
});

test('Complete require keeps comments and compares extension names case-insensitively', () => {
  const fixed = fixRequire('require ["fileinto", # folders\n "copy"];\nif true { addflag "x"; fileinto :copy "A"; }');
  assert.match(fixed, /^require \["fileinto", "copy", "imap4flags"\];\n# folders\n/);
  assert.equal(fixRequire('require "FileInto";\nif true { fileinto "A"; }'), 'require "FileInto";\nif true { fileinto "A"; }');
});

test('the captcha page opens only over https or locally, else Proton\'s own page', () => {
  assert.equal(verificationUrl('https://verify.proton.me/?token=a', 'a'), 'https://verify.proton.me/?token=a');
  assert.equal(verificationUrl('http://127.0.0.1:9000/verify', 'a'), 'http://127.0.0.1:9000/verify');
  for (const bad of ['javascript:alert(1)', 'http://evil.example/x', 'file:///etc/passwd', '', undefined]) {
    assert.equal(verificationUrl(bad, 't 1'), 'https://verify.proton.me/?methods=captcha&token=t%201', String(bad));
  }
});

test('versions are kept per connection, older ones without one stay visible', async () => {
  const items = new Map();
  globalThis.localStorage = { getItem: (k) => items.get(k) ?? null, setItem: (k, v) => items.set(k, v), removeItem: (k) => items.delete(k) };
  const { getHistory, pushHistory, storage } = await import('../addon/shared/env.js');
  await storage.set('history:main', [{ at: 'old', name: 'main', sieve: '# legacy\n' }]);
  await storage.set('settings', { mode: 'service', serviceUrl: 'http://localhost:8080' });
  await pushHistory('main', 'main', '# server A\n');
  await storage.set('settings', { mode: 'service', serviceUrl: 'http://127.0.0.1:9090' });
  await pushHistory('main', 'main', '# server B\n');
  assert.deepEqual((await getHistory('main')).map((v) => v.sieve), ['# server B\n', '# legacy\n']);
  await storage.set('settings', { mode: 'service', serviceUrl: 'http://localhost:8080' });
  assert.deepEqual((await getHistory('main')).map((v) => v.sieve), ['# server A\n', '# legacy\n']);
});
