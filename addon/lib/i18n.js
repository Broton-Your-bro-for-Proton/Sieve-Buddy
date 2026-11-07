// Gettext-style translation: the German text is the key, a catalog maps it to English. A missing entry
// shows the German text. Placeholders are written {name}. Free of Thunderbird APIs, shared by the add-on
// and the service.

import { EN } from './locales/en.js';

let catalog = null; // null = German

/** 'de…' selects German, anything else English. */
export function setLocale(lang) {
  catalog = String(lang ?? '').toLowerCase().startsWith('de') ? null : EN;
}

export const getLocale = () => (catalog ? 'en' : 'de');

/** Locale tag for dates and numbers. */
export const dateLocale = () => (catalog ? 'en-US' : 'de-DE');

/** The German key of a translated text (the text itself when it is not a translation). */
export const sourceOf = (text) => (catalog && Object.keys(catalog).find((key) => catalog[key] === text)) ?? text;

export function t(text, params) {
  const out = catalog?.[text] ?? text;
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
    if (key && catalog[key]) node.nodeValue = node.nodeValue.replace(key, catalog[key]);
  }
  for (const el of root.querySelectorAll('[title], [placeholder], [label], [aria-label]')) {
    for (const attr of ['title', 'placeholder', 'label', 'aria-label']) {
      if (el.hasAttribute(attr)) el.setAttribute(attr, t(el.getAttribute(attr)));
    }
  }
}

// The add-on follows Thunderbird's language, a plain browser (preview) ?lang= or its own; Node (the
// service, tests) stays German unless LOCALE is set.
setLocale(
  globalThis.browser?.i18n?.getUILanguage?.() ??
    (globalThis.process?.versions?.node
      ? globalThis.process.env.LOCALE ?? 'de'
      : new URLSearchParams(globalThis.location?.search ?? '').get('lang') ?? globalThis.navigator?.language),
);
