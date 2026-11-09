import { test } from 'node:test';
import assert from 'node:assert/strict';

import { LoginBlockedError, LoginGuard, isAbuseError } from '../addon/lib/login-guard.js';
import { ProtonApiError, ProtonClient } from '../addon/lib/proton-api.js';

const memory = () => {
  let value = null;
  return { load: async () => value, save: async (v) => (value = structuredClone(v)) };
};
const clock = (start = Date.parse('2026-11-04T10:00:00Z')) => {
  let t = start;
  const now = () => t;
  now.advance = (ms) => (t += ms);
  return now;
};
const MIN = 60_000;

test('at most three password attempts per 15 minutes', async () => {
  const now = clock();
  const g = new LoginGuard(memory(), now);
  for (let i = 0; i < 3; i++) await g.beforeAttempt();
  await assert.rejects(g.beforeAttempt(), LoginBlockedError);
  now.advance(15 * MIN + 1);
  await g.beforeAttempt();
});

test('wrong password and captcha do not cause a pause, other errors back off exponentially', async () => {
  const now = clock();
  const g = new LoginGuard(memory(), now);
  await g.onError(new ProtonApiError('Incorrect login credentials', { status: 422, code: 8002 }));
  await g.onError(new ProtonApiError('CAPTCHA', { status: 422, code: 9001 }));
  assert.equal((await g.status()).blockedUntil, null);

  await g.onError(new ProtonApiError('Something odd', { status: 422, code: 12345 }));
  assert.equal((await g.status()).blockedUntil, now() + 5 * MIN);
  await g.onError(new ProtonApiError('Something odd', { status: 500 }));
  assert.equal((await g.status()).blockedUntil, now() + 10 * MIN);
  await g.onSuccess();
  assert.equal((await g.status()).blockedUntil, null);
});

test('Proton abuse message blocks for 24 hours', async () => {
  const now = clock();
  const g = new LoginGuard(memory(), now);
  const abuse = new ProtonApiError(
    'Our systems detected unusual activity targeting your account. To protect you from potential compromise, we have temporarily limited access to it.',
    { status: 422, code: 2028 },
  );
  assert.equal(isAbuseError(abuse), true);
  await g.onError(abuse);
  const s = await g.status();
  assert.equal(s.blockedUntil, now() + 24 * 60 * MIN);
  assert.match(s.reason, /unusual activity/);
  assert.equal(s.lastError.code, 2028);
  await assert.rejects(g.beforeAttempt(), /Login paused until/);
  await g.reset();
  await g.beforeAttempt();
});

test('the client consults the guard and does not even contact Proton while blocked', async () => {
  const now = clock();
  const guard = new LoginGuard(memory(), now);
  await guard.onError(new ProtonApiError('unusual activity', { status: 422 }));
  let calls = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    calls++;
    throw new Error('must not be called');
  };
  try {
    const client = new ProtonClient({ bcrypt: {}, store: memory(), guard });
    await assert.rejects(client.login('a', 'b'), LoginBlockedError);
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('API errors are reported to the logging hook without secrets', async () => {
  const seen = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ Code: 2028, Error: 'unusual activity' }), { status: 422 });
  try {
    const client = new ProtonClient({ bcrypt: {}, store: memory(), onApiError: (i) => seen.push(i) });
    await assert.rejects(client.request('POST', 'core/v4/auth/info', { body: { Username: 'x' }, auth: false }));
    assert.deepEqual(seen, [{ method: 'POST', path: 'core/v4/auth/info', status: 422, code: 2028, message: 'unusual activity' }]);
  } finally {
    globalThis.fetch = realFetch;
  }
});
