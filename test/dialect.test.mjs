// Standard (non-Proton) servers: dialect-aware linting and completion, RFC 5228 simulation, planning.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { getCompletions, lintSieve } from '../addon/lib/sieve-analyzer.js';
import { makeDialect, newScript } from '../addon/lib/sieve-dialect.js';
import { parseHeaderBlock } from '../addon/lib/mail.js';
import { planRule } from '../addon/lib/rule-planner.js';
import { simulate } from '../addon/lib/sieve-sim.js';

// what Dovecot/Pigeonhole typically announces
const dovecot = makeDialect({ name: 'rfc', extensions: ['fileinto', 'reject', 'envelope', 'encoded-character', 'vacation', 'subaddress', 'comparator-i;ascii-numeric', 'relational', 'regex', 'imap4flags', 'copy', 'include', 'variables', 'body', 'enotify', 'environment', 'mailbox', 'date', 'index', 'ihave', 'duplicate', 'mime', 'foreverypart', 'extracttext'] });
const minimal = makeDialect({ name: 'rfc', extensions: ['fileinto'] });

const msg = (raw) => ({ headers: parseHeaderBlock(raw) });
const errors = (text, dialect) => lintSieve(text, { dialect }).filter((i) => i.severity === 'error').map((i) => i.message);
const all = (text, dialect, options = {}) => lintSieve(text, { dialect, ...options }).map((i) => i.message).join('\n');

test('standard scripts: no spam guard, no Proton warnings, :copy/:create/body known', () => {
  const script = 'require ["fileinto", "copy", "mailbox", "body", "imap4flags"];\nif body :contains "Rechnung" {\n    addflag "\\\\Answered";\n    fileinto :copy :create "Rechnungen";\n    keep;\n}\n';
  assert.equal(all(script, dovecot), '');
  assert.match(all(script, makeDialect({ name: 'proton' })), /Spam-Schutz/);
  assert.equal(newScript('', dovecot).includes('spam-threshold'), false);
});

test('extensions the server does not offer and Proton-only commands are errors', () => {
  assert.match(errors('require ["fileinto", "vnd.proton.expire"];\nexpire "day" "3";', dovecot).join(), /nicht angeboten/);
  assert.match(errors('require ["fileinto", "vnd.proton.expire"];\nexpire "day" "3";', dovecot).join(), /„expire“ gibt es nur bei Proton/);
  assert.match(errors('require "copy";\nfileinto :copy "X";', minimal).join(), /„copy“ wird von diesem Server nicht angeboten/);
});

test('unknown folders: hint to use :create, :create silences it', () => {
  assert.match(all('require "fileinto";\nfileinto "Neu";', dovecot, { folders: ['INBOX', 'Archiv'] }), /:create ergänzen/);
  assert.doesNotMatch(all('require ["fileinto", "mailbox"];\nfileinto :create "Neu";', dovecot, { folders: ['INBOX'] }), /existiert nicht/);
});

test('completion offers the server\'s extensions', () => {
  const list = getCompletions('require ["', 10, { dialect: minimal }).list.map((i) => i.text);
  assert.deepEqual(list, ['fileinto"']);
  const fileinto = getCompletions('fileinto "', 10, { dialect: dovecot, folders: ['Archiv'] }).list.map((i) => i.text);
  assert.deepEqual(fileinto, ['INBOX"', 'Archiv"']);
});

test('RFC simulation: implicit keep, copies, discard, redirect', () => {
  const run = (sieve, m) => simulate([{ id: 's', name: 'S', sieve }], m, { semantics: 'rfc' });
  const m = msg('From: a@shop.de\nSubject: Rechnung 1\n');
  assert.equal(run('# nichts', m).location, 'INBOX');
  assert.equal(run('require "fileinto";\nif address :domain :is "from" "shop.de" { fileinto "Shop"; }', m).location, 'Shop');
  assert.equal(run('require ["fileinto", "copy"];\nfileinto :copy "Shop";', m).location, 'Shop + INBOX');
  assert.equal(run('require "fileinto";\nfileinto "A";\nfileinto "B";', m).location, 'A + B');
  assert.equal(run('discard;', m).location, 'gelöscht');
  assert.equal(run('require "fileinto";\nfileinto "A";\nkeep;', m).location, 'A + INBOX');
  assert.equal(run('redirect "x@y.de";', m).location, 'weitergeleitet an x@y.de');
  const flagged = run('require ["fileinto", "imap4flags"];\nfileinto :flags "\\\\Seen" "A";', m);
  assert.deepEqual(flagged.copies, [{ folder: 'A', flags: ['\\Seen'] }]);
});

test('planner on a standard server: merges, no expire, verifies with RFC semantics', () => {
  const sieve = 'require ["fileinto"];\n\nif address :domain :is "from" ["amazon.de"] {\n    fileinto "Shop";\n}\n';
  const scripts = [{ id: 'main', name: 'main', sieve, enabled: true }];
  const rule = { conditions: [{ kind: 'address', header: 'from', part: 'domain', match: 'is', value: 'otto.de' }], actions: { fileinto: 'Shop' } };
  const r = planRule({ scripts, rule, dialect: dovecot, message: msg('From: x@otto.de\n') });
  assert.equal(r.plan.steps[0].kind, 'append-key');
  assert.equal(r.after.location, 'Shop');
  assert.deepEqual(r.errors, []);
  assert.throws(() => planRule({ scripts, rule: { ...rule, actions: { expireDays: 3 } }, dialect: dovecot }), /nur bei Proton/);
  assert.throws(() => planRule({ scripts, rule: { ...rule, actions: { seen: true } }, dialect: minimal }), /imap4flags/);
  const fresh = planRule({ scripts, rule, dialect: dovecot, target: 'new' });
  assert.equal(fresh.plan.sieve.includes('spam-threshold'), false);
  assert.match(fresh.plan.sieve, /^require \["fileinto"\];/m);
});
