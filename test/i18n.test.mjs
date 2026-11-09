import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { getLocale, setLocale, t } from '../addon/lib/i18n.js';
import { DE } from '../addon/lib/locales/de.js';
import { parseSieve } from '../addon/lib/sieve-ast.js';
import { check } from '../scripts/i18n-check.mjs';

test('every UI text has a German translation and the source holds no German text', () => {
  const problems = check().map((p) => `${p.file}:${p.line} [${p.kind}] ${p.text}`);
  assert.deepEqual(problems, []);
});

test('translations keep every placeholder and use no em dash', () => {
  for (const [key, value] of Object.entries(DE)) {
    const placeholders = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    assert.deepEqual(placeholders(value), placeholders(key), key);
    assert.ok(!key.includes('—') && !value.includes('—'), `em dash in: ${key}`);
  }
});

test('t() fills placeholders, falls back to English and follows the locale', () => {
  assert.equal(getLocale(), 'en');
  assert.equal(t('No block starts at line {line}', { line: 3 }), 'No block starts at line 3');
  setLocale('de-DE');
  try {
    assert.equal(t('No block starts at line {line}', { line: 3 }), 'Kein Block beginnt in Zeile 3');
    assert.equal(t('Text without a translation'), 'Text without a translation');
    // messages built at call time switch with the locale
    assert.throws(() => parseSieve('fileinto "a"'), /erwartet/);
  } finally {
    setLocale('en');
  }
});

test('manifest strings exist in both languages', () => {
  const read = (lang) => JSON.parse(readFileSync(new URL(`../addon/_locales/${lang}/messages.json`, import.meta.url), 'utf8'));
  assert.deepEqual(Object.keys(read('en')).sort(), Object.keys(read('de')).sort());
  const manifest = readFileSync(new URL('../addon/manifest.json', import.meta.url), 'utf8');
  for (const [, key] of manifest.matchAll(/__MSG_(\w+)__/g)) assert.ok(key in read('en'), key);
});

test('the template category finds section titles in the other language', async () => {
  const { chooseSection, findSections } = await import('../addon/lib/sieve-sections.js');
  const section = (title) => findSections(`require ["fileinto"];\n\n### ${title} ###\nif header :contains "subject" "Beleg" {\n    fileinto "Belege";\n}\n`);
  assert.equal(chooseSection(section('Rechnungen'), { actions: { flagged: true } }, { category: t('Shops & invoices') })?.title, 'Rechnungen');
  setLocale('de');
  try {
    assert.equal(chooseSection(section('Invoices'), { actions: { flagged: true } }, { category: t('Shops & invoices') })?.title, 'Invoices');
  } finally {
    setLocale('en');
  }
});
