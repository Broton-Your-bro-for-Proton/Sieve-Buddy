// Hands the add-on's Proton session to the Docker service, so the service never needs a password login
// of its own. Proton rotates refresh tokens, so after a successful handover the add-on forgets the session
// (without logging out, which would end it at Proton).

import { $, el, openModal, storage, toast } from '../shared/env.js';

async function requestOrigin(origin) {
  if (!globalThis.browser?.permissions) return true; // preview outside Thunderbird
  return browser.permissions.request({ origins: [`${origin}/*`] });
}

/**
 * @param {{getClient: () => object, onHandedOver: () => void}} hooks
 */
export function installHandover({ getClient, onHandedOver }) {
  $('handover').addEventListener('click', async () => {
    const client = getClient();
    if (!client?.isLoggedIn) {
      toast('Keine Proton-Sitzung zum Übergeben', true);
      return;
    }
    const urlInput = el('input', { value: (await storage.get('serviceUrl')) ?? 'http://localhost:8080', placeholder: 'http://localhost:8080' });
    const tokenInput = el('input', { type: 'password', autocomplete: 'off', placeholder: 'API_TOKEN des Dienstes' });
    const status = el('div', { class: 'small' });

    await openModal({
      title: 'Sitzung an den Docker-Dienst übergeben',
      body: [
        el('p', { class: 'muted small' }, 'Der Dienst übernimmt diese Proton-Sitzung und muss sich nicht selbst mit Passwort anmelden. Danach ist das Add-on abgemeldet, weil Proton den Refresh-Token bei jeder Nutzung erneuert und zwei Programme ihn nicht teilen können.'),
        el('label', {}, 'Adresse des Dienstes', urlInput),
        el('label', {}, 'API-Token des Dienstes', tokenInput),
        status,
      ],
      actions: [
        { label: 'Abbrechen', class: 'ghost', value: false },
        {
          label: 'Übergeben',
          onClick: async (close) => {
            let origin;
            try {
              origin = new URL(urlInput.value.trim()).origin;
            } catch {
              status.textContent = 'Ungültige Adresse';
              return;
            }
            if (!(await requestOrigin(origin))) {
              status.textContent = 'Zugriff auf den Dienst wurde nicht erlaubt';
              return;
            }
            status.textContent = 'Übergebe …';
            try {
              const { UID, AccessToken, RefreshToken, username } = client.session;
              const res = await fetch(`${origin}/api/session/import`, {
                method: 'POST',
                headers: { Authorization: `Bearer ${tokenInput.value.trim()}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ UID, AccessToken, RefreshToken, username }),
              });
              const data = await res.json().catch(() => ({}));
              if (!res.ok) throw new Error(res.status === 401 ? 'API-Token falsch' : data.error || `HTTP ${res.status}`);
              await storage.set('serviceUrl', origin);
              // forget the session locally – do NOT call logout, that would end it at Proton
              client.session = null;
              await storage.set('session', null);
              close(true);
              toast(`Sitzung an den Dienst übergeben (${data.username ?? 'angemeldet'}) – das Add-on ist jetzt abgemeldet`);
              onHandedOver();
            } catch (error) {
              status.textContent = `Fehlgeschlagen: ${error.message}`;
            }
          },
        },
      ],
    });
  });
}
