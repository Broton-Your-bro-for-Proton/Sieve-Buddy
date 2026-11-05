import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { getLocale, setLocale, t } from '../addon/lib/i18n.js';
import { EN } from '../addon/lib/locales/en.js';
import { parseSieve } from '../addon/lib/sieve-ast.js';
import { check } from '../scripts/i18n-check.mjs';

test('every German UI text has an English translation and goes through t()', () => {
  const problems = check().map((p) => `${p.file}:${p.line} [${p.kind}] ${p.text}`);
  assert.deepEqual(problems, []);
});

test('translations keep every placeholder and use no em dash', () => {
  for (const [key, value] of Object.entries(EN)) {
    const placeholders = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    assert.deepEqual(placeholders(value), placeholders(key), key);
    assert.ok(!value.includes('—'), `em dash in: ${value}`);
  }
});

test('t() fills placeholders, falls back to German and follows the locale', () => {
  assert.equal(getLocale(), 'de');
  assert.equal(t('Kein Block beginnt in Zeile {line}', { line: 3 }), 'Kein Block beginnt in Zeile 3');
  assert.equal(t('Text ohne Übersetzung'), 'Text ohne Übersetzung');
  setLocale('en-US');
  try {
    assert.equal(t('Kein Block beginnt in Zeile {line}', { line: 3 }), EN['Kein Block beginnt in Zeile {line}'].replace('{line}', '3'));
    // messages built at call time switch with the locale
    assert.throws(() => parseSieve('fileinto "a"'), (e) => !/erwartet/.test(e.message));
  } finally {
    setLocale('de');
  }
});

test('manifest strings exist in both languages', () => {
  const read = (lang) => JSON.parse(readFileSync(new URL(`../addon/_locales/${lang}/messages.json`, import.meta.url), 'utf8'));
  assert.deepEqual(Object.keys(read('en')).sort(), Object.keys(read('de')).sort());
  const manifest = readFileSync(new URL('../addon/manifest.json', import.meta.url), 'utf8');
  for (const [, key] of manifest.matchAll(/__MSG_(\w+)__/g)) assert.ok(key in read('en'), key);
});
