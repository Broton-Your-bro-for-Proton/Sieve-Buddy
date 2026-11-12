import assert from 'node:assert/strict';
import test from 'node:test';

import { changedActions, findFolder, mailActions } from '../addon/lib/mail-actions.js';
import { simulate } from '../addon/lib/sieve-sim.js';

const message = { headers: { from: ['shop@example.com'], subject: ['Order'] }, size: 1000 };
const run = (sieve, semantics = 'proton') => mailActions(simulate([{ id: '1', name: 'f', sieve, enabled: true }], message, { semantics }));

test('fileinto with seen flag moves and marks read', () => {
  const a = run(String.raw`require ["fileinto","imap4flags"]; if true { addflag "\\Seen"; fileinto "Einkäufe"; }`);
  assert.equal(a.move, 'Einkäufe');
  assert.equal(a.read, true);
  assert.equal(a.trash, false);
});

test('discard goes to the trash, nothing else', () => {
  const a = run('if true { discard; }');
  assert.deepEqual([a.trash, a.move], [true, null]);
});

test('sending actions are skipped, keep stays put', () => {
  const a = run('require "vacation";\nvacation "away";', 'rfc');
  assert.equal(a.move, null);
  assert.deepEqual(a.skipped, ['vacation']);
});

test('RFC copies: first non-inbox folder is the move target', () => {
  const a = run('require ["fileinto","copy"];\nfileinto :copy "A"; fileinto "B";', 'rfc');
  assert.equal(a.move, 'A');
  assert.deepEqual(a.copies, ['B']);
});

test('findFolder maps system names, separators and Bridge prefixes', () => {
  const folders = [
    { path: '/INBOX', name: 'Inbox', specialUse: ['inbox'] },
    { path: '/Spam', name: 'Spam', specialUse: ['junk'] },
    { path: '/Folders/Einkäufe', name: 'Einkäufe' },
    { path: '/INBOX/Lists', name: 'Lists' },
  ];
  assert.equal(findFolder(folders, 'spam').path, '/Spam');
  assert.equal(findFolder(folders, 'Einkäufe').path, '/Folders/Einkäufe');
  assert.equal(findFolder(folders, 'INBOX.Lists').path, '/INBOX/Lists');
  assert.equal(findFolder(folders, 'Nope'), null);
});

test('changedActions: only messages the change treats differently', () => {
  const sim = (sieve) => simulate([{ id: '1', name: 'f', sieve, enabled: true }], message, { semantics: 'proton' });
  const before = sim('require "fileinto"; if header :contains "subject" "Invoice" { fileinto "Bills"; }');
  const hit = sim('require "fileinto"; if header :contains "subject" ["Invoice", "Order"] { fileinto "Bills"; }');
  const miss = sim('require "fileinto"; if header :contains "subject" ["Invoice", "Refund"] { fileinto "Bills"; }');
  assert.equal(changedActions(before, hit).move, 'Bills');
  assert.equal(changedActions(before, miss), null);
});
