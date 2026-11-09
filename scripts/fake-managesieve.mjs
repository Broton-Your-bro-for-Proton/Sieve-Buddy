// A small ManageSieve server (RFC 5804) for tests: SASL PLAIN, LISTSCRIPTS, GETSCRIPT, PUTSCRIPT (literals),
// CHECKSCRIPT (validated with the RFC dialect of our linter), SETACTIVE, DELETESCRIPT, RENAMESCRIPT, LOGOUT.
// No TLS – for real TLS/STARTTLS the Dovecot test container is used.

import net from 'node:net';
import { fileURLToPath } from 'node:url';

import { lintSieve } from '../addon/lib/sieve-analyzer.js';
import { makeDialect } from '../addon/lib/sieve-dialect.js';

export const FAKE_SIEVE_EXTENSIONS = ['fileinto', 'reject', 'envelope', 'vacation', 'imap4flags', 'copy', 'include', 'variables', 'body', 'relational', 'comparator-i;ascii-numeric', 'regex', 'mailbox', 'date', 'subaddress'];

const q = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

export function createFakeManageSieve({ user = 'test', password = 'test123', scripts = {}, active = null, checkscript = true } = {}) {
  const state = { scripts: new Map(Object.entries(scripts)), active, commands: [] };
  const dialect = makeDialect({ name: 'rfc', extensions: FAKE_SIEVE_EXTENSIONS });

  const server = net.createServer((socket) => {
    let buffer = Buffer.alloc(0);
    let authed = false;
    let pendingLiteral = null; // {n, head}
    const send = (s) => socket.write(s);
    const caps = () =>
      [
        `"IMPLEMENTATION" "Fake ManageSieve"`,
        `"SIEVE" ${q(FAKE_SIEVE_EXTENSIONS.join(' '))}`,
        `"SASL" "PLAIN"`,
        ...(checkscript ? [`"VERSION" "1.0"`] : []),
        `OK "ready"`,
      ].join('\r\n') + '\r\n';
    send(caps());

    const args = (rest) => {
      const out = [];
      const re = /"((?:[^"\\]|\\.)*)"/g;
      let m;
      while ((m = re.exec(rest))) out.push(m[1].replace(/\\(.)/g, '$1'));
      return out;
    };

    const handle = (line, literal) => {
      const [cmd] = line.split(' ', 1);
      const rest = line.slice(cmd.length);
      const a = args(rest);
      state.commands.push(cmd.toUpperCase());
      switch (cmd.toUpperCase()) {
        case 'AUTHENTICATE': {
          const [, u, p] = Buffer.from(a[1] ?? '', 'base64').toString('utf8').split('\0');
          if (u === user && p === password) {
            authed = true;
            return send('OK "Logged in."\r\n');
          }
          return send('NO "Authentication failed."\r\n');
        }
        case 'LOGOUT':
          send('OK "Bye."\r\n');
          return socket.end();
        case 'CAPABILITY':
          return send(caps());
      }
      if (!authed) return send('NO "Not authenticated"\r\n');
      switch (cmd.toUpperCase()) {
        case 'LISTSCRIPTS':
          return send([...state.scripts.keys()].map((n) => `${q(n)}${n === state.active ? ' ACTIVE' : ''}`).concat('OK "Listscripts completed."').join('\r\n') + '\r\n');
        case 'GETSCRIPT': {
          const body = state.scripts.get(a[0]);
          if (body === undefined) return send('NO (NONEXISTENT) "Script does not exist."\r\n');
          return send(`{${Buffer.byteLength(body)}}\r\n${body}\r\nOK "Getscript completed."\r\n`);
        }
        case 'PUTSCRIPT':
        case 'CHECKSCRIPT': {
          const errors = lintSieve(literal, { dialect }).filter((i) => i.severity === 'error' || i.message.startsWith('Unknown command')); // a real server rejects commands it does not know
          if (errors.length) {
            const lineNo = literal.slice(0, errors[0].start).split('\n').length;
            return send(`NO ${q(`line ${lineNo}: error: ${errors[0].message}`)}\r\n`);
          }
          if (cmd.toUpperCase() === 'PUTSCRIPT') state.scripts.set(a[0], literal);
          return send('OK "Script valid."\r\n');
        }
        case 'SETACTIVE':
          if (a[0] && !state.scripts.has(a[0])) return send('NO (NONEXISTENT) "Script does not exist."\r\n');
          state.active = a[0] || null;
          return send('OK "Setactive completed."\r\n');
        case 'DELETESCRIPT':
          if (!state.scripts.has(a[0])) return send('NO (NONEXISTENT) "Script does not exist."\r\n');
          if (state.active === a[0]) return send('NO (ACTIVE) "Cannot delete active script."\r\n');
          state.scripts.delete(a[0]);
          return send('OK "Deletescript completed."\r\n');
        case 'RENAMESCRIPT': {
          if (!state.scripts.has(a[0])) return send('NO (NONEXISTENT) "Script does not exist."\r\n');
          state.scripts.set(a[1], state.scripts.get(a[0]));
          state.scripts.delete(a[0]);
          if (state.active === a[0]) state.active = a[1];
          return send('OK "Renamescript completed."\r\n');
        }
        default:
          return send('NO "Unknown command"\r\n');
      }
    };

    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        if (pendingLiteral) {
          if (buffer.length < pendingLiteral.n + 2) return;
          const literal = buffer.subarray(0, pendingLiteral.n).toString('utf8');
          buffer = buffer.subarray(pendingLiteral.n + 2); // literal + CRLF
          const head = pendingLiteral.head;
          pendingLiteral = null;
          handle(head, literal);
          continue;
        }
        const i = buffer.indexOf('\r\n');
        if (i === -1) return;
        const line = buffer.subarray(0, i).toString('utf8');
        buffer = buffer.subarray(i + 2);
        const lit = /\{(\d+)\+?\}$/.exec(line);
        if (lit) pendingLiteral = { n: Number(lit[1]), head: line.slice(0, lit.index).trim() };
        else handle(line, '');
      }
    });
    socket.on('error', () => {});
  });

  return {
    state,
    server,
    async listen(port = 0, host = '127.0.0.1') {
      await new Promise((r) => server.listen(port, host, r));
      return server.address().port;
    },
    close: () => new Promise((r) => server.close(r)),
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const fake = createFakeManageSieve({
    scripts: { main: 'require ["fileinto"];\n\nif address :domain :is "from" ["amazon.de"] {\n    fileinto "Shop";\n}\n' },
    active: 'main',
  });
  const port = await fake.listen(Number(process.env.PORT ?? 4190), process.env.HOST ?? '127.0.0.1');
  console.log(`Fake ManageSieve on 127.0.0.1:${port} (user test / test123)`);
}
