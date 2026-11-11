# Agent notes

- Language for code, comments, UI source texts, log and error messages, commits and docs: American English.
- Other languages exist only as additional UI locales. English is the key in `t('...')`. German lives in `addon/lib/locales/de.js` and `addon/_locales/de/messages.json`. A new language is one more catalog next to `de.js`, not a new mechanism.
- Every new UI text goes through `t()` or `localizeDom` and gets a German entry. `npm test` fails otherwise (`scripts/i18n-check.mjs`).
- Never rename a storage key, stored value, message ID, CSS class or URL because of language or spelling.
- Core logic goes into `addon/lib/` so the add-on and the service share it and `npm test` covers it without Thunderbird.
- No runtime dependencies in the add-on besides the vendored CodeMirror and bcryptjs.

## German and umlauts outside the locale files

Test data is English. Exceptions are deliberate and stay:

- `Einkäufe` is the canonical folder name with non-ASCII characters in tests and fakes.
- Data in tests about umlauts, UTF-7 folder names, encoded words or German input, for example `Entwürfe`, `Grüße`, `pässwort`.
- `addon/lib/login-guard.js` matches Proton's German error text. `server/src/ops.js` knows umlaut spellings for typo suggestions.
- The invoice template in `addon/lib/sieve-templates.js` ships German and English keywords on purpose.

## Verified for real

A change counts as checked only when:

1. `npm run test:all` passes (core and service).
2. `npm run lint` passes (`web-ext lint`).
3. A change to a provider or to the simulator also passes against the real servers: `npm run dovecot:up` and `npm run stalwart:up`, then the two commands under "Developing and testing" in the README.
4. Every touched add-on page was looked at in English and in German. `npm run preview` serves the pages at `http://localhost:8765/manager/manager.html`, `?lang=de` switches to German. A change to the manifest, the background script or the message display action is also loaded in Thunderbird via "Load Temporary Add-on", once with an English and once with a German UI.
5. A change to the service was looked at in the running container: `docker compose up -d --build`, then the web UI at `http://localhost:8080`, with `LOCALE=en` and `LOCALE=de` if texts changed.

Proton has no test environment. Behavior of the real Proton API remains a manual check with a real account and is named as such in the report.

## README style

- Centered icon on top, title, bold tagline, one badge row (at most six).
- Every `##` heading starts with an emoji. Fixed ones: ✨ Features,
  📦 Installation, 🚀 Usage, ⚙️ Configuration, 🖼️ Screenshots,
  🩺 Troubleshooting, 💬 Support, 🙏 Credits, 📄 License. Other sections get
  a fitting emoji of their own, never one twice per file.
- Install path first, features as bullets, configuration as a table, one
  screenshot when there is a UI, GitHub alerts for warnings.
- The repository is private, so badges are static shields.io badges; keep
  their values (Thunderbird version, status) in sync with the manifest.
