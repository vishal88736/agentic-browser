// tests/crypto.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { encryptVault, decryptVault } from '../shared/crypto.js';

test('vault round-trips through AES-GCM encryption', async () => {
  const data = { aadhaar_number: { value: '123456789012' }, pan: { value: 'ABCDE1234F' }, password: { value: 'S3cret!' } };
  const enc = await encryptVault('correct horse battery staple', data);

  assert.ok(enc.cipherText, 'ciphertext present');
  assert.ok(enc.salt, 'salt present');
  assert.ok(enc.iv, 'iv present');
  assert.ok(!enc.cipherText.includes('123456789012'), 'ciphertext must not contain plaintext');

  const dec = await decryptVault('correct horse battery staple', enc);
  assert.deepEqual(dec, data);
});

test('wrong password fails safely', async () => {
  const enc = await encryptVault('right-pass', { password: { value: 'x' } });
  await assert.rejects(() => decryptVault('wrong-pass', enc), /Decryption failed/);
});

test('tampered ciphertext fails safely', async () => {
  const enc = await encryptVault('pass', { pan: { value: 'ABCDE1234F' } });
  const tampered = { ...enc, cipherText: enc.cipherText.slice(0, -4) + 'AAAA' };
  await assert.rejects(() => decryptVault('pass', tampered), /Decryption failed/);
});

test('each encryption uses a fresh random salt + IV', async () => {
  const a = await encryptVault('pass', { x: { value: '1' } });
  const b = await encryptVault('pass', { x: { value: '1' } });
  assert.notEqual(a.salt, b.salt);
  assert.notEqual(a.iv, b.iv);
  assert.notEqual(a.cipherText, b.cipherText);
});