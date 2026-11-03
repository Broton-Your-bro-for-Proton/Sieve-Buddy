# Proton Sieve Manager (Thunderbird, POC)

Ein Thunderbird-Add-on, mit dem du die Sieve-Filter deines Proton-Mail-Kontos direkt in Thunderbird verwaltest, ohne dich jedes Mal im Proton-Web-Login anzumelden.

> **Inoffiziell.** Das Add-on spricht dieselbe (undokumentierte) Web-API wie Protons eigener Web-Client. Proton kann sie jederzeit ändern. Nutzung auf eigenes Risiko.

## Funktionen

- **Proton-Login per SRP**, inkl. TOTP-2FA und Captcha-Prüfung. Das Passwort wird nicht gespeichert, nur UID und Refresh-Token (in `browser.storage.local`).
- **Filter verwalten:** auflisten, anlegen, bearbeiten, löschen, aktivieren/deaktivieren, Reihenfolge ändern.
- **Sieve-Editor** (CodeMirror 5) mit
  - Syntax-Highlighting, Klammer-Matching, Kommentar-Toggle (`Strg+/`)
  - kontextabhängiger **Autovervollständigung**: Befehle, Tests, `:tags`, Erweiterungen in `require`, Header-Namen, **deine Proton-Ordner und Labels** bei `fileinto`, Flags, Listen-Specs, Datumsteile, Vorlagen
  - **Live-Prüfung im Editor** für Protons Dialekt: fehlende `require`s, fehlende `;`, offene Klammern/Strings, unbekannte Befehle/Erweiterungen, nicht vorhandene Ordner, nicht unterstützte Regex-Kürzel (`\d`, `\w`), Flag-Änderungen nach `fileinto`, `keep`/`discard`/`stop`-Fallen, fehlender Spam-Schutz
  - zusätzlich **Prüfung durch Proton selbst** (`PUT mail/v4/filters/check`), automatisch beim Tippen und vor jedem Speichern
  - „require ergänzen“: führt alle benötigten Erweiterungen in **ein** `require` zusammen
  - Vorlagen und „Spam-Schutz einfügen“
- **Offline-Modus:** Editor ohne Anmeldung, Skripte werden lokal gespeichert.

## Installation (Entwicklung)

```bash
npm install
npm run vendor   # kopiert CodeMirror und bcryptjs nach addon/vendor
npm test         # SRP- und Analyzer-Tests
npm run build    # erzeugt dist/*.zip (als .xpi installierbar)
```

In Thunderbird: *Extras → Add-ons und Themes → Zahnrad → Add-on zum Testen debuggen* (`about:debugging`) → „Temporäres Add-on laden“ → `addon/manifest.json` wählen. Danach öffnet das Symbol in der Werkzeugleiste den Manager als Tab.

Für eine reine UI-Vorschau im Browser (nur Offline-Modus): `node scripts/serve.mjs` und dann `http://localhost:8765/manager/manager.html` öffnen.

## Aufbau

```
addon/
  manifest.json, background.js   Toolbar-Button öffnet den Manager-Tab
  manager/                       Oberfläche (HTML/CSS/JS)
  lib/srp.js                     Proton-SRP (Port von ProtonMail/go-srp)
  lib/proton-api.js              Login, 2FA, Refresh, Filter- und Label-Endpunkte
  lib/sieve-dialect.js           Protons Sieve-Dialekt (Erweiterungen, Befehle, Vorlagen)
  lib/sieve-analyzer.js          Tokenizer, Linter, Autovervollständigung, require-Fixer
```

`lib/` hängt nicht von Thunderbird ab (nur `fetch` und WebCrypto). So lässt es sich später auch in einem eigenständigen Dienst oder MCP-Server wiederverwenden, z. B. für Inbox Zero.

## Bekannte Einschränkungen / offene Punkte

- **Noch nicht gegen ein echtes Proton-Konto getestet.** SRP ist gegen einen Server getestet, der go-srp nachgebaut ist, und nutzt den echten Proton-Modulus. Ob Proton die Anfragen aus dem Add-on annimmt, zeigt erst der erste Login.
- **App-Kennung:** Proton prüft den Header `x-pm-appversion`. Voreingestellt ist `Other`. Lehnt Proton das ab, lässt sich die Kennung unter *Erweitert* ändern.
- Die PGP-Signatur des SRP-Modulus wird noch **nicht** geprüft (go-srp prüft sie).
- 2FA nur per TOTP, keine Sicherheitsschlüssel (FIDO2).
- Bei der menschlichen Verifizierung wird nur Captcha unterstützt (kein E-Mail-/SMS-Code).
- Das Refresh-Token liegt unverschlüsselt im Thunderbird-Profil.
