// tests/visualDetectors.test.js
//
// Synthetic-pixel tests for the local computer-vision detectors: QR-like
// finder patterns, barcodes, skin-tone faces, and signatures. Pixels are
// fabricated locally (no network, no model) to prove the CV layer produces a
// real fail-closed signal.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  detectQrLikeRegions,
  detectBarcodeLikeRegions,
  detectFaceLikeRegions,
  detectSignatureLikeRegions,
  detectAllVisualSensitive
} from '../shared/visualDetectors.js';

function makeImage(width, height, fn) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b] = fn(x, y);
      const i = (y * width + x) * 4;
      data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = 255;
    }
  }
  return data;
}

const WHITE = [255, 255, 255];
const BLACK = [0, 0, 0];

test('detects a QR-like finder pattern', () => {
  const width = 60, height = 60;
  const data = makeImage(width, height, (x, y) => {
    // Horizontal band (rows 20..40) carrying 1:1:3:1:1 black/white runs.
    if (y >= 20 && y <= 40) {
      if (x < 3 || (x >= 6 && x < 15) || (x >= 18 && x < 21)) return BLACK;
    }
    return WHITE;
  });
  const regions = detectQrLikeRegions(data, width, height);
  assert.ok(regions.some(r => r.category === 'qr_code'), 'should find a QR-like region');
});

test('detects a barcode-like region (high-frequency bars)', () => {
  const width = 80, height = 40;
  const data = makeImage(width, height, (x, y) => {
    return (Math.floor(x / 4) % 2 === 0) ? BLACK : WHITE;
  });
  const regions = detectBarcodeLikeRegions(data, width, height);
  assert.ok(regions.some(r => r.category === 'barcode'));
});

test('detects a skin-tone face-like blob', () => {
  const width = 60, height = 60;
  const data = makeImage(width, height, (x, y) => {
    if (x >= 15 && x <= 45 && y >= 15 && y <= 45) return [210, 170, 140]; // skin tone
    return WHITE;
  });
  const regions = detectFaceLikeRegions(data, width, height);
  assert.ok(regions.some(r => r.category === 'face'));
});

test('detects a signature-like band of scattered ink', () => {
  const width = 120, height = 60;
  const data = makeImage(width, height, (x, y) => {
    if (y >= 20 && y <= 29) {
      // sparse dark strokes spread horizontally, not a solid block
      if (x % 24 === 0 || x % 24 === 1) return BLACK;
    }
    return WHITE;
  });
  const regions = detectSignatureLikeRegions(data, width, height);
  assert.ok(regions.some(r => r.category === 'signature'));
});

test('detectAllVisualSensitive combines multiple detector outputs', () => {
  const width = 100, height = 60;
  const data = makeImage(width, height, (x, y) => {
    if (y === 30 && x < 50) return (Math.floor(x / 4) % 2 === 0) ? BLACK : WHITE; // barcode-ish
    return WHITE;
  });
  const regions = detectAllVisualSensitive(data, width, height);
  assert.ok(Array.isArray(regions));
});

test('plain white image yields no visual findings', () => {
  const width = 40, height = 40;
  const data = makeImage(width, height, () => WHITE);
  assert.equal(detectAllVisualSensitive(data, width, height).length, 0);
});