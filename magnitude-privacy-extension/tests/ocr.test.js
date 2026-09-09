// tests/ocr.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeOcrResult, analyzeOcrResults, ocrFailClosed } from '../shared/ocr.js';

test('OCR PAN text yields a redaction decision (raw text dropped)', () => {
  const d = analyzeOcrResult({ text: 'PAN: ABCDE1234F', confidence: 0.93, bbox: { x: 10, y: 20, width: 200, height: 30 } });
  assert.equal(d.sensitive, true);
  assert.equal(d.category, 'pan');
  assert.deepEqual(d.redactRegion, { x: 10, y: 20, width: 200, height: 30 });
  assert.ok(!('text' in d), 'raw OCR text must not be included in the decision');
});

test('OCR neutral text is not sensitive', () => {
  const d = analyzeOcrResult({ text: 'Subscribe now', bbox: { x: 0, y: 0, width: 100, height: 20 } });
  assert.equal(d.sensitive, false);
});

test('analyzeOcrResults reduces multiple lines to bbox regions', () => {
  const regions = analyzeOcrResults([
    { text: 'Name: Vishal Agrawal', bbox: { x: 0, y: 0, width: 100, height: 20 } },
    { text: 'Pan card ABCDE1234F', bbox: { x: 0, y: 30, width: 200, height: 20 } },
    { text: 'Footer text', bbox: { x: 0, y: 60, width: 100, height: 20 } }
  ]);
  assert.ok(regions.length >= 2);
  assert.ok(regions.some(r => r.category === 'pan'));
  assert.ok(regions.every(r => r.bbox));
});

test('fail-closed when OCR unavailable on suspicious image', () => {
  const r = ocrFailClosed({ ocrAvailable: false, potentiallySensitiveImage: true });
  assert.equal(r.state, 'UNVERIFIED');
  assert.equal(r.redactEntireRegion, true);
});

test('ok when OCR available', () => {
  const r = ocrFailClosed({ ocrAvailable: true, potentiallySensitiveImage: true });
  assert.equal(r.state, 'SAFE');
  assert.equal(r.redactEntireRegion, false);
});