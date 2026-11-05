// Finds German UI text without an English translation: t('…') keys missing from the catalog, German string
// literals outside t(), and German text in the HTML pages. `node scripts/i18n-check.mjs` lists them,
// `--keys` prints the missing keys as JSON (to fill addon/lib/locales/en.js).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { EN } from '../addon/lib/locales/en.js';

const root = fileURLToPath(new URL('../', import.meta.url));

export const SOURCES = [
  'addon/background.js',
  'addon/shared/env.js',
  'addon/manager/manager.js',
  'addon/manager/tools.js',
  'addon/manager/handover.js',
  'addon/rule/rule.js',
  'addon/lib/login-guard.js',
  'addon/lib/mail.js',
  'addon/lib/proton-api.js',
  'addon/lib/rule-planner.js',
  'addon/lib/service-client.js',
  'addon/lib/sieve-analyzer.js',
  'addon/lib/sieve-ast.js',
  'addon/lib/sieve-dialect.js',
  'addon/lib/sieve-rules.js',
  'addon/lib/sieve-sections.js',
  'addon/lib/sieve-sim.js',
  'addon/lib/sieve-templates.js',
  'addon/lib/srp.js',
  'server/src/providers/managesieve-provider.js',
  'server/src/providers/managesieve.js',
  'server/src/providers/imap-folders.js',
  'addon/lib/providers/proton-provider.js',
  'server/src/account.js',
  'server/src/config.js',
  'server/src/index.js',
  'server/src/mcp.js',
  'server/src/ops.js',
  'server/src/store.js',
];
export const PAGES = ['addon/manager/manager.html', 'addon/rule/rule.html', 'server/src/ui.html'];

const GERMAN =
  /[äöüÄÖÜß„“]|\b(nicht|und|oder|der|die|das|den|dem|des|ein|eine|einen|einem|einer|mit|für|bei|nach|ist|sind|wird|werden|kein|keine|bitte|Bitte|Zeile|Regel|Regeln|Abschnitt|Ordner|Mail|Mails|Neu|neue|neuen|schon|noch|auf|aus|vor|zum|zur|wurde|kann|gibt|Skript|Anmeldung|Fehler|Dienst|Vorlage|Absender|Betreff|erwartet|fehlt|gefunden|Erweiterung|Befehl|Tags?|Wert|Werte|Liste|Verschieben|Abbrechen|Schließen|Speichern|Laden|Anmelden|Abmelden|Prüfen|aktiv|Aktiv)\b/;

// strings that are data, not UI text (folder names in demo data, Sieve identifiers, ...)
const IGNORE = [/^if [\s\S]*\}$/, /^From: /, /^Einkäufe$/, /^Newsletter$/, /^Listen$/, /^Rechnungen$/, /^Wichtig$/, /^Domains\/$/];

/** String literals of a JS source: {value, template, line, inT}. Comments and regex literals are skipped. */
export function literals(src) {
  const out = [];
  let i = 0;
  let line = 1;
  let lastSignificant = '';
  const lineAt = () => line;
  while (i < src.length) {
    const c = src[i];
    if (c === '\n') {
      line++;
      i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      for (const ch of src.slice(i, end)) if (ch === '\n') line++;
      i = end + 2;
      continue;
    }
    if (c === '/' && (lastSignificant === '' || '(,=:[!&|?{};+-*%<>~^'.includes(lastSignificant) || /\breturn$/.test(src.slice(Math.max(0, i - 7), i).trim()))) {
      // regex literal
      i++;
      let inClass = false;
      while (i < src.length && (src[i] !== '/' || inClass)) {
        if (src[i] === '\\') i++;
        else if (src[i] === '[') inClass = true;
        else if (src[i] === ']') inClass = false;
        i++;
      }
      i++;
      while (/[a-z]/.test(src[i])) i++;
      lastSignificant = '/';
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      const start = i;
      const startLine = lineAt();
      let value = '';
      i++;
      let depth = 0;
      while (i < src.length) {
        const ch = src[i];
        if (ch === '\\') {
          value += ch + src[i + 1];
          i += 2;
          continue;
        }
        if (ch === '\n') line++;
        if (c === '`' && ch === '$' && src[i + 1] === '{') {
          // skip the expression, including nested braces and strings
          i += 2;
          depth = 1;
          value += '${…}';
          while (i < src.length && depth) {
            if (src[i] === '{') depth++;
            else if (src[i] === '}') depth--;
            else if (src[i] === "'" || src[i] === '"') {
              const q = src[i++];
              while (i < src.length && src[i] !== q) i += src[i] === '\\' ? 2 : 1;
            } else if (src[i] === '\n') line++;
            i++;
          }
          continue;
        }
        if (ch === c) break;
        value += ch;
        i++;
      }
      i++;
      const before = src.slice(Math.max(0, start - 12), start);
      out.push({ value, template: c === '`', line: startLine, inT: /(^|[^\w.])t\(\s*$/.test(before) });
      lastSignificant = 'x';
      continue;
    }
    if (!/\s/.test(c)) lastSignificant = c;
    i++;
  }
  return out;
}

const unescape = (s) => s.replace(/\\(.)/g, (m, ch) => ({ n: '\n', t: '\t' })[ch] ?? ch);

/** Text nodes and title/placeholder/label attributes of an HTML page (scripts and styles skipped). */
export function pageTexts(html) {
  const body = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, '');
  const texts = [];
  for (const m of body.matchAll(/>([^<]+)</g)) if (m[1].trim()) texts.push(m[1].trim());
  for (const m of body.matchAll(/\s(?:title|placeholder|label|aria-label)="([^"]*)"/g)) if (m[1].trim()) texts.push(m[1]);
  return texts;
}

export function check() {
  const problems = [];
  for (const file of SOURCES) {
    const src = readFileSync(root + file, 'utf8');
    for (const lit of literals(src)) {
      const value = unescape(lit.value);
      if (lit.inT) {
        if (lit.template) problems.push({ file, line: lit.line, kind: 'template-in-t', text: value });
        else if (!(value in EN)) problems.push({ file, line: lit.line, kind: 'missing', text: value });
      } else if (GERMAN.test(value) && !IGNORE.some((r) => r.test(value))) {
        problems.push({ file, line: lit.line, kind: lit.template ? 'template' : 'unwrapped', text: value });
      }
    }
  }
  for (const file of PAGES) {
    for (const text of pageTexts(readFileSync(root + file, 'utf8'))) {
      if (GERMAN.test(text) && !(text in EN)) problems.push({ file, line: 0, kind: 'page', text });
    }
  }
  return problems;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const problems = check();
  if (process.argv.includes('--keys')) {
    const keys = [...new Set(problems.filter((p) => p.kind === 'missing' || p.kind === 'page').map((p) => p.text))];
    console.log(JSON.stringify(keys, null, 1));
  } else {
    for (const p of problems) console.log(`${p.file}:${p.line} [${p.kind}] ${p.text.replace(/\n/g, '\\n').slice(0, 140)}`);
    console.log(`${problems.length} problem(s)`);
  }
}
