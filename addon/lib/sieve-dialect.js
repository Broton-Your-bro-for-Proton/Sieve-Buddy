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
  fileinto: t('Move message to folder/label'),
  imap4flags: t('Set flags (addflag, removeflag, setflag, hasflag)'),
  reject: t('Reject message with a reason'),
  vacation: t('Automatic reply (paid accounts only)'),
  date: t('Tests date and currentdate'),
  envelope: t('Test the SMTP envelope (from/to only)'),
  variables: t('Variables with set and ${…}'),
  relational: t('Comparisons with :value and :count'),
  'comparator-i;ascii-numeric': t('Numeric comparison'),
  regex: t('Match type :regex'),
  extlists: t('Contact, allow and block lists (header :list)'),
  'vnd.proton.eval': t('Arithmetic with set :eval'),
  'vnd.proton.expire': t('Automatic deletion (expire, unexpire)'),
  include: t('Only for return (spam guard)'),
  environment: t('Read environment values (spam guard)'),
  spamtest: t('Test the spam score (spam guard)'),
};

/** Extensions Proton accepts – exactly the list above. */
export const PROTON_EXTENSIONS = Object.keys(EXTENSIONS);

/** Further standard extensions found on Dovecot/Pigeonhole, Stalwart, Cyrus and others. */
export const STANDARD_EXTENSIONS = {
  copy: t('fileinto/redirect :copy – keep the original and store a copy'),
  mailbox: t('fileinto :create and test mailboxexists'),
  body: t('Test body – search the message text'),
  editheader: t('addheader / deleteheader'),
  enotify: t('notify – send a notification'),
  duplicate: t('Test duplicate – detect duplicate messages'),
  subaddress: t('Address parts :user and :detail (name+detail@…)'),
  ihave: t('Test ihave – is the extension available?'),
  'encoded-character': t('${hex:…} / ${unicode:…} in strings'),
  'spamtestplus': 'spamtest :percent',
  virustest: t('Test the virus score'),
  'special-use': 'fileinto :specialuse',
  imapflags: t('Deprecated predecessor of imap4flags'),
  index: t(':index / :last for header/address/date'),
  'comparator-i;unicode-casemap': t('Unicode comparison, case-insensitive'),
  'vnd.dovecot.debug': 'debug_log (Dovecot)',
  'vnd.dovecot.duplicate': t('Older Dovecot variant of duplicate'),
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
  require: { ext: null, kind: 'control', doc: t('Load required extensions') },
  if: { ext: null, kind: 'control', doc: t('Condition') },
  elsif: { ext: null, kind: 'control', doc: t('Further condition') },
  else: { ext: null, kind: 'control', doc: t('Else branch') },
  stop: { ext: null, kind: 'action', doc: t('Ends ALL filters (including following ones)') },
  return: { ext: 'include', kind: 'action', doc: t('Ends this script') },
  // actions
  keep: { ext: null, kind: 'action', doc: t('Cancels a discard (no copy in the inbox!)') },
  discard: { ext: null, kind: 'action', doc: t('Discards the message, following filters do not run') },
  fileinto: { ext: 'fileinto', kind: 'action', doc: t('Move to folder/label') },
  addflag: { ext: 'imap4flags', kind: 'action', doc: t('Add flag') },
  removeflag: { ext: 'imap4flags', kind: 'action', doc: t('Remove flag') },
  setflag: { ext: 'imap4flags', kind: 'action', doc: t('Replace flags') },
  reject: { ext: 'reject', kind: 'action', doc: t('Reject with a reason') },
  vacation: { ext: 'vacation', kind: 'action', doc: t('Automatic reply') },
  set: { ext: 'variables', kind: 'action', doc: t('Set variable') },
  expire: { ext: 'vnd.proton.expire', kind: 'action', doc: t('Delete after a period') },
  unexpire: { ext: 'vnd.proton.expire', kind: 'action', doc: t('Remove expiration') },
  // tests
  address: { ext: null, kind: 'test', doc: t('Test an address header') },
  header: { ext: null, kind: 'test', doc: t('Test a header value') },
  exists: { ext: null, kind: 'test', doc: t('Header present?') },
  size: { ext: null, kind: 'test', doc: t('Size (encrypted) :over/:under') },
  true: { ext: null, kind: 'test', doc: t('Always true') },
  false: { ext: null, kind: 'test', doc: t('Always false') },
  not: { ext: null, kind: 'test', doc: t('Negation') },
  anyof: { ext: null, kind: 'test', doc: t('OR') },
  allof: { ext: null, kind: 'test', doc: t('AND') },
  envelope: { ext: 'envelope', kind: 'test', doc: t('Envelope from/to') },
  date: { ext: 'date', kind: 'test', doc: t('Date from header') },
  currentdate: { ext: 'date', kind: 'test', doc: t('Current date') },
  hasflag: { ext: 'imap4flags', kind: 'test', doc: t('Flag set?') },
  string: { ext: 'variables', kind: 'test', doc: t('Test string/variable') },
  hasexpiration: { ext: 'vnd.proton.expire', kind: 'test', doc: t('Expiration set?') },
  expiration: { ext: 'vnd.proton.expire', kind: 'test', doc: t('Compare expiration') },
  environment: { ext: 'environment', kind: 'test', doc: t('Environment value') },
  spamtest: { ext: 'spamtest', kind: 'test', doc: t('Spam score') },
  // standard extensions (not on Proton)
  redirect: { ext: null, kind: 'action', doc: t('Redirect to another address') },
  include: { ext: 'include', kind: 'action', doc: t('Include another script') },
  global: { ext: 'include', kind: 'action', doc: t('Global variable (include)') },
  notify: { ext: 'enotify', kind: 'action', doc: t('Send notification') },
  addheader: { ext: 'editheader', kind: 'action', doc: t('Add header') },
  deleteheader: { ext: 'editheader', kind: 'action', doc: t('Remove header') },
  debug_log: { ext: 'vnd.dovecot.debug', kind: 'action', doc: t('Debug output (Dovecot)') },
  body: { ext: 'body', kind: 'test', doc: t('Search the message text') },
  mailboxexists: { ext: 'mailbox', kind: 'test', doc: t('Folder exists?') },
  duplicate: { ext: 'duplicate', kind: 'test', doc: t('Already delivered once?') },
  ihave: { ext: 'ihave', kind: 'test', doc: t('Extension available?') },
  virustest: { ext: 'virustest', kind: 'test', doc: t('Virus score') },
  valid_notify_method: { ext: 'enotify', kind: 'test', doc: t('Notification method valid?') },
};

/** Commands that only exist (or behave as documented here) on Proton. */
export const PROTON_ONLY_COMMANDS = new Set(['expire', 'unexpire', 'hasexpiration', 'expiration']);

/** Tagged arguments, with the extension they need. */
export const TAGS = {
  ':is': { ext: null, doc: t('Exactly equal') },
  ':contains': { ext: null, doc: t('Contains') },
  ':matches': { ext: null, doc: t('Wildcards * and ?') },
  ':regex': { ext: 'regex', doc: t('Regular expression (POSIX, no \\d/\\w/\\b)') },
  ':value': { ext: 'relational', doc: t('Comparison "gt" "ge" "eq" "le" "lt"') },
  ':count': { ext: 'relational', doc: t('Compare the count') },
  ':comparator': { ext: null, doc: t('Comparison type, e.g. "i;ascii-numeric"') },
  ':all': { ext: null, doc: t('Entire address') },
  ':localpart': { ext: null, doc: t('Part before @') },
  ':domain': { ext: null, doc: t('Part after @') },
  ':over': { ext: null, doc: t('Greater than') },
  ':under': { ext: null, doc: t('Less than') },
  ':zone': { ext: 'date', doc: t('Time zone "+0100"') },
  ':originalzone': { ext: 'date', doc: t('Time zone of the header') },
  ':days': { ext: 'vacation', doc: t('Reply interval in days') },
  ':subject': { ext: 'vacation', doc: t('Subject of the reply') },
  ':mime': { ext: 'vacation', doc: t('Reply as MIME') },
  ':handle': { ext: null, doc: t('Reply group') },
  ':list': { ext: 'extlists', doc: t('Against contact/allow/block list') },
  ':lower': { ext: 'variables', doc: t('Lowercase') },
  ':upper': { ext: 'variables', doc: t('Uppercase') },
  ':lowerfirst': { ext: 'variables', doc: t('First letter lowercase') },
  ':upperfirst': { ext: 'variables', doc: t('First letter uppercase') },
  ':quotewildcard': { ext: 'variables', doc: t('Escape wildcards') },
  ':length': { ext: 'variables', doc: t('Length') },
  ':eval': { ext: 'vnd.proton.eval', doc: t('Evaluate arithmetic') },
  // standard extensions
  ':copy': { ext: 'copy', doc: t('Store a copy, the original stays in the inbox') },
  ':create': { ext: 'mailbox', doc: t('Create the folder if it is missing') },
  ':specialuse': { ext: 'special-use', doc: t('Select a folder by special use (\\\\Junk …)') },
  ':raw': { ext: 'body', doc: t('Search the raw text') },
  ':content': { ext: 'body', doc: t('Search specific MIME types') },
  ':text': { ext: 'body', doc: t('Search the decoded text') },
  ':user': { ext: 'subaddress', doc: t('Part before the + (name+detail@…)') },
  ':detail': { ext: 'subaddress', doc: t('Part after the + (name+detail@…)') },
  ':from': { ext: null, doc: t('Sender (vacation/notify)') },
  ':addresses': { ext: 'vacation', doc: t('Own addresses for vacation') },
  ':seconds': { ext: null, doc: t('Reply interval in seconds') },
  ':importance': { ext: 'enotify', doc: t('Importance 1–3') },
  ':options': { ext: 'enotify', doc: t('Notification options') },
  ':message': { ext: 'enotify', doc: t('Notification text') },
  ':header': { ext: 'duplicate', doc: t('Header for duplicate') },
  ':uniqueid': { ext: 'duplicate', doc: t('Unique ID for duplicate') },
  ':last': { ext: null, doc: t('Add at the end / select the last one') },
  ':index': { ext: 'index', doc: t('Select the nth header') },
  ':percent': { ext: 'spamtestplus', doc: t('Spam score in percent') },
  ':flags': { ext: 'imap4flags', doc: t('Set flags directly with fileinto/keep') },
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
    name: t('Sender → folder'),
    body: `if address :is "from" "${t('sender@example.com')}" {
    fileinto "${t('Folder')}";
}`,
  },
  {
    name: t('Domain → folder'),
    body: `if address :domain :is "from" "example.com" {
    fileinto "${t('Folder')}";
}`,
  },
  {
    name: t('Mailing list → folder, mark as read'),
    body: `if exists "list-id" {
    addflag "\\\\Seen";
    fileinto "${t('Lists')}";
}`,
  },
  {
    name: t('Newsletter (List-Unsubscribe) → folder'),
    body: `if exists "list-unsubscribe" {
    fileinto "Newsletter";
}`,
  },
  {
    name: t('Subject contains → label + star'),
    body: `if header :contains "subject" "${t('Invoice')}" {
    addflag "\\\\Flagged";
    fileinto "${t('Invoices')}";
}`,
  },
  {
    name: t('Folder by sender domain'),
    body: `if address :domain :matches "from" "*" {
    set :lower "sender" "\${1}";
    fileinto "\${sender}";
}`,
  },
  {
    name: t('Delete non-contacts after 30 days'),
    body: `if not anyof(
    header :list "from" ":addrbook:personal",
    header :list "from" ":addrbook:myself"
) {
    expire "day" "30";
}`,
  },
  {
    name: t('Out-of-office reply (date range)'),
    body: `if allof(
    currentdate :value "ge" "date" "2026-12-20",
    currentdate :value "le" "date" "2027-01-06"
) {
    vacation :days 7 :subject "${t('Out of Office')}" "${t('I am unavailable until January 6.')}";
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
