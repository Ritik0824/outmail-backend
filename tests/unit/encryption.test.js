import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { setTestEnv } from '../helpers/env.js';

setTestEnv();
const { decrypt, encrypt } = await import('../../utils/encryption.js');

function legacyEncrypt(value) {
  const key = Buffer.from(
    crypto.createHash('sha256')
      .update(process.env.SECRET_KEY)
      .digest('base64')
      .substring(0, 32),
  );
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  const ciphertext = cipher.update(value, 'utf8', 'hex') + cipher.final('hex');
  return `${iv.toString('hex')}:${ciphertext}`;
}

test('encrypt produces a versioned authenticated value that decrypts', () => {
  const encrypted = encrypt('gmail-app-password');

  assert.match(encrypted, /^v2:/);
  assert.equal(decrypt(encrypted), 'gmail-app-password');
});

test('encrypt uses a fresh nonce for the same plaintext', () => {
  assert.notEqual(encrypt('same-value'), encrypt('same-value'));
});

test('decrypt rejects a modified authentication tag', () => {
  const parts = encrypt('protected').split(':');
  parts[2] = `${parts[2].slice(0, -2)}00`;

  assert.throws(() => decrypt(parts.join(':')));
});

test('decrypt remains compatible with legacy credentials', () => {
  assert.equal(decrypt(legacyEncrypt('legacy-password')), 'legacy-password');
});
