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

if address :is "from" "chef@firma.de" {
    addflag "\\\\Flagged";
}

if anyof(
    exists "list-id",
    header :contains "subject" "Newsletter"
) {
    fileinto "Newsletter";
}`);

const scripts = [{ id: 'f1', name: 'Hauptfilter', sieve: SCRIPT }];
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
  assert.throws(() => parseSieve('fileinto "a"'), /„;“ oder „{“ erwartet/);
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
    actions: { fileinto: 'Archiv' },
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
    conditions: [{ kind: 'address', header: 'from', match: 'is', value: 'ceo@firma.de' }],
    actions: { flagged: true },
  });
  assert.equal(proposals[0].kind, 'append-key');
  const domain = proposeRule(scripts, {
    conditions: [{ kind: 'address', header: 'from', part: 'domain', match: 'is', value: 'vorstand.de' }],
    actions: { flagged: true },
  });
  assert.equal(domain.proposals[0].kind, 'wrap-anyof');
  assert.deepEqual(errors(domain.proposals[0].sieve), []);
});

test('no matching block: new block at the end, require fixed', () => {
  const plain = [{ id: 'x', name: 'Neu', sieve: newScript() }];
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
  assert.equal(describeRule(rule), 'Domain from ist „a.de“ oder Header „list-id“ vorhanden → nach „X“, als gelesen');
});

test('formatter re-indents but keeps the spam guard verbatim', () => {
  const messy = withRules('if true {\nfileinto "A";\n      if exists "x" {\n stop;\n}\n}');
  const formatted = formatSieve(messy);
  assert.match(formatted, /if true \{\n {4}fileinto "A";\n {4}if exists "x" \{\n {8}stop;\n {4}\}\n\}/);
  assert.ok(formatted.includes(newScript().split('\n\n')[1]));
});
