// Every add-on page has its own ProtonClient on one stored session. A refresh in one page rotates the refresh
// token, so the others must take the stored session instead of failing and deleting it.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';

import { createFakeProton } from '../scripts/fake-proton.mjs';
import { ProtonClient } from '../addon/lib/proton-api.js';

let fake;
let apiBase;
before(async () => {
  fake = createFakeProton();
  apiBase = await fake.listen();
});
after(() => fake.close());

function sharedStore(session) {
  let stored = structuredClone(session);
  return { load: async () => structuredClone(stored), save: async (s) => void (stored = structuredClone(s)) };
}

function signedIn(uid) {
  fake.state.sessions.set(uid, { access: `${uid}-a`, refresh: `${uid}-r`, scope: 'full' });
  const store = sharedStore({ UID: uid, AccessToken: `${uid}-a`, RefreshToken: `${uid}-r`, username: 'max@example.com' });
  const client = () => new ProtonClient({ bcrypt: {}, store, settings: { apiBase } });
  return { store, client };
}

test('a second page refreshes with the session the first page rotated, and keeps it', async () => {
  const { store, client } = signedIn('uid-two-pages');
  const [manager, rule] = [client(), client()];
  await manager.restore();
  await rule.restore();
  fake.state.sessions.get('uid-two-pages').access = 'expired';

  await rule.request('GET', 'mail/v4/filters'); // refreshes and rotates the refresh token
  await manager.request('GET', 'mail/v4/filters'); // still holds the old refresh token
  assert.equal((await store.load())?.RefreshToken, fake.state.sessions.get('uid-two-pages').refresh);
  assert.equal(manager.session.RefreshToken, rule.session.RefreshToken);
});

test('a page whose session was handed over or signed out elsewhere does not refresh it', async () => {
  const { store, client } = signedIn('uid-handed-over');
  const rule = client();
  await rule.restore();
  const refresh = fake.state.sessions.get('uid-handed-over').refresh;
  fake.state.sessions.get('uid-handed-over').access = 'expired';
  await store.save(null); // the manager handed the session over to the service

  await assert.rejects(rule.request('GET', 'mail/v4/filters'), /Signed out in another window/);
  assert.equal(fake.state.sessions.get('uid-handed-over').refresh, refresh, 'the service keeps a valid refresh token');
  assert.equal(rule.session, null);
});
