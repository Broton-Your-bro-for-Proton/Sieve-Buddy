// Runs the client against a server ported from ProtonMail/go-srp server.go, using go-srp's test modulus.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

import {
  base64ToBytes,
  bytesToBase64,
  expandHash,
  fromInt,
  getSrpProofs,
  hashPassword,
  modPow,
  readClearSignedModulus,
  toInt,
} from '../addon/lib/srp.js';

const bcrypt = createRequire(import.meta.url)('bcryptjs');
const fixtures = JSON.parse(readFileSync(new URL('./fixtures.json', import.meta.url), 'utf8'));

const concat = (...parts) => Uint8Array.from(parts.flatMap((p) => [...p]));

async function makeServer(password, salt) {
  const modulusBytes = base64ToBytes(readClearSignedModulus(fixtures.signedModulus));
  const N = toInt(modulusBytes);
  const x = toInt(await hashPassword({ version: 4, password, salt, modulusBytes, bcrypt }));
  const v = modPow(2n, x, N);
  const k = toInt(await expandHash(concat(fromInt(2n), fromInt(N)))) % N;
  const b = toInt(crypto.getRandomValues(new Uint8Array(256))) % (N - 1n);
  const B = fromInt((k * v + modPow(2n, b, N)) % N);

  return {
    serverEphemeral: bytesToBase64(B),
    async verify(clientEphemeral, clientProof) {
      const A = base64ToBytes(clientEphemeral);
      const u = toInt(await expandHash(concat(A, B)));
      const S = fromInt(modPow((toInt(A) * modPow(v, u, N)) % N, b, N));
      const expected = await expandHash(concat(A, B, S));
      if (bytesToBase64(expected) !== clientProof) throw new Error('invalid SRP client proof');
      return bytesToBase64(await expandHash(concat(A, base64ToBytes(clientProof), S)));
    },
  };
}

test('modulus from go-srp fixture is a 2048-bit number = 3 mod 8', () => {
  const N = toInt(base64ToBytes(readClearSignedModulus(fixtures.signedModulus)));
  assert.equal(N.toString(2).length, 2048);
  assert.equal(N % 8n, 3n);
});

test('client and go-srp-style server agree on proofs', async () => {
  const server = await makeServer(fixtures.password, fixtures.salt);
  const proofs = await getSrpProofs({
    version: 4,
    password: fixtures.password,
    salt: fixtures.salt,
    signedModulus: fixtures.signedModulus,
    serverEphemeral: server.serverEphemeral,
    bcrypt,
  });
  const serverProof = await server.verify(proofs.clientEphemeral, proofs.clientProof);
  assert.equal(serverProof, proofs.expectedServerProof);
});

test('wrong password is rejected by the server', async () => {
  const server = await makeServer(fixtures.password, fixtures.salt);
  const proofs = await getSrpProofs({
    version: 4,
    password: 'falsch',
    salt: fixtures.salt,
    signedModulus: fixtures.signedModulus,
    serverEphemeral: server.serverEphemeral,
    bcrypt,
  });
  await assert.rejects(server.verify(proofs.clientEphemeral, proofs.clientProof), /invalid SRP client proof/);
});

test('accepts the real ServerEphemeral from the go-srp test vector', async () => {
  const proofs = await getSrpProofs({
    version: 4,
    password: fixtures.password,
    salt: fixtures.salt,
    signedModulus: fixtures.signedModulus,
    serverEphemeral: fixtures.goServerEphemeral,
    bcrypt,
  });
  assert.equal(base64ToBytes(proofs.clientProof).length, 256);
});

test('unsupported auth versions are refused', async () => {
  await assert.rejects(
    hashPassword({ version: 2, password: 'x', salt: fixtures.salt, modulusBytes: new Uint8Array(256), bcrypt }),
    /Auth-Version 2/,
  );
});
