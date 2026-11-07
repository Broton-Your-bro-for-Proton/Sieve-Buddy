// Regression tests for the findings of the independent review of the sections and i18n work.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { setLocale, t } from '../addon/lib/i18n.js';
import { lintSieve } from '../addon/lib/sieve-analyzer.js';
import { parseSieve } from '../addon/lib/sieve-ast.js';
import { newScript } from '../addon/lib/sieve-dialect.js';
import { parseHeaderBlock } from '../addon/lib/mail.js';
import { planRule } from '../addon/lib/rule-planner.js';
import { insertBlock } from '../addon/lib/sieve-rules.js';
import { deleteRule, findSections, moveRule, ruleUnits, suggestSections } from '../addon/lib/sieve-sections.js';

const withExt = (rules) => newScript(rules).replace('"spamtest"]', '"spamtest", "fileinto", "imap4flags"]');
const errors = (text) => lintSieve(text).filter((i) => i.severity === 'error');
const ruleLine = (text, needle) => ruleUnits(text).find((u) => u.type === 'rule' && text.slice(u.start, u.end).includes(needle)).line;
const titles = (text) => findSections(text).map((s) => [s.title, s.rules.length]);
const domainRule = (value, actions) => ({ conditions: [{ kind: 'address', header: 'from', part: 'domain', match: 'is', value }], actions });

const THREE = withExt(
  '### Shops ###\nif exists "x-a" {\n    stop;\n}\n\n### Newsletter ###\nif exists "x-b" {\n    stop;\n}\n\n### Rechnungen ###\nif exists "x-c" {\n    stop;\n}',
);

test('moving the only rule of a section keeps both headings apart', () => {
  const down = moveRule(THREE, ruleLine(THREE, 'x-b'), +1);
  assert.deepEqual(titles(down), [
    ['Shops', 1],
    ['Newsletter', 0],
    ['Rechnungen', 2],
  ]);
  const up = moveRule(THREE, ruleLine(THREE, 'x-b'), -1);
  assert.deepEqual(titles(up), [
    ['Shops', 2],
    ['Newsletter', 0],
    ['Rechnungen', 1],
  ]);
  assert.deepEqual(errors(down), []);
});

test('plain comments above single rules move and disappear with their rule', () => {
  const text = withExt('# Amazon orders\nif exists "x-a" {\n    stop;\n}\n\n# Zalando, also flagged\nif exists "x-z" {\n    stop;\n}');
  const deleted = deleteRule(text, ruleLine(text, 'x-z'));
  assert.doesNotMatch(deleted, /Zalando/);
  const moved = moveRule(text, ruleLine(text, 'x-z'), -1);
  assert.match(moved, /# Zalando, also flagged\nif exists "x-z"[\s\S]*# Amazon orders\nif exists "x-a"/);
  // for placing new rules they are still sections
  assert.deepEqual(titles(text), [
    ['Amazon orders', 1],
    ['Zalando, also flagged', 1],
  ]);
});

test('a new section title cannot break out of its comment line', () => {
  const scripts = [{ id: 'f', name: 'x', sieve: withExt('if exists "x-a" {\n    stop;\n}') }];
  const { plan } = planRule({ scripts, rule: domainRule('a.de', { flagged: true }), section: { new: 'Shops\nredirect "evil@example.com";\n#' } });
  assert.doesNotMatch(plan.sieve, /^redirect/m);
  assert.equal(parseSieve(plan.sieve).commands.some((c) => c.name === 'redirect'), false);
  const suggested = suggestSections(withExt('if exists "x-a" {\n    fileinto "A\nredirect \\"e@x.de\\";";\n}\n\nif exists "x-b" {\n    stop;\n}\n\nif exists "x-c" {\n    stop;\n}'));
  assert.equal(parseSieve(suggested).commands.some((c) => c.name === 'redirect'), false);
});

test('an empty section above require gets new blocks after the require', () => {
  const text = '# ===== Newsletter =====\nrequire ["fileinto"];\n\n# ===== Shops =====\nif exists "x-a" {\n    fileinto "Shops";\n}\n';
  const { plan, errors: errs } = planRule({ scripts: [{ id: 'f', name: 'x', sieve: text }], rule: domainRule('n.de', { fileinto: 'Newsletter' }) });
  assert.equal(plan.section.title, 'Newsletter');
  assert.deepEqual(errs, []);
  assert.match(plan.sieve, /require \["fileinto"\];\n\nif address :domain :is "from" "n\.de"/);
});

test('scripts with CRLF line endings have sections and keep their line endings', () => {
  const crlf = THREE.replace(/\n/g, '\r\n');
  assert.deepEqual(titles(crlf), titles(THREE));
  const moved = moveRule(crlf, ruleLine(crlf, 'x-a'), +1);
  assert.equal(moved, moveRule(THREE, ruleLine(THREE, 'x-a'), +1).replace(/\n/g, '\r\n'));
  const deleted = deleteRule(crlf, ruleLine(crlf, 'x-c'));
  assert.doesNotMatch(deleted, /x-c/);
  assert.doesNotMatch(deleted, /[^\r]\n/);
  const { plan } = planRule({ scripts: [{ id: 'f', name: 'x', sieve: crlf }], rule: domainRule('a.de', { fileinto: 'Rechnungen' }), section: 'Rechnungen' });
  assert.equal(plan.section.title, 'Rechnungen');
  assert.deepEqual(errors(plan.sieve), []);
});

test('a separate block without stop is preferred when it is enough', () => {
  const text = withExt('if address :domain :is "from" "rabatt.de" {\n    fileinto "Einkäufe";\n}\n\nif exists "list-unsubscribe" {\n    fileinto "Newsletter";\n}');
  const message = { headers: parseHeaderBlock('From: a@otto.de\nList-Unsubscribe: <x>\n'), size: 1 };
  const { plan, after, notes } = planRule({ scripts: [{ id: 'f', name: 'x', sieve: text }], rule: domainRule('otto.de', { fileinto: 'Einkäufe' }), section: 'end', message });
  assert.equal(after.folder, 'Einkäufe');
  assert.doesNotMatch(plan.sieve, /stop;/);
  assert.match(notes[0], /eigener Block/);
});

test('rules sharing a line with other code are cut exactly', () => {
  const text = withExt('if exists "x-a" { stop; } if exists "x-b" { stop; }');
  // rules are addressed by line: on a shared line that is the first one, and only that one goes
  const out = deleteRule(text, ruleLine(text, 'x-a'));
  assert.match(out, /if exists "x-b" \{ stop; \}/);
  assert.doesNotMatch(out, /x-a/);
  assert.deepEqual(errors(out), []);
  const req = 'require ["fileinto"]; if exists "x-a" { fileinto "A"; }\n\nif exists "x-b" {\n    stop;\n}\n';
  const out2 = deleteRule(req, ruleLine(req, 'x-a'));
  assert.match(out2, /^require \["fileinto"\];/);
});

test('reported lines point at the new block, also when require is added', () => {
  const plain = 'if exists "x-a" {\n    stop;\n}\n';
  const placed = insertBlock(plain, 'if exists "x-b" {\n    fileinto "B";\n}');
  assert.match(placed.sieve.split('\n')[placed.line - 1], /^if exists "x-b"/);
  const scripts = [{ id: 'f', name: 'x', sieve: plain }];
  for (const section of ['auto', 'end', { new: 'Neu' }]) {
    const { plan } = planRule({ scripts, rule: domainRule('a.de', { fileinto: 'A' }), section });
    assert.match(plan.sieve.split('\n')[plan.steps[0].line - 1], /^if address :domain :is "from" "a\.de"/, JSON.stringify(section));
  }
});

test('long comment lines do not slow down section detection', () => {
  const text = withExt(`# ${' '.repeat(40000)}x\nif exists "x-a" {\n    stop;\n}`);
  const started = Date.now();
  findSections(text);
  assert.ok(Date.now() - started < 200);
});

test('prototype names are never looked up in the catalog', () => {
  setLocale('en');
  try {
    assert.equal(t('constructor'), 'constructor');
    assert.equal(t('toString', { a: 1 }), 'toString');
  } finally {
    setLocale('de');
  }
});
