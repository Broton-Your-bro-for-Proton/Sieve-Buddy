// Proton's Sieve dialect: extensions, commands, tagged arguments and the spam-guard prologue.
// Based on https://proton.me/support/sieve-advanced-custom-filters and Proton's web client.

export const SPAM_GUARD_REQUIRE = ['include', 'environment', 'variables', 'relational', 'comparator-i;ascii-numeric', 'spamtest'];

export const SPAM_GUARD = `# Generated: Do not run this script on spam messages
if allof (environment :matches "vnd.proton.spam-threshold" "*",
spamtest :value "ge" :comparator "i;ascii-numeric" "\${1}")
{
    return;
}`;

export const EXTENSIONS = {
  fileinto: 'Nachricht in Ordner/Label verschieben',
  imap4flags: 'Flags setzen (addflag, removeflag, setflag, hasflag)',
  reject: 'Nachricht mit Begründung abweisen',
  vacation: 'Automatische Antwort (nur bezahlte Konten)',
  date: 'Tests date und currentdate',
  envelope: 'SMTP-Envelope testen (nur from/to)',
  variables: 'Variablen mit set und ${…}',
  relational: 'Vergleiche mit :value und :count',
  'comparator-i;ascii-numeric': 'Numerischer Vergleich',
  regex: 'Match-Typ :regex',
  extlists: 'Kontakt-, Allow- und Blocklisten (header :list)',
  'vnd.proton.eval': 'Arithmetik mit set :eval',
  'vnd.proton.expire': 'Automatisches Löschen (expire, unexpire)',
  include: 'Nur für return (Spam-Schutz)',
  environment: 'Umgebungswerte lesen (Spam-Schutz)',
  spamtest: 'Spam-Score testen (Spam-Schutz)',
};

/** Commands and tests, each with the extension it needs (null = core Sieve). */
export const COMMANDS = {
  // control
  require: { ext: null, kind: 'control', doc: 'Benötigte Erweiterungen laden' },
  if: { ext: null, kind: 'control', doc: 'Bedingung' },
  elsif: { ext: null, kind: 'control', doc: 'Weitere Bedingung' },
  else: { ext: null, kind: 'control', doc: 'Sonst-Zweig' },
  stop: { ext: null, kind: 'action', doc: 'Beendet ALLE Filter (auch nachfolgende)' },
  return: { ext: 'include', kind: 'action', doc: 'Beendet dieses Skript' },
  // actions
  keep: { ext: null, kind: 'action', doc: 'Hebt ein discard auf (keine Kopie im Posteingang!)' },
  discard: { ext: null, kind: 'action', doc: 'Verwirft die Nachricht, nachfolgende Filter laufen nicht' },
  fileinto: { ext: 'fileinto', kind: 'action', doc: 'In Ordner/Label verschieben' },
  addflag: { ext: 'imap4flags', kind: 'action', doc: 'Flag hinzufügen' },
  removeflag: { ext: 'imap4flags', kind: 'action', doc: 'Flag entfernen' },
  setflag: { ext: 'imap4flags', kind: 'action', doc: 'Flags ersetzen' },
  reject: { ext: 'reject', kind: 'action', doc: 'Mit Begründung abweisen' },
  vacation: { ext: 'vacation', kind: 'action', doc: 'Automatische Antwort' },
  set: { ext: 'variables', kind: 'action', doc: 'Variable setzen' },
  expire: { ext: 'vnd.proton.expire', kind: 'action', doc: 'Nach Zeitraum löschen' },
  unexpire: { ext: 'vnd.proton.expire', kind: 'action', doc: 'Ablauf entfernen' },
  // tests
  address: { ext: null, kind: 'test', doc: 'Adress-Header testen' },
  header: { ext: null, kind: 'test', doc: 'Header-Wert testen' },
  exists: { ext: null, kind: 'test', doc: 'Header vorhanden?' },
  size: { ext: null, kind: 'test', doc: 'Größe (verschlüsselt) :over/:under' },
  true: { ext: null, kind: 'test', doc: 'Immer wahr' },
  false: { ext: null, kind: 'test', doc: 'Immer falsch' },
  not: { ext: null, kind: 'test', doc: 'Negation' },
  anyof: { ext: null, kind: 'test', doc: 'ODER' },
  allof: { ext: null, kind: 'test', doc: 'UND' },
  envelope: { ext: 'envelope', kind: 'test', doc: 'Envelope from/to' },
  date: { ext: 'date', kind: 'test', doc: 'Datum aus Header' },
  currentdate: { ext: 'date', kind: 'test', doc: 'Aktuelles Datum' },
  hasflag: { ext: 'imap4flags', kind: 'test', doc: 'Flag gesetzt?' },
  string: { ext: 'variables', kind: 'test', doc: 'Zeichenkette/Variable testen' },
  hasexpiration: { ext: 'vnd.proton.expire', kind: 'test', doc: 'Ablauf gesetzt?' },
  expiration: { ext: 'vnd.proton.expire', kind: 'test', doc: 'Ablauf vergleichen' },
  environment: { ext: 'environment', kind: 'test', doc: 'Umgebungswert' },
  spamtest: { ext: 'spamtest', kind: 'test', doc: 'Spam-Score' },
};

/** Tagged arguments, with the extension they need. */
export const TAGS = {
  ':is': { ext: null, doc: 'Exakt gleich' },
  ':contains': { ext: null, doc: 'Enthält' },
  ':matches': { ext: null, doc: 'Wildcards * und ?' },
  ':regex': { ext: 'regex', doc: 'Regulärer Ausdruck (POSIX, kein \\d/\\w/\\b)' },
  ':value': { ext: 'relational', doc: 'Vergleich "gt" "ge" "eq" "le" "lt"' },
  ':count': { ext: 'relational', doc: 'Anzahl vergleichen' },
  ':comparator': { ext: null, doc: 'Vergleichsart, z. B. "i;ascii-numeric"' },
  ':all': { ext: null, doc: 'Ganze Adresse' },
  ':localpart': { ext: null, doc: 'Teil vor @' },
  ':domain': { ext: null, doc: 'Teil nach @' },
  ':over': { ext: null, doc: 'Größer als' },
  ':under': { ext: null, doc: 'Kleiner als' },
  ':zone': { ext: 'date', doc: 'Zeitzone "+0100"' },
  ':originalzone': { ext: 'date', doc: 'Zeitzone des Headers' },
  ':days': { ext: 'vacation', doc: 'Antwort-Intervall in Tagen' },
  ':subject': { ext: 'vacation', doc: 'Betreff der Antwort' },
  ':mime': { ext: 'vacation', doc: 'Antwort als MIME' },
  ':handle': { ext: 'vacation', doc: 'Antwort-Gruppe' },
  ':list': { ext: 'extlists', doc: 'Gegen Kontakt-/Allow-/Blockliste' },
  ':lower': { ext: 'variables', doc: 'Kleinbuchstaben' },
  ':upper': { ext: 'variables', doc: 'Großbuchstaben' },
  ':lowerfirst': { ext: 'variables', doc: 'Erster Buchstabe klein' },
  ':upperfirst': { ext: 'variables', doc: 'Erster Buchstabe groß' },
  ':quotewildcard': { ext: 'variables', doc: 'Wildcards maskieren' },
  ':length': { ext: 'variables', doc: 'Länge' },
  ':eval': { ext: 'vnd.proton.eval', doc: 'Arithmetik auswerten' },
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
    name: 'Absender → Ordner',
    body: `if address :is "from" "absender@example.com" {
    fileinto "Ordner";
}`,
  },
  {
    name: 'Domain → Ordner',
    body: `if address :domain :is "from" "example.com" {
    fileinto "Ordner";
}`,
  },
  {
    name: 'Mailingliste → Ordner, als gelesen',
    body: `if exists "list-id" {
    addflag "\\\\Seen";
    fileinto "Listen";
}`,
  },
  {
    name: 'Newsletter (List-Unsubscribe) → Ordner',
    body: `if exists "list-unsubscribe" {
    fileinto "Newsletter";
}`,
  },
  {
    name: 'Betreff enthält → Label + Stern',
    body: `if header :contains "subject" "Rechnung" {
    addflag "\\\\Flagged";
    fileinto "Rechnungen";
}`,
  },
  {
    name: 'Ordner nach Absender-Domain',
    body: `if address :domain :matches "from" "*" {
    set :lower "sender" "\${1}";
    fileinto "\${sender}";
}`,
  },
  {
    name: 'Nicht-Kontakte nach 30 Tagen löschen',
    body: `if not anyof(
    header :list "from" ":addrbook:personal",
    header :list "from" ":addrbook:myself"
) {
    expire "day" "30";
}`,
  },
  {
    name: 'Abwesenheitsnotiz (Zeitraum)',
    body: `if allof(
    currentdate :value "ge" "date" "2026-12-20",
    currentdate :value "le" "date" "2027-01-06"
) {
    vacation :days 7 :subject "Abwesend" "Ich bin bis zum 6. Januar nicht erreichbar.";
}`,
  },
];

export function newScript(rules = '') {
  return `require ${formatList(SPAM_GUARD_REQUIRE)};\n\n${SPAM_GUARD}\n${rules ? `\n${rules}\n` : ''}`;
}

export function formatList(items) {
  return `[${items.map((i) => `"${i}"`).join(', ')}]`;
}
