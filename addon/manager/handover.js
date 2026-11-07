// Hands the add-on's Proton session to the Docker service, so the service never needs a password login
// of its own. Proton rotates refresh tokens, so afterwards the add-on forgets its copy (without logging out,
// which would end the session at Proton) and continues to work through the service.

import { t } from '../lib/i18n.js';
import { $, el, openModal, requestOrigin, storage, toast } from '../shared/env.js';

/**
 * @param {{getClient: () => object, onHandedOver: (service: {url: string, token: string}) => void}} hooks
 */
export function installHandover({ getClient, onHandedOver }) {
  $('handover').addEventListener('click', async () => {
    const client = getClient();
    if (!client?.isLoggedIn) {
      toast(t('Keine Proton-Sitzung zum Übergeben'), true);
      return;
    }
    const urlInput = el('input', { value: (await storage.get('serviceUrl')) ?? 'http://localhost:8080', placeholder: 'http://localhost:8080' });
    const tokenInput = el('input', { type: 'password', autocomplete: 'off', placeholder: t('API_TOKEN des Dienstes') });
    const status = el('div', { class: 'small' });

    await openModal({
      title: t('Sitzung an den Docker-Dienst übergeben'),
      body: [
        el('p', { class: 'muted small' }, t('Der Dienst übernimmt diese Proton-Sitzung und muss sich nicht selbst mit Passwort anmelden. Das Add-on arbeitet danach über den Dienst weiter – zwei Programme können eine Proton-Sitzung nicht gleichzeitig nutzen.')),
        el('label', {}, t('Adresse des Dienstes'), urlInput),
        el('label', {}, t('API-Token des Dienstes'), tokenInput),
        status,
      ],
      actions: [
        { label: t('Abbrechen'), class: 'ghost', value: false },
        {
          label: t('Übergeben'),
          onClick: async (close) => {
            let origin;
            try {
              origin = await requestOrigin(urlInput.value.trim());
            } catch (error) {
              status.textContent = error instanceof TypeError ? t('Ungültige Adresse') : error.message;
              return;
            }
            status.textContent = t('Übergebe …');
            try {
              const { UID, AccessToken, RefreshToken, username } = client.session;
              const res = await fetch(`${origin}/api/session/import`, {
                method: 'POST',
                headers: { Authorization: `Bearer ${tokenInput.value.trim()}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ UID, AccessToken, RefreshToken, username }),
              });
              const data = await res.json().catch(() => ({}));
              if (!res.ok) throw new Error(res.status === 401 ? t('API-Token falsch') : data.error || `HTTP ${res.status}`);
              await storage.set('serviceUrl', origin);
              // forget the session locally – do NOT call logout, that would end it at Proton
              client.session = null;
              await storage.set('session', null);
              close(true);
              toast(t('Sitzung an den Dienst übergeben ({user}) – das Add-on arbeitet jetzt über den Dienst', { user: data.username ?? t('angemeldet') }));
              onHandedOver({ url: origin, token: tokenInput.value.trim() });
            } catch (error) {
              status.textContent = t('Fehlgeschlagen: {message}', { message: error.message });
            }
          },
        },
      ],
    });
  });
}
