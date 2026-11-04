// HTTP entry point: web UI (login), REST API under /api and the MCP endpoint under /mcp.
// Everything except /health and the UI page itself requires `Authorization: Bearer <API_TOKEN>`.

import { timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

import { Account } from './account.js';
import { loadConfig } from './config.js';
import { createMcpServer } from './mcp.js';
import * as ops from './ops.js';

const MAX_BODY = 1024 * 1024;

// REST names → operations (same as the MCP tools)
const OPERATIONS = {
  'list-filters': ops.listFilters,
  'get-filter': ops.getFilter,
  'list-folders': ops.listFolders,
  capabilities: ops.capabilities,
  lint: ops.lintSieve,
  check: ops.checkSieve,
  format: ops.formatSieve,
  simulate: ops.simulateMessage,
  suggest: ops.suggestRule,
  'plan-rule': ops.planRule,
  'apply-rule': ops.applyRule,
  templates: ops.listTemplates,
  'plan-template': ops.buildTemplate,
  'apply-template': ops.applyTemplate,
  'create-filter': ops.createFilter,
  'update-filter': ops.updateFilter,
  'set-filter-enabled': ops.setFilterEnabled,
  'reorder-filters': ops.reorderFilters,
  'delete-filter': ops.deleteFilter,
};

export async function startServer(config = loadConfig()) {
  const account = new Account(config);
  await account.init();
  const ui = await readFile(fileURLToPath(new URL('./ui.html', import.meta.url)), 'utf8');
  const expected = Buffer.from(`Bearer ${config.apiToken}`);

  const authorized = (req) => {
    const given = Buffer.from(req.headers.authorization ?? '');
    return given.length === expected.length && timingSafeEqual(given, expected);
  };

  const send = (res, status, body, type = 'application/json; charset=utf-8') => {
    res.writeHead(status, {
      'Content-Type': type,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  };

  const readBody = (req) =>
    new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > MAX_BODY) {
          reject(Object.assign(new Error('Anfrage zu groß'), { status: 413 }));
          req.destroy();
        } else chunks.push(c);
      });
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        try {
          resolve(raw ? JSON.parse(raw) : {});
        } catch {
          reject(Object.assign(new Error('Ungültiges JSON'), { status: 400 }));
        }
      });
      req.on('error', reject);
    });

  async function handleMcp(req, res) {
    if (req.method !== 'POST') return send(res, 405, { error: 'Nur POST (zustandsloses Streamable HTTP)' });
    const body = await readBody(req);
    const server = createMcpServer(account);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  }

  async function handleApi(req, res, path) {
    if (path === '/api/status' && req.method === 'GET') return send(res, 200, await account.status());
    if (req.method !== 'POST') return send(res, 405, { error: 'Methode nicht erlaubt' });
    const body = await readBody(req);
    switch (path) {
      case '/api/login':
        return send(res, 200, await account.login(String(body.username ?? ''), String(body.password ?? '')));
      case '/api/login/totp':
        return send(res, 200, await account.submitTotp(String(body.code ?? '')));
      case '/api/login/continue':
        return send(res, 200, await account.continueAfterCaptcha());
      case '/api/session/import':
        return send(res, 200, await account.importSession(body));
      case '/api/login/reset-guard':
        if (!account.guard) return send(res, 404, { error: 'Nur bei PROVIDER=proton' });
        await account.guard.reset();
        return send(res, 200, await account.status());
      case '/api/logout':
        await account.logout();
        return send(res, 200, { ok: true });
      default: {
        const op = OPERATIONS[path.replace(/^\/api\/ops\//, '')];
        if (!path.startsWith('/api/ops/') || !op) return send(res, 404, { error: 'Unbekannte Operation' });
        return send(res, 200, await op(account, body));
      }
    }
  }

  const server = createServer(async (req, res) => {
    const path = new URL(req.url, 'http://local').pathname;
    // the Thunderbird add-on hands its session over from a moz-extension:// page
    const origin = req.headers.origin ?? '';
    const allowedOrigin = origin.startsWith('moz-extension://') || config.corsOrigins?.includes(origin);
    // the add-on (moz-extension://) talks to the whole API when it works through the service
    if (allowedOrigin && path.startsWith('/api/')) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST');
      res.setHeader('Access-Control-Max-Age', '600');
      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        return res.end();
      }
    }
    try {
      if (path === '/health') return send(res, 200, { ok: true, provider: account.kind, loggedIn: account.provider.isReady });
      if (path === '/' && req.method === 'GET') return send(res, 200, ui, 'text/html; charset=utf-8');
      if (!authorized(req)) return send(res, 401, { error: 'Bearer-Token fehlt oder ist falsch' });
      if (path === '/mcp') return await handleMcp(req, res);
      if (path.startsWith('/api/')) return await handleApi(req, res, path);
      return send(res, 404, { error: 'Nicht gefunden' });
    } catch (error) {
      if (res.headersSent) return;
      // Proton's own status codes are not passed through: a Proton 401 must not look like a wrong API token
      const fromProton = error.name === 'ProtonApiError';
      const status = fromProton ? (error.status >= 500 ? 502 : 400) : (error.status ?? 400);
      send(res, status, {
        error: error.message,
        ...(fromProton ? { proton: { status: error.status ?? null, code: error.code ?? null } } : {}),
        ...(error.issues ? { issues: error.issues } : {}),
      });
    }
  });

  await new Promise((resolve) => server.listen(config.port, config.host, resolve));
  const { port } = server.address();
  console.log(`Sieve-Dienst (${account.kind}) läuft auf http://${config.host}:${port} (MCP: /mcp)`);
  return { server, account, port };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  startServer();
}
