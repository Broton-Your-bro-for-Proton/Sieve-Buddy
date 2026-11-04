// Configuration from environment variables (see .env.example).

const env = process.env;

function required(name) {
  const value = env[name];
  if (!value) {
    console.error(`Umgebungsvariable ${name} fehlt – siehe .env.example`);
    process.exit(1);
  }
  return value;
}

export function loadConfig() {
  const apiToken = required('API_TOKEN');
  if (apiToken.length < 24) {
    console.error('API_TOKEN muss mindestens 24 Zeichen lang sein (z. B. `openssl rand -hex 32`)');
    process.exit(1);
  }
  return {
    host: env.HOST ?? '0.0.0.0',
    port: Number(env.PORT ?? 8080),
    dataDir: env.DATA_DIR ?? './data',
    apiToken,
    // encrypts the stored Proton session; falls back to the API token
    secret: env.SESSION_SECRET || apiToken,
    allowWrite: env.ALLOW_WRITE !== 'false',
    // extra origins allowed to hand over a session (the add-on's moz-extension:// origin always is)
    corsOrigins: (env.CORS_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    proton: {
      apiBase: env.PROTON_API_BASE ?? 'https://mail.proton.me/api',
      appVersion: env.PROTON_APP_VERSION ?? 'Other',
    },
  };
}
