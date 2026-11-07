// Configuration from environment variables (see .env.example). Secrets can also come from files
// (VARIABLE_FILE=/run/secrets/…), as Docker/Compose secrets provide them.

import { readFileSync } from 'node:fs';
import { t } from '../../addon/lib/i18n.js';

const env = process.env;

function value(name) {
  if (env[`${name}_FILE`]) return readFileSync(env[`${name}_FILE`], 'utf8').trim();
  return env[name];
}

function required(name, hint = t('siehe .env.example')) {
  const v = value(name);
  if (!v) {
    console.error(t('Umgebungsvariable {name} fehlt – {hint}', { name, hint }));
    process.exit(1);
  }
  return v;
}

const bool = (name, fallback) => (env[name] === undefined ? fallback : env[name] === 'true');
const tlsMode = (name, fallback) => {
  const mode = (env[name] ?? fallback).toLowerCase();
  if (!['starttls', 'tls', 'none'].includes(mode)) {
    console.error(t('{name} muss starttls, tls oder none sein', { name }));
    process.exit(1);
  }
  return mode;
};

export function loadConfig() {
  const apiToken = required('API_TOKEN');
  if (apiToken.length < 24) {
    console.error(t('API_TOKEN muss mindestens 24 Zeichen lang sein (z. B. `openssl rand -hex 32`)'));
    process.exit(1);
  }
  const provider = (env.PROVIDER ?? 'proton').toLowerCase();
  if (!['proton', 'managesieve'].includes(provider)) {
    console.error(t('PROVIDER muss proton oder managesieve sein'));
    process.exit(1);
  }

  const config = {
    host: env.HOST ?? '0.0.0.0',
    port: Number(env.PORT ?? 8080),
    dataDir: env.DATA_DIR ?? './data',
    apiToken,
    // encrypts the stored Proton session; falls back to the API token
    secret: value('SESSION_SECRET') || apiToken,
    allowWrite: bool('ALLOW_WRITE', true),
    // extra origins allowed to call the API from a browser (the add-on's moz-extension:// origin always is)
    corsOrigins: (env.CORS_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    provider,
    // Proton: the session normally comes from the add-on; a password login of the service itself triggered
    // Proton's abuse protection in tests, so it is off unless explicitly enabled
    allowPasswordLogin: bool('ALLOW_PASSWORD_LOGIN', false),
    proton: {
      apiBase: env.PROTON_API_BASE ?? 'https://mail.proton.me/api',
      appVersion: env.PROTON_APP_VERSION ?? 'Other',
    },
  };

  if (provider === 'managesieve') {
    const host = required('MANAGESIEVE_HOST', t('Hostname des ManageSieve-Servers'));
    config.managesieve = {
      host,
      port: Number(env.MANAGESIEVE_PORT ?? 4190),
      tls: tlsMode('MANAGESIEVE_TLS', 'starttls'),
      user: required('MANAGESIEVE_USER'),
      password: required('MANAGESIEVE_PASSWORD'),
      rejectUnauthorized: !bool('MANAGESIEVE_INSECURE', false),
      imap:
        env.IMAP_HOST === ''
          ? null
          : {
              host: env.IMAP_HOST ?? host,
              port: env.IMAP_PORT ? Number(env.IMAP_PORT) : undefined,
              tls: tlsMode('IMAP_TLS', 'tls'),
              user: value('IMAP_USER') || undefined,
              password: value('IMAP_PASSWORD') || undefined,
            },
    };
  }
  return config;
}
