// Regression tests for the findings of the full repository check.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseHeaderBlock } from '../addon/lib/mail.js';
import { fixRequire } from '../addon/lib/sieve-analyzer.js';
import { formatSieve, parseSieve } from '../addon/lib/sieve-ast.js';
import { SPAM_GUARD, newScript } from '../addon/lib/sieve-dialect.js';
import { conditionToSieve, findOverlaps, insertBlock, mergeRuleIntoScript, ruleToSieve } from '../addon/lib/sieve-rules.js';
import { deleteRule, moveRule, resolveSection, ruleUnits, suggestSections } from '../addon/lib/sieve-sections.js';
import { simulate } from '../addon/lib/sieve-sim.js';

const rule = (value, folder = 'Projekt') => ({ conditions: [{ kind: 'address', header: 'from', value }], actions: { fileinto: folder } });
const merged = (sieve, r) => mergeRuleIntoScript({ id: 's', name: 's', sieve }, r);

test('a rule is never merged into a nested if or an elsif', () => {
  const nested = 'require ["fileinto"];\nif header :contains "subject" "Projekt" {\n    if address :is "from" "a@x.de" {\n        fileinto "Projekt";\n    }\n}\n';
  const out = merged(nested, rule('b@y.de'));
  assert.equal(out.steps[0].kind, 'new-block');
  assert.match(out.sieve, /if address :is "from" "a@x\.de" \{/);

  const chain = 'require ["fileinto"];\nif exists "x-a" {\n    fileinto "A";\n} elsif address :is "from" "a@x.de" {\n    fileinto "Projekt";\n}\n';
  assert.equal(merged(chain, rule('b@y.de')).steps[0].kind, 'new-block');

  const top = 'require ["fileinto"];\nif address :is "from" "a@x.de" {\n    fileinto "Projekt";\n}\n';
  assert.equal(merged(top, rule('b@y.de')).steps[0].kind, 'append-key');
});

test('fileinto :copy is no merge target, :create still is', () => {
  const copy = 'require ["fileinto", "copy"];\nif address :is "from" "a@x.de" {\n    fileinto :copy "Projekt";\n}\n';
  assert.equal(merged(copy, rule('b@y.de')).steps[0].kind, 'new-block');
  const create = 'require ["fileinto", "mailbox"];\nif address :is "from" "a@x.de" {\n    fileinto :create "Projekt";\n}\n';
  assert.equal(merged(create, rule('b@y.de')).steps[0].kind, 'append-key');
  // the other users of describeActions still see the action
  const twice = 'require ["fileinto", "mailbox"];\nif address :is "from" "a@x.de" { fileinto :create "X"; }\nif address :is "from" "a@x.de" { fileinto :create "X"; }\n';
  assert.deepEqual(findOverlaps(twice).map((o) => o.kind), ['duplicate']);
  assert.match(suggestSections(twice), /# ===== X =====/);
});

test('unquoted parts of generated code only accept known words', () => {
  const c = { kind: 'address', header: 'from', value: 'v' };
  assert.throws(() => conditionToSieve({ ...c, match: 'is "x" "y" { discard; stop; } if true' }), /Unbekannter Vergleich/);
  assert.throws(() => conditionToSieve({ ...c, part: 'all :is "x" "y" { discard; }' }), /Unbekannter Adressteil/);
  assert.throws(() => ruleToSieve({ conditions: [c], combine: 'true) { discard; } if anyof(', actions: { fileinto: 'A' } }), /Unbekannte Verknüpfung/);
  assert.throws(() => ruleToSieve({ conditions: [c], actions: { fileinto: 'A', expireDays: -5 } }), /Ungültige Anzahl Tage/);
  assert.match(ruleToSieve({ conditions: [c], actions: { fileinto: 'A', expireDays: '7' } }), /expire "day" "7";/);
});

test('if and elsif need a test and a block', () => {
  assert.throws(() => parseSieve('if header :is "subject" "x" fileinto "y";'), /braucht einen Block/);
  assert.throws(() => parseSieve('if { stop; }'), /braucht eine Bedingung/);
  assert.throws(() => parseSieve('if true { stop; } else stop;'), /braucht einen Block/);
  const r = simulate([{ id: 'a', name: 'A', sieve: 'if header :is "subject" "x" fileinto "y";' }], { headers: parseHeaderBlock('Subject: x\n') }, { semantics: 'rfc' });
  assert.ok(r.notes.some((n) => n.includes('konnte nicht gelesen werden')));
});

test('a block goes after a comment on the same line as the closing brace', () => {
  const text = '# ===== A =====\nif exists "x-a" {\n    fileinto "A";\n} # end of A\n';
  const { at } = resolveSection(text, 'A', { actions: {} });
  const out = insertBlock(text, 'if exists "x-b" {\n    fileinto "B";\n}', at).sieve;
  assert.match(out, /\} # end of A\n\nif exists "x-b"/);
});

test('rules sharing a line are moved and deleted one by one', () => {
  const text = 'if exists "x-a" { stop; } if exists "x-b" { stop; }\nif exists "x-c" { stop; }\n';
  const units = ruleUnits(text).filter((u) => u.type === 'rule');
  assert.deepEqual(units.map((u) => [u.line, u.nth]), [[1, 0], [1, 1], [2, 0]]);
  assert.equal(deleteRule(text, 1, 1), 'if exists "x-a" { stop; }\nif exists "x-c" { stop; }\n');
  assert.equal(deleteRule(text, 1, 0), 'if exists "x-b" { stop; }\nif exists "x-c" { stop; }\n');
  assert.match(moveRule(text, 1, +1, 1), /if exists "x-c" \{ stop; \}[\s\S]*if exists "x-b"/);
});

test('edits keep CRLF line endings', () => {
  const crlf = 'require ["fileinto"];\r\nif address :is "from" ["a@x.de", "c@x.de"] {\r\n    fileinto "P";\r\n}\r\n';
  const noLoneLf = (s) => assert.ok(!/[^\r]\n/.test(s), JSON.stringify(s));
  noLoneLf(insertBlock(crlf, 'if exists "x-b" {\n    fileinto "B";\n}').sieve);
  noLoneLf(merged(crlf, rule('b@y.de', 'P')).sieve);
  noLoneLf(merged(crlf, rule('b@y.de', 'Other')).sieve);
  noLoneLf(formatSieve('if true {\r\nstop;\r\n}\r\n'));
  // Proton's spam guard stays byte for byte in a CRLF file
  const guarded = newScript('if exists "x-a" {\nfileinto "A";\n}').replace(/\n/g, '\r\n');
  assert.ok(formatSieve(guarded).includes(SPAM_GUARD.replace(/\n/g, '\r\n')));
  // a file with mixed endings keeps its untouched LF lines
  const mixed = 'require "vacation";\r\nvacation text:\nline1\nline2\n.\n;\r\n';
  assert.match(insertBlock(mixed, 'if exists "x-b" {\n    stop;\n}').sieve, /text:\nline1\nline2\n\.\n/);
});

test('encoded-character needs no variables, dot-stuffing is undone', () => {
  const enc = 'require ["encoded-character"];\nif header :is "subject" "${hex:41}" { stop; }\n';
  assert.equal(fixRequire(enc), enc);
  assert.match(fixRequire('if header :is "subject" "${hex:41}" { stop; }\n'), /^require \["encoded-character"\];/);
  const stuffed = 'if header :is "subject" text:\n..x\n.\n{ discard; }\n';
  const r = simulate([{ id: 'a', name: 'A', sieve: stuffed }], { headers: parseHeaderBlock('Subject: .x\n') }, { semantics: 'rfc' });
  assert.equal(r.discarded, true);
});
