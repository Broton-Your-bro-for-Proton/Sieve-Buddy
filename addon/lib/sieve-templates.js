// Parameterised rule templates. Most build a structured rule ({conditions, actions}) so they can be merged
// into existing blocks by proposeRule(); a few complex ones return finished Sieve code instead.

import { quoteSieve } from './sieve-ast.js';

const list = (value) =>
  String(value ?? '')
    .split(/[\n,;]+/)
    .map((v) => v.trim())
    .filter(Boolean);

const folder = (id = 'folder', label = 'Ordner/Label', fallback = '') => ({ id, label, type: 'folder', default: fallback });
const bool = (id, label, fallback = false) => ({ id, label, type: 'bool', default: fallback });
const text = (id, label, fallback = '', placeholder = '') => ({ id, label, type: 'text', default: fallback, placeholder });
const number = (id, label, fallback) => ({ id, label, type: 'number', default: fallback });

const actionParams = [bool('seen', 'Als gelesen markieren'), bool('flagged', 'Mit Stern markieren'), number('expireDays', 'Nach … Tagen löschen (leer = nie)', '')];
const actionsFrom = (p) => ({
  fileinto: p.folder || null,
  seen: Boolean(p.seen),
  flagged: Boolean(p.flagged),
  expireDays: p.expireDays ? Number(p.expireDays) : null,
});

export const TEMPLATE_CATEGORIES = ['Absender', 'Newsletter & Listen', 'Shops & Rechnungen', 'Benachrichtigungen', 'Aufräumen', 'Abwesenheit', 'Kontakte & Schutz'];

export const RULE_TEMPLATES = [
  {
    id: 'sender-to-folder',
    category: 'Absender',
    name: 'Absender in Ordner',
    description: 'Mails von bestimmten Adressen einsortieren.',
    params: [text('addresses', 'Absender-Adressen (eine pro Zeile)', '', 'chef@firma.de'), folder(), ...actionParams],
    build: (p) => ({
      conditions: list(p.addresses).map((value) => ({ kind: 'address', header: 'from', part: 'all', match: 'is', value: value.toLowerCase() })),
      actions: actionsFrom(p),
    }),
  },
  {
    id: 'domain-to-folder',
    category: 'Absender',
    name: 'Domain in Ordner',
    description: 'Alle Mails einer oder mehrerer Domains.',
    params: [text('domains', 'Domains (eine pro Zeile)', '', 'example.com'), folder(), ...actionParams],
    build: (p) => ({
      conditions: list(p.domains).map((value) => ({ kind: 'address', header: 'from', part: 'domain', match: 'is', value: value.toLowerCase() })),
      actions: actionsFrom(p),
    }),
  },
  {
    id: 'vip',
    category: 'Absender',
    name: 'Wichtige Absender markieren',
    description: 'Stern setzen, im Posteingang lassen.',
    params: [text('addresses', 'Adressen (eine pro Zeile)')],
    build: (p) => ({
      conditions: list(p.addresses).map((value) => ({ kind: 'address', header: 'from', part: 'all', match: 'is', value: value.toLowerCase() })),
      actions: { flagged: true },
    }),
  },
  {
    id: 'list-id',
    category: 'Newsletter & Listen',
    name: 'Mailingliste in Ordner',
    description: 'Anhand der List-Id – zuverlässiger als der Absender.',
    params: [text('ids', 'List-Ids (eine pro Zeile)', '', 'news.example.com'), folder('folder', 'Ordner/Label', 'Listen'), bool('seen', 'Als gelesen markieren', true), number('expireDays', 'Nach … Tagen löschen (leer = nie)', '')],
    build: (p) => ({
      conditions: list(p.ids).map((value) => ({ kind: 'header', header: 'list-id', match: 'contains', value })),
      actions: actionsFrom(p),
    }),
  },
  {
    id: 'all-newsletters',
    category: 'Newsletter & Listen',
    name: 'Alle Newsletter in einen Ordner',
    description: 'Alles mit List-Unsubscribe-Header.',
    params: [folder('folder', 'Ordner/Label', 'Newsletter'), ...actionParams],
    build: (p) => ({ conditions: [{ kind: 'exists', header: 'list-unsubscribe' }], actions: actionsFrom(p) }),
  },
  {
    id: 'social',
    category: 'Newsletter & Listen',
    name: 'Soziale Netzwerke',
    description: 'LinkedIn, Facebook, Instagram, X, XING …',
    params: [folder('folder', 'Ordner/Label', 'Soziale Netzwerke'), ...actionParams],
    build: (p) => ({
      conditions: ['linkedin.com', 'facebookmail.com', 'instagram.com', 'x.com', 'twitter.com', 'xing.com', 'mastodon.social'].map((value) => ({
        kind: 'address',
        header: 'from',
        part: 'domain',
        match: 'is',
        value,
      })),
      actions: actionsFrom(p),
    }),
  },
  {
    id: 'invoices',
    category: 'Shops & Rechnungen',
    name: 'Rechnungen nach Betreff',
    description: 'Betreff enthält z. B. „Rechnung“, „Invoice“, „Beleg“.',
    params: [text('words', 'Stichwörter (eines pro Zeile)', 'Rechnung\nInvoice\nBeleg\nQuittung'), folder('folder', 'Ordner/Label', 'Rechnungen'), bool('flagged', 'Mit Stern markieren', true)],
    build: (p) => ({
      conditions: list(p.words).map((value) => ({ kind: 'header', header: 'subject', match: 'contains', value })),
      actions: actionsFrom(p),
    }),
  },
  {
    id: 'shops',
    category: 'Shops & Rechnungen',
    name: 'Shops & Bestellungen',
    description: 'Bekannte Shop-Domains.',
    params: [text('domains', 'Domains (eine pro Zeile)', 'amazon.de\nebay.de\nzalando.de\npaypal.de'), folder('folder', 'Ordner/Label', 'Einkäufe'), ...actionParams],
    build: (p) => ({
      conditions: list(p.domains).map((value) => ({ kind: 'address', header: 'from', part: 'domain', match: 'is', value })),
      actions: actionsFrom(p),
    }),
  },
  {
    id: 'github',
    category: 'Benachrichtigungen',
    name: 'GitHub-Benachrichtigungen',
    description: 'notifications@github.com, optional nach Repository getrennt.',
    params: [folder('folder', 'Ordner/Label', 'GitHub'), bool('seen', 'Als gelesen markieren'), number('expireDays', 'Nach … Tagen löschen (leer = nie)', '90')],
    build: (p) => ({
      conditions: [{ kind: 'address', header: 'from', part: 'all', match: 'is', value: 'notifications@github.com' }],
      actions: actionsFrom(p),
    }),
  },
  {
    id: 'monitoring',
    category: 'Benachrichtigungen',
    name: 'Monitoring & System-Mails',
    description: 'Cron, Backups, Uptime-Monitore – Betreff-Stichwörter.',
    params: [text('words', 'Stichwörter', 'Cron\nBackup\n[ALERT]\nUptime'), folder('folder', 'Ordner/Label', 'System'), bool('seen', 'Als gelesen markieren', true), number('expireDays', 'Nach … Tagen löschen', '30')],
    build: (p) => ({
      conditions: list(p.words).map((value) => ({ kind: 'header', header: 'subject', match: 'contains', value })),
      actions: actionsFrom(p),
    }),
  },
  {
    id: 'noreply',
    category: 'Benachrichtigungen',
    name: 'No-Reply-Absender',
    description: 'Automatische Mails von noreply@ / no-reply@.',
    params: [folder('folder', 'Ordner/Label', 'Automatisch'), ...actionParams],
    build: (p) => ({
      conditions: ['noreply', 'no-reply', 'donotreply'].map((value) => ({ kind: 'address', header: 'from', part: 'localpart', match: 'is', value })),
      actions: actionsFrom(p),
    }),
  },
  {
    id: 'expire-folder-mails',
    category: 'Aufräumen',
    name: 'Absender automatisch löschen lassen',
    description: 'Mails bestimmter Domains nach X Tagen entfernen.',
    params: [text('domains', 'Domains (eine pro Zeile)'), number('expireDays', 'Nach … Tagen löschen', '14')],
    build: (p) => ({
      conditions: list(p.domains).map((value) => ({ kind: 'address', header: 'from', part: 'domain', match: 'is', value })),
      actions: { expireDays: Number(p.expireDays) || 14 },
    }),
  },
  {
    id: 'expire-non-contacts',
    category: 'Aufräumen',
    name: 'Nicht-Kontakte nach X Tagen löschen',
    description: 'Alles, was nicht von deinen Kontakten kommt.',
    params: [number('days', 'Tage', '30')],
    code: (p) => `if not anyof(
    header :list "from" ":addrbook:personal",
    header :list "from" ":addrbook:myself"
) {
    expire "day" "${Number(p.days) || 30}";
}`,
  },
  {
    id: 'vacation',
    category: 'Abwesenheit',
    name: 'Abwesenheitsnotiz im Zeitraum',
    description: 'Automatische Antwort (nur bezahlte Konten).',
    params: [text('from', 'Von (JJJJ-MM-TT)', ''), text('to', 'Bis (JJJJ-MM-TT)', ''), text('subject', 'Betreff', 'Abwesend'), text('message', 'Text', 'Ich bin derzeit nicht erreichbar.'), number('days', 'Höchstens alle … Tage pro Absender antworten', '7')],
    code: (p) => `if allof(
    currentdate :value "ge" "date" ${quoteSieve(p.from || '2026-01-01')},
    currentdate :value "le" "date" ${quoteSieve(p.to || '2026-01-14')}
) {
    vacation :days ${Number(p.days) || 7} :subject ${quoteSieve(p.subject)} ${quoteSieve(p.message)};
}`,
  },
  {
    id: 'contacts-only-inbox',
    category: 'Kontakte & Schutz',
    name: 'Unbekannte Absender in Ordner',
    description: 'Nur Kontakte und Allow-Liste bleiben im Posteingang.',
    params: [folder('folder', 'Ordner/Label', 'Unbekannt')],
    code: (p) => `if not anyof(
    header :list "from" ":addrbook:personal",
    header :list "from" ":incomingdefaults:inbox",
    header :list "from" ":addrbook:myself"
) {
    fileinto ${quoteSieve(p.folder || 'Unbekannt')};
}`,
  },
  {
    id: 'domain-folder-auto',
    category: 'Kontakte & Schutz',
    name: 'Ordner automatisch nach Domain',
    description: 'Jede Absender-Domain bekommt ihren eigenen Ordner (muss existieren).',
    params: [text('prefix', 'Ordner-Präfix', 'Domains/')],
    code: (p) => `if address :domain :matches "from" "*" {
    set :lower "sender" "\${1}";
    fileinto ${quoteSieve(`${p.prefix ?? ''}\${sender}`)};
}`,
  },
];

export function templateDefaults(template) {
  return Object.fromEntries(template.params.map((p) => [p.id, p.default]));
}

/** Returns {rule} for mergeable templates or {code} for finished Sieve snippets. */
export function buildTemplate(template, params) {
  if (template.code) return { code: template.code(params) };
  const rule = template.build(params);
  if (!rule.conditions.length) throw new Error('Bitte mindestens einen Wert angeben');
  return { rule };
}
