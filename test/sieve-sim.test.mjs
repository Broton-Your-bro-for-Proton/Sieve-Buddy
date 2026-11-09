import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseHeaderBlock, parseAddresses, suggestConditions, decodeEncodedWords } from '../addon/lib/mail.js';
import { newScript } from '../addon/lib/sieve-dialect.js';
import { simulate } from '../addon/lib/sieve-sim.js';

const req = (exts) => (s) => s.replace('"spamtest"]', `"spamtest", ${exts.map((e) => `"${e}"`).join(', ')}]`);
const script = (rules, exts = ['fileinto', 'imap4flags']) => req(exts)(newScript(rules));

const mail = (raw) => ({ headers: parseHeaderBlock(raw), size: 12000 });

const NEWSLETTER = mail(`From: "Example News" <news@example.com>
To: me@proton.me
Subject: =?utf-8?Q?Neuigkeiten_f=C3=BCr_Sie_#1234?=
List-Id: Example News <news.example.com>
List-Unsubscribe: <https://example.com/u>
Date: Tue, 03 Nov 2026 10:00:00 +0100
`);

const filters = [
  {
    id: 'a',
    name: 'Shops',
    sieve: script(`if address :domain :is "from" ["amazon.de", "example.com"] {
    addflag "\\\\Seen";
    fileinto "Einkäufe";
}`),
  },
  {
    id: 'b',
    name: 'Lists',
    sieve: script(`if exists "list-id" {
    fileinto "Lists";
    stop;
}`),
  },
  { id: 'c', name: 'Never reached', sieve: script('fileinto "Late filter";', ['fileinto']) },
];

test('headers are parsed, unfolded and decoded', () => {
  const h = parseHeaderBlock('Subject: a\n b\nX-Two: 1\nX-Two: 2\n\nbody: no');
  assert.deepEqual(h, { subject: ['a b'], 'x-two': ['1', '2'] });
  assert.equal(decodeEncodedWords('=?utf-8?B?w6TDtsO8?='), 'äöü');
  assert.deepEqual(parseAddresses('"Doe, Jane" <jane@x.de>, bob@y.de (Bob)'), ['jane@x.de', 'bob@y.de']);
});

test('later folders win, flags are applied at fileinto time, stop ends all filters', () => {
  const r = simulate(filters, NEWSLETTER);
  assert.equal(r.location, 'Lists');
  assert.deepEqual(r.flags, ['\\Seen']); // flags set by an earlier filter carry over to the later fileinto
  assert.equal(r.stoppedBy.script, 'Lists');
  assert.deepEqual(r.fired.map((f) => f.script), ['Shops', 'Lists']);
});

test('spam guard returns early for spam', () => {
  const r = simulate(filters, NEWSLETTER, { spamScore: 9, spamThreshold: '5' });
  assert.equal(r.location, 'Inbox');
  assert.equal(r.fired.filter((f) => f.test.includes('environment')).length, 3);
});

test(':matches captures, variables and labels', () => {
  const f = [
    {
      id: 'x',
      name: 'Domain folder',
      sieve: script(`if address :domain :matches "from" "*" {
    set :lower "d" "\${1}";
    fileinto "\${d}";
    fileinto "Important";
}`, ['fileinto', 'variables']),
    },
  ];
  const r = simulate(f, NEWSLETTER, { labels: ['Important'] });
  assert.equal(r.location, 'example.com');
  assert.deepEqual(r.labels, ['Important']);
});

test('discard drops only unfiled mail, keep cancels discard', () => {
  const drop = [{ id: 'd', name: 'Gone', sieve: script('if header :contains "subject" "neuigkeiten" { discard; }') }];
  assert.equal(simulate(drop, NEWSLETTER).location, 'deleted');
  const kept = [{ id: 'k', name: 'Kept', sieve: script('discard;\nkeep;') }];
  assert.equal(simulate(kept, NEWSLETTER).location, 'Inbox');
  const filed = [filters[0], ...drop];
  assert.equal(simulate(filed, NEWSLETTER).location, 'Einkäufe');
});

test('relational, size, date and expire', () => {
  const f = [
    {
      id: 'r',
      name: 'Mix',
      sieve: script(`if allof(size :over 10K, date :value "ge" :comparator "i;ascii-numeric" "date" "year" "2026") {
    expire "day" "30";
}`, ['date', 'vnd.proton.expire']),
    },
  ];
  assert.equal(simulate(f, NEWSLETTER).expireDays, 30);
});

test('disabled filters are skipped and unknown lists are noted', () => {
  const f = [
    { ...filters[1], enabled: false },
    { id: 'l', name: 'Contacts', sieve: script('if header :list "from" ":addrbook:personal" { fileinto "Contacts"; }', ['fileinto', 'extlists']) },
  ];
  const r = simulate(f, NEWSLETTER);
  assert.equal(r.location, 'Inbox');
  assert.match(r.notes.join(), /Contact lists/);
  const known = simulate(f, NEWSLETTER, { isInList: () => true });
  assert.equal(known.location, 'Contacts');
});

test('suggestions prefer the mailing list and strip volatile subject parts', () => {
  const s = suggestConditions(NEWSLETTER);
  assert.equal(s.find((x) => x.recommended).id, 'list-id');
  assert.equal(s.find((x) => x.id === 'list-id').condition.value, 'news.example.com');
  assert.equal(s.find((x) => x.id === 'subject').condition.value, 'Neuigkeiten für Sie');
  const personal = suggestConditions(mail('From: Anna <anna@gmail.com>\nTo: me+shop@proton.me\nSubject: Hello\n'));
  assert.equal(personal.find((x) => x.recommended).id, 'from');
  assert.ok(personal.some((x) => x.id === 'to' && x.condition.value === 'me+shop@proton.me'));
});
