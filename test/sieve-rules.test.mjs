import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SieveParseError, formatSieve, parseSieve } from '../addon/lib/sieve-ast.js';
import { lintSieve } from '../addon/lib/sieve-analyzer.js';
import { newScript } from '../addon/lib/sieve-dialect.js';
import { describeRule, proposeRule, ruleToSieve } from '../addon/lib/sieve-rules.js';

const withRules = (rules, extra = ['fileinto', 'imap4flags']) =>
  newScript(rules).replace('"spamtest"]', `"spamtest", ${extra.map((e) => `"${e}"`).join(', ')}]`);

const SCRIPT = withRules(`# Shops
if address :domain :is "from" ["amazon.de", "ebay.de"] {
    addflag "\\\\Seen";
    fileinto "Einkäufe";
}

if address :is "from" "boss@company.com" {
    addflag "\\\\Flagged";
}

if anyof(
    exists "list-id",
    header :contains "subject" "Newsletter"
) {
    fileinto "Newsletter";
}`);

const scripts = [{ id: 'f1', name: 'Main filter', sieve: SCRIPT }];
const errors = (text) => lintSieve(text).filter((i) => i.severity === 'error');

test('parser keeps exact offsets for commands, tests and lists', () => {
  const ast = parseSieve(SCRIPT);
  const ifs = ast.commands.filter((c) => c.name === 'if');
  assert.equal(ifs.length, 4); // spam guard + 3 rules
  const shops = ifs[1];
  assert.equal(SCRIPT.slice(shops.test.start, shops.test.end), 'address :domain :is "from" ["amazon.de", "ebay.de"]');
  assert.equal(SCRIPT.slice(shops.block.start, shops.block.end).trim().at(-1), '}');
  assert.equal(ifs[3].test.tests.length, 2);
});

test('parser reports errors with a position', () => {
  assert.throws(() => parseSieve('if true { stop; '), SieveParseError);
  assert.throws(() => parseSieve('fileinto "a"'), /“;” or “{” expected/);
});

test('a new domain with the same actions is appended to the existing list', () => {
  const { proposals } = proposeRule(scripts, {
    conditions: [{ kind: 'address', header: 'from', part: 'domain', match: 'is', value: 'zalando.de' }],
    actions: { fileinto: 'Einkäufe', seen: true },
  });
  const best = proposals[0];
  assert.equal(best.kind, 'append-key');
  assert.match(best.sieve, /\["amazon\.de", "ebay\.de", "zalando\.de"\]/);
  // only that one line changed
  const changed = best.sieve.split('\n').filter((l, i) => l !== SCRIPT.split('\n')[i]);
  assert.equal(changed.length, 1);
  assert.deepEqual(errors(best.sieve), []);
});

test('an already covered value is reported, not proposed again', () => {
  const result = proposeRule(scripts, {
    conditions: [{ kind: 'address', header: 'from', part: 'domain', match: 'is', value: 'Amazon.de' }],
    actions: { fileinto: 'Einkäufe', seen: true },
  });
  assert.equal(result.covered.length, 1);
  assert.equal(result.proposals[0].kind, 'new-block');
});

test('the same value with different actions is a conflict', () => {
  const result = proposeRule(scripts, {
    conditions: [{ kind: 'address', header: 'from', part: 'domain', match: 'is', value: 'ebay.de' }],
    actions: { fileinto: 'Archive' },
  });
  assert.equal(result.conflicts.length, 1);
  assert.match(result.conflicts[0].message, /ebay\.de/);
});

test('a different condition with the same action extends an existing anyof', () => {
  const { proposals } = proposeRule(scripts, {
    conditions: [{ kind: 'address', header: 'from', part: 'domain', match: 'is', value: 'substack.com' }],
    actions: { fileinto: 'Newsletter' },
  });
  assert.equal(proposals[0].kind, 'extend-anyof');
  assert.match(proposals[0].sieve, /header :contains "subject" "Newsletter",\n {4}address :domain :is "from" "substack\.com"\n\)/);
  assert.deepEqual(errors(proposals[0].sieve), []);
});

test('a single test with the same action gets wrapped in anyof', () => {
  const { proposals } = proposeRule(scripts, {
    conditions: [{ kind: 'address', header: 'from', match: 'is', value: 'ceo@company.com' }],
    actions: { flagged: true },
  });
  assert.equal(proposals[0].kind, 'append-key');
  const domain = proposeRule(scripts, {
    conditions: [{ kind: 'address', header: 'from', part: 'domain', match: 'is', value: 'board.example' }],
    actions: { flagged: true },
  });
  assert.equal(domain.proposals[0].kind, 'wrap-anyof');
  assert.deepEqual(errors(domain.proposals[0].sieve), []);
});

test('no matching block: new block at the end, require fixed', () => {
  const plain = [{ id: 'x', name: 'New', sieve: newScript() }];
  const { proposals } = proposeRule(plain, {
    conditions: [{ kind: 'header', header: 'list-id', match: 'contains', value: 'github.com' }],
    actions: { fileinto: 'GitHub', seen: true, expireDays: 60 },
  });
  assert.equal(proposals[0].kind, 'new-block');
  assert.match(proposals[0].sieve, /"fileinto"/);
  assert.match(proposals[0].sieve, /"vnd\.proton\.expire"/);
  assert.deepEqual(errors(proposals[0].sieve), []);
});

test('rule code and description', () => {
  const rule = {
    conditions: [
      { kind: 'address', header: 'from', part: 'domain', match: 'is', value: 'a.de' },
      { kind: 'exists', header: 'list-id' },
    ],
    actions: { fileinto: 'X', seen: true },
  };
  assert.equal(ruleToSieve(rule), 'if anyof(\n    address :domain :is "from" "a.de",\n    exists "list-id"\n) {\n    addflag "\\\\Seen";\n    fileinto "X";\n}');
  assert.equal(describeRule(rule), 'Domain from is “a.de” or Header “list-id” present → to “X”, mark as read');
});

test('formatter re-indents but keeps the spam guard verbatim', () => {
  const messy = withRules('if true {\nfileinto "A";\n      if exists "x" {\n stop;\n}\n}');
  const formatted = formatSieve(messy);
  assert.match(formatted, /if true \{\n {4}fileinto "A";\n {4}if exists "x" \{\n {8}stop;\n {4}\}\n\}/);
  assert.ok(formatted.includes(newScript().split('\n\n')[1]));
});

test('multi-condition rules merge every condition into the block with the same actions', async () => {
  const { mergeRuleIntoScript } = await import('../addon/lib/sieve-rules.js');
  const { sieve, steps } = mergeRuleIntoScript(scripts[0], {
    conditions: [
      { kind: 'address', header: 'from', part: 'domain', match: 'is', value: 'amazon.de' },
      { kind: 'address', header: 'from', part: 'domain', match: 'is', value: 'otto.de' },
      { kind: 'header', header: 'subject', match: 'contains', value: 'Order' },
    ],
    actions: { fileinto: 'Einkäufe', seen: true },
  });
  assert.deepEqual(steps.map((s) => s.kind), ['covered', 'append-key', 'wrap-anyof']);
  assert.match(sieve, /anyof\(\n {4}address :domain :is "from" \["amazon\.de", "ebay\.de", "otto\.de"\],\n {4}header :contains "subject" "Order"\n\) \{/);
  assert.equal((sieve.match(/fileinto "Einkäufe"/g) ?? []).length, 1);
  assert.deepEqual(errors(sieve), []);
});

test('conditions without a matching block end up in one new block', async () => {
  const { mergeRuleIntoScript } = await import('../addon/lib/sieve-rules.js');
  const { sieve, steps } = mergeRuleIntoScript(scripts[0], {
    conditions: [
      { kind: 'header', header: 'subject', match: 'contains', value: 'Receipt' },
      { kind: 'header', header: 'subject', match: 'contains', value: 'Invoice' },
    ],
    actions: { fileinto: 'Invoices' },
  });
  // the first condition creates nothing to merge into, the second then joins the first one's new block
  assert.deepEqual(steps.map((s) => s.kind), ['new-block', 'new-block']);
  // same-form conditions share one test with a key list
  assert.match(sieve, /if header :contains "subject" \["Receipt", "Invoice"\] \{\n {4}fileinto "Invoices";\n\}\n$/);
  assert.deepEqual(errors(sieve), []);
});

test('every template builds valid Sieve', async () => {
  const { RULE_TEMPLATES, buildTemplate, templateDefaults } = await import('../addon/lib/sieve-templates.js');
  const { mergeRuleIntoScript } = await import('../addon/lib/sieve-rules.js');
  const { fixRequire } = await import('../addon/lib/sieve-analyzer.js');
  const samples = { addresses: 'a@b.de', domains: 'b.de', ids: 'list.b.de', from: '2026-12-20', to: '2027-01-06' };
  for (const t of RULE_TEMPLATES) {
    const params = { ...templateDefaults(t), ...Object.fromEntries(Object.entries(samples).filter(([k]) => t.params.some((p) => p.id === k))) };
    if (t.params.some((p) => p.id === 'folder')) params.folder ||= 'Folder';
    const built = buildTemplate(t, params);
    const sieve = built.code
      ? fixRequire(`${newScript()}\n${built.code}\n`)
      : mergeRuleIntoScript({ id: 'n', name: 'n', sieve: newScript() }, built.rule).sieve;
    assert.deepEqual(errors(sieve), [], `${t.id}: ${JSON.stringify(errors(sieve))}`);
  }
});

test('a rule blocked by an earlier stop can be placed before it', async () => {
  const { insertRuleBefore, ruleReached, proposeRule: propose } = await import('../addon/lib/sieve-rules.js');
  const { simulate } = await import('../addon/lib/sieve-sim.js');
  const { parseHeaderBlock } = await import('../addon/lib/mail.js');
  const base = withRules('if exists "list-id" {\n    fileinto "Lists";\n    stop;\n}');
  const rule = { conditions: [{ kind: 'header', header: 'list-id', match: 'contains', value: 'news.example.com' }], actions: { fileinto: 'News' } };
  const msg = { headers: parseHeaderBlock('From: a@example.com\nList-Id: <news.example.com>\n') };
  const appended = propose([{ id: 'a', name: 'A', sieve: base }], rule).proposals[0].sieve;
  assert.equal(ruleReached(simulate([{ id: 'a', name: 'A', sieve: appended }], msg), rule.actions), false);
  const blockLine = base.split('\n').findIndex((l) => l.startsWith('if exists')) + 1;
  // before the catching block alone is not enough: its later fileinto would win
  const before = insertRuleBefore(base, blockLine, rule);
  assert.equal(ruleReached(simulate([{ id: 'a', name: 'A', sieve: before }], msg), rule.actions), false);
  const withStop = insertRuleBefore(base, blockLine, rule, { stop: true });
  assert.equal(ruleReached(simulate([{ id: 'a', name: 'A', sieve: withStop }], msg), rule.actions), true);
  assert.deepEqual(errors(withStop), []);
  assert.deepEqual(errors(before), []);
});
