// A small JMAP server with JMAP for Sieve (RFC 9661) for tests: session resource with relative URLs (like
// Stalwart, reached through a redirect), Bearer or Basic auth (user "test"), blob upload/download, SieveScript/get, SieveScript/set (incl. onSuccessActivateScript and
// onSuccessDeactivateScript), SieveScript/validate (with the RFC dialect of our linter) and Mailbox/get.

import http from 'node:http';
import { fileURLToPath } from 'node:url';

import { lintSieve } from '../addon/lib/sieve-analyzer.js';
import { makeDialect } from '../addon/lib/sieve-dialect.js';
import { FAKE_SIEVE_EXTENSIONS } from './fake-managesieve.mjs';

const SIEVE = 'urn:ietf:params:jmap:sieve';
const ACCOUNT = 'a1';

export function createFakeJmap({ token = 'jmap-test-token', scripts = {}, active = null, validate = true, mailboxes = ['Shop', 'Archive/2026'] } = {}) {
  const dialect = makeDialect({ name: 'rfc', extensions: FAKE_SIEVE_EXTENSIONS });
  const blobs = new Map();
  let nextId = 1;
  const newId = (prefix) => `${prefix}${nextId++}`;
  const putBlob = (text) => {
    const id = newId('B');
    blobs.set(id, text);
    return id;
  };
  // state.scripts: id → {id, name, blobId, isActive}
  const state = { scripts: new Map(), calls: [], blobs };
  for (const [name, text] of Object.entries(scripts)) {
    const id = newId('S');
    state.scripts.set(id, { id, name, blobId: putBlob(text), isActive: name === active });
  }
  state.text = (name) => blobs.get([...state.scripts.values()].find((s) => s.name === name)?.blobId);
  state.active = () => [...state.scripts.values()].find((s) => s.isActive)?.name ?? null;

  const invalid = (text) => {
    const errors = lintSieve(text, { dialect }).filter((i) => i.severity === 'error');
    if (!errors.length) return null;
    const line = text.slice(0, errors[0].start).split('\n').length;
    return { type: 'invalidSieve', description: `${errors[0].message} at line ${line}, column 1.` };
  };
  const activate = (id) => {
    for (const s of state.scripts.values()) s.isActive = s.id === id;
  };

  const folders = new Map([['m0', { id: 'm0', name: 'Inbox', parentId: null, role: 'inbox' }]]);
  for (const path of mailboxes) {
    let parentId = null;
    for (const name of path.split('/')) {
      const found = [...folders.values()].find((m) => m.name === name && m.parentId === parentId);
      const id = found?.id ?? `m${folders.size}`;
      if (!found) folders.set(id, { id, name, parentId, role: null });
      parentId = id;
    }
  }

  function set(args) {
    const r = { accountId: ACCOUNT, created: {}, updated: {}, destroyed: [], notCreated: {}, notUpdated: {}, notDestroyed: {} };
    const created = {};
    const nameTaken = (name, except) => [...state.scripts.values()].some((s) => s.name === name && s.id !== except);
    for (const [cid, { name, blobId }] of Object.entries(args.create ?? {})) {
      const error = !blobs.has(blobId) ? { type: 'blobNotFound' } : nameTaken(name) ? { type: 'alreadyExists' } : invalid(blobs.get(blobId));
      if (error) r.notCreated[cid] = error;
      else {
        const id = newId('S');
        state.scripts.set(id, { id, name, blobId, isActive: false });
        r.created[cid] = (created[`#${cid}`] = { id, blobId });
      }
    }
    for (const [id, patch] of Object.entries(args.update ?? {})) {
      const s = state.scripts.get(id);
      const error = !s ? { type: 'notFound' } : patch.name && nameTaken(patch.name, id) ? { type: 'alreadyExists' } : patch.blobId && invalid(blobs.get(patch.blobId));
      if (error) r.notUpdated[id] = error;
      else {
        Object.assign(s, patch);
        r.updated[id] = null;
      }
    }
    for (const id of args.destroy ?? []) {
      const s = state.scripts.get(id);
      if (!s) r.notDestroyed[id] = { type: 'notFound' };
      else if (s.isActive) r.notDestroyed[id] = { type: 'scriptIsActive' };
      else {
        state.scripts.delete(id);
        r.destroyed.push(id);
      }
    }
    // RFC 9661: both run only after all creates, updates and destroys
    const failed = [r.notCreated, r.notUpdated, r.notDestroyed].some((g) => Object.keys(g).length);
    const target = created[args.onSuccessActivateScript]?.id ?? args.onSuccessActivateScript;
    if (failed) return r;
    if (args.onSuccessActivateScript && state.scripts.has(target)) activate(target);
    else if (args.onSuccessDeactivateScript) activate(null);
    return r;
  }

  const methods = {
    'SieveScript/get': () => ({ accountId: ACCOUNT, list: [...state.scripts.values()].map((s) => ({ ...s })), notFound: [] }),
    'SieveScript/set': set,
    'SieveScript/validate': (args) => {
      if (!validate) return null;
      return { accountId: ACCOUNT, error: invalid(blobs.get(args.blobId) ?? '') };
    },
    'Mailbox/get': () => ({ accountId: ACCOUNT, list: [...folders.values()], notFound: [] }),
  };

  const json = (res, status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks).toString('utf8');
    const basic = `Basic ${Buffer.from(`test:${token}`).toString('base64')}`;
    if (![`Bearer ${token}`, basic].includes(req.headers.authorization)) return json(res, 401, { type: 'about:blank', status: 401, detail: 'Unauthorized' });
    const path = new URL(req.url, 'http://x').pathname;

    if (req.method === 'GET' && path === '/.well-known/jmap') {
      res.writeHead(307, { Location: '/jmap/session' });
      return res.end();
    }
    if (req.method === 'GET' && path === '/jmap/session') {
      return json(res, 200, {
        capabilities: { 'urn:ietf:params:jmap:core': {}, 'urn:ietf:params:jmap:mail': {}, [SIEVE]: { implementation: 'Fake JMAP' } },
        accounts: { [ACCOUNT]: { name: 'test', accountCapabilities: { [SIEVE]: { sieveExtensions: FAKE_SIEVE_EXTENSIONS }, 'urn:ietf:params:jmap:mail': {} } } },
        primaryAccounts: { [SIEVE]: ACCOUNT, 'urn:ietf:params:jmap:mail': ACCOUNT },
        username: 'test',
        apiUrl: '/jmap/',
        uploadUrl: '/jmap/upload/{accountId}/',
        downloadUrl: '/jmap/download/{accountId}/{blobId}/{name}?accept={type}',
        state: '1',
      });
    }
    if (req.method === 'POST' && path === `/jmap/upload/${ACCOUNT}/`) {
      return json(res, 200, { accountId: ACCOUNT, blobId: putBlob(body), type: req.headers['content-type'], size: Buffer.byteLength(body) });
    }
    const download = /^\/jmap\/download\/([^/]+)\/([^/]+)\//.exec(path);
    if (req.method === 'GET' && download) {
      if (!blobs.has(download[2])) return json(res, 404, { status: 404 });
      res.writeHead(200, { 'Content-Type': 'application/sieve; charset=utf-8' });
      return res.end(blobs.get(download[2]));
    }
    if (req.method === 'POST' && path === '/jmap/') {
      const { using, methodCalls } = JSON.parse(body);
      const methodResponses = methodCalls.map(([name, args, id]) => {
        state.calls.push(name);
        if (!using.includes(name.startsWith('Mailbox/') ? 'urn:ietf:params:jmap:mail' : SIEVE)) return ['error', { type: 'unknownMethod' }, id];
        const r = methods[name]?.(args);
        return r ? [name, r, id] : ['error', { type: 'unknownMethod' }, id];
      });
      return json(res, 200, { methodResponses, sessionState: '1' });
    }
    json(res, 404, { status: 404 });
  });

  return {
    state,
    server,
    token,
    async listen(port = 0, host = '127.0.0.1') {
      await new Promise((r) => server.listen(port, host, r));
      return server.address().port;
    },
    close: () => new Promise((r) => server.close(r)),
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const fake = createFakeJmap({
    scripts: { main: 'require ["fileinto"];\n\nif address :domain :is "from" ["amazon.de"] {\n    fileinto "Shop";\n}\n' },
    active: 'main',
  });
  const port = await fake.listen(Number(process.env.PORT ?? 18090), process.env.HOST ?? '127.0.0.1');
  console.log(`Fake JMAP on http://127.0.0.1:${port}/.well-known/jmap (Bearer ${fake.token})`);
}
