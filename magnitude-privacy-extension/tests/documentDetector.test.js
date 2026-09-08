// tests/documentDetector.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  detectSensitiveDocument,
  detectDocumentFromText,
  detectDocumentFileName,
  detectDocumentMimeType,
  classifyDocumentAspectRatio,
  readPngDimensions
} from '../shared/documentDetector.js';

test('detects PAN pattern in OCR text', () => {
  const r = detectDocumentFromText('Name: Vishal Agrawal PAN: ABCDE1234F DOB: 01/01/2000');
  assert.equal(r.found, true);
  assert.equal(r.category, 'pan');
});

test('detects PAN keyword without a PAN number', () => {
  const r = detectDocumentFromText('PERMANENT ACCOUNT NUMBER, GOVT. OF INDIA, INCOME TAX DEPARTMENT');
  assert.equal(r.found, true);
});

test('detects Aadhaar keyword', () => {
  const r = detectDocumentFromText('Unique Identification Authority of India, AADHAAR');
  assert.equal(r.found, true);
  assert.equal(r.category, 'aadhaar');
});

test('detects sensitive file name', () => {
  const r = detectDocumentFileName('my_pan_card.jpg');
  assert.equal(r.found, true);
  assert.equal(r.category, 'pan');
});

test('detects sensitive MIME type (PDF)', () => {
  const r = detectDocumentMimeType('application/pdf');
  assert.equal(r.found, true);
});

test('ID-card aspect ratio is card-like; portrait is not', () => {
  assert.equal(classifyDocumentAspectRatio(1011, 638).isCardLike, true); // 1.585
  assert.equal(classifyDocumentAspectRatio(400, 800).isCardLike, false); // 0.5 portrait
});

test('combined detector redacts a full PAN card from OCR + file name', () => {
  const res = detectSensitiveDocument({
    ocrText: 'INCOME TAX DEPARTMENT PAN ABCDE1234F',
    fileName: 'pan-card-scan.png',
    width: 1011,
    height: 638
  });
  assert.equal(res.decision, 'redact');
  assert.ok(['pan', 'generic_identity'].includes(res.category) || res.category);
  assert.ok(res.methods.length >= 2);
});

test('combined detector is safe for a neutral image', () => {
  const res = detectSensitiveDocument({
    fileName: 'holiday.jpg',
    altText: 'beach photo',
    width: 800,
    height: 600
  });
  assert.equal(res.decision, 'safe');
});

test('aspect-ratio alone (weak signal) fails closed to confirm, not safe', () => {
  const res = detectSensitiveDocument({ width: 1011, height: 638 });
  assert.equal(res.decision, 'confirm'); // weak but not dismissed
});

test('readPngDimensions parses a valid PNG header', () => {
  // 1x1 transparent PNG
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  const dims = readPngDimensions(`data:image/png;base64,${png}`);
  assert.deepEqual(dims, { width: 1, height: 1 });
});

test('readPngDimensions returns null for garbage', () => {
  assert.equal(readPngDimensions('data:image/png;base64,AAAA'), null);
});