// Message headers for the simulator and for "rule from mail": parsing, addresses, rule suggestions.

import { t } from './i18n.js';

/**
 * A message as the simulator sees it (Proton filters only see headers, never the body).
 * @typedef {{headers: Record<string, string[]>, size?: number, envelope?: {from?: string, to?: string}, flags?: string[]}} SieveMessage
 */

/** Parses a raw RFC 5322 header block into lower-cased names → unfolded values. */
export function parseHeaderBlock(raw) {
  const headers = {};
  const text = raw.replace(/\r\n/g, '\n').split(/\n\n/)[0];
  let current = null;
  for (const line of text.split('\n')) {
    if (/^[ \t]/.test(line) && current) {
      current.value += ` ${line.trim()}`;
      continue;
    }
    const m = /^([^:\s]+):\s?(.*)$/.exec(line);
    if (!m) continue;
    current = { name: m[1].toLowerCase(), value: m[2] };
    (headers[current.name] ??= []).push(current);
  }
  return Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, v.map((h) => h.value)]));
}

/** Thunderbird's messages.getFull() part → SieveMessage. */
export function messageFromThunderbird(full, { size, flags = [] } = {}) {
  const headers = {};
  for (const [name, values] of Object.entries(full.headers ?? {})) headers[name.toLowerCase()] = values;
  return { headers, size: size ?? full.size, flags };
}

/** Decodes RFC 2047 encoded words (=?utf-8?B?...?= / =?utf-8?Q?...?=). */
export function decodeEncodedWords(value) {
  return value.replace(/=\?([^?]+)\?([bqBQ])\?([^?]*)\?=(\s+(?==\?))?/g, (_, charset, enc, data) => {
    try {
      let bytes;
      if (enc.toUpperCase() === 'B') {
        bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
      } else {
        const s = data.replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/g, (__, h) => String.fromCharCode(parseInt(h, 16)));
        bytes = Uint8Array.from(s, (c) => c.charCodeAt(0));
      }
      return new TextDecoder(charset).decode(bytes);
    } catch {
      return data;
    }
  });
}

/** Extracts bare addresses from an address header ("Jane <jane@x.de>, bob@y.de" → ["jane@x.de", "bob@y.de"]). */
export function parseAddresses(value) {
  const out = [];
  let depth = 0;
  let quoted = false;
  let current = '';
  const flush = () => {
    const angle = /<([^>]*)>/.exec(current);
    const addr = (angle ? angle[1] : current.replace(/\(.*?\)/g, '')).trim();
    if (addr) out.push(addr);
    current = '';
  };
  for (const ch of value) {
    if (ch === '"' && depth === 0) quoted = !quoted;
    if (!quoted && ch === '<') depth++;
    if (!quoted && ch === '>') depth = Math.max(0, depth - 1);
    if (ch === ',' && !quoted && depth === 0) flush();
    else current += ch;
  }
  flush();
  return out;
}

export function addressPart(address, part) {
  const at = address.lastIndexOf('@');
  if (part === 'localpart') return at === -1 ? address : address.slice(0, at);
  if (part === 'domain') return at === -1 ? '' : address.slice(at + 1);
  return address;
}

const first = (msg, name) => msg.headers[name]?.[0];

/** Display name of the first From address, if any. */
export function senderName(msg) {
  const from = first(msg, 'from');
  if (!from) return '';
  const m = /^\s*"?([^"<]*?)"?\s*</.exec(decodeEncodedWords(from));
  return m ? m[1].trim() : '';
}

/**
 * Suggests conditions for a rule from this message, best guess first.
 * @returns {Array<{id: string, label: string, condition: object, recommended?: boolean}>}
 */
export function suggestConditions(msg, { ownAddresses = [] } = {}) {
  const suggestions = [];
  const from = parseAddresses(first(msg, 'from') ?? '')[0];
  const listId = first(msg, 'list-id');
  const subject = decodeEncodedWords(first(msg, 'subject') ?? '').trim();
  const to = [...(msg.headers.to ?? []), ...(msg.headers.cc ?? [])].flatMap(parseAddresses);
  const own = new Set(ownAddresses.map((a) => a.toLowerCase()));

  if (listId) {
    const id = /<([^>]+)>/.exec(listId)?.[1] ?? listId.trim();
    suggestions.push({
      id: 'list-id',
      label: t('Mailingliste {id}', { id }),
      condition: { kind: 'header', header: 'list-id', match: 'contains', value: id },
    });
  }
  if (from) {
    const domain = addressPart(from, 'domain').toLowerCase();
    const local = addressPart(from, 'localpart').toLowerCase();
    const automated = /^(no-?reply|donotreply|notifications?|news(letter)?|info|mailer|support|service|updates?|hello)\b/.test(local);
    suggestions.push({
      id: 'from',
      label: t('Absender {from}', { from }),
      condition: { kind: 'address', header: 'from', part: 'all', match: 'is', value: from.toLowerCase() },
    });
    if (domain) {
      suggestions.push({
        id: 'domain',
        label: t('Absender-Domain {domain}', { domain }),
        condition: { kind: 'address', header: 'from', part: 'domain', match: 'is', value: domain },
        automated,
      });
    }
  }
  // mail sent to an alias / sub-address (e.g. hide-my-email or name+shop@)
  const alias = to.find((a) => /\+/.test(addressPart(a, 'localpart')) || (own.size && !own.has(a.toLowerCase())));
  if (alias) {
    suggestions.push({
      id: 'to',
      label: t('Empfänger-Adresse {address}', { address: alias }),
      condition: { kind: 'address', header: 'to', part: 'all', match: 'is', value: alias.toLowerCase() },
    });
  }
  if (subject) {
    // drop numbers, dates and order ids so the rule survives the next mail
    const stable = subject.replace(/[#\d][\w\-./]*\d\w*/g, '').replace(/\s{2,}/g, ' ').replace(/[\s:–-]+$/, '').trim().slice(0, 60);
    if (stable) {
      suggestions.push({
        id: 'subject',
        label: t('Betreff enthält „{subject}“', { subject: stable }),
        condition: { kind: 'header', header: 'subject', match: 'contains', value: stable },
      });
    }
  }
  if (msg.headers['list-unsubscribe'] && !listId) {
    suggestions.push({
      id: 'unsubscribe',
      label: t('Jeder Newsletter (List-Unsubscribe vorhanden)'),
      condition: { kind: 'exists', header: 'list-unsubscribe' },
    });
  }

  const recommended =
    suggestions.find((s) => s.id === 'list-id') ??
    suggestions.find((s) => s.id === 'domain' && s.automated) ??
    suggestions.find((s) => s.id === 'from') ??
    suggestions[0];
  if (recommended) recommended.recommended = true;
  return suggestions;
}
