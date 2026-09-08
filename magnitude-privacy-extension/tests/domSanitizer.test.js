// tests/domSanitizer.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeText, sanitizeDomField, stripLocalOnlyFields, sanitizeDomSnapshot } from '../shared/domSanitizer.js';

test('sanitizeText redacts emails', () => {
  assert.equal(sanitizeText('john@example.com'), '[REDACTED]');
});

test('sanitizeText redacts PAN numbers', () => {
  assert.equal(sanitizeText('ABCDE1234F'), '[REDACTED]');
});

test('sanitizeText leaves neutral labels alone', () => {
  assert.equal(sanitizeText('Submit'), 'Submit');
});

test('sanitizeDomField strips value and redacts PII in label/placeholder', () => {
  const out = sanitizeDomField({
    role: 'textbox',
    label: 'Email: john@example.com',
    placeholder: 'Enter Aadhaar 123456789012',
    name: 'email',
    value: 'secret',
    bbox: { x: 0, y: 0, width: 10, height: 10 }
  });
  assert.equal(out.value, '[REDACTED]');
  assert.equal(out.label, '[REDACTED]');
  assert.equal(out.placeholder, '[REDACTED]');
});

test('sanitizeDomField preserves selectorPath for local use', () => {
  const out = sanitizeDomField({ selectorPath: '#password', label: 'Pass' });
  assert.equal(out.selectorPath, '#password');
});

test('stripLocalOnlyFields removes selectorPath and value', () => {
  const out = stripLocalOnlyFields({ selectorPath: '#x', value: 'secret', label: 'ok' });
  assert.equal(out.selectorPath, undefined);
  assert.equal(out.value, undefined);
  assert.equal(out.label, 'ok');
});

test('sanitizeDomSnapshot redacts PII across fields and media candidates', () => {
  const out = sanitizeDomSnapshot({
    url: 'https://site.com/?email=john@example.com',
    title: 'KYC',
    fields: [{ selectorPath: '#aadhaar', label: 'Aadhaar 1234 5678 9012' }],
    mediaCandidates: [{ alt: 'pan-card.png', fileName: 'pan-card.png', src: 'https://x/pan.jpg' }]
  });
  assert.ok(!JSON.stringify(out).includes('john@example.com'));
  assert.ok(!JSON.stringify(out).includes('1234 5678 9012'));
  assert.equal(out.mediaCandidates[0].fileName, undefined); // fileName stripped for transport
});