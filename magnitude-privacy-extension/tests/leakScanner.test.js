// tests/leakScanner.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { scanPayloadForLeaks } from '../shared/leakScanner.js';

test('scanner passes a clean sanitized payload', () => {
  const payload = {
    body: {
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'A form with a PAN field and a Submit button (values withheld).' }],
      temperature: 0.2
    },
    sanitizedContext: 'This page contains an Aadhaar field, a PAN field, and a Submit button.',
    sanitizedScreenshot: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
  };
  const scan = scanPayloadForLeaks(payload);
  assert.equal(scan.safe, true, JSON.stringify(scan.findings));
});

test('scanner flags a PAN number in outgoing text', () => {
  const scan = scanPayloadForLeaks({ text: 'PAN: ABCDE1234F' });
  assert.equal(scan.safe, false);
  assert.ok(scan.findings.some(f => f.category === 'pan'));
});

test('scanner flags an email in outgoing text', () => {
  const scan = scanPayloadForLeaks({ desc: 'contact john.doe@example.com' });
  assert.equal(scan.safe, false);
  assert.ok(scan.findings.some(f => f.category === 'email'));
});

test('scanner flags a password value under a sensitive key', () => {
  const scan = scanPayloadForLeaks({ form: { password: 'MyPassword123' } });
  assert.equal(scan.safe, false);
  assert.ok(scan.findings.some(f => f.category === 'sensitive_key' || f.category === 'credential_value'));
});

test('scanner flags an API key', () => {
  const scan = scanPayloadForLeaks({ headers: { authorization: 'Bearer sk-1234567890abcdefghijk' } });
  assert.equal(scan.safe, false);
});

test('scanner flags an Aadhaar number with context', () => {
  const scan = scanPayloadForLeaks({ kyc: 'Aadhaar Number: 1234 5678 9012' });
  assert.equal(scan.safe, false);
  assert.ok(scan.findings.some(f => f.category === 'aadhaar'));
});

test('scanner flags a phone number', () => {
  const scan = scanPayloadForLeaks({ contact: 'Call 9876543210' });
  assert.equal(scan.safe, false);
});

test('scanner flags original image data under a forbidden key', () => {
  const scan = scanPayloadForLeaks({ fileDataUrl: 'data:image/png;base64,...' });
  assert.equal(scan.safe, false);
  assert.ok(scan.findings.some(f => f.category === 'original_image_data'));
});

test('scanner detects sensitive text embedded as base64', () => {
  const b64 = Buffer.from('PAN: ABCDE1234F').toString('base64');
  const scan = scanPayloadForLeaks({ embedded: `data:text/plain;base64,${b64}` });
  assert.equal(scan.safe, false);
  assert.ok(scan.findings.some(f => f.category === 'pan'));
});

test('scanner walks nested arrays and objects', () => {
  const scan = scanPayloadForLeaks({ list: [{ meta: { value: 'user@example.com' } }] });
  assert.equal(scan.safe, false);
  assert.ok(scan.findings.some(f => f.category === 'email'));
});

test('scanner ignores plain numbers (coordinates) and neutral text', () => {
  const scan = scanPayloadForLeaks({ mouse: { x: 320, y: 240 }, label: 'Submit' });
  assert.equal(scan.safe, true);
});