// Minimal IMAP client that only lists folders (LOGIN + LIST), so fileinto targets can be offered and checked
// for ManageSieve servers – ManageSieve itself knows nothing about mailboxes.

import net from 'node:net';
import tls from 'node:tls';
import { t } from '../../../addon/lib/i18n.js';

/** Decodes IMAP's modified UTF-7 (RFC 3501 §5.1.3): "Entw&APw-rfe" → "Entwürfe". */
export function decodeModifiedUtf7(name) {
  return name.replace(/&([^-]*)-/g, (_, b64) => {
    if (!b64) return '&';
    const bytes = Buffer.from(b64.replace(/,/g, '/'), 'base64');
    let out = '';
    for (let i = 0; i + 1 < bytes.length; i += 2) out += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]);
    return out;
  });
}

// only for printable ASCII: anything else goes as a literal (see login below)
const quote = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
const plain = (s) => /^[\x20-\x7e]*$/.test(s);

/**
 * @param {{host: string, port?: number, tls?: 'tls'|'starttls'|'none', user: string, password: string, rejectUnauthorized?: boolean, timeoutMs?: number}} o
 * @returns {Promise<string[]>} selectable folder names (decoded), as Sieve's fileinto expects them
 */
export async function listImapFolders({ host, port, tls: mode = 'tls', user, password, rejectUnauthorized = true, timeoutMs = 15_000 }) {
  port ??= mode === 'tls' ? 993 : 143;
  let socket = await new Promise((resolve, reject) => {
    const s = mode === 'tls' ? tls.connect({ host, port, servername: host, rejectUnauthorized }) : net.connect({ host, port });
    s.setTimeout(timeoutMs, () => s.destroy(new Error(t('IMAP: Zeitüberschreitung'))));
    s.once(mode === 'tls' ? 'secureConnect' : 'connect', () => resolve(s));
    s.once('error', reject);
  });

  let buffer = '';
  let waiting = null;
  const onData = (chunk) => {
    buffer += chunk.toString('utf8');
    waiting?.();
  };
  socket.on('data', onData);
  const until = (predicate) =>
    new Promise((resolve, reject) => {
      const check = () => {
        const result = predicate(buffer);
        if (result) {
          waiting = null;
          resolve(result);
        }
      };
      const timer = setTimeout(() => reject(new Error(t('IMAP: Zeitüberschreitung'))), timeoutMs);
      waiting = () => {
        try {
          check();
        } catch (e) {
          reject(e);
        }
        if (!waiting) clearTimeout(timer);
      };
      socket.once('error', reject);
      check();
    });

  let tagNo = 0;
  // `literals` are sent one by one, each after the server's "+" continuation (synchronizing literals)
  const run = async (command, literals = []) => {
    const tag = `a${++tagNo}`;
    const start = buffer.length;
    const tagged = (b) => {
      const m = new RegExp(`(^|\\r\\n)${tag} (OK|NO|BAD)([^\\r\\n]*)\\r\\n`).exec(b.slice(start));
      return m ? { status: m[2], text: m[3].trim(), body: b.slice(start, start + m.index) } : null;
    };
    socket.write(`${tag} ${command}\r\n`);
    for (const part of literals) {
      const from = buffer.length;
      await until((b) => tagged(b) || /(^|\r\n)\+[^\r\n]*\r\n/.test(b.slice(from)));
      if (tagged(buffer)) break;
      socket.write(part);
    }
    const done = await until(tagged);
    if (done.status !== 'OK') throw new Error(`IMAP ${command.split(' ')[0]}: ${done.text}`);
    return done.body;
  };

  try {
    await until((b) => /^\* (OK|PREAUTH)[^\r\n]*\r\n/.test(b));
    if (mode === 'starttls') {
      await run('STARTTLS');
      socket.removeListener('data', onData);
      socket = await new Promise((resolve, reject) => {
        const s = tls.connect({ socket, servername: host, rejectUnauthorized }, () => resolve(s));
        s.once('error', reject);
      });
      buffer = '';
      socket.on('data', onData);
    }
    if (plain(user) && plain(password)) await run(`LOGIN ${quote(user)} ${quote(password)}`);
    // umlauts or control characters are not allowed in a quoted string
    else await run(`LOGIN {${Buffer.byteLength(user)}}`, [`${user} {${Buffer.byteLength(password)}}\r\n`, `${password}\r\n`]);
    const body = await run('LIST "" "*"');
    const folders = [];
    const re = /^\* LIST \(([^)]*)\) (?:NIL|"(?:[^"\\]|\\.)*") (?:"((?:[^"\\]|\\.)*)"|\{(\d+)\}\r\n|(\S+))/gm;
    let m;
    while ((m = re.exec(body))) {
      let name = m[2] !== undefined ? m[2].replace(/\\(.)/g, '$1') : m[4];
      if (m[3]) {
        const start = m.index + m[0].length;
        name = body.slice(start, start + Number(m[3]));
      }
      if (/\\Noselect|\\NonExistent/i.test(m[1])) continue;
      folders.push(decodeModifiedUtf7(name));
    }
    await run('LOGOUT').catch(() => {});
    return folders;
  } finally {
    socket.destroy();
  }
}
