// Regression tests for the findings of the second review (planner, simulator, analyzer, sections).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseHeaderBlock } from '../addon/lib/mail.js';
import { planRule } from '../addon/lib/rule-planner.js';
import { makeDialect, newScript } from '../addon/lib/sieve-dialect.js';
import { fixRequire, lintSieve } from '../addon/lib/sieve-analyzer.js';

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

test('a literal ${…} never pulls in require "variables"', () => {
  const sieve = 'require ["fileinto"];\n\nif header :contains "subject" "${name}" {\n    discard;\n}\n';
  assert.equal(fixRequire(sieve), sieve);
  const issues = lintSieve(sieve, { dialect: RFC });
  assert.deepEqual(
    issues.filter((i) => i.severity === 'error'),
    [],
  );
  assert.ok(issues.some((i) => /plain text/.test(i.message)));
  // with set, the script uses variables on purpose
  assert.match(fixRequire('set "a" "b";\nif header :is "subject" "${a}" { discard; }\n'), /require \["variables"\]/);
});

test('tags shared by several extensions do not add a require', () => {
  const sieve = 'require ["index"];\n\nif header :index 1 :last :is "received" "x" {\n    discard;\n}\n';
  assert.equal(fixRequire(sieve), sieve);
});

test('unknown commands block only on Proton, other servers check them themselves', () => {
  const sieve = 'require ["ereject"];\n\nereject "no";\n';
  const errors = (dialect) => lintSieve(sieve, { dialect }).filter((i) => i.severity === 'error' && /Unknown command/.test(i.message));
  assert.equal(errors(makeDialect({ name: 'rfc', extensions: ['ereject'] })).length, 0);
  assert.equal(errors(undefined).length, 1);
});

test('a rule never moves above require across a heading', async () => {
  const { moveRule } = await import('../addon/lib/sieve-sections.js');
  const sieve = '# ===== Shops =====\nrequire ["fileinto"];\n\nif exists "x-a" {\n    fileinto "A";\n}\n';
  assert.equal(moveRule(sieve, 4, -1), sieve);
});

test('rfc: i;ascii-casemap folds only ASCII letters', async () => {
  const { simulate } = await import('../addon/lib/sieve-sim.js');
  const run = (test, semantics) =>
    simulate([{ id: 's', name: 's', sieve: `require ["fileinto"];\nif ${test} {\n    fileinto "Bank";\n}\n` }], { headers: parseHeaderBlock('From: a@b.com\nSubject: Ihre überweisung\n') }, { semantics }).folder;
  assert.equal(run('header :contains "subject" "ÜBERWEISUNG"', 'rfc'), 'INBOX');
  assert.equal(run('header :contains "subject" "üBERWEISUNG"', 'rfc'), 'Bank');
  assert.equal(run('header :matches "subject" "*ÜBERWEISUNG"', 'rfc'), 'INBOX');
  assert.equal(run('header :matches "subject" "IHRE *"', 'rfc'), 'Bank');
});

test('rfc: an escaped letter in :matches still ignores ASCII case', async () => {
  const { simulate } = await import('../addon/lib/sieve-sim.js');
  const r = simulate([{ id: 's', name: 's', sieve: 'require ["fileinto"];\nif header :matches "subject" "\\Invoice*" {\n    fileinto "Bank";\n}\n' }], { headers: parseHeaderBlock('From: a@b.com\nSubject: invoice 42\n') }, { semantics: 'rfc' });
  assert.equal(r.folder, 'Bank');
});
