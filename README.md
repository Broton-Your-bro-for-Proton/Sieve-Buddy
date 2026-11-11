<p align="center"><img src="addon/icons/icon.svg" alt="icon" width="128"></p>

# Sieve Buddy: Sieve filters for Proton and every ManageSieve server

**Sieve filters for Proton and every ManageSieve or JMAP server, from Thunderbird or over MCP.**

![Thunderbird](https://img.shields.io/badge/Thunderbird-115%2B-0A84FF)
![Proton](https://img.shields.io/badge/Proton-supported-6D4AFF)
![ManageSieve](https://img.shields.io/badge/ManageSieve-RFC%205804-2EA44F)
![JMAP](https://img.shields.io/badge/JMAP-RFC%209661-2EA44F)
![MCP](https://img.shields.io/badge/MCP-server-555555)
![Status](https://img.shields.io/badge/Status-test%20version-orange)

Manage Sieve filters comfortably, without signing in to webmail every time. Supported are **Proton Mail**, **every mail server with ManageSieve** (RFC 5804), such as Dovecot/Pigeonhole, Stalwart, Cyrus, Mailcow, Mailu, mailbox.org or Uberspace, and **JMAP for Sieve** (RFC 9661, for example Stalwart).

- **Thunderbird add-on:** Sieve editor that knows the server's dialect, "rule from mail" in two clicks, simulator, rule assistant, history
- **Docker service:** REST API and **MCP server**, for example for Inbox Zero or Claude

Both share the same core (`addon/lib/`).

**Languages:** The UI is available in English and German. The add-on follows Thunderbird's language, the service follows `LOCALE` (`en` or `de`, default `en`). English is the source language, German lives in `addon/lib/locales/de.js`. `npm test` checks new texts (`scripts/i18n-check.mjs` lists missing translations).

```
Thunderbird add-on ──┬─ directly ───────────────────────────▶ Proton (unofficial web API)
                     └─ via the service ─┐
Inbox Zero / Claude ── MCP ──────────────┤
                                         ▼
                                  Docker service ──▶ Proton, ManageSieve server (+ IMAP for folders) or JMAP server
```

> [!WARNING]
> **Proton:** There is no official API for filters. Access uses the same web API as Proton's own web client, and Proton can change it at any time or block unknown programs (see [Protection against account locks](#-protection-against-account-locks)). **ManageSieve**, in contrast, is an official standard, so this risk does not exist there.

## 🧩 Thunderbird add-on

### Features

- **Connection:** directly with Proton (SRP login with TOTP; captcha via verify.proton.me like the Bridge) **or via your own service**, then also for ManageSieve servers.
- **Manage filters and scripts:** create, edit, delete and activate, on Proton also reorder. Before saving, a **diff** shows what changes, and earlier versions are kept in the **history**.
- **Editor that knows the server's dialect:**
  - Syntax highlighting and **suggestions** for commands, tags and the extensions the server offers, plus headers, your **folders and labels**, flags and date parts
  - **Live check**: missing `require`, `;`, brackets, extensions the server does not support, unknown folders. Proton pitfalls (`keep`, `discard`, flags after `fileinto`, spam guard) only apply to Proton.
  - In addition **the server itself** checks: Proton, or `CHECKSCRIPT` via ManageSieve.
  - **Hover help**, **outline**, **formatter**, "Complete require"
  - **Warnings on overlaps:** the same value in two blocks (duplicate or with a different action) and addresses that a domain rule already covers
- **One large file with sections:** comment headings such as `### Shops ###` or a title between `# =====` lines structure a script into sections (without decorated headings, every comment above a rule counts).
  - The **outline** shows the rules per section. ↑/↓ moves a rule, across a heading into the neighboring section, ✕ deletes it. A comment directly above the rule moves along.
  - **Suggest sections** inserts one heading per group of rules with the same target folder into a file without headings, without reordering rules.
- **✨ Rule assistant:** 16 templates, including domains, mailing lists, invoices, shops, GitHub, monitoring, out of office and contact protection. New values are **merged into matching blocks**, new blocks land in the matching section (the template's category helps with the choice). Templates that only exist on Proton are hidden for other servers.
- **Test mail:** The simulator shows where a mail ends up, with Proton's behavior or according to **RFC 5228** (implicit `keep`, `fileinto` as a copy, `:copy`, `redirect`). The RFC mode is **verified against real Dovecot delivery**.
- **Sieve rule from mail:** button in the message view or right-click in the message list.
  - Conditions are suggested: list, sender, domain, alias, subject without numbers.
  - The rule lands in the **best place**. Extending an existing block is preferred: join the list, extend `anyof` or convert to `anyof`. Otherwise a new block is created.
  - The **simulator checks** whether the mail really ends up there afterwards. If an earlier block catches it, the rule is placed before that block, with `stop` if needed.
  - If there is only one active script, the window does not ask for the filter but for the **section**: automatic, a specific one, end of the file or a new one. Automatic means: the section whose rules do the same or move into the same folder, otherwise the one whose title matches the folder. Values still prefer to join an existing list.
  - If a later block would move the mail elsewhere, the new rule in its section ends with `stop`.
  - A click on a rule under "Currently" opens it in the manager.
  - You see the diff and conflicts and save with one click.

### Installation (development)

```bash
npm install
npm run vendor   # CodeMirror and bcryptjs into addon/vendor
npm test         # core tests
npm run build    # dist/*.zip (installable as .xpi)
```

In Thunderbird: menu ☰ → **Add-ons and Themes** → gear ⚙ → **Debug Add-ons** → "Load Temporary Add-on" → `addon/manifest.json`. For an update click **"Reload"** there instead of removing it, otherwise the sign-in is gone.

## 🐳 Docker service with MCP

```bash
cp .env.example .env          # set API_TOKEN (e.g. openssl rand -hex 32), choose PROVIDER
docker compose up -d --build
```

Then open `http://localhost:8080` and enter the API token. The web UI shows the status and the MCP configuration.

### With a ManageSieve server

```env
PROVIDER=managesieve
MANAGESIEVE_HOST=mail.example.com
# MANAGESIEVE_USER=me@example.com   # optional: without user and password, enter them in the web UI
# MANAGESIEVE_PASSWORD=…            # or MANAGESIEVE_PASSWORD_FILE=/run/secrets/sieve
# MANAGESIEVE_TLS=starttls      # default; tls or none (none only in your own network)
# MANAGESIEVE_SASL=auto         # default: SCRAM when the server offers it, else PLAIN; plain if SCRAM fails with the right password
# IMAP_HOST=…                   # folder list via IMAP (default: same host, 993/TLS); empty IMAP_HOST= turns it off
```

The service adopts the server's capabilities, that is the extensions it reports under `SIEVE`. With ManageSieve **exactly one script is active** at any time:
- Only the active one is planned and simulated.
- New scripts stay inactive unless something else is requested.
- There is no ordering.

### With a JMAP server (JMAP for Sieve)

```env
PROVIDER=jmap
JMAP_URL=https://mail.example.com/.well-known/jmap
# JMAP_TOKEN=…                  # or JMAP_TOKEN_FILE=/run/secrets/jmap; optional, see below
# JMAP_USER=me@example.com      # set: user + token as password (Basic, e.g. app password); empty: bearer token
```

**Credentials without a configuration file:** leave out the user and the password (or token), open the web UI and enter them there. The service signs in once to test them, then stores them AES-256-GCM encrypted in its data volume, with `SESSION_SECRET` as the key. "Remove credentials" deletes them. Credentials set in the configuration always win and cannot be changed in the web UI.

The server must offer `urn:ietf:params:jmap:sieve` (RFC 9661). As of November 2026 **Stalwart** does so by default, also for regular users. Cyrus IMAP ships it, provided the operator has enabled JMAP. Fastmail does not open it to API tokens, Apache James uses its own filter extension instead of RFC 9661. Scripts are managed via `SieveScript/get`/`set` and blob upload/download and checked with `SieveScript/validate` before saving. The folder list comes from `Mailbox/get`, IMAP is not needed. As with ManageSieve, **exactly one script is active**.

### With Proton

```env
PROVIDER=proton
```

The service does **not sign in** to Proton itself. Instead you sign in to the Thunderbird add-on and click **"Hand over to service"** there (address and API token of the service). The service takes over the session, and the add-on then keeps working through the service. The session is stored in `/data`, encrypted with AES-256-GCM. A password login directly in the service is only possible with `ALLOW_PASSWORD_LOGIN=true` (not recommended, see below).

### Variables

| Variable | Meaning |
|---|---|
| `API_TOKEN` | **Required.** Bearer token for web UI, REST and MCP (≥ 24 characters) |
| `PROVIDER` | `proton` (default), `managesieve` or `jmap` |
| `LOCALE` | language of web UI, messages, MCP descriptions and template defaults (folder names, out-of-office text): `en` (default) or `de`. The default used to be German, so an existing install without this variable needs `LOCALE=de` to stay as it was |
| `ALLOW_WRITE` | `false` = only read, plan, simulate |
| `SESSION_SECRET` | key of the stored Proton session (default: `API_TOKEN`) |
| `CORS_ORIGINS` | additional browser origins for the API; the add-on (`moz-extension://`) is always allowed |
| `MANAGESIEVE_*`, `IMAP_*` | see above; `MANAGESIEVE_INSECURE=true` accepts self-signed certificates |
| `JMAP_URL`, `JMAP_TOKEN`, `JMAP_USER` | see above |
| `ALLOW_PASSWORD_LOGIN`, `PROTON_API_BASE`, `PROTON_APP_VERSION` | Proton only |

Every variable that holds a secret also exists as `…_FILE` for Docker secrets.

### MCP

Streamable HTTP at `POST /mcp`, header `Authorization: Bearer <API_TOKEN>`:

```json
{ "mcpServers": { "sieve": { "type": "http", "url": "http://localhost:8080/mcp",
  "headers": { "Authorization": "Bearer <API_TOKEN>" } } } }
```

| Tool | Purpose |
|---|---|
| `sieve_status`, `sieve_capabilities` | provider, connection, write permission, extensions of the server |
| `list_filters`, `get_filter`, `list_folders` | read |
| `lint_sieve`, `check_sieve`, `format_sieve` | check (locally with the server's dialect / by the server), format |
| `simulate_message` | Where does a mail end up? (with the server's behavior, optionally with changed scripts) |
| `suggest_rule` | suggest conditions from the headers of a mail |
| `plan_rule` / `apply_rule` | plan a rule (best place, diff, conflicts, simulation) or save it; `section` chooses the section (`auto`, `end`, a title or `{new: "Title"}`), `list_filters` names the sections |
| `list_templates`, `plan_template` / `apply_template` | templates (filtered to fit the server) |
| `create_filter`, `update_filter`, `set_filter_enabled`, `reorder_filters`, `delete_filter` | direct management |

Saving always happens only after the server's check. The target folders of `plan_rule`/`apply_rule` and the templates are checked against the real folders, with suggestions for typos ("Einkaufe" → "Einkäufe"), as long as the server lists its folders. `create_filter` and `update_filter` take the script as written; there the server's check is the only one. The same operations exist via REST at `POST /api/ops/<name>`, for example `plan-rule`, `apply-rule`, `simulate`, `capabilities`.

## 🔒 Protection against account locks

Proton temporarily restricted a test account twice ("unusual activity"), each time after a **password login from the Docker service**. The existing session in the add-on kept working. This leads to:

- By default the service does **not** sign in with a password. The session comes from the add-on via handover.
- A **login guard** (`addon/lib/login-guard.js`) applies to add-on and service:
  - at most 3 password sign-ins in 15 minutes; each captcha continuation counts as one, because it sends the password again
  - growing pauses after errors; a wrong password only uses up one of the 3 sign-ins
  - three wrong 2FA codes end the pending sign-in
  - **24 hours pause** after an abuse report; blocked attempts do not reach Proton at all
- Proton's error codes end up in the log (`[proton] … Code …`), never tokens or passwords.

Proton's "Sign in with another device" (session fork) would be more elegant, but requires the client ID of an official Proton app and is therefore deliberately not used.

## 🛠️ Developing and testing

| | |
|---|---|
| `npm test` | core: SRP, linter (both dialects), parser, merging, planner, simulator, templates, login guard, translations |
| `npm run test:server` | service: MCP with a real client, login flow, handover, guard, ManageSieve client and provider, JMAP provider |
| `npm run lint` | `web-ext lint` for the add-on |
| `npm run fake-proton` | local Proton stand-in with real SRP, 2FA and captcha (`FAKE_TOTP=1 FAKE_CAPTCHA=1`) |
| `npm run fake-managesieve` | small ManageSieve server on port 4190 |
| `npm run fake-jmap` | small JMAP server with JMAP for Sieve on port 18090 |
| `npm run stalwart:up` | **real Stalwart** (JMAP for Sieve) on port 18480 |
| `npm run dovecot:up` | **real Dovecot 2.3 + Pigeonhole** (STARTTLS, IMAPS, folders with umlauts) |
| `npm run preview` | add-on UI at `http://localhost:8765/manager/manager.html` (append `?lang=de` for German) |

Tests against the real Dovecot, including a comparison of the simulator with real delivery:

```bash
npm run dovecot:up
cd server && DOVECOT_TEST=127.0.0.1:14190:10993 DOVECOT_CONTAINER=sieve-dovecot npm test
```

Tests against the real Stalwart via JMAP:

```bash
npm run stalwart:up
cd server && STALWART_TEST=127.0.0.1:18480 npm test
```

## 🚧 Known limitations

- **Proton:** tested against a real (free) account (2026-11-04): session handover to the add-on/the service, reading, Proton's check, merging, renaming, rejecting broken scripts, deleting. Free accounts allow only **one active filter**; above the limit Proton creates new filters disabled (code 50016), and the service reports that as "Created, but disabled".
- The PGP signature of the SRP modulus is not verified yet (go-srp verifies it).
- Proton 2FA only via TOTP; human verification only via captcha.
- ManageSieve sign-in via SCRAM-SHA-512, -256 or -1 when the server offers it (the password never leaves the service, and the server has to prove it knows it), otherwise SASL PLAIN over TLS (`MANAGESIEVE_SASL=plain` forces PLAIN for servers that offer SCRAM but store other password hashes). No OAUTHBEARER.
- The simulator does not know Proton's contact lists (`header :list`) or `body`, `include` and `duplicate` and notes that.
- In the add-on, the Proton session and the service token are stored unencrypted in the Thunderbird profile; in the service the Proton session is encrypted.
