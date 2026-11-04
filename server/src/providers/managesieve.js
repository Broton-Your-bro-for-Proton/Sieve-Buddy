// ManageSieve client (RFC 5804): capabilities, STARTTLS / implicit TLS, SASL PLAIN, and the script commands.
// One connection per operation keeps it simple and robust against server-side timeouts.

import net from 'node:net';
import tls from 'node:tls';

const CRLF = '\r\n';

export class ManageSieveError extends Error {
  constructor(message, { code = null, status = 'NO' } = {}) {
    super(message);
    this.name = 'ManageSieveError';
    this.code = code; // response code, e.g. "NONEXISTENT", "ACTIVE", "QUOTA"
    this.status = status;
  }
}

export const quote = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
const literal = (s) => `{${Buffer.byteLength(s, 'utf8')}+}${CRLF}${s}`;

/** Buffered reader over a socket that can be swapped (for STARTTLS). */
class Reader {
  constructor(socket, timeoutMs) {
    this.buffer = Buffer.alloc(0);
    this.waiters = [];
    this.error = null;
    this.timeoutMs = timeoutMs;
    this.attach(socket);
  }

  attach(socket) {
    this.socket = socket;
    socket.on('data', (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.#wake();
    });
    socket.on('error', (e) => {
      this.error = e;
      this.#wake();
    });
    socket.on('close', () => {
      this.error ??= new ManageSieveError('Verbindung vom Server geschlossen', { status: 'BYE' });
      this.#wake();
    });
  }

  detach() {
    this.socket.removeAllListeners('data');
    this.socket.removeAllListeners('error');
    this.socket.removeAllListeners('close');
  }

  #wake() {
    const waiters = this.waiters;
    this.waiters = [];
    for (const w of waiters) w();
  }

  async #wait() {
    if (this.error) throw this.error;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new ManageSieveError('Zeitüberschreitung beim Warten auf den Server', { status: 'TIMEOUT' })), this.timeoutMs);
      this.waiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
    if (this.error && !this.buffer.length) throw this.error;
  }

  async line() {
    for (;;) {
      const i = this.buffer.indexOf(CRLF);
      if (i !== -1) {
        const line = this.buffer.subarray(0, i).toString('utf8');
        this.buffer = this.buffer.subarray(i + 2);
        return line;
      }
      await this.#wait();
    }
  }

  async bytes(n) {
    while (this.buffer.length < n) await this.#wait();
    const out = this.buffer.subarray(0, n).toString('utf8');
    this.buffer = this.buffer.subarray(n);
    return out;
  }
}

/** Parses one logical response line into items (atoms, strings, literals, parenthesised groups). */
async function readItems(reader) {
  const items = [];
  const stack = [items];
  let line = await reader.line();
  let i = 0;
  for (;;) {
    if (i >= line.length) {
      if (stack.length > 1) {
        line = await reader.line(); // a group may continue after a literal
        i = 0;
        continue;
      }
      return items;
    }
    const c = line[i];
    const top = stack[stack.length - 1];
    if (c === ' ') {
      i++;
    } else if (c === '(') {
      const group = [];
      top.push(group);
      stack.push(group);
      i++;
    } else if (c === ')') {
      stack.pop();
      i++;
    } else if (c === '"') {
      let s = '';
      i++;
      while (i < line.length && line[i] !== '"') {
        if (line[i] === '\\') i++;
        s += line[i++];
      }
      i++;
      top.push({ string: s });
    } else if (c === '{') {
      const m = /^\{(\d+)\+?\}$/.exec(line.slice(i));
      if (!m) throw new ManageSieveError(`Unerwartete Antwort: ${line}`);
      top.push({ string: await reader.bytes(Number(m[1])) });
      line = await reader.line();
      i = 0;
    } else {
      let j = i;
      while (j < line.length && !' ()'.includes(line[j])) j++;
      top.push({ atom: line.slice(i, j) });
      i = j;
    }
  }
}

const text = (item) => item?.string ?? item?.atom ?? '';

/** Reads data lines until OK/NO/BYE. Throws ManageSieveError on NO/BYE. */
async function readResponse(reader) {
  const lines = [];
  for (;;) {
    const items = await readItems(reader);
    const head = items[0]?.atom?.toUpperCase();
    if (head === 'OK' || head === 'NO' || head === 'BYE') {
      let k = 1;
      let code = null;
      if (Array.isArray(items[1])) {
        code = items[1].map(text).join(' ');
        k = 2;
      }
      const message = text(items[k]);
      if (head !== 'OK') throw new ManageSieveError(message || head, { code, status: head });
      return { lines, code, message };
    }
    lines.push(items);
  }
}

function parseCapabilities(lines) {
  const caps = {};
  for (const items of lines) caps[text(items[0]).toUpperCase()] = items[1] === undefined ? true : text(items[1]);
  return {
    implementation: caps.IMPLEMENTATION ?? null,
    sieve: String(caps.SIEVE ?? '').split(/\s+/).filter(Boolean),
    sasl: String(caps.SASL ?? '').split(/\s+/).filter(Boolean),
    starttls: caps.STARTTLS === true || caps.STARTTLS === '',
    version: caps.VERSION ?? null,
    raw: caps,
  };
}

export class ManageSieveConnection {
  /**
   * @param {{host: string, port?: number, tls?: 'starttls'|'tls'|'none', rejectUnauthorized?: boolean, timeoutMs?: number}} options
   */
  static async open({ host, port = 4190, tls: mode = 'starttls', rejectUnauthorized = true, timeoutMs = 15_000 }) {
    const socket = await new Promise((resolve, reject) => {
      const s = mode === 'tls' ? tls.connect({ host, port, servername: host, rejectUnauthorized }) : net.connect({ host, port });
      s.setTimeout(timeoutMs, () => s.destroy(new ManageSieveError('Zeitüberschreitung beim Verbinden', { status: 'TIMEOUT' })));
      s.once(mode === 'tls' ? 'secureConnect' : 'connect', () => resolve(s));
      s.once('error', reject);
    });
    const conn = new ManageSieveConnection(socket, timeoutMs);
    conn.capabilities = parseCapabilities((await readResponse(conn.reader)).lines);
    if (mode === 'starttls') {
      if (!conn.capabilities.starttls) throw new ManageSieveError('Server bietet kein STARTTLS an (MANAGESIEVE_TLS=none nur im eigenen Netz verwenden)');
      await conn.command('STARTTLS');
      conn.reader.detach();
      const secure = await new Promise((resolve, reject) => {
        const s = tls.connect({ socket, servername: host, rejectUnauthorized }, () => resolve(s));
        s.once('error', reject);
      });
      conn.socket = secure;
      conn.reader.attach(secure);
      // RFC 5804: the server sends its capabilities again after STARTTLS
      conn.capabilities = parseCapabilities((await readResponse(conn.reader)).lines);
    }
    return conn;
  }

  constructor(socket, timeoutMs) {
    this.socket = socket;
    this.reader = new Reader(socket, timeoutMs);
    this.capabilities = null;
  }

  async command(line) {
    this.socket.write(line + CRLF);
    return readResponse(this.reader);
  }

  async authenticate(user, password) {
    if (!this.capabilities.sasl.map((m) => m.toUpperCase()).includes('PLAIN')) {
      throw new ManageSieveError(`Server bietet SASL PLAIN nicht an (angeboten: ${this.capabilities.sasl.join(', ') || 'nichts'})`);
    }
    const token = Buffer.from(`\0${user}\0${password}`, 'utf8').toString('base64');
    const result = await this.command(`AUTHENTICATE "PLAIN" ${quote(token)}`);
    // some servers send updated capabilities after authentication
    if (result.lines.length) this.capabilities = parseCapabilities(result.lines);
    return result;
  }

  async listScripts() {
    const { lines } = await this.command('LISTSCRIPTS');
    return lines.map((items) => ({ name: text(items[0]), active: text(items[1]).toUpperCase() === 'ACTIVE' }));
  }

  async getScript(name) {
    const { lines } = await this.command(`GETSCRIPT ${quote(name)}`);
    return text(lines[0]?.[0]);
  }

  putScript(name, script) {
    return this.command(`PUTSCRIPT ${quote(name)} ${literal(script)}`);
  }

  checkScript(script) {
    return this.command(`CHECKSCRIPT ${literal(script)}`);
  }

  setActive(name) {
    return this.command(`SETACTIVE ${quote(name)}`);
  }

  deleteScript(name) {
    return this.command(`DELETESCRIPT ${quote(name)}`);
  }

  renameScript(from, to) {
    return this.command(`RENAMESCRIPT ${quote(from)} ${quote(to)}`);
  }

  async logout() {
    try {
      await this.command('LOGOUT');
    } catch {
      // the server may close the connection right away
    } finally {
      this.socket.destroy();
    }
  }
}
