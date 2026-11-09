// Gettext-style translation: the English text is the key, a catalog maps it to German. A missing entry
// shows the English text. Placeholders are written {name}. Free of Thunderbird APIs, shared by the add-on
// and the service.

import { DE } from './locales/de.js';

let catalog = null; // null = English

/** 'de…' selects German, anything else English. */
export function setLocale(lang) {
  catalog = String(lang ?? '').toLowerCase().startsWith('de') ? DE : null;
}

export const getLocale = () => (catalog ? 'de' : 'en');

/** Locale tag for dates and numbers. */
export const dateLocale = () => (catalog ? 'de-DE' : 'en-US');

/** A UI text in the other language, whichever one it is in (the text itself when it has no translation). */
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
setLocale(
  globalThis.browser?.i18n?.getUILanguage?.() ??
    (globalThis.process?.versions?.node
      ? globalThis.process.env.LOCALE
      : new URLSearchParams(globalThis.location?.search ?? '').get('lang') ?? globalThis.navigator?.language),
);
