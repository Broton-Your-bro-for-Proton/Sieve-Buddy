import { test } from 'node:test';
import assert from 'node:assert/strict';

import { lintSieve } from '../addon/lib/sieve-analyzer.js';
import { newScript } from '../addon/lib/sieve-dialect.js';
import { planRule } from '../addon/lib/rule-planner.js';
import { findOverlaps } from '../addon/lib/sieve-rules.js';
import { chooseSection, deleteRule, findSections, moveRule, ruleUnits, suggestSections } from '../addon/lib/sieve-sections.js';

const withExt = (rules) => newScript(rules).replace('"spamtest"]', '"spamtest", "fileinto", "imap4flags"]');
const errors = (text) => lintSieve(text).filter((i) => i.severity === 'error');

const BIG = withExt(`# ==========================
# Shops
# ==========================
if address :domain :is "from" ["amazon.de", "ebay.de"] {
    fileinto "Einkäufe";
}

# Zalando separately, with a star
if address :domain :is "from" "zalando.de" {
    addflag "\\\\Flagged";
    fileinto "Einkäufe";
}

### Newsletter ###
if exists "list-unsubscribe" {
    fileinto "Newsletter";
}

### Invoices ###
if header :contains "subject" "Invoice" {
    fileinto "Invoices";
}`);

const domainRule = (value, actions) => ({ conditions: [{ kind: 'address', header: 'from', part: 'domain', match: 'is', value }], actions });

test('decorated comment headings become sections; plain comments and the spam guard do not', () => {
  const sections = findSections(BIG);
  assert.deepEqual(
    sections.map((s) => [s.title, s.rules.length]),
    [
      ['Shops', 2],
      ['Newsletter', 1],
      ['Invoices', 1],
    ],
  );
});

test('without decorated headings, plain top-level comments are the sections', () => {
  const text = withExt(`# Shops\nif address :domain :is "from" "a.de" {\n    fileinto "A";\n}\n\n# Lists\nif exists "list-id" {\n    fileinto "Lists";\n}`);
  assert.deepEqual(
    findSections(text).map((s) => s.title),
    ['Shops', 'Lists'],
  );
});

test('a new block goes to the end of the section with the same target folder', () => {
  // same folder as the Shops rules but other actions, so no existing block can take it
  const rule = { conditions: [{ kind: 'header', header: 'subject', match: 'contains', value: 'Order' }], actions: { fileinto: 'Einkäufe', seen: true } };
  const { plan } = planRule({ scripts: [{ id: 'f', name: 'All', sieve: BIG }], rule });
  assert.equal(plan.section.title, 'Shops');
  const lines = plan.sieve.split('\n');
  const at = lines.findIndex((l) => l.includes('"Order"'));
  assert.ok(at > lines.findIndex((l) => l.includes('zalando.de')), 'after the last Shops rule');
  assert.ok(at < lines.findIndex((l) => l.includes('### Newsletter')), 'before the next heading');
  assert.equal(plan.steps[0].line, at + 1);
  assert.deepEqual(errors(plan.sieve), []);
});

test('a value still joins an existing list instead of a new block', () => {
  const { plan } = planRule({ scripts: [{ id: 'f', name: 'All', sieve: BIG }], rule: domainRule('otto.de', { fileinto: 'Einkäufe' }) });
  assert.equal(plan.steps[0].kind, 'append-key');
  assert.equal(plan.section, null);
  assert.match(plan.sieve, /\["amazon\.de", "ebay\.de", "otto\.de"\]/);
});

test('the section title matches the folder when no rule there files into it yet', () => {
  const rule = { conditions: [{ kind: 'address', header: 'from', part: 'all', match: 'is', value: 'billing@example.com' }], actions: { fileinto: 'Archive/Invoices 2026' } };
  const { plan } = planRule({ scripts: [{ id: 'f', name: 'All', sieve: BIG }], rule });
  assert.equal(plan.section.title, 'Invoices');
});

test('the template category is a hint for the section', () => {
  const sections = findSections(BIG);
  const rule = { actions: { flagged: true } };
  assert.equal(chooseSection(sections, rule, { category: 'Newsletters & lists' }).title, 'Newsletter');
  assert.equal(chooseSection(sections, rule, {}), null);
});

test('an explicit section only extends blocks inside it', () => {
  // same actions as the Shops list, but the user wants it under Newsletter
  const { plan } = planRule({ scripts: [{ id: 'f', name: 'All', sieve: BIG }], rule: domainRule('otto.de', { fileinto: 'Einkäufe' }), section: 'Newsletter' });
  assert.equal(plan.steps[0].kind, 'new-block');
  assert.equal(plan.section.title, 'Newsletter');
  const lines = plan.sieve.split('\n');
  assert.ok(lines.findIndex((l) => l.includes('"otto.de"')) > lines.findIndex((l) => l.includes('list-unsubscribe')));
  assert.ok(lines.findIndex((l) => l.includes('"otto.de"')) < lines.findIndex((l) => l.includes('### Invoices')));
});

test('"end" and a new section put the block at the end of the file', () => {
  const scripts = [{ id: 'f', name: 'All', sieve: BIG }];
  const rule = domainRule('github.com', { fileinto: 'Dev' });
  const end = planRule({ scripts, rule, section: 'end' }).plan;
  assert.match(end.sieve, /"Invoices";\n}\n\nif address :domain :is "from" "github\.com"/);
  const fresh = planRule({ scripts, rule, section: { new: 'Development' } }).plan;
  assert.match(fresh.sieve, /\n# ===== Development =====\nif address :domain :is "from" "github\.com"/);
  assert.equal(fresh.section.title, 'Development');
  assert.equal(findSections(fresh.sieve).at(-1).title, 'Development');
  assert.deepEqual(errors(fresh.sieve), []);
});

test('an empty section gets the block right below its heading', () => {
  const text = withExt('### Shops ###\n\n### Lists ###\nif exists "list-id" {\n    fileinto "Lists";\n}');
  const { plan } = planRule({ scripts: [{ id: 'f', name: 'x', sieve: text }], rule: domainRule('a.de', { fileinto: 'Einkäufe' }), section: 'Shops' });
  assert.match(plan.sieve, /### Shops ###\nif address :domain :is "from" "a\.de" \{\n    fileinto "Einkäufe";\n\}\n\n### Lists ###/);
});

test('rule units keep attached comments and elsif chains together', () => {
  const text = withExt('### A ###\n\n# note\nif true {\n    stop;\n} elsif false {\n    stop;\n} else {\n    keep;\n}');
  const rules = ruleUnits(text).filter((u) => u.type === 'rule');
  assert.equal(rules.length, 1);
  assert.match(text.slice(rules[0].start, rules[0].end), /^# note\nif true[\s\S]*keep;\n}$/);
});

test('moving a rule swaps with its neighbor and crosses headings into the next section', () => {
  const zalando = ruleUnits(BIG).find((u) => u.type === 'rule' && BIG.slice(u.start, u.end).includes('zalando'));
  const up = moveRule(BIG, zalando.line, -1);
  assert.ok(up.indexOf('zalando') < up.indexOf('amazon'));
  assert.ok(up.indexOf('# Zalando separately') < up.indexOf('zalando.de'), 'comment moves along');
  const down = moveRule(BIG, zalando.line, +1);
  assert.ok(down.indexOf('### Newsletter') < down.indexOf('zalando.de'));
  assert.equal(findSections(down)[1].rules.length, 2);
  assert.deepEqual(errors(down), []);
  // the rule's own comment stays with the rule instead of merging into the heading
  const moved = ruleUnits(down).find((u) => u.type === 'rule' && down.slice(u.start, u.end).includes('zalando'));
  assert.match(down.slice(moved.start, moved.end), /^# Zalando separately/);
  assert.equal(findSections(down)[1].title, 'Newsletter');
  // moving back restores the original order (only blank lines may differ)
  const squash = (t) => t.replace(/\n(?:[ \t]*\n)+/g, '\n');
  assert.equal(squash(moveRule(down, moved.line, -1)), squash(BIG));
});

test('a rule without comment moved under a heading sits right below it, with the gap kept before the next rule', () => {
  const text = withExt('### A ###\nif exists "x" {\n    stop;\n}\n\nif exists "y" {\n    stop;\n}\n\n### B ###\nif exists "z" {\n    stop;\n}');
  const y = ruleUnits(text).find((u) => u.type === 'rule' && text.slice(u.start, u.end).includes('"y"'));
  const down = moveRule(text, y.line, +1);
  assert.match(down, /\n}\n\n### B ###\nif exists "y" \{\n    stop;\n}\n\nif exists "z"/);
  const back = ruleUnits(down).find((u) => u.type === 'rule' && down.slice(u.start, u.end).includes('"y"'));
  assert.equal(moveRule(down, back.line, -1), text);
});

test('deleting a rule removes it with its blank line', () => {
  const zalando = ruleUnits(BIG).find((u) => u.type === 'rule' && BIG.slice(u.start, u.end).includes('zalando'));
  const out = deleteRule(BIG, zalando.line);
  assert.doesNotMatch(out, /zalando|Zalando separately/);
  assert.match(out, /"Einkäufe";\n}\n\n### Newsletter ###/);
  assert.deepEqual(errors(out), []);
});

test('suggested sections only add headings, never reorder', () => {
  const text = withExt('if address :is "from" "a@x.de" {\n    fileinto "A";\n}\n\nif address :is "from" "b@x.de" {\n    fileinto "A";\n}\n\nif exists "list-id" {\n    fileinto "Lists";\n}');
  const out = suggestSections(text);
  assert.deepEqual(
    findSections(out).map((s) => [s.title, s.rules.length]),
    [
      ['A', 2],
      ['Lists', 1],
    ],
  );
  assert.equal(out.replace(/# ===== .* =====\n/g, ''), text);
});

test('overlaps: duplicates, conflicts and addresses covered by a domain rule', () => {
  const text = withExt(`if address :domain :is "from" ["amazon.de", "ebay.de"] {
    fileinto "Einkäufe";
}

if address :domain :is "from" "amazon.de" {
    fileinto "Einkäufe";
}

if address :domain :is "from" "ebay.de" {
    fileinto "Suspected spam";
}

if address :is "from" "shop@ebay.de" {
    fileinto "Einkäufe";
}

if address :is "from" "x@other.de" {
    fileinto "Einkäufe";
}`);
  const found = findOverlaps(text).map((o) => [o.kind, o.value]);
  assert.deepEqual(found, [
    ['duplicate', 'amazon.de'],
    ['conflict', 'ebay.de'],
    ['domain', 'shop@ebay.de'],
  ]);
  assert.deepEqual(findOverlaps(BIG), []);
});

test('a rule placed in its section ends with stop when a later block would move the mail', async () => {
  const { parseHeaderBlock } = await import('../addon/lib/mail.js');
  const message = { headers: parseHeaderBlock('From: News <news@example.com>\nList-Unsubscribe: <https://example.com/u>\n'), size: 1000 };
  const rule = domainRule('example.com', { fileinto: 'Einkäufe', seen: true });
  const { plan, notes, after } = planRule({ scripts: [{ id: 'f', name: 'All', sieve: BIG }], rule, message });
  assert.equal(plan.section.title, 'Shops');
  assert.match(plan.sieve, /"example\.com" \{\n    addflag "\\\\Seen";\n    fileinto "Einkäufe";\n    stop;\n\}\n\n### Newsletter ###/);
  assert.equal(after.folder, 'Einkäufe');
  assert.match(notes[0], /stop.*list-unsubscribe/);
});

test('when nothing helps, the note names an existing block, not the new one', async () => {
  const { parseHeaderBlock } = await import('../addon/lib/mail.js');
  const text = withExt('### A ###\nif exists "x-a" {\n    fileinto "A";\n}\n\n### B ###\nif true {\n    fileinto "B";\n    stop;\n}');
  const scripts = [
    { id: 'f', name: 'All', sieve: text },
    { id: 'g', name: 'Later', sieve: withExt('if exists "x-a" {\n    fileinto "Z";\n}') },
  ];
  const message = { headers: parseHeaderBlock('From: a@a.de\nX-A: 1\n'), size: 1 };
  const { notes } = planRule({ scripts, rule: domainRule('a.de', { fileinto: 'A', seen: true }), target: 'f', message });
  assert.ok(notes.length);
  assert.doesNotMatch(notes.at(-1), /a\.de/);
});

test('a value that would join a list overridden later becomes its own stop block in the same section', async () => {
  const { parseHeaderBlock } = await import('../addon/lib/mail.js');
  const message = { headers: parseHeaderBlock('From: News <news@example.com>\nList-Unsubscribe: <https://example.com/u>\n'), size: 1000 };
  const { plan, after } = planRule({ scripts: [{ id: 'f', name: 'All', sieve: BIG }], rule: domainRule('example.com', { fileinto: 'Einkäufe' }), message });
  assert.equal(after.folder, 'Einkäufe');
  assert.equal(plan.section.title, 'Shops');
  assert.match(plan.sieve, /"example\.com" \{\n    fileinto "Einkäufe";\n    stop;\n\}\n\n### Newsletter ###/);
});

const CHAIN = withExt(`# Accounts
if header :contains "subject" "Login" {
  fileinto "Accounts";
  stop;
}

# Newsletter
elsif address :is "from" "news@example.com" {
  fileinto "Newsletter";
  stop;
}

# Categories
elsif address :matches "to" "shop.*@example.org" {
  fileinto "Shops";
  stop;
}`);
const unsubscribe = { conditions: [{ kind: 'exists', header: 'list-unsubscribe' }], actions: { fileinto: 'Newsletter' } };

test('headings between elsif links are sections too', () => {
  assert.deepEqual(findSections(CHAIN).map((s) => s.title), ['Accounts', 'Newsletter', 'Categories']);
});

test('the automatic choice skips a section inside a chain that would take messages from later rules, and says why', () => {
  const { plan, notes } = planRule({ scripts: [{ id: 'f', name: 'All', sieve: CHAIN }], rule: unsubscribe });
  assert.equal(plan.section, null);
  assert.match(plan.sieve, /stop;\n\}\n\nif exists "list-unsubscribe"/);
  assert.match(notes[0], /“Newsletter”.*“Shops”/);
});

test('an explicitly chosen section inside a chain gets an elsif and a warning', () => {
  const { plan, notes } = planRule({ scripts: [{ id: 'f', name: 'All', sieve: CHAIN }], rule: unsubscribe, section: 'Newsletter' });
  assert.match(plan.sieve, /"news@example\.com" \{\n  fileinto "Newsletter";\n  stop;\n\}\nelsif exists "list-unsubscribe" \{\n    fileinto "Newsletter";\n\}\n\n# Categories\nelsif/);
  assert.deepEqual(plan.section.displaced, [{ folder: 'Shops', line: 23 }]);
  assert.match(notes[0], /“Shops”/);
});

test('a snippet with more than one block never goes into a chain', async () => {
  const { insertBlock } = await import('../addon/lib/sieve-rules.js');
  const { resolveSection } = await import('../addon/lib/sieve-sections.js');
  const at = resolveSection(CHAIN, 'Newsletter', { actions: {} }).at;
  assert.equal(at.elsif, true);
  const { sieve } = insertBlock(CHAIN, 'if true { keep; }\nif false { keep; }', at);
  assert.match(sieve, /"Shops";\n  stop;\n\}\n\nif true \{ keep; \}\nif false \{ keep; \}\n$/);
  assert.match(insertBlock(CHAIN, 'if true { keep; }', at).sieve, /\n\}\nelsif true \{ keep; \}\n\n# Categories/);
});

test('a later chain link without fileinto counts as displaced too', () => {
  const text = withExt('# Shops\nif header :contains "from" "amazon" {\n    fileinto "Shops";\n}\n# Junk\nelsif header :contains "from" "x" {\n    discard;\n}');
  const rule = { conditions: [{ kind: 'header', header: 'subject', match: 'contains', value: 'Order' }], actions: { fileinto: 'Shops', seen: true } };
  const { plan, notes } = planRule({ scripts: [{ id: 'f', name: 'All', sieve: text }], rule });
  assert.equal(plan.section, null);
  assert.match(notes[0], /the rule in line \d+/);
});

test('nothing is inserted before an elsif, the chain stays whole', async () => {
  const { insertRuleBefore } = await import('../addon/lib/sieve-rules.js');
  const text = 'if true {\n    keep;\n}\nelsif false {\n    keep;\n}';
  assert.throws(() => insertRuleBefore(text, 4, unsubscribe));
});
