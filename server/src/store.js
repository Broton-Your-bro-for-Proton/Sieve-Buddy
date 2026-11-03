// Stores the Proton session (UID + refresh token) AES-256-GCM encrypted on disk.

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export function encryptedFileStore(path, secret) {
  const key = scryptSync(secret, 'proton-sieve-session', 32);
  return {
    async load() {
      let raw;
      try {
        raw = await readFile(path, 'utf8');
      } catch {
        return null;
      }
      try {
        const { iv, tag, data } = JSON.parse(raw);
        const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
        decipher.setAuthTag(Buffer.from(tag, 'base64'));
        const plain = Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]);
        return JSON.parse(plain.toString('utf8'));
      } catch {
        console.warn('Gespeicherte Sitzung konnte nicht entschlüsselt werden (anderes SESSION_SECRET?) – bitte neu anmelden');
        return null;
      }
    },
    async save(session) {
      if (!session) {
        await rm(path, { force: true });
        return;
      }
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const data = Buffer.concat([cipher.update(JSON.stringify(session), 'utf8'), cipher.final()]);
      const payload = JSON.stringify({ v: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') });
      await mkdir(dirname(path), { recursive: true });
      const tmp = `${path}.tmp`;
      await writeFile(tmp, payload, { mode: 0o600 });
      await rename(tmp, path);
    },
  };
}
