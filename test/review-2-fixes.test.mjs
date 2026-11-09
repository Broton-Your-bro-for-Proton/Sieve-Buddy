// Regression tests for the findings of the second review (planner, simulator, analyzer, sections).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseHeaderBlock } from '../addon/lib/mail.js';
import { planRule } from '../addon/lib/rule-planner.js';
import { makeDialect, newScript } from '../addon/lib/sieve-dialect.js';

const withExt = (rules) => newScript(rules).replace('"spamtest"]', '"spamtest", "fileinto", "imap4flags"]');
const domainRule = (value, actions) => ({ conditions: [{ kind: 'address', header: 'from', part: 'domain', match: 'is', value }], actions });
const fromRule = (value, actions) => ({ conditions: [{ kind: 'address', header: 'from', part: 'all', match: 'is', value }], actions });
const RFC = makeDialect({ name: 'rfc', extensions: ['fileinto', 'imap4flags', 'copy'] });

test('the automatic target never picks a disabled filter', () => {
  const scripts = [
    { id: 'main', name: 'Main', enabled: true, sieve: withExt('if address :is "from" "x@other.com" {\n    fileinto "Lists";\n}') },
    { id: 'old', name: 'Old shops', enabled: false, sieve: withExt('if address :domain :is "from" ["amazon.de", "ebay.de"] {\n    fileinto "Shops";\n}') },
  ];
  for (const value of ['zalando.de', 'ebay.de']) {
    const { plan } = planRule({ scripts, rule: domainRule(value, { fileinto: 'Shops' }) });
    assert.equal(plan.targetId, 'main', value);
    assert.ok(plan.sieve.includes(value), value);
  }
  // only disabled filters: a new one
  const { plan } = planRule({ scripts: [scripts[1]], rule: domainRule('zalando.de', { fileinto: 'Shops' }) });
  assert.equal(plan.targetId, null);
});

test('a value inside a nested if or an elsif is not "already covered"', () => {
  const rule = fromRule('a@b.com', { fileinto: 'X' });
  const nested = 'require ["fileinto"];\n\nif header :contains "subject" "Invoice" {\n    if address :is "from" "a@b.com" {\n        fileinto "X";\n    }\n}\n';
  const elsif = 'require ["fileinto"];\n\nif header :contains "subject" "Invoice" {\n    fileinto "Y";\n} elsif address :is "from" "a@b.com" {\n    fileinto "X";\n}\n';
  const copy = 'require ["fileinto", "copy"];\n\nif address :is "from" "a@b.com" {\n    fileinto :copy "X";\n}\n';
  for (const sieve of [nested, elsif, copy]) {
    const { plan } = planRule({ scripts: [{ id: 's', name: 's', enabled: true, sieve }], rule, dialect: RFC });
    assert.deepEqual(
      plan.steps.map((s) => s.kind),
      ['new-block'],
    );
    assert.notEqual(plan.sieve, sieve);
  }
});

test('a label spelled in another case is still the label on Proton', () => {
  const main = { id: 'a', name: 'Main', enabled: true, sieve: withExt('if address :domain :is "from" "shop.example" {\n    fileinto "Shops";\n}') };
  const second = { id: 'b', name: 'Labels', enabled: true, sieve: withExt('if exists "list-unsubscribe" {\n    fileinto "newsletter";\n}') };
  const message = { headers: parseHeaderBlock('From: news@other.example\nList-Unsubscribe: <x>\nSubject: Hi\n') };
  const { plan, after, notes } = planRule({ scripts: [main, second], rule: domainRule('other.example', { fileinto: 'Shops' }), message, labels: ['Newsletter'] });
  assert.deepEqual(notes, []);
  assert.deepEqual(
    plan.steps.map((s) => s.kind),
    ['append-key'],
  );
  assert.deepEqual(after.labels, ['Newsletter']);
  assert.equal(after.folder, 'Shops');
});

test('rfc: the rule flags its own copy, an earlier :copy does not block it', () => {
  const sieve = 'require ["fileinto", "copy", "imap4flags"];\n\nif true {\n    fileinto :copy "Archive";\n}\n';
  const message = { headers: parseHeaderBlock('From: a@b.com\nSubject: Hi\n') };
  const { plan, after, notes } = planRule({ scripts: [{ id: 's', name: 's', enabled: true, sieve }], rule: fromRule('a@b.com', { fileinto: 'X', seen: true }), message, dialect: RFC });
  assert.deepEqual(notes, []);
  assert.ok(plan.sieve.indexOf('fileinto :copy "Archive"') < plan.sieve.indexOf('fileinto "X"'));
  assert.deepEqual(after.copies.find((c) => c.folder === 'Archive').flags, []);
});
