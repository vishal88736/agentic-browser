// tests/adversarial.test.js
//
// Adversarial privacy tests. Every test below is a deliberate attempt to leak
// sensitive information past the privacy boundary. The expected result of each
// is that the value is DETECTED and/or the payload is BLOCKED — i.e. nothing
// sensitive reaches a (mock) server.

import test from 'node:test';
import assert from 'node:assert/strict';
import { scanPayloadForLeaks } from '../shared/leakScanner.js';
import { sanitizeDomSnapshot } from '../shared/domSanitizer.js';

const expectBlocked = (payload) => {
  const scan = scanPayloadForLeaks(payload);
  if (scan.safe) {
    return { ok: false, debug: `expected a leak but scanner found none in: ${JSON.stringify(payload)}` };
  }
  return { ok: true };
};

test('raw PAN text nested deep in an object', () => {
  assert.ok(expectBlocked({ context: { page: { elements: [{ meta: { note: 'PAN ABCDE1234F' } }] } } }).ok);
});

test('raw Aadhaar in an array element', () => {
  assert.ok(expectBlocked({ labels: ['Title', 'aadhaar number 1234 5678 9012'] }).ok);
});

test('password under a sensitive key', () => {
  assert.ok(expectBlocked({ auth: { password: 'hunter2secret' } }).ok);
});

test('base64-encoded screenshot (data URL) is caught as original image', () => {
  // A realistic data URL prefix plus base64 payload → flagged as original image data.
  assert.ok(expectBlocked({ fileDataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB' }).ok);
});

test('base64 of sensitive text is decoded and caught', () => {
  const b64 = Buffer.from('email: user@example.com').toString('base64');
  assert.ok(expectBlocked({ note: `data:application/octet-stream;base64,${b64}` }).ok);
});

test('URL-encoded email is caught', () => {
  assert.ok(expectBlocked({ contact: 'mailto:john%2Edoe%40example.com' }).ok);
});

test('fullwidth Unicode homoglyph of a PAN is caught', () => {
  // FULLWIDTH A-E, digits, A
  const full = 'ＡＢＣＤＥ１２３４Ｆ';
  assert.ok(expectBlocked({ id: full }).ok);
});

test('sensitive file name is caught', () => {
  assert.ok(expectBlocked({ upload: { fileName: 'pan-card-scan.png' } }).ok);
});

test('OCR text accidentally included is caught', () => {
  assert.ok(expectBlocked({ ocrText: 'income tax department PAN ABCDE1234F' }).ok);
});

test('raw screenshot accidentally attached under a forbidden key', () => {
  assert.ok(expectBlocked({ body: { rawScreenshot: 'data:image/png;base64,AAAA' } }).ok);
});

test('sanitizeDomSnapshot is never the source of a leak', () => {
  const raw = {
    url: 'https://site/page?email=john@example.com',
    fields: [
      { selectorPath: '#aadhaar', label: 'Aadhaar', value: '1234 5678 9012', placeholder: 'Enter aadhaar 1234 5678 9012' }
    ],
    mediaCandidates: [{ alt: 'PAN Card', src: 'pan-card.png', fileName: 'pan-card.png' }]
  };
  const out = sanitizeDomSnapshot(raw);
  const scan = scanPayloadForLeaks(out);
  assert.equal(scan.safe, true, JSON.stringify(scan.findings));
});