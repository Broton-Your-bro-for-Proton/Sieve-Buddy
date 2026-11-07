// Parameterised rule templates. Most build a structured rule ({conditions, actions}) so they can be merged
// into existing blocks by proposeRule(); a few complex ones return finished Sieve code instead.

import { t } from './i18n.js';
import { quoteSieve } from './sieve-ast.js';

const list = (value) =>
  String(value ?? '')
    .split(/[\n,;]+/)
    .map((v) => v.trim())
    .filter(Boolean);

const folder = (id = 'folder', label = t('Ordner/Label'), fallback = '') => ({ id, label, type: 'folder', default: fallback });
const bool = (id, label, fallback = false) => ({ id, label, type: 'bool', default: fallback });
const text = (id, label, fallback = '', placeholder = '') => ({ id, label, type: 'text', default: fallback, placeholder });
const number = (id, label, fallback) => ({ id, label, type: 'number', default: fallback });

const actionParams = [bool('seen', t('Als gelesen markieren')), bool('flagged', t('Mit Stern markieren')), number('expireDays', t('Nach … Tagen löschen (leer = nie)'), '')];
const actionsFrom = (p) => ({
  fileinto: p.folder || null,
  seen: Boolean(p.seen),
  flagged: Boolean(p.flagged),
  expireDays: p.expireDays ? Number(p.expireDays) : null,
});

export const TEMPLATE_CATEGORIES = [t('Absender'), t('Newsletter & Listen'), t('Shops & Rechnungen'), t('Benachrichtigungen'), t('Aufräumen'), t('Abwesenheit'), t('Kontakte & Schutz')];

export const RULE_TEMPLATES = [
  {
    id: 'sender-to-folder',
    category: t('Absender'),
    name: t('Absender in Ordner'),
    description: t('Mails von bestimmten Adressen einsortieren.'),
    params: [text('addresses', t('Absender-Adressen (eine pro Zeile)'), '', 'chef@firma.de'), folder(), ...actionParams],
    build: (p) => ({
      conditions: list(p.addresses).map((value) => ({ kind: 'address', header: 'from', part: 'all', match: 'is', value: value.toLowerCase() })),
      actions: actionsFrom(p),
    }),
  },
  {
    id: 'domain-to-folder',
    category: t('Absender'),
    name: t('Domain in Ordner'),
    description: t('Alle Mails einer oder mehrerer Domains.'),
    params: [text('domains', t('Domains (eine pro Zeile)'), '', 'example.com'), folder(), ...actionParams],
    build: (p) => ({
      conditions: list(p.domains).map((value) => ({ kind: 'address', header: 'from', part: 'domain', match: 'is', value: value.toLowerCase() })),
      actions: actionsFrom(p),
    }),
  },
  {
    id: 'vip',
    category: t('Absender'),
    name: t('Wichtige Absender markieren'),
    description: t('Stern setzen, im Posteingang lassen.'),
    params: [text('addresses', t('Adressen (eine pro Zeile)'))],
    build: (p) => ({
      conditions: list(p.addresses).map((value) => ({ kind: 'address', header: 'from', part: 'all', match: 'is', value: value.toLowerCase() })),
      actions: { flagged: true },
    }),
  },
  {
    id: 'list-id',
    category: t('Newsletter & Listen'),
    name: t('Mailingliste in Ordner'),
    description: t('Anhand der List-Id – zuverlässiger als der Absender.'),
    params: [text('ids', t('List-Ids (eine pro Zeile)'), '', 'news.example.com'), folder('folder', t('Ordner/Label'), t('Listen')), bool('seen', t('Als gelesen markieren'), true), number('expireDays', t('Nach … Tagen löschen (leer = nie)'), '')],
    build: (p) => ({
      conditions: list(p.ids).map((value) => ({ kind: 'header', header: 'list-id', match: 'contains', value })),
      actions: actionsFrom(p),
    }),
  },
  {
    id: 'all-newsletters',
    category: t('Newsletter & Listen'),
    name: t('Alle Newsletter in einen Ordner'),
    description: t('Alles mit List-Unsubscribe-Header.'),
    params: [folder('folder', t('Ordner/Label'), t('Newsletter')), ...actionParams],
    build: (p) => ({ conditions: [{ kind: 'exists', header: 'list-unsubscribe' }], actions: actionsFrom(p) }),
  },
  {
    id: 'social',
    category: t('Newsletter & Listen'),
    name: t('Soziale Netzwerke'),
    description: t('LinkedIn, Facebook, Instagram, X, XING …'),
    params: [folder('folder', t('Ordner/Label'), t('Soziale Netzwerke')), ...actionParams],
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
    category: t('Shops & Rechnungen'),
    name: t('Rechnungen nach Betreff'),
    description: t('Betreff enthält z. B. „Rechnung“, „Invoice“, „Beleg“.'),
    params: [text('words', t('Stichwörter (eines pro Zeile)'), 'Rechnung\nInvoice\nBeleg\nQuittung'), folder('folder', t('Ordner/Label'), t('Rechnungen')), bool('flagged', t('Mit Stern markieren'), true)],
    build: (p) => ({
      conditions: list(p.words).map((value) => ({ kind: 'header', header: 'subject', match: 'contains', value })),
      actions: actionsFrom(p),
    }),
  },
  {
    id: 'shops',
    category: t('Shops & Rechnungen'),
    name: t('Shops & Bestellungen'),
    description: t('Bekannte Shop-Domains.'),
    params: [text('domains', t('Domains (eine pro Zeile)'), 'amazon.de\nebay.de\nzalando.de\npaypal.de'), folder('folder', t('Ordner/Label'), t('Einkäufe')), ...actionParams],
    build: (p) => ({
      conditions: list(p.domains).map((value) => ({ kind: 'address', header: 'from', part: 'domain', match: 'is', value })),
      actions: actionsFrom(p),
    }),
  },
  {
    id: 'github',
    category: t('Benachrichtigungen'),
    name: t('GitHub-Benachrichtigungen'),
    description: t('notifications@github.com, optional nach Repository getrennt.'),
    params: [folder('folder', t('Ordner/Label'), 'GitHub'), bool('seen', t('Als gelesen markieren')), number('expireDays', t('Nach … Tagen löschen (leer = nie)'), '90')],
    build: (p) => ({
      conditions: [{ kind: 'address', header: 'from', part: 'all', match: 'is', value: 'notifications@github.com' }],
      actions: actionsFrom(p),
    }),
  },
  {
    id: 'monitoring',
    category: t('Benachrichtigungen'),
    name: t('Monitoring & System-Mails'),
    description: t('Cron, Backups, Uptime-Monitore – Betreff-Stichwörter.'),
    params: [text('words', t('Stichwörter'), 'Cron\nBackup\n[ALERT]\nUptime'), folder('folder', t('Ordner/Label'), 'System'), bool('seen', t('Als gelesen markieren'), true), number('expireDays', t('Nach … Tagen löschen'), '30')],
    build: (p) => ({
      conditions: list(p.words).map((value) => ({ kind: 'header', header: 'subject', match: 'contains', value })),
      actions: actionsFrom(p),
    }),
  },
  {
    id: 'noreply',
    category: t('Benachrichtigungen'),
    name: t('No-Reply-Absender'),
    description: t('Automatische Mails von noreply@ / no-reply@.'),
    params: [folder('folder', t('Ordner/Label'), t('Automatisch')), ...actionParams],
    build: (p) => ({
      conditions: ['noreply', 'no-reply', 'donotreply'].map((value) => ({ kind: 'address', header: 'from', part: 'localpart', match: 'is', value })),
      actions: actionsFrom(p),
    }),
  },
  {
    id: 'expire-folder-mails',
    protonOnly: true,
    category: t('Aufräumen'),
    name: t('Absender automatisch löschen lassen'),
    description: t('Mails bestimmter Domains nach X Tagen entfernen.'),
    params: [text('domains', t('Domains (eine pro Zeile)')), number('expireDays', t('Nach … Tagen löschen'), '14')],
    build: (p) => ({
      conditions: list(p.domains).map((value) => ({ kind: 'address', header: 'from', part: 'domain', match: 'is', value })),
      actions: { expireDays: Number(p.expireDays) || 14 },
    }),
  },
  {
    id: 'expire-non-contacts',
    protonOnly: true,
    category: t('Aufräumen'),
    name: t('Nicht-Kontakte nach X Tagen löschen'),
    description: t('Alles, was nicht von deinen Kontakten kommt.'),
    params: [number('days', t('Tage'), '30')],
    code: (p) => `if not anyof(
    header :list "from" ":addrbook:personal",
    header :list "from" ":addrbook:myself"
) {
    expire "day" "${Number(p.days) || 30}";
}`,
  },
  {
    id: 'vacation',
    category: t('Abwesenheit'),
    name: t('Abwesenheitsnotiz im Zeitraum'),
    description: t('Automatische Antwort (nur bezahlte Konten).'),
    params: [text('from', t('Von (JJJJ-MM-TT)'), ''), text('to', t('Bis (JJJJ-MM-TT)'), ''), text('subject', t('Betreff'), t('Abwesend')), text('message', t('Text'), t('Ich bin derzeit nicht erreichbar.')), number('days', t('Höchstens alle … Tage pro Absender antworten'), '7')],
    code: (p) => `if allof(
    currentdate :value "ge" "date" ${quoteSieve(p.from || '2026-01-01')},
    currentdate :value "le" "date" ${quoteSieve(p.to || '2026-01-14')}
) {
    vacation :days ${Number(p.days) || 7} :subject ${quoteSieve(p.subject)} ${quoteSieve(p.message)};
}`,
  },
  {
    id: 'contacts-only-inbox',
    protonOnly: true,
    category: t('Kontakte & Schutz'),
    name: t('Unbekannte Absender in Ordner'),
    description: t('Nur Kontakte und Allow-Liste bleiben im Posteingang.'),
    params: [folder('folder', t('Ordner/Label'), t('Unbekannt'))],
    code: (p) => `if not anyof(
    header :list "from" ":addrbook:personal",
    header :list "from" ":incomingdefaults:inbox",
    header :list "from" ":addrbook:myself"
) {
    fileinto ${quoteSieve(p.folder || t('Unbekannt'))};
}`,
  },
  {
    id: 'domain-folder-auto',
    category: t('Kontakte & Schutz'),
    name: t('Ordner automatisch nach Domain'),
    description: t('Jede Absender-Domain bekommt ihren eigenen Ordner (muss existieren).'),
    params: [text('prefix', t('Ordner-Präfix'), 'Domains/')],
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
  if (!rule.conditions.length) throw new Error(t('Bitte mindestens einen Wert angeben'));
  return { rule };
}
