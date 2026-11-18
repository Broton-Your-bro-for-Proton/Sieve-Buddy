import assert from 'node:assert/strict';
import test from 'node:test';

import { secureUrl } from '../addon/lib/secure-url.js';
import { ServiceClient } from '../addon/lib/service-client.js';

test('secureUrl: https anywhere, http only on this computer', () => {
  assert.equal(secureUrl('https://mail.proton.me/api').href, 'https://mail.proton.me/api');
  for (const ok of ['http://localhost:8080', 'http://127.0.0.1:8080/', 'http://[::1]:8080']) assert.ok(secureUrl(ok));
  for (const bad of ['http://example.com', 'http://nas.example.com:8080', 'ws://localhost', 'ftp://example.com', 'http://localhost.example.com']) {
    assert.throws(() => secureUrl(bad), /https/);
  }
});

test('the service client refuses a plain http address on another machine', () => {
  assert.throws(() => new ServiceClient({ baseUrl: 'http://nas.example.com:8080', token: 'x' }), /https/);
  assert.equal(new ServiceClient({ baseUrl: 'https://nas.example.com/', token: 'x' }).baseUrl, 'https://nas.example.com');
});
