import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { LOCALES, englishOf, getLocale, loadLocale, matchLocale, setLocale, t } from '../addon/lib/i18n.js';
import { DE } from '../addon/lib/locales/de.js';
import { parseSieve } from '../addon/lib/sieve-ast.js';
import { check, dynamicKeys, tKeys } from '../scripts/i18n-check.mjs';

test('every UI text has a German translation and the source holds no German text', () => {
  const problems = check().map((p) => `${p.file}:${p.line} [${p.kind}] ${p.text}`);
  assert.deepEqual(problems, []);
});

test('the check also sees t() calls inside template expressions', () => {
  assert.deepEqual(tKeys("const a = `${ok ? t('One') : t(\"It's two\")} ${x.t('no')}`;\n t('Three', { n })"), [
    { key: 'One', line: 1 },
    { key: "It's two", line: 1 },
    { key: 'Three', line: 2 },
  ]);
});

test('the check rejects t() keys it cannot look up', () => {
  const found = (src) => dynamicKeys(src).length;
  assert.equal(found("t(ok ? 'One' : 'Two')"), 1);
  assert.equal(found('t(label)'), 1);
  assert.equal(found('t(`Folder ${name}`)'), 1);
  assert.equal(found("t('Prefix ' + name)"), 1);
  assert.equal(found("t('One'); t(\"Two\", { n }); x.t(label); // goes through t()"), 0);
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

test('editor snippets carry translated sample values', async () => {
  setLocale('de');
  try {
    const { TEMPLATES } = await import('../addon/lib/sieve-dialect.js?de'); // fresh copy, built in German
    assert.match(TEMPLATES[0].body, /"absender@example\.com" \{\n {4}fileinto "Ordner";/);
    assert.match(TEMPLATES.map((s) => s.body).join('\n'), /:subject "Abwesend" "Ich bin bis zum 6\. Januar nicht erreichbar\.";/);
  } finally {
    setLocale('en');
  }
});

test('manifest strings exist in every language', () => {
  const read = (lang) => JSON.parse(readFileSync(new URL(`../addon/_locales/${lang}/messages.json`, import.meta.url), 'utf8'));
  for (const code of LOCALES) assert.deepEqual(Object.keys(read(code.replace('-', '_'))).sort(), Object.keys(read('en')).sort(), code);
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

test('every language has a complete catalog with the same placeholders', async () => {
  const placeholders = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join();
  for (const code of LOCALES) {
    const { default: catalog } = await import(`../addon/lib/locales/${code}.js`);
    for (const key of Object.keys(DE)) {
      const value = catalog[key];
      assert.ok(typeof value === 'string' && value.trim(), `${code}: missing ${key}`);
      assert.equal(placeholders(value), placeholders(key), `${code}: ${key}`);
      assert.ok(!value.includes('—'), `${code}: em dash in ${key}`);
    }
    assert.deepEqual(Object.keys(catalog).filter((key) => !(key in DE)), [], `${code}: keys no UI text uses`);
  }
});

test('a language tag finds its catalog, a region falls back to the language', async () => {
  assert.equal(matchLocale('pt-BR'), 'pt-BR');
  assert.equal(matchLocale('pt'), 'pt-BR');
  assert.equal(matchLocale('sv'), 'sv-SE');
  assert.equal(matchLocale('de-AT'), 'de');
  assert.equal(matchLocale('zh_TW'), 'zh-TW');
  assert.equal(matchLocale('en-GB'), 'en');
  assert.equal(matchLocale('xx'), 'en');
  await loadLocale('fr');
  try {
    assert.equal(getLocale(), 'fr');
    assert.notEqual(t('Save'), 'Save');
    assert.equal(englishOf(t('Save')), 'Save', 'a section title in French still finds its English category');
    await loadLocale('xx-missing'); // unknown tags fall back to English without an error
  } finally {
    setLocale('en');
  }
});
