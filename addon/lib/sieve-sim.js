// Sieve simulator: runs the user's filters against a message's headers and reports where it would end up
// and which rules fired. Two semantics:
//   proton – Proton's documented behaviour (one folder, labels, keep only cancels discard, flags at fileinto)
//   rfc    – RFC 5228 (implicit keep, every fileinto/keep stores a copy, discard cancels the implicit keep)
// Contact lists are unknown unless a resolver is given.

import { t } from './i18n.js';
import { lineOf, parseSieve } from './sieve-ast.js';
import { addressPart, decodeEncodedWords, parseAddresses } from './mail.js';

const SYSTEM = { inbox: t('Inbox'), archive: t('Archive'), trash: t('Trash'), spam: t('Spam'), starred: t('Starred') };

// tagged arguments that are followed by their own value
const VALUE_TAGS = new Set([':comparator', ':value', ':count', ':zone', ':days', ':subject', ':handle', ':flags', ':from', ':addresses', ':seconds', ':importance', ':options', ':message', ':header', ':uniqueid', ':index', ':specialuse']);

class Stop extends Error {}
class Return extends Error {}

/**
 * @param {Array<{id: string, name: string, sieve: string, enabled?: boolean}>} scripts in Proton's order
 * @param {import('./mail.js').SieveMessage} message
 * @param {{semantics?: 'proton'|'rfc', labels?: string[], spamScore?: number, spamThreshold?: string, now?: Date, isInList?: (spec: string, address: string) => boolean|undefined}} [options]
 */
export function simulate(scripts, message, options = {}) {
  const rfc = options.semantics === 'rfc';
  const labels = new Set(options.labels ?? []);
  const state = {
    folder: null,
    labels: new Set(),
    flags: new Set(message.flags ?? []),
    filedFlags: null,
    filedOrKept: false,
    discarded: false,
    rejected: null,
    vacation: null,
    expire: null,
    stoppedBy: null,
    fired: [],
    notes: [],
    // rfc
    implicitKeep: true,
    copies: [], // {folder, flags}
    redirects: [],
  };
  // the same mailbox twice is stored once; its flags are combined (as Dovecot/Pigeonhole does)
  const storeCopy = (folder, flags) => {
    const existing = state.copies.find((c) => c.folder === folder);
    if (existing) existing.flags = [...new Set([...existing.flags, ...flags])];
    else state.copies.push({ folder, flags: [...flags] });
  };

  for (const script of scripts) {
    if (script.enabled === false) continue;
    let ast;
    try {
      ast = parseSieve(script.sieve);
    } catch (error) {
      state.notes.push(t('Filter “{name}” could not be read: {message}', { name: script.name, message: error.message }));
      continue;
    }
    const ctx = { script, text: script.sieve, vars: new Map(), match: [], discard: false, keep: false };
    let stopped = false;
    try {
      runCommands(ast.commands, ctx);
    } catch (e) {
      if (e instanceof Stop) stopped = true;
      // one broken script must not take the whole simulation down
      else if (!(e instanceof Return)) state.notes.push(t('Filter “{name}” could not be simulated: {message}', { name: script.name, message: e.message }));
    }
    if (rfc) {
      if (state.rejected || stopped) {
        state.stoppedBy ??= { script: script.name, reason: state.rejected ? 'reject' : 'stop' };
        break;
      }
      continue;
    }
    if (ctx.discard && !ctx.keep) {
      if (!state.filedOrKept) state.discarded = true;
      state.stoppedBy ??= { script: script.name, reason: 'discard' };
      break;
    }
    if (state.rejected || stopped) {
      state.stoppedBy ??= { script: script.name, reason: state.rejected ? 'reject' : 'stop' };
      break;
    }
  }

  if (rfc) {
    if (state.implicitKeep && !state.rejected) storeCopy('INBOX', state.flags);
    const folders = state.copies.map((c) => c.folder);
    const location = state.rejected
      ? t('rejected')
      : folders.length
        ? folders.join(' + ')
        : state.redirects.length
          ? t('forwarded to {to}', { to: state.redirects.join(', ') })
          : t('deleted');
    return {
      location,
      folder: folders.find((f) => f !== 'INBOX') ?? folders[0] ?? null,
      folders,
      copies: state.copies,
      labels: [],
      flags: state.copies[0]?.flags ?? [...state.flags],
      expireDays: null,
      rejected: state.rejected,
      redirects: state.redirects,
      vacation: state.vacation,
      discarded: !folders.length && !state.redirects.length && !state.rejected,
      stoppedBy: state.stoppedBy,
      fired: state.fired,
      notes: state.notes,
    };
  }

  const location = state.rejected ? t('rejected') : state.discarded ? t('deleted') : SYSTEM[state.folder ?? 'inbox'] ?? state.folder;
  return {
    folders: state.discarded || state.rejected ? [] : [state.folder ?? 'inbox'],
    location,
    folder: state.folder,
    labels: [...state.labels],
    flags: [...(state.filedFlags ?? state.flags)],
    expireDays: state.expire,
    rejected: state.rejected,
    vacation: state.vacation,
    discarded: state.discarded,
    stoppedBy: state.stoppedBy,
    fired: state.fired,
    notes: state.notes,
  };

  // ---------- commands ----------

  function runCommands(commands, ctx) {
    let chainMatched = false;
    for (const c of commands) {
      if (c.name === 'if' || c.name === 'elsif' || c.name === 'else') {
        if (c.name === 'if') chainMatched = false;
        if (chainMatched) continue;
        const ok = c.name === 'else' || evalTest(c.test, ctx);
        if (ok) {
          chainMatched = true;
          state.fired.push({
            script: ctx.script.name,
            scriptId: ctx.script.id,
            line: lineOf(ctx.text, c.start),
            test: c.test ? ctx.text.slice(c.test.start, c.test.end) : 'else',
          });
          runCommands(c.block.commands, ctx);
        }
        continue;
      }
      runAction(c, ctx);
    }
  }

  function runAction(c, ctx) {
    const pos = positional(c.args);
    const tags = tagsOf(c.args);
    const str = (i) => expand(strs(pos[i])[0] ?? '', ctx);
    switch (c.name) {
      case 'require':
        return;
      case 'stop':
        throw new Stop();
      case 'return':
        throw new Return();
      case 'keep':
        if (rfc) {
          state.implicitKeep = false;
          storeCopy('INBOX', tags[':flags'] ? strs(c.args[c.args.findIndex((a) => a.value === ':flags') + 1]) : state.flags);
          return;
        }
        ctx.keep = true;
        state.filedOrKept = true;
        state.filedFlags = new Set(state.flags);
        return;
      case 'discard':
        if (rfc) {
          state.implicitKeep = false;
          return;
        }
        ctx.discard = true;
        return;
      case 'redirect': {
        state.redirects.push(str(0));
        if (!tags[':copy']) state.implicitKeep = false;
        return;
      }
      case 'fileinto': {
        const target = str(0);
        if (rfc) {
          const flagsIdx = c.args.findIndex((a) => a.value === ':flags');
          storeCopy(target, flagsIdx >= 0 ? strs(c.args[flagsIdx + 1]).map((x) => expand(x, ctx)) : state.flags);
          if (!tags[':copy']) state.implicitKeep = false;
          return;
        }
        const lower = target.toLowerCase();
        if (lower === 'drafts' || lower === 'sent') {
          state.notes.push(t('fileinto “{folder}” is ignored by Proton', { folder: target }));
          return;
        }
        // Proton matches folder and label names case-insensitively
        const label = [...labels].find((l) => l.toLowerCase() === lower);
        if (label) state.labels.add(label);
        else if (lower === 'starred') state.labels.add('Markiert');
        else state.folder = SYSTEM[lower] ? lower : target;
        state.filedOrKept = true;
        state.filedFlags = new Set(state.flags);
        return;
      }
      case 'addflag':
        for (const f of strs(pos[pos.length - 1]).map((s) => expand(s, ctx))) state.flags.add(f);
        return;
      case 'removeflag':
        for (const f of strs(pos[pos.length - 1]).map((s) => expand(s, ctx))) state.flags.delete(f);
        return;
      case 'setflag':
        state.flags = new Set(strs(pos[pos.length - 1]).map((s) => expand(s, ctx)));
        return;
      case 'reject':
        state.rejected = str(0) || t('rejected');
        throw new Stop();
      case 'vacation':
        state.vacation = { reason: expand(strs(pos[pos.length - 1])[0] ?? '', ctx), days: tags[':days'] ?? null, subject: tags[':subject'] ?? null };
        return;
      case 'expire': {
        const unit = str(0);
        const n = Number(str(1));
        const days = { month: n * 30, day: n, hour: n / 24, minute: n / 1440, second: n / 86400 }[unit] ?? n;
        state.expire = Math.min(730, days);
        return;
      }
      case 'unexpire':
        state.expire = null;
        return;
      case 'set': {
        let value = expand(strs(pos[1])[0] ?? '', ctx);
        if (tags[':lower']) value = value.toLowerCase();
        if (tags[':upper']) value = value.toUpperCase();
        if (tags[':lowerfirst']) value = value.charAt(0).toLowerCase() + value.slice(1);
        if (tags[':upperfirst']) value = value.charAt(0).toUpperCase() + value.slice(1);
        if (tags[':quotewildcard']) value = value.replace(/[*?\\]/g, '\\$&');
        if (tags[':length']) value = String([...value].length);
        if (tags[':eval']) value = String(evalArithmetic(value));
        ctx.vars.set((strs(pos[0])[0] ?? '').toLowerCase(), value);
        return;
      }
      default:
        state.notes.push(t('Command “{name}” is not executed in the simulator', { name: c.name }));
    }
  }

  // ---------- tests ----------

  function evalTest(test, ctx) {
    const tags = tagsOf(test.args);
    const pos = positional(test.args);
    const keys = () => strs(pos[pos.length - 1]).map((k) => expand(k, ctx));
    switch (test.name) {
      case 'true':
        return true;
      case 'false':
        return false;
      case 'not':
        return !evalTest(test.tests[0], ctx);
      case 'anyof':
        return test.tests.some((x) => evalTest(x, ctx));
      case 'allof':
        return test.tests.every((x) => evalTest(x, ctx));
      case 'exists':
        return strs(pos[0]).every((h) => (message.headers[h.toLowerCase()] ?? []).length > 0);
      case 'size': {
        const limit = parseSize(pos[0]?.value ?? '0');
        const size = message.size ?? 0;
        return tags[':over'] !== undefined ? size > limit : size < limit;
      }
      case 'header': {
        const values = strs(pos[0]).flatMap((h) => (message.headers[h.toLowerCase()] ?? []).map(decodeEncodedWords));
        if (tags[':list'] !== undefined) return listTest(values.flatMap(parseAddresses), strs(pos[1]));
        return compare(values, keys(), tags, ctx);
      }
      case 'address': {
        const part = tags[':domain'] !== undefined ? 'domain' : tags[':localpart'] !== undefined ? 'localpart' : 'all';
        const values = strs(pos[0]).flatMap((h) => (message.headers[h.toLowerCase()] ?? []).flatMap(parseAddresses)).map((a) => addressPart(a, part));
        return compare(values, keys(), tags, ctx);
      }
      case 'envelope': {
        const part = tags[':domain'] !== undefined ? 'domain' : tags[':localpart'] !== undefined ? 'localpart' : 'all';
        const values = strs(pos[0]).map((p) => envelope(p.toLowerCase())).filter(Boolean).map((a) => addressPart(a, part));
        return compare(values, keys(), tags, ctx);
      }
      case 'string':
        return compare(strs(pos[0]).map((s) => expand(s, ctx)), keys(), tags, ctx);
      case 'hasflag':
        return compare([...state.flags], keys(), tags, ctx);
      case 'environment': {
        const name = expand(strs(pos[0])[0] ?? '', ctx);
        const env = { 'vnd.proton.spam-threshold': options.spamThreshold ?? '5', ...(options.environment ?? {}) };
        return env[name] !== undefined && compare([env[name]], keys(), tags, ctx);
      }
      case 'spamtest':
        return compare([String(options.spamScore ?? 0)], keys(), tags, ctx);
      case 'hasexpiration':
        return state.expire !== null;
      case 'expiration':
        return state.expire !== null && compare([String(Math.round(state.expire))], keys(), tags, ctx);
      case 'currentdate': {
        const part = expand(strs(pos[0])[0] ?? '', ctx);
        return compare([datePart(options.now ?? new Date(), part, tags[':zone'])], keys(), tags, ctx);
      }
      case 'date': {
        const raw = message.headers[(strs(pos[0])[0] ?? '').toLowerCase()]?.[0];
        const date = raw ? new Date(raw.replace(/^.*;\s*/, '')) : null;
        if (!date || Number.isNaN(date.getTime())) return false;
        return compare([datePart(date, expand(strs(pos[1])[0] ?? '', ctx), tags[':zone'])], keys(), tags, ctx);
      }
      default:
        state.notes.push(t('Test “{name}” is not evaluated in the simulator (assumed false)', { name: test.name }));
        return false;
    }
  }

  function listTest(addresses, specs) {
    if (!options.isInList) {
      state.notes.push(t('Contact lists ({lists}) are unknown to the simulator – assumed “not included”', { lists: specs.join(', ') }));
      return false;
    }
    return addresses.some((a) => specs.some((s) => options.isInList(s, a)));
  }

  function envelope(part) {
    if (message.envelope?.[part]) return message.envelope[part];
    if (part === 'from') return parseAddresses(message.headers['return-path']?.[0] ?? message.headers.from?.[0] ?? '')[0];
    if (part === 'to') return parseAddresses(message.headers['delivered-to']?.[0] ?? message.headers.to?.[0] ?? '')[0];
    return null;
  }

  function compare(values, keys, tags, ctx) {
    const named = tags[':comparator'] ?? 'i;ascii-casemap';
    // RFC 4790: i;ascii-casemap folds only A-Z ("Ü" and "ü" differ); Proton's own folding is not documented
    const comparator = rfc && named === 'i;ascii-casemap' ? ASCII_ONLY : named;
    if (tags[':count'] !== undefined) {
      return keys.some((k) => relational(String(values.length), k, tags[':count'], 'i;ascii-numeric'));
    }
    for (const v of values) {
      for (const k of keys) {
        if (tags[':value'] !== undefined) {
          if (relational(v, k, tags[':value'], comparator)) return true;
        } else if (tags[':matches'] !== undefined) {
          const m = globToRegExp(k, comparator).exec(v);
          if (m) {
            ctx.match = [...m];
            return true;
          }
        } else if (tags[':regex'] !== undefined) {
          try {
            const m = new RegExp(k, comparator === 'i;octet' ? '' : 'i').exec(v);
            if (m) {
              ctx.match = [...m];
              return true;
            }
          } catch {
            state.notes.push(t('Regex “{regex}” is invalid', { regex: k }));
          }
        } else if (tags[':contains'] !== undefined) {
          if (fold(v, comparator).includes(fold(k, comparator))) return true;
        } else if (comparator === 'i;ascii-numeric' ? numeric(v) === numeric(k) : fold(v, comparator) === fold(k, comparator)) {
          return true;
        }
      }
    }
    return false;
  }

  function expand(value, ctx) {
    return value.replace(/\$\{([^}]+)\}/g, (whole, name) => {
      const n = name.trim().toLowerCase();
      if (/^\d+$/.test(n)) return ctx.match[Number(n)] ?? '';
      return ctx.vars.get(n) ?? '';
    });
  }
}

// ---------- helpers ----------

function tagsOf(args) {
  const tags = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.type !== 'tag') continue;
    const next = args[i + 1];
    if (VALUE_TAGS.has(a.value) && next && next.type !== 'tag') {
      tags[a.value] = next.type === 'list' ? next.items[0]?.value : next.value;
      i++;
    } else {
      tags[a.value] = true;
    }
  }
  return tags;
}

function positional(args) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.type === 'tag') {
      if (VALUE_TAGS.has(a.value)) i++;
      continue;
    }
    out.push(a);
  }
  return out;
}

const strs = (arg) => (arg?.type === 'list' ? arg.items.map((i) => i.value) : arg?.type === 'string' ? [arg.value] : arg ? [String(arg.value)] : []);

const ASCII_ONLY = 'ascii-only';
const fold = (s, comparator) => (comparator === 'i;octet' ? s : comparator === ASCII_ONLY ? s.replace(/[A-Z]+/g, (m) => m.toLowerCase()) : s.toLowerCase());

function numeric(s) {
  const m = /^\d+/.exec(s);
  return m ? Number(m[0]) : Infinity;
}

function relational(value, key, op, comparator) {
  let a = value;
  let b = key;
  if (comparator === 'i;ascii-numeric') {
    a = numeric(value);
    b = numeric(key);
  } else {
    a = fold(value, comparator);
    b = fold(key, comparator);
  }
  return { gt: a > b, ge: a >= b, lt: a < b, le: a <= b, eq: a === b, ne: a !== b }[op] ?? false;
}

function globToRegExp(glob, comparator) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '\\' && i + 1 < glob.length) re += glob[++i].replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
    else if (c === '*') re += '(.*?)';
    else if (c === '?') re += '(.)';
    else if (comparator === ASCII_ONLY && /[a-z]/i.test(c)) re += `[${c.toLowerCase()}${c.toUpperCase()}]`;
    else re += c.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, comparator === 'i;octet' || comparator === ASCII_ONLY ? 's' : 'is');
}

function parseSize(v) {
  const m = /^(\d+)([KMGkmg]?)$/.exec(String(v));
  if (!m) return 0;
  return Number(m[1]) * ({ k: 1024, m: 1024 ** 2, g: 1024 ** 3 }[m[2].toLowerCase()] ?? 1);
}

/** Integer arithmetic for `set :eval` (+ - * / % and parentheses) without eval, which extension CSP forbids. */
function evalArithmetic(expr) {
  const tokens = expr.match(/\d+|[+\-*/%()]/g) ?? [];
  let i = 0;
  const factor = () => {
    const t = tokens[i++];
    if (t === '(') {
      const v = sum();
      i++; // ')'
      return v;
    }
    if (t === '-') return -factor();
    return Number(t) || 0;
  };
  const product = () => {
    let v = factor();
    while (['*', '/', '%'].includes(tokens[i])) {
      const op = tokens[i++];
      const r = factor();
      v = op === '*' ? v * r : r === 0 ? 0 : op === '/' ? Math.trunc(v / r) : v % r;
    }
    return v;
  };
  const sum = () => {
    let v = product();
    while (tokens[i] === '+' || tokens[i] === '-') v = tokens[i++] === '+' ? v + product() : v - product();
    return v;
  };
  return tokens.length ? sum() : 0;
}

const pad = (n, w = 2) => String(n).padStart(w, '0');

function datePart(date, part, zone) {
  // shift into the requested zone ("+0100") or the runtime's local zone
  let offset = -date.getTimezoneOffset();
  if (typeof zone === 'string' && /^[+-]\d{4}$/.test(zone)) {
    offset = (zone[0] === '-' ? -1 : 1) * (Number(zone.slice(1, 3)) * 60 + Number(zone.slice(3)));
  }
  const d = new Date(date.getTime() + offset * 60000);
  const Y = d.getUTCFullYear();
  const M = pad(d.getUTCMonth() + 1);
  const D = pad(d.getUTCDate());
  const h = pad(d.getUTCHours());
  const m = pad(d.getUTCMinutes());
  const s = pad(d.getUTCSeconds());
  const z = `${offset < 0 ? '-' : '+'}${pad(Math.floor(Math.abs(offset) / 60))}${pad(Math.abs(offset) % 60)}`;
  switch (part.toLowerCase()) {
    case 'year': return String(Y);
    case 'month': return M;
    case 'day': return D;
    case 'date': return `${Y}-${M}-${D}`;
    case 'time': return `${h}:${m}:${s}`;
    case 'hour': return h;
    case 'minute': return m;
    case 'second': return s;
    case 'weekday': return String(d.getUTCDay());
    case 'zone': return z;
    case 'iso8601': return `${Y}-${M}-${D}T${h}:${m}:${s}${z.slice(0, 3)}:${z.slice(3)}`;
    case 'julian': return String(Math.floor(date.getTime() / 86400000) + 40587);
    case 'std11': return date.toUTCString();
    default: return '';
  }
}
