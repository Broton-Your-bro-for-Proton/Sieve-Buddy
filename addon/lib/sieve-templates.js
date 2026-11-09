// Parameterised rule templates. Most build a structured rule ({conditions, actions}) so they can be merged
// into existing blocks by proposeRule(); a few complex ones return finished Sieve code instead.

import { t } from './i18n.js';
import { quoteSieve } from './sieve-ast.js';

const list = (value) =>
  String(value ?? '')
    .split(/[\n,;]+/)
    .map((v) => v.trim())
    .filter(Boolean);

const folder = (id = 'folder', label = t('Folder/label'), fallback = '') => ({ id, label, type: 'folder', default: fallback });
const bool = (id, label, fallback = false) => ({ id, label, type: 'bool', default: fallback });
const text = (id, label, fallback = '', placeholder = '') => ({ id, label, type: 'text', default: fallback, placeholder });
const number = (id, label, fallback) => ({ id, label, type: 'number', default: fallback });

const actionParams = [bool('seen', t('Mark as read')), bool('flagged', t('Mark with star')), number('expireDays', t('Delete after … days (empty = never)'), '')];
const actionsFrom = (p) => ({
  fileinto: p.folder || null,
  seen: Boolean(p.seen),
  flagged: Boolean(p.flagged),
  expireDays: p.expireDays ? Number(p.expireDays) : null,
});

export const TEMPLATE_CATEGORIES = [t('Sender'), t('Newsletters & lists'), t('Shops & invoices'), t('Notifications'), t('Cleanup'), t('Out of office'), t('Contacts & protection')];

export const RULE_TEMPLATES = [
  {
    id: 'sender-to-folder',
    category: t('Sender'),
    name: t('Sender to folder'),
    description: t('File messages from specific addresses.'),
    params: [text('addresses', t('Sender addresses (one per line)'), '', t('boss@company.com')), folder(), ...actionParams],
    build: (p) => ({
      conditions: list(p.addresses).map((value) => ({ kind: 'address', header: 'from', part: 'all', match: 'is', value: value.toLowerCase() })),
      actions: actionsFrom(p),
    }),
  },
  {
    id: 'domain-to-folder',
    category: t('Sender'),
    name: t('Domain to folder'),
    description: t('All messages from one or more domains.'),
    params: [text('domains', t('Domains (one per line)'), '', 'example.com'), folder(), ...actionParams],
    build: (p) => ({
      conditions: list(p.domains).map((value) => ({ kind: 'address', header: 'from', part: 'domain', match: 'is', value: value.toLowerCase() })),
      actions: actionsFrom(p),
    }),
  },
  {
    id: 'vip',
    category: t('Sender'),
    name: t('Mark important senders'),
    description: t('Set a star, keep in the inbox.'),
    params: [text('addresses', t('Addresses (one per line)'))],
    build: (p) => ({
      conditions: list(p.addresses).map((value) => ({ kind: 'address', header: 'from', part: 'all', match: 'is', value: value.toLowerCase() })),
      actions: { flagged: true },
    }),
  },
  {
    id: 'list-id',
    category: t('Newsletters & lists'),
    name: t('Mailing list to folder'),
    description: t('By List-Id – more reliable than the sender.'),
    params: [text('ids', t('List IDs (one per line)'), '', 'news.example.com'), folder('folder', t('Folder/label'), t('Lists')), bool('seen', t('Mark as read'), true), number('expireDays', t('Delete after … days (empty = never)'), '')],
    build: (p) => ({
      conditions: list(p.ids).map((value) => ({ kind: 'header', header: 'list-id', match: 'contains', value })),
      actions: actionsFrom(p),
    }),
  },
  {
    id: 'all-newsletters',
    category: t('Newsletters & lists'),
    name: t('All newsletters into one folder'),
    description: t('Everything with a List-Unsubscribe header.'),
    params: [folder('folder', t('Folder/label'), t('Newsletters')), ...actionParams],
    build: (p) => ({ conditions: [{ kind: 'exists', header: 'list-unsubscribe' }], actions: actionsFrom(p) }),
  },
  {
    id: 'social',
    category: t('Newsletters & lists'),
    name: t('Social networks'),
    description: t('LinkedIn, Facebook, Instagram, X, XING …'),
    params: [folder('folder', t('Folder/label'), t('Social networks')), ...actionParams],
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
    category: t('Shops & invoices'),
    name: t('Invoices by subject'),
    description: t('Subject contains e.g. “Rechnung”, “Invoice”, “Beleg”.'),
    params: [text('words', t('Keywords (one per line)'), 'Rechnung\nInvoice\nBeleg\nQuittung'), folder('folder', t('Folder/label'), t('Invoices')), bool('flagged', t('Mark with star'), true)],
    build: (p) => ({
      conditions: list(p.words).map((value) => ({ kind: 'header', header: 'subject', match: 'contains', value })),
      actions: actionsFrom(p),
    }),
  },
  {
    id: 'shops',
    category: t('Shops & invoices'),
    name: t('Shops & orders'),
    description: t('Known shop domains.'),
    params: [text('domains', t('Domains (one per line)'), 'amazon.de\nebay.de\nzalando.de\npaypal.de'), folder('folder', t('Folder/label'), t('Shopping')), ...actionParams],
    build: (p) => ({
      conditions: list(p.domains).map((value) => ({ kind: 'address', header: 'from', part: 'domain', match: 'is', value })),
      actions: actionsFrom(p),
    }),
  },
  {
    id: 'github',
    category: t('Notifications'),
    name: t('GitHub notifications'),
    description: t('notifications@github.com, optionally split by repository.'),
    params: [folder('folder', t('Folder/label'), 'GitHub'), bool('seen', t('Mark as read')), number('expireDays', t('Delete after … days (empty = never)'), '90')],
    build: (p) => ({
      conditions: [{ kind: 'address', header: 'from', part: 'all', match: 'is', value: 'notifications@github.com' }],
      actions: actionsFrom(p),
    }),
  },
  {
    id: 'monitoring',
    category: t('Notifications'),
    name: t('Monitoring & system mail'),
    description: t('Cron, backups, uptime monitors – subject keywords.'),
    params: [text('words', t('Keywords'), 'Cron\nBackup\n[ALERT]\nUptime'), folder('folder', t('Folder/label'), 'System'), bool('seen', t('Mark as read'), true), number('expireDays', t('Delete after … days'), '30')],
    build: (p) => ({
      conditions: list(p.words).map((value) => ({ kind: 'header', header: 'subject', match: 'contains', value })),
      actions: actionsFrom(p),
    }),
  },
  {
    id: 'noreply',
    category: t('Notifications'),
    name: t('No-reply senders'),
    description: t('Automatic mail from noreply@ / no-reply@.'),
    params: [folder('folder', t('Folder/label'), t('Automatic')), ...actionParams],
    build: (p) => ({
      conditions: ['noreply', 'no-reply', 'donotreply'].map((value) => ({ kind: 'address', header: 'from', part: 'localpart', match: 'is', value })),
      actions: actionsFrom(p),
    }),
  },
  {
    id: 'expire-folder-mails',
    protonOnly: true,
    category: t('Cleanup'),
    name: t('Delete mail from a sender automatically'),
    description: t('Remove mail from certain domains after X days.'),
    params: [text('domains', t('Domains (one per line)')), number('expireDays', t('Delete after … days'), '14')],
    build: (p) => ({
      conditions: list(p.domains).map((value) => ({ kind: 'address', header: 'from', part: 'domain', match: 'is', value })),
      actions: { expireDays: Number(p.expireDays) || 14 },
    }),
  },
  {
    id: 'expire-non-contacts',
    protonOnly: true,
    category: t('Cleanup'),
    name: t('Delete non-contacts after X days'),
    description: t('Everything that does not come from your contacts.'),
    params: [number('days', t('Days'), '30')],
    code: (p) => `if not anyof(
    header :list "from" ":addrbook:personal",
    header :list "from" ":addrbook:myself"
) {
    expire "day" "${Number(p.days) || 30}";
}`,
  },
  {
    id: 'vacation',
    category: t('Out of office'),
    name: t('Out-of-office reply for a date range'),
    description: t('Automatic reply (paid accounts only).'),
    params: [text('from', t('From (YYYY-MM-DD)'), ''), text('to', t('To (YYYY-MM-DD)'), ''), text('subject', t('Subject'), t('Out of Office')), text('message', t('Text'), t('I am currently not available.')), number('days', t('Reply at most every … days per sender'), '7')],
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
    category: t('Contacts & protection'),
    name: t('Unknown senders to folder'),
    description: t('Only contacts and the allow list stay in the inbox.'),
    params: [folder('folder', t('Folder/label'), t('Unknown'))],
    code: (p) => `if not anyof(
    header :list "from" ":addrbook:personal",
    header :list "from" ":incomingdefaults:inbox",
    header :list "from" ":addrbook:myself"
) {
    fileinto ${quoteSieve(p.folder || t('Unknown'))};
}`,
  },
  {
    id: 'domain-folder-auto',
    category: t('Contacts & protection'),
    name: t('Folder automatically by domain'),
    description: t('Each sender domain gets its own folder (must exist).'),
    params: [text('prefix', t('Folder prefix'), 'Domains/')],
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
  if (!rule.conditions.length) throw new Error(t('Please enter at least one value'));
  return { rule };
}
