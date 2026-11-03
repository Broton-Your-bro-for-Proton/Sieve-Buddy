# Proton Sieve

Werkzeuge, mit denen du die Sieve-Filter deines Proton-Mail-Kontos verwaltest, ohne dich jedes Mal im Proton-Web-Login anzumelden:

- **Thunderbird-Add-on:** Sieve-Editor mit Protons Dialekt, „Regel aus Mail“ mit zwei Klicks, Simulator, Regel-Assistent
- **Docker-Dienst:** Web-Login, REST-API und **MCP-Server**, zum Beispiel für Inbox Zero oder Claude

Beide nutzen denselben Kern (`addon/lib/`).

> **Inoffiziell.** Alles spricht dieselbe, undokumentierte Web-API wie Protons eigener Web-Client. Proton kann sie jederzeit ändern. Nutzung auf eigenes Risiko.

## Aufbau

```
addon/                 Thunderbird-Add-on (MV2, Thunderbird ≥ 115)
  lib/                 gemeinsamer Kern – ohne Thunderbird-Abhängigkeit (nur fetch + WebCrypto)
    srp.js             Proton-SRP-Login (Port von ProtonMail/go-srp)
    proton-api.js      Login, 2FA, Captcha, Token-Refresh, Filter- und Label-Endpunkte
    sieve-dialect.js   Protons Sieve-Dialekt (Erweiterungen, Befehle, Tags, Spam-Schutz)
    sieve-analyzer.js  Tokenizer, Linter, Autovervollständigung, require-Fixer
    sieve-ast.js       Parser mit exakten Textpositionen, Formatierer
    sieve-rules.js     Regeln ↔ Sieve, Einreihen in bestehende Blöcke, Konflikte
    sieve-sim.js       Simulator: Wo landet eine Mail?
    rule-planner.js    beste Stelle über alle Filter finden + mit dem Simulator prüfen
    sieve-templates.js 16 parametrisierte Vorlagen in 7 Kategorien
    mail.js            Header-Parsing, Adressen, Regelvorschläge aus einer Mail
    diff.js            Zeilen-Diff
  manager/             Manager-Tab (Editor, Assistent, Simulator, Verlauf …)
  rule/                Fenster „Sieve-Regel aus Mail“
  shared/              gemeinsame UI-Helfer
server/                Docker-Dienst (Node ≥ 20): Web-Login, REST, MCP
test/                  Kern-Tests       server/test/   Server-Ende-zu-Ende-Test
```

## Thunderbird-Add-on

### Funktionen

- **Proton-Login per SRP** mit TOTP-2FA. Verlangt Proton ein Captcha, öffnet sich wie bei der Proton Bridge verify.proton.me im Browser. Gespeichert werden nur UID und Refresh-Token, nie das Passwort.
- **Filter verwalten:** anlegen, bearbeiten, löschen, aktivieren und Reihenfolge ändern. Vor jedem Speichern zeigt ein **Diff**, was sich ändert, und jede gespeicherte Version landet im **Verlauf** (letzte 25 pro Filter, wiederherstellbar).
- **Sieve-Editor** (CodeMirror):
  - Syntax-Highlighting und **kontextabhängige Vorschläge**: Befehle, Tags, Erweiterungen, Header, deine **Proton-Ordner und Labels**, Flags, Listen und Datumsteile
  - **Live-Prüfung** für Protons Dialekt plus Prüfung durch Proton selbst
  - **Hover-Hilfe** zu Befehlen und Tags, **Gliederung** aller Regeln, **Formatierer** (der Spam-Schutz bleibt unverändert), „require ergänzen“
- **✨ Regel-Assistent:** 16 Vorlagen mit Formular, darunter Domains, Mailinglisten, Rechnungen, Shops, GitHub, Monitoring, Aufräumen, Abwesenheit und Kontaktschutz. Neue Werte werden **in passende bestehende Blöcke eingereiht**, statt Duplikate anzulegen.
- **Mail testen:** Header einfügen oder die in Thunderbird ausgewählte Mail übernehmen. Der Simulator zeigt, wo sie landet und welche Regeln greifen.
- **Sieve-Regel aus Mail**, über den Button in der Mail-Ansicht oder das Rechtsklick-Menü der Nachrichtenliste:
  1. Schlägt Bedingungen vor: Mailingliste, Absender, Domain, Alias-Empfänger, Betreff ohne Nummern
  2. Findet die beste Stelle über alle Filter:
     - **in eine bestehende Liste einreihen**, also `["a.de", "b.de"]` → `["a.de", "b.de", "c.de"]`
     - ein bestehendes `anyof(…)` erweitern
     - einen Block mit gleicher Aktion zu `anyof` umbauen
     - oder einen neuen Block anlegen
  3. Prüft mit dem Simulator, ob die Mail danach wirklich dort landet. Fängt ein früherer Block (etwa mit `stop`) sie ab, kommt die Regel automatisch davor, bei Bedarf mit `stop`.
  4. Zeigt den Diff und Konflikte („ebay.de wird schon anders behandelt“) und speichert mit einem Klick. Alternativ öffnet „Im Manager bearbeiten“ das Ergebnis im Editor.

### Installation (Entwicklung)

```bash
npm install
npm run vendor   # CodeMirror und bcryptjs nach addon/vendor kopieren
npm test         # Kern-Tests (SRP, Analyzer, Parser, Einreihen, Simulator, Vorlagen)
npm run build    # dist/*.zip (als .xpi installierbar)
```

In Thunderbird: Menü ☰ → **Add-ons und Themes** → Zahnrad ⚙ → **Add-ons debuggen** → „Temporäres Add-on laden“ → `addon/manifest.json`.

## Docker-Dienst mit MCP

Ein eigenständiger Dienst für ein Proton-Konto. Er braucht kein laufendes Thunderbird.

```bash
cp .env.example .env              # API_TOKEN setzen, z. B. openssl rand -hex 32
docker compose up -d --build
```

Dann `http://localhost:8080` öffnen, das API-Token eingeben und dich bei Proton anmelden (gegebenenfalls mit 2FA und Captcha). Die Sitzung wird **AES-256-GCM-verschlüsselt** im Volume `/data` gespeichert und automatisch erneuert. Das Passwort wird nicht gespeichert.

| Variable | Bedeutung |
|---|---|
| `API_TOKEN` | **Pflicht.** Bearer-Token für Weboberfläche, REST und MCP (≥ 24 Zeichen) |
| `SESSION_SECRET` | Schlüssel für die gespeicherte Sitzung (Standard: `API_TOKEN`) |
| `ALLOW_WRITE` | `false` = nur lesen, planen und simulieren |
| `PROTON_API_BASE`, `PROTON_APP_VERSION` | Standard: `https://mail.proton.me/api`, `Other` |

### MCP

Streamable HTTP unter `POST /mcp`, Header `Authorization: Bearer <API_TOKEN>`:

```json
{ "mcpServers": { "proton-sieve": { "type": "http", "url": "http://localhost:8080/mcp",
  "headers": { "Authorization": "Bearer <API_TOKEN>" } } } }
```

| Tool | Zweck |
|---|---|
| `proton_status`, `list_filters`, `get_filter`, `list_folders` | Lesen |
| `lint_sieve`, `check_sieve`, `format_sieve` | Prüfen (lokal / durch Proton), formatieren |
| `simulate_message` | Wo landet eine Mail (optional mit geänderten Skripten)? |
| `suggest_rule` | Bedingungen aus den Headern einer Mail vorschlagen |
| `plan_rule` / `apply_rule` | Regel planen (beste Stelle, Diff, Konflikte, Simulation) bzw. speichern |
| `list_templates`, `plan_template` / `apply_template` | Vorlagen |
| `create_filter`, `update_filter`, `set_filter_enabled`, `reorder_filters`, `delete_filter` | Direkte Filterverwaltung |

Gespeichert wird immer erst, nachdem Proton das Skript selbst geprüft hat. Dieselben Operationen gibt es als REST-Aufrufe unter `POST /api/ops/<name>`, etwa `plan-rule`, `apply-rule` oder `simulate`.

```bash
npm run test:server   # Ende-zu-Ende: Dienst + nachgebautes Proton + echter MCP-Client
```

## Bekannte Einschränkungen

- **Getestet gegen ein echtes Proton-Konto ist der Login** (03.11.2026: SRP, App-Kennung `Other`, Captcha). Schreibzugriffe sind gegen einen nachgebauten Proton-Server getestet, aber noch nicht ausführlich gegen das echte.
- Die PGP-Signatur des SRP-Modulus wird noch nicht geprüft (go-srp prüft sie).
- 2FA nur per TOTP, keine Sicherheitsschlüssel (FIDO2). Bei der menschlichen Verifizierung nur Captcha.
- Der Simulator kennt Protons Kontaktlisten (`header :list`) nicht und wertet sie als „nicht enthalten“.
- Im Add-on liegt das Refresh-Token unverschlüsselt im Thunderbird-Profil. Im Dienst ist es verschlüsselt.
