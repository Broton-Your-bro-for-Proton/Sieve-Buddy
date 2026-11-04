# Sieve-Manager für Proton und alle ManageSieve-Server

Sieve-Filter bequem verwalten, ohne sich jedes Mal im Webmail anzumelden. Unterstützt werden **Proton Mail** und **jeder Mailserver mit ManageSieve** (RFC 5804), etwa Dovecot/Pigeonhole, Stalwart, Cyrus, Mailcow, Mailu, mailbox.org oder Uberspace.

- **Thunderbird-Add-on:** Sieve-Editor, der den Dialekt des Servers kennt, „Regel aus Mail“ mit zwei Klicks, Simulator, Regel-Assistent, Verlauf
- **Docker-Dienst:** REST-API und **MCP-Server**, z. B. für Inbox Zero oder Claude

Beide teilen sich denselben Kern (`addon/lib/`).

```
Thunderbird-Add-on ──┬─ direkt ─────────────────────────────▶ Proton (inoffizielle Web-API)
                     └─ über den Dienst ─┐
Inbox Zero / Claude ── MCP ──────────────┤
                                         ▼
                                  Docker-Dienst ──▶ Proton  oder  ManageSieve-Server (+ IMAP für Ordner)
```

> **Proton:** Für Filter gibt es keine offizielle API. Der Zugriff nutzt dieselbe Web-API wie Protons eigener Web-Client, und Proton kann sie jederzeit ändern oder unbekannte Programme sperren (siehe [Schutz vor Konto-Sperren](#schutz-vor-konto-sperren)). **ManageSieve** ist dagegen ein offizieller Standard, dort gibt es dieses Risiko nicht.

## Thunderbird-Add-on

### Funktionen

- **Verbindung:** direkt mit Proton (SRP-Login mit TOTP; Captcha über verify.proton.me wie bei der Bridge) **oder über den eigenen Dienst**, dann auch für ManageSieve-Server.
- **Filter und Skripte verwalten:** anlegen, bearbeiten, löschen und aktivieren, bei Proton auch sortieren. Vor dem Speichern zeigt ein **Diff**, was sich ändert, und frühere Versionen liegen im **Verlauf**.
- **Editor, der den Dialekt des Servers kennt:**
  - Syntax-Highlighting und **Vorschläge** für Befehle, Tags und die vom Server angebotenen Erweiterungen, außerdem Header, deine **Ordner und Labels**, Flags und Datumsteile
  - **Live-Prüfung**: fehlende `require`, `;`, Klammern, Erweiterungen, die der Server nicht kann, unbekannte Ordner. Proton-Fallen (`keep`, `discard`, Flags nach `fileinto`, Spam-Schutz) gelten nur bei Proton.
  - Zusätzlich prüft **der Server selbst**: Proton bzw. `CHECKSCRIPT` per ManageSieve.
  - **Hover-Hilfe**, **Gliederung**, **Formatierer**, „require ergänzen“
- **✨ Regel-Assistent:** 16 Vorlagen, darunter Domains, Mailinglisten, Rechnungen, Shops, GitHub, Monitoring, Abwesenheit und Kontaktschutz. Neue Werte werden **in passende Blöcke eingereiht**. Vorlagen, die es nur bei Proton gibt, sind bei anderen Servern ausgeblendet.
- **Mail testen:** Der Simulator zeigt, wo eine Mail landet, mit Protons Verhalten oder nach **RFC 5228** (implizites `keep`, `fileinto` als Kopie, `:copy`, `redirect`). Der RFC-Modus ist **gegen echte Dovecot-Zustellung geprüft**.
- **Sieve-Regel aus Mail:** Button in der Mail-Ansicht oder Rechtsklick in der Nachrichtenliste.
  - Bedingungen werden vorgeschlagen: Liste, Absender, Domain, Alias, Betreff ohne Nummern.
  - Die Regel landet an der **besten Stelle**. Bevorzugt wird ein bestehender Block erweitert: in die Liste einreihen, `anyof` erweitern oder zu `anyof` umbauen. Sonst wird ein neuer Block angelegt.
  - Der **Simulator prüft**, ob die Mail danach wirklich dort landet. Fängt ein früherer Block sie ab, wird die Regel davor gesetzt, bei Bedarf mit `stop`.
  - Du siehst Diff und Konflikte und speicherst mit einem Klick.

### Installation (Entwicklung)

```bash
npm install
npm run vendor   # CodeMirror und bcryptjs nach addon/vendor
npm test         # Kern-Tests
npm run build    # dist/*.zip (als .xpi installierbar)
```

In Thunderbird: Menü ☰ → **Add-ons und Themes** → Zahnrad ⚙ → **Add-ons debuggen** → „Temporäres Add-on laden“ → `addon/manifest.json`. Für ein Update dort **„Neu laden“** klicken, nicht entfernen, sonst ist die Anmeldung weg.

## Docker-Dienst mit MCP

```bash
cp .env.example .env          # API_TOKEN setzen (z. B. openssl rand -hex 32), PROVIDER wählen
docker compose up -d --build
```

Danach `http://localhost:8080` öffnen und das API-Token eingeben. Die Weboberfläche zeigt den Status und die MCP-Konfiguration.

### Mit einem ManageSieve-Server

```env
PROVIDER=managesieve
MANAGESIEVE_HOST=mail.example.com
MANAGESIEVE_USER=ich@example.com
MANAGESIEVE_PASSWORD=…          # oder MANAGESIEVE_PASSWORD_FILE=/run/secrets/sieve
# MANAGESIEVE_TLS=starttls      # Standard; tls oder none (none nur im eigenen Netz)
# IMAP_HOST=…                   # Ordnerliste per IMAP (Standard: gleicher Host, 993/TLS); IMAP_HOST= leer = aus
```

Der Dienst übernimmt die Fähigkeiten des Servers, also die Erweiterungen, die er unter `SIEVE` meldet. Bei ManageSieve ist immer **genau ein Skript aktiv**:
- Geplant und simuliert wird nur das aktive.
- Neue Skripte bleiben inaktiv, solange nichts anderes verlangt ist.
- Eine Reihenfolge gibt es nicht.

### Mit Proton

```env
PROVIDER=proton
```

Der Dienst meldet sich **nicht selbst** bei Proton an. Stattdessen meldest du dich im Thunderbird-Add-on an und klickst dort **„An Dienst übergeben“** (Adresse und API-Token des Dienstes). Der Dienst übernimmt die Sitzung, und das Add-on arbeitet danach über den Dienst weiter. Die Sitzung wird AES-256-GCM-verschlüsselt in `/data` gespeichert. Ein Passwort-Login direkt im Dienst ist nur mit `ALLOW_PASSWORD_LOGIN=true` möglich (nicht empfohlen, siehe unten).

### Variablen

| Variable | Bedeutung |
|---|---|
| `API_TOKEN` | **Pflicht.** Bearer-Token für Weboberfläche, REST und MCP (≥ 24 Zeichen) |
| `PROVIDER` | `proton` (Standard) oder `managesieve` |
| `ALLOW_WRITE` | `false` = nur lesen, planen, simulieren |
| `SESSION_SECRET` | Schlüssel der gespeicherten Proton-Sitzung (Standard: `API_TOKEN`) |
| `CORS_ORIGINS` | weitere Browser-Ursprünge für die API; das Add-on (`moz-extension://`) ist immer erlaubt |
| `MANAGESIEVE_*`, `IMAP_*` | siehe oben; `MANAGESIEVE_INSECURE=true` akzeptiert selbstsignierte Zertifikate |
| `ALLOW_PASSWORD_LOGIN`, `PROTON_API_BASE`, `PROTON_APP_VERSION` | nur Proton |

Jede Variable mit Geheimnis gibt es auch als `…_FILE` für Docker-Secrets.

### MCP

Streamable HTTP unter `POST /mcp`, Header `Authorization: Bearer <API_TOKEN>`:

```json
{ "mcpServers": { "sieve": { "type": "http", "url": "http://localhost:8080/mcp",
  "headers": { "Authorization": "Bearer <API_TOKEN>" } } } }
```

| Tool | Zweck |
|---|---|
| `sieve_status`, `sieve_capabilities` | Anbieter, Verbindung, Schreibrecht, Erweiterungen des Servers |
| `list_filters`, `get_filter`, `list_folders` | Lesen |
| `lint_sieve`, `check_sieve`, `format_sieve` | Prüfen (lokal mit dem Dialekt des Servers / durch den Server), formatieren |
| `simulate_message` | Wo landet eine Mail? (mit dem Verhalten des Servers, optional mit geänderten Skripten) |
| `suggest_rule` | Bedingungen aus den Headern einer Mail vorschlagen |
| `plan_rule` / `apply_rule` | Regel planen (beste Stelle, Diff, Konflikte, Simulation) bzw. speichern |
| `list_templates`, `plan_template` / `apply_template` | Vorlagen (passend zum Server gefiltert) |
| `create_filter`, `update_filter`, `set_filter_enabled`, `reorder_filters`, `delete_filter` | Direkte Verwaltung |

Gespeichert wird immer erst nach der Prüfung durch den Server. Zielordner werden gegen die echten Ordner geprüft, mit Vorschlägen bei Tippfehlern („Einkaufe“ → „Einkäufe“). Dieselben Operationen gibt es per REST unter `POST /api/ops/<name>`, z. B. `plan-rule`, `apply-rule`, `simulate`, `capabilities`.

## Schutz vor Konto-Sperren

Proton hat ein Test-Konto zweimal vorübergehend eingeschränkt („unusual activity“), jeweils nach einem **Passwort-Login aus dem Docker-Dienst**. Die bestehende Sitzung im Add-on lief dabei weiter. Daraus folgt:

- Der Dienst meldet sich standardmäßig **nicht** mit Passwort an. Die Sitzung kommt per Übergabe aus dem Add-on.
- Ein **Login-Wächter** (`addon/lib/login-guard.js`) gilt für Add-on und Dienst:
  - höchstens 3 Passwort-Anmeldungen in 15 Minuten
  - wachsende Pausen nach Fehlern
  - **24 Stunden Pause** nach einer Missbrauchsmeldung; blockierte Versuche erreichen Proton gar nicht
- Protons Fehlercodes landen im Log (`[proton] … Code …`), nie Tokens oder Passwörter.

Protons „Sign in with another device“ (Session Fork) wäre eleganter, verlangt aber die Client-Kennung einer offiziellen Proton-App und wird deshalb bewusst nicht genutzt.

## Entwickeln und testen

| | |
|---|---|
| `npm test` | Kern: SRP, Linter (beide Dialekte), Parser, Einreihen, Planer, Simulator, Vorlagen, Login-Wächter |
| `npm run test:server` | Dienst: MCP mit echtem Client, Login-Ablauf, Übergabe, Wächter, ManageSieve-Client und -Anbieter |
| `npm run fake-proton` | lokaler Proton-Ersatz mit echtem SRP, 2FA und Captcha (`FAKE_TOTP=1 FAKE_CAPTCHA=1`) |
| `npm run fake-managesieve` | kleiner ManageSieve-Server auf Port 4190 |
| `npm run dovecot:up` | **echter Dovecot 2.3 + Pigeonhole** (STARTTLS, IMAPS, Ordner mit Umlauten) |
| `npm run preview` | Add-on-Oberfläche unter `http://localhost:8765/manager/manager.html` |

Tests gegen den echten Dovecot, inklusive Abgleich des Simulators mit echter Zustellung:

```bash
npm run dovecot:up
cd server && DOVECOT_TEST=127.0.0.1:14190:10993 DOVECOT_CONTAINER=sieve-dovecot npm test
```

## Bekannte Einschränkungen

- **Proton:** gegen ein echtes (Free-)Konto getestet (04.11.2026): Sitzungsübergabe ans Add-on/den Dienst, Lesen, Protons Prüfung, Einreihen, Umbenennen, Ablehnen kaputter Skripte, Löschen. Free-Konten erlauben nur **einen aktiven Filter**; über dem Limit legt Proton neue Filter deaktiviert an (Code 50016) – der Dienst meldet das als „angelegt, aber deaktiviert“.
- Die PGP-Signatur des SRP-Modulus wird noch nicht geprüft (go-srp prüft sie).
- Proton-2FA nur per TOTP; menschliche Verifizierung nur per Captcha.
- ManageSieve-Anmeldung nur per SASL PLAIN, über TLS. Kein OAUTHBEARER oder SCRAM.
- Der Simulator kennt Protons Kontaktlisten (`header :list`) sowie `body`, `include` und `duplicate` nicht und notiert das.
- Im Add-on liegen Proton-Sitzung und Dienst-Token unverschlüsselt im Thunderbird-Profil; im Dienst ist die Proton-Sitzung verschlüsselt.
