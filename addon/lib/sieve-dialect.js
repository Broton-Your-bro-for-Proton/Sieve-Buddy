// Sieve dialects: Proton's (https://proton.me/support/sieve-advanced-custom-filters) and standard servers
// (RFC 5228 plus extensions, e.g. Dovecot/Pigeonhole, Stalwart, Cyrus) – extensions, commands, tags,
// and Proton's spam-guard prologue.

import { t } from './i18n.js';

export const SPAM_GUARD_REQUIRE = ['include', 'environment', 'variables', 'relational', 'comparator-i;ascii-numeric', 'spamtest'];

export const SPAM_GUARD = `# Generated: Do not run this script on spam messages
if allof (environment :matches "vnd.proton.spam-threshold" "*",
spamtest :value "ge" :comparator "i;ascii-numeric" "\${1}")
{
    return;
}`;

export const EXTENSIONS = {
  fileinto: t('Nachricht in Ordner/Label verschieben'),
  imap4flags: t('Flags setzen (addflag, removeflag, setflag, hasflag)'),
  reject: t('Nachricht mit Begründung abweisen'),
  vacation: t('Automatische Antwort (nur bezahlte Konten)'),
  date: t('Tests date und currentdate'),
  envelope: t('SMTP-Envelope testen (nur from/to)'),
  variables: t('Variablen mit set und ${…}'),
  relational: t('Vergleiche mit :value und :count'),
  'comparator-i;ascii-numeric': t('Numerischer Vergleich'),
  regex: t('Match-Typ :regex'),
  extlists: t('Kontakt-, Allow- und Blocklisten (header :list)'),
  'vnd.proton.eval': t('Arithmetik mit set :eval'),
  'vnd.proton.expire': t('Automatisches Löschen (expire, unexpire)'),
  include: t('Nur für return (Spam-Schutz)'),
  environment: t('Umgebungswerte lesen (Spam-Schutz)'),
  spamtest: t('Spam-Score testen (Spam-Schutz)'),
};

/** Extensions Proton accepts – exactly the list above. */
export const PROTON_EXTENSIONS = Object.keys(EXTENSIONS);

/** Further standard extensions found on Dovecot/Pigeonhole, Stalwart, Cyrus and others. */
export const STANDARD_EXTENSIONS = {
  copy: t('fileinto/redirect :copy – Kopie, Original bleibt'),
  mailbox: t('fileinto :create und Test mailboxexists'),
  body: t('Test body – Nachrichtentext durchsuchen'),
  editheader: t('addheader / deleteheader'),
  enotify: t('notify – Benachrichtigung senden'),
  duplicate: t('Test duplicate – doppelte Nachrichten erkennen'),
  subaddress: t('Adressteile :user und :detail (name+detail@…)'),
  ihave: t('Test ihave – Erweiterung vorhanden?'),
  'encoded-character': t('${hex:…} / ${unicode:…} in Strings'),
  'spamtestplus': 'spamtest :percent',
  virustest: t('Virus-Score testen'),
  'special-use': 'fileinto :specialuse',
  imapflags: t('Veraltete Vorgängerin von imap4flags'),
  index: t(':index / :last bei header/address/date'),
  'comparator-i;unicode-casemap': t('Unicode-Vergleich ohne Groß-/Kleinschreibung'),
  'vnd.dovecot.debug': 'debug_log (Dovecot)',
  'vnd.dovecot.duplicate': t('Ältere Dovecot-Variante von duplicate'),
};

/** Documentation for every known extension (for hints and hover help). */
export const ALL_EXTENSIONS = { ...STANDARD_EXTENSIONS, ...EXTENSIONS };

/**
 * A dialect decides which extensions are valid and whether Proton's special rules apply.
 * @param {{name: 'proton'} | {name: 'rfc', extensions?: string[]}} spec
 */
export function makeDialect(spec = { name: 'proton' }) {
  if (spec.name === 'proton') return { name: 'proton', proton: true, extensions: new Set(PROTON_EXTENSIONS) };
  const extensions = spec.extensions?.length ? spec.extensions : Object.keys(STANDARD_EXTENSIONS).concat(['fileinto', 'imap4flags', 'reject', 'vacation', 'date', 'envelope', 'variables', 'relational', 'comparator-i;ascii-numeric', 'regex', 'include', 'environment', 'spamtest']);
  return { name: 'rfc', proton: false, extensions: new Set(extensions.map((e) => e.toLowerCase())) };
}

export const PROTON_DIALECT = makeDialect({ name: 'proton' });

/** Commands and tests, each with the extension it needs (null = core Sieve). */
export const COMMANDS = {
  // control
  require: { ext: null, kind: 'control', doc: t('Benötigte Erweiterungen laden') },
  if: { ext: null, kind: 'control', doc: t('Bedingung') },
  elsif: { ext: null, kind: 'control', doc: t('Weitere Bedingung') },
  else: { ext: null, kind: 'control', doc: t('Sonst-Zweig') },
  stop: { ext: null, kind: 'action', doc: t('Beendet ALLE Filter (auch nachfolgende)') },
  return: { ext: 'include', kind: 'action', doc: t('Beendet dieses Skript') },
  // actions
  keep: { ext: null, kind: 'action', doc: t('Hebt ein discard auf (keine Kopie im Posteingang!)') },
  discard: { ext: null, kind: 'action', doc: t('Verwirft die Nachricht, nachfolgende Filter laufen nicht') },
  fileinto: { ext: 'fileinto', kind: 'action', doc: t('In Ordner/Label verschieben') },
  addflag: { ext: 'imap4flags', kind: 'action', doc: t('Flag hinzufügen') },
  removeflag: { ext: 'imap4flags', kind: 'action', doc: t('Flag entfernen') },
  setflag: { ext: 'imap4flags', kind: 'action', doc: t('Flags ersetzen') },
  reject: { ext: 'reject', kind: 'action', doc: t('Mit Begründung abweisen') },
  vacation: { ext: 'vacation', kind: 'action', doc: t('Automatische Antwort') },
  set: { ext: 'variables', kind: 'action', doc: t('Variable setzen') },
  expire: { ext: 'vnd.proton.expire', kind: 'action', doc: t('Nach Zeitraum löschen') },
  unexpire: { ext: 'vnd.proton.expire', kind: 'action', doc: t('Ablauf entfernen') },
  // tests
  address: { ext: null, kind: 'test', doc: t('Adress-Header testen') },
  header: { ext: null, kind: 'test', doc: t('Header-Wert testen') },
  exists: { ext: null, kind: 'test', doc: t('Header vorhanden?') },
  size: { ext: null, kind: 'test', doc: t('Größe (verschlüsselt) :over/:under') },
  true: { ext: null, kind: 'test', doc: t('Immer wahr') },
  false: { ext: null, kind: 'test', doc: t('Immer falsch') },
  not: { ext: null, kind: 'test', doc: t('Negation') },
  anyof: { ext: null, kind: 'test', doc: t('ODER') },
  allof: { ext: null, kind: 'test', doc: t('UND') },
  envelope: { ext: 'envelope', kind: 'test', doc: t('Envelope from/to') },
  date: { ext: 'date', kind: 'test', doc: t('Datum aus Header') },
  currentdate: { ext: 'date', kind: 'test', doc: t('Aktuelles Datum') },
  hasflag: { ext: 'imap4flags', kind: 'test', doc: t('Flag gesetzt?') },
  string: { ext: 'variables', kind: 'test', doc: t('Zeichenkette/Variable testen') },
  hasexpiration: { ext: 'vnd.proton.expire', kind: 'test', doc: t('Ablauf gesetzt?') },
  expiration: { ext: 'vnd.proton.expire', kind: 'test', doc: t('Ablauf vergleichen') },
  environment: { ext: 'environment', kind: 'test', doc: t('Umgebungswert') },
  spamtest: { ext: 'spamtest', kind: 'test', doc: t('Spam-Score') },
  // standard extensions (not on Proton)
  redirect: { ext: null, kind: 'action', doc: t('An andere Adresse weiterleiten') },
  include: { ext: 'include', kind: 'action', doc: t('Anderes Skript einbinden') },
  global: { ext: 'include', kind: 'action', doc: t('Globale Variable (include)') },
  notify: { ext: 'enotify', kind: 'action', doc: t('Benachrichtigung senden') },
  addheader: { ext: 'editheader', kind: 'action', doc: t('Header hinzufügen') },
  deleteheader: { ext: 'editheader', kind: 'action', doc: t('Header entfernen') },
  debug_log: { ext: 'vnd.dovecot.debug', kind: 'action', doc: t('Debug-Ausgabe (Dovecot)') },
  body: { ext: 'body', kind: 'test', doc: t('Nachrichtentext durchsuchen') },
  mailboxexists: { ext: 'mailbox', kind: 'test', doc: t('Ordner vorhanden?') },
  duplicate: { ext: 'duplicate', kind: 'test', doc: t('Schon einmal zugestellt?') },
  ihave: { ext: 'ihave', kind: 'test', doc: t('Erweiterung vorhanden?') },
  virustest: { ext: 'virustest', kind: 'test', doc: t('Virus-Score') },
  valid_notify_method: { ext: 'enotify', kind: 'test', doc: t('Benachrichtigungsweg gültig?') },
};

/** Commands that only exist (or behave as documented here) on Proton. */
export const PROTON_ONLY_COMMANDS = new Set(['expire', 'unexpire', 'hasexpiration', 'expiration']);

/** Tagged arguments, with the extension they need. */
export const TAGS = {
  ':is': { ext: null, doc: t('Exakt gleich') },
  ':contains': { ext: null, doc: t('Enthält') },
  ':matches': { ext: null, doc: t('Wildcards * und ?') },
  ':regex': { ext: 'regex', doc: t('Regulärer Ausdruck (POSIX, kein \\d/\\w/\\b)') },
  ':value': { ext: 'relational', doc: t('Vergleich "gt" "ge" "eq" "le" "lt"') },
  ':count': { ext: 'relational', doc: t('Anzahl vergleichen') },
  ':comparator': { ext: null, doc: t('Vergleichsart, z. B. "i;ascii-numeric"') },
  ':all': { ext: null, doc: t('Ganze Adresse') },
  ':localpart': { ext: null, doc: t('Teil vor @') },
  ':domain': { ext: null, doc: t('Teil nach @') },
  ':over': { ext: null, doc: t('Größer als') },
  ':under': { ext: null, doc: t('Kleiner als') },
  ':zone': { ext: 'date', doc: t('Zeitzone "+0100"') },
  ':originalzone': { ext: 'date', doc: t('Zeitzone des Headers') },
  ':days': { ext: 'vacation', doc: t('Antwort-Intervall in Tagen') },
  ':subject': { ext: 'vacation', doc: t('Betreff der Antwort') },
  ':mime': { ext: 'vacation', doc: t('Antwort als MIME') },
  ':handle': { ext: 'vacation', doc: t('Antwort-Gruppe') },
  ':list': { ext: 'extlists', doc: t('Gegen Kontakt-/Allow-/Blockliste') },
  ':lower': { ext: 'variables', doc: t('Kleinbuchstaben') },
  ':upper': { ext: 'variables', doc: t('Großbuchstaben') },
  ':lowerfirst': { ext: 'variables', doc: t('Erster Buchstabe klein') },
  ':upperfirst': { ext: 'variables', doc: t('Erster Buchstabe groß') },
  ':quotewildcard': { ext: 'variables', doc: t('Wildcards maskieren') },
  ':length': { ext: 'variables', doc: t('Länge') },
  ':eval': { ext: 'vnd.proton.eval', doc: t('Arithmetik auswerten') },
  // standard extensions
  ':copy': { ext: 'copy', doc: t('Kopie ablegen, Original bleibt im Posteingang') },
  ':create': { ext: 'mailbox', doc: t('Ordner anlegen, falls er fehlt') },
  ':specialuse': { ext: 'special-use', doc: t('Ordner über Sonderfunktion wählen (\\\\Junk …)') },
  ':raw': { ext: 'body', doc: t('Rohtext durchsuchen') },
  ':content': { ext: 'body', doc: t('Bestimmte MIME-Typen durchsuchen') },
  ':text': { ext: 'body', doc: t('Dekodierten Text durchsuchen') },
  ':user': { ext: 'subaddress', doc: t('Teil vor dem + (name+detail@…)') },
  ':detail': { ext: 'subaddress', doc: t('Teil nach dem + (name+detail@…)') },
  ':from': { ext: null, doc: t('Absender (vacation/notify)') },
  ':addresses': { ext: 'vacation', doc: t('Eigene Adressen für vacation') },
  ':seconds': { ext: 'vacation', doc: t('Antwort-Intervall in Sekunden') },
  ':importance': { ext: 'enotify', doc: t('Wichtigkeit 1–3') },
  ':options': { ext: 'enotify', doc: t('Optionen der Benachrichtigung') },
  ':message': { ext: 'enotify', doc: t('Text der Benachrichtigung') },
  ':header': { ext: 'duplicate', doc: t('Header für duplicate') },
  ':uniqueid': { ext: 'duplicate', doc: t('Eindeutige ID für duplicate') },
  ':last': { ext: 'editheader', doc: t('Am Ende hinzufügen / letzten wählen') },
  ':index': { ext: 'index', doc: t('n-ten Header wählen') },
  ':percent': { ext: 'spamtestplus', doc: t('Spam-Score in Prozent') },
  ':flags': { ext: 'imap4flags', doc: t('Flags direkt beim fileinto/keep setzen') },
};

export const HEADERS = [
  'from', 'to', 'cc', 'bcc', 'reply-to', 'sender', 'subject', 'list-id', 'list-unsubscribe',
  'list-post', 'return-path', 'received', 'date', 'message-id', 'x-priority', 'precedence',
  'auto-submitted', 'x-mailer', 'x-spam-flag', 'delivered-to',
];

export const SYSTEM_FOLDERS = ['inbox', 'archive', 'trash', 'spam', 'starred'];

export const FLAGS = ['\\\\Seen', '\\\\Flagged'];

export const LIST_SPECS = [
  ':addrbook:personal', ':addrbook:myself', ':addrbook:organization',
  ':incomingdefaults:inbox', ':incomingdefaults:spam',
];

export const DATE_PARTS = [
  'year', 'month', 'day', 'date', 'time', 'hour', 'minute', 'second',
  'weekday', 'zone', 'iso8601', 'std11', 'julian',
];

export const RELATIONAL_OPS = ['gt', 'ge', 'eq', 'le', 'lt'];

export const EXPIRE_UNITS = ['month', 'day', 'hour', 'minute', 'second'];

export const TEMPLATES = [
  {
    name: t('Absender → Ordner'),
    body: `if address :is "from" "absender@example.com" {
    fileinto "Ordner";
}`,
  },
  {
    name: t('Domain → Ordner'),
    body: `if address :domain :is "from" "example.com" {
    fileinto "Ordner";
}`,
  },
  {
    name: t('Mailingliste → Ordner, als gelesen'),
    body: `if exists "list-id" {
    addflag "\\\\Seen";
    fileinto "Listen";
}`,
  },
  {
    name: t('Newsletter (List-Unsubscribe) → Ordner'),
    body: `if exists "list-unsubscribe" {
    fileinto "Newsletter";
}`,
  },
  {
    name: t('Betreff enthält → Label + Stern'),
    body: `if header :contains "subject" "Rechnung" {
    addflag "\\\\Flagged";
    fileinto "Rechnungen";
}`,
  },
  {
    name: t('Ordner nach Absender-Domain'),
    body: `if address :domain :matches "from" "*" {
    set :lower "sender" "\${1}";
    fileinto "\${sender}";
}`,
  },
  {
    name: t('Nicht-Kontakte nach 30 Tagen löschen'),
    body: `if not anyof(
    header :list "from" ":addrbook:personal",
    header :list "from" ":addrbook:myself"
) {
    expire "day" "30";
}`,
  },
  {
    name: t('Abwesenheitsnotiz (Zeitraum)'),
    body: `if allof(
    currentdate :value "ge" "date" "2026-12-20",
    currentdate :value "le" "date" "2027-01-06"
) {
    vacation :days 7 :subject "Abwesend" "Ich bin bis zum 6. Januar nicht erreichbar.";
}`,
  },
];

/** A fresh script: Proton's starts with the spam guard, a standard one with an (empty) header comment. */
export function newScript(rules = '', dialect = PROTON_DIALECT) {
  if (!dialect.proton) return `# Sieve-Filter\n${rules ? `\n${rules}\n` : ''}`;
  return `require ${formatList(SPAM_GUARD_REQUIRE)};\n\n${SPAM_GUARD}\n${rules ? `\n${rules}\n` : ''}`;
}

export function formatList(items) {
  return `[${items.map((i) => `"${i}"`).join(', ')}]`;
}
