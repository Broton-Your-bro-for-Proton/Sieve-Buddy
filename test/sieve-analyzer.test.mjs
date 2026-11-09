import { test } from 'node:test';
import assert from 'node:assert/strict';

import { fixRequire, getCompletions, lintSieve, tokenize } from '../addon/lib/sieve-analyzer.js';
import { newScript } from '../addon/lib/sieve-dialect.js';

const errors = (text, options) => lintSieve(text, options).filter((i) => i.severity === 'error');
const messages = (issues) => issues.map((i) => i.message).join('\n');

test('the default script with spam guard is clean', () => {
  assert.deepEqual(lintSieve(newScript()), []);
});

test('valid rule with merged require has no errors', () => {
  const script = newScript(`if address :domain :is "from" "example.com" {
    addflag "\\\\Seen";
    fileinto "Newsletter";
}`).replace('"spamtest"]', '"spamtest", "fileinto", "imap4flags"]');
  assert.equal(messages(errors(script)), '');
});

test('missing require is reported and fixRequire merges it into the single require', () => {
  const script = newScript('if exists "list-id" {\n    fileinto "Listen";\n}');
  assert.match(messages(errors(script)), /require "fileinto"/);
  const fixed = fixRequire(script);
  assert.match(fixed, /^require \[[^\]]*"spamtest", "fileinto"\];/);
  assert.equal(messages(errors(fixed)), '');
  assert.equal((fixed.match(/require/g) ?? []).length, 1);
});

test('fixRequire merges two require statements', () => {
  const fixed = fixRequire('require "fileinto";\nrequire ["imap4flags"];\nif true { addflag "\\\\Seen"; fileinto "X"; }');
  assert.equal(fixed.split('require').length - 1, 1);
  assert.match(fixed, /require \["fileinto", "imap4flags"\];/);
});

test('missing semicolon is detected', () => {
  const issues = errors('require "fileinto";\nif true {\n    fileinto "A"\n    stop;\n}');
  assert.match(messages(issues), /Fehlendes ;/);
});

test('unbalanced braces and unterminated strings are errors', () => {
  assert.match(messages(errors('if true {\n  stop;\n')), /wird nicht geschlossen/);
  assert.match(messages(errors('if header :is "subject" "abc {\n stop;\n}')), /nicht mit " geschlossen/);
});

test('unknown command, unknown extension and test outside if', () => {
  const out = messages(errors('require "notify";\nfoo;\naddress :is "from" "a";'));
  assert.match(out, /„notify“ wird von Proton nicht unterstützt/);
  assert.match(out, /Unbekannter Befehl „foo“/);
  assert.match(out, /nur in einer Bedingung/);
});

test('Proton-specific warnings', () => {
  const script = newScript(`if header :regex "subject" "\\\\d+" {
    fileinto "X";
    addflag "\\\\Seen";
    fileinto "drafts";
}`).replace('"spamtest"]', '"spamtest", "fileinto", "imap4flags", "regex"]');
  const out = messages(lintSieve(script, { folders: ['Y'] }));
  assert.match(out, /\\d, \\w/);
  assert.match(out, /Flag-Änderungen nach fileinto/);
  assert.match(out, /„drafts“ wird von Proton bei fileinto ignoriert/);
  assert.match(out, /„X“ existiert in Proton nicht/);
});

test('Proton folder names match case-insensitively', () => {
  const script = newScript('fileinto "Shops/eBay";').replace('"spamtest"]', '"spamtest", "fileinto"]');
  assert.doesNotMatch(messages(lintSieve(script, { folders: ['Shops/Ebay'] })), /existiert/);
});

test('missing spam guard is a warning', () => {
  assert.match(messages(lintSieve('require "fileinto";\nfileinto "X";')), /Spam-Schutz-Block fehlt/);
});

test('tokenizer handles comments and escapes', () => {
  const { tokens, errors: errs } = tokenize('# c\n/* block */ fileinto "a\\"b";');
  assert.equal(errs.length, 0);
  assert.deepEqual(tokens.map((t) => t.value), ['fileinto', 'a"b', ';']);
});

const complete = (textWithCursor, context) => {
  const cursor = textWithCursor.indexOf('|');
  const text = textWithCursor.replace('|', '');
  return getCompletions(text, cursor, context);
};
const texts = (r) => r.list.map((i) => i.text);

test('completes extension names inside require', () => {
  assert.ok(texts(complete('require ["file|'))[0].startsWith('fileinto'));
  assert.ok(texts(complete('require [|')).includes('"imap4flags"'));
});

test('completes folders and labels after fileinto', () => {
  const r = complete('fileinto "Rech|', { folders: ['Rechnungen', 'Privat'], labels: ['Rechtliches'] });
  assert.deepEqual(texts(r), ['Rechnungen"', 'Rechtliches"']);
});

test('completes headers, list specs, flags and tags', () => {
  assert.ok(texts(complete('if address :is "|')).includes('from"'));
  assert.ok(texts(complete('if header :list "from" ":addr|')).includes(':addrbook:personal"'));
  assert.ok(texts(complete('addflag "|')).includes('\\\\Seen"'));
  assert.ok(texts(complete('if header :con|')).includes(':contains '));
});

test('offers tests inside conditions and actions outside', () => {
  const inIf = texts(complete('if ex|'));
  assert.ok(inIf.includes('exists'));
  assert.ok(!inIf.includes('expire'));
  const outside = texts(complete('ex|'));
  assert.ok(outside.includes('expire'));
  assert.ok(!outside.includes('exists'));
});
