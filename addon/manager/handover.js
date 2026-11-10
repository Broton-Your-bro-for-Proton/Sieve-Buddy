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
      toast(t('No Proton session to hand over'), true);
      return;
    }
    const urlInput = el('input', { value: (await storage.get('serviceUrl')) ?? 'http://localhost:8080', placeholder: 'http://localhost:8080' });
    const tokenInput = el('input', { type: 'password', autocomplete: 'off', placeholder: t("The service's API_TOKEN") });
    const status = el('div', { class: 'small' });

    await openModal({
      title: t('Hand over session to the Docker service'),
      body: [
        el('p', { class: 'small' }, t('The Docker service is an optional companion you run yourself. It offers your filters to AI assistants and tools over MCP and a REST API, for example to let Claude or Inbox Zero sort mail with Sieve rules.')),
        el('p', { class: 'small' }, el('a', { href: 'https://github.com/Broton-Your-bro-for-Proton/Sieve-Buddy#docker-service-with-mcp', target: '_blank', rel: 'noopener noreferrer' }, t('Set up the service (README)'))),
        el('p', { class: 'muted small' }, t('The service takes over this Proton session and does not need to sign in with a password itself. Afterwards the add-on keeps working through the service, because two programs cannot use one Proton session at the same time.')),
        el('label', {}, t('Service address'), urlInput),
        el('label', {}, t('Service API token'), tokenInput),
        status,
      ],
      actions: [
        { label: t('Cancel'), class: 'ghost', value: false },
        {
          label: t('Hand over'),
          onClick: async (close) => {
            let origin;
            try {
              origin = await requestOrigin(urlInput.value.trim());
            } catch (error) {
              status.textContent = error instanceof TypeError ? t('Invalid address') : error.message;
              return;
            }
            status.textContent = t('Handing over …');
            try {
              const { UID, AccessToken, RefreshToken, username } = client.session;
              const res = await fetch(`${origin}/api/session/import`, {
                method: 'POST',
                headers: { Authorization: `Bearer ${tokenInput.value.trim()}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ UID, AccessToken, RefreshToken, username }),
              });
              const data = await res.json().catch(() => ({}));
              if (!res.ok) throw new Error(res.status === 401 ? t('Wrong API token') : data.error || `HTTP ${res.status}`);
              await storage.set('serviceUrl', origin);
              // forget the session locally – do NOT call logout, that would end it at Proton
              client.session = null;
              await storage.set('session', null);
              close(true);
              toast(t('Session handed over to the service ({user}): the add-on now works through the service', { user: data.username ?? t('signed in') }));
              onHandedOver({ url: origin, token: tokenInput.value.trim() });
            } catch (error) {
              status.textContent = t('Failed: {message}', { message: error.message });
            }
          },
        },
      ],
    });
  });
}
