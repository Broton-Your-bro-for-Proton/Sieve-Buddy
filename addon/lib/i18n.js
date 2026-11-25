// Gettext-style translation: the English text is the key, a catalog per language maps it to that language.
// A missing entry shows the English text. Placeholders are written {name}. Free of Thunderbird APIs, shared
// by the add-on and the service.

import { DE } from './locales/de.js';

/** Every UI language besides English, with a catalog ./locales/<code>.js (the store's languages). */
export const LOCALES = [
  'af', 'ar', 'ast', 'az', 'bg', 'bn', 'bs', 'ca', 'cak', 'cs', 'da', 'de', 'dsb', 'el', 'es', 'eu', 'fa', 'fi',
  'fr', 'fy-NL', 'ga-IE', 'gu', 'he', 'hsb', 'hu', 'id', 'it', 'ja', 'ka', 'kab', 'ko', 'mk', 'mn', 'ms', 'nb-NO',
  'nl', 'nn-NO', 'pa-IN', 'pl', 'pt-BR', 'pt-PT', 'ro', 'ru', 'sk', 'sl', 'sq', 'sv-SE', 'te', 'th', 'tr', 'uk',
  'ur', 'vi', 'zh-CN', 'zh-TW',
];

const loaded = { de: DE }; // German is always there: otherLanguage and the template categories use it
let locale = 'en';
let catalog = null; // null = English

/** The supported locale for a language tag: the exact one (pt-BR), else the first of that language (pt), else English. */
export function matchLocale(tag) {
  const want = String(tag ?? '').replace('_', '-').toLowerCase();
  const base = want.split('-')[0];
  return LOCALES.find((l) => l.toLowerCase() === want) ?? LOCALES.find((l) => l.toLowerCase().split('-')[0] === base) ?? 'en';
}

/** Switches to a language whose catalog is loaded (German always is); any other shows English until loadLocale. */
export function setLocale(lang) {
  const code = matchLocale(lang);
  locale = loaded[code] ? code : 'en';
  catalog = loaded[locale] ?? null;
}

/** Loads the catalog of a language and switches to it. */
export async function loadLocale(lang) {
  const code = matchLocale(lang);
  if (code !== 'en' && !loaded[code]) loaded[code] = (await import(`./locales/${code}.js`)).default;
  setLocale(code);
}

export const getLocale = () => locale;

/** Locale tag for dates and numbers. */
export const dateLocale = () => ({ en: 'en-US', de: 'de-DE' })[locale] ?? locale;

/** A UI text in the other language (English or German), whichever one it is in (the text itself when it has no translation). */
export const otherLanguage = (text) => (Object.hasOwn(DE, text ?? '') ? DE[text] : Object.keys(DE).find((key) => DE[key] === text)) ?? text;

export function t(text, params) {
  const out = catalog && Object.hasOwn(catalog, text) ? catalog[text] : text;
  return params ? out.replace(/\{(\w+)\}/g, (m, key) => (key in params ? String(params[key]) : m)) : out;
}

/**
 * Translates static text of a page: text nodes, the title and the title/placeholder/label attributes.
 * Leading and trailing whitespace of a text node is kept.
 */
export function localizeDom(root, doc = root.ownerDocument ?? root) {
  if (!catalog) return;
  doc.title = t(doc.title);
  const walker = doc.createTreeWalker(root, 4 /* NodeFilter.SHOW_TEXT */);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const key = node.nodeValue.trim();
    if (key && Object.hasOwn(catalog, key)) node.nodeValue = node.nodeValue.replace(key, catalog[key]);
  }
  for (const el of root.querySelectorAll('[title], [placeholder], [label], [aria-label]')) {
    for (const attr of ['title', 'placeholder', 'label', 'aria-label']) {
      if (el.hasAttribute(attr)) el.setAttribute(attr, t(el.getAttribute(attr)));
    }
  }
}

// The add-on follows Thunderbird's language, a plain browser (preview) ?lang= or its own; Node (the
// service, tests) stays English unless LOCALE is set.
await loadLocale(
  globalThis.browser?.i18n?.getUILanguage?.() ??
    (globalThis.process?.versions?.node
      ? globalThis.process.env.LOCALE
      : new URLSearchParams(globalThis.location?.search ?? '').get('lang') ?? globalThis.navigator?.language),
);
