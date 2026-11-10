// SCRAM: the test vectors of RFC 5802 and RFC 7677, and the ManageSieve exchange against the fake server.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createFakeManageSieve } from '../../scripts/fake-managesieve.mjs';
import { ManageSieveConnection } from '../src/providers/managesieve.js';
import { scramClient } from '../src/providers/scram.js';

test('SCRAM-SHA-1 matches RFC 5802', async () => {
  const c = scramClient('SCRAM-SHA-1', 'user', 'pencil', 'fyko+d2lbbFgONRv9qkxdawL');
  assert.equal(c.first, 'n,,n=user,r=fyko+d2lbbFgONRv9qkxdawL');
  const final = await c.final('r=fyko+d2lbbFgONRv9qkxdawL3rfcNHYJY1ZVvWVs7j,s=QSXCR+Q6sek8bf92,i=4096');
  assert.equal(final, 'c=biws,r=fyko+d2lbbFgONRv9qkxdawL3rfcNHYJY1ZVvWVs7j,p=v0X8v3Bz2T0CJGbJQyF0X+HI4Ts=');
  assert.equal(c.verify('v=rmF9pqV8S7suAoZWja4dJRkFsKQ='), true);
  assert.equal(c.verify('v=AAAAAAAAAAAAAAAAAAAAAAAAAAA='), false);
});

test('SCRAM-SHA-256 matches RFC 7677', async () => {
  const c = scramClient('SCRAM-SHA-256', 'user', 'pencil', 'rOprNGfwEbeRWgbNEkqO');
  const final = await c.final('r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0,s=W22ZaJ0SNY7soEsUEjb6gQ==,i=4096');
  assert.equal(final, 'c=biws,r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0,p=dHzbZapWIk4jUhN+Ute9ytag9zjfMHgsqmmiz7AndVQ=');
  assert.equal(c.verify('v=6rriTRBi23WpRR/wtup+mMhUZUn/dB5nLTJRsjl95G4='), true);
});

test('a challenge that does not extend the nonce or asks for absurd work is refused', async () => {
  const c = scramClient('SCRAM-SHA-256', 'user', 'pencil', 'abc');
  await assert.rejects(c.final('r=xyz,s=QSXCR+Q6sek8bf92,i=4096'), /Invalid SCRAM challenge/);
  await assert.rejects(c.final('r=abcdef,s=QSXCR+Q6sek8bf92,i=999999999'), /Invalid SCRAM challenge/);
});

async function withFake(options, fn) {
  const fake = createFakeManageSieve({ sasl: ['SCRAM-SHA-256', 'PLAIN'], ...options });
  const port = await fake.listen();
  try {
    await fn(fake, () => ManageSieveConnection.open({ host: '127.0.0.1', port, tls: 'none' }));
  } finally {
    await fake.close();
  }
}

test('ManageSieve prefers SCRAM over PLAIN when both are offered', () =>
  withFake({}, async (fake, open) => {
    const conn = await open();
    await conn.authenticate('test', 'test123');
    assert.deepEqual(await conn.listScripts(), []);
    await conn.logout();
    assert.deepEqual(fake.state.commands.slice(0, 2), ['AUTHENTICATE', 'LISTSCRIPTS']);
  }));

test('the server signature may also come as a last challenge', () =>
  withFake({ scramFinal: 'challenge' }, async (fake, open) => {
    const conn = await open();
    await conn.authenticate('test', 'test123');
    assert.deepEqual(await conn.listScripts(), []);
    await conn.logout();
  }));

test('a server that cannot prove the password is refused', () =>
  withFake({ scramFinal: 'forged' }, async (fake, open) => {
    const conn = await open();
    await assert.rejects(conn.authenticate('test', 'test123'), /could not prove that it knows the password/);
  }));

test('a wrong password fails with the server message', () =>
  withFake({}, async (fake, open) => {
    const conn = await open();
    await assert.rejects(conn.authenticate('test', 'wrong'), /Authentication failed/);
  }));

test('a mandatory extension or an empty challenge is refused', async () => {
  const c = scramClient('SCRAM-SHA-256', 'user', 'pencil', 'abc');
  await assert.rejects(c.final('m=ext,r=abcdef,s=QSXCR+Q6sek8bf92,i=4096'), /Invalid SCRAM challenge/);
  await assert.rejects(c.final(null), /Invalid SCRAM challenge/);
});

test('MANAGESIEVE_SASL=plain signs in with PLAIN although SCRAM is offered', () =>
  withFake({}, async (fake, open) => {
    const conn = await open();
    await conn.authenticate('test', 'test123', { sasl: 'plain' });
    await conn.logout();
    assert.deepEqual(fake.state.mechanisms, ['PLAIN']);
  }));

test('a failed SCRAM sign-in names the switch to PLAIN', () =>
  withFake({}, async (fake, open) => {
    const conn = await open();
    await assert.rejects(conn.authenticate('test', 'wrong'), /MANAGESIEVE_SASL=plain/);
    assert.deepEqual(fake.state.mechanisms, ['SCRAM-SHA-256']);
  }));
