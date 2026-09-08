// tests/e2eVisual.test.js
//
// Browser-based verification of the local CV detectors against real rendered
// pixels (canvas → ImageData), proving the QR/face path works in a real
// browser, not just over synthetic test arrays.

import test from 'node:test';
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer';
import fs from 'node:fs';
import path from 'node:path';

const visualCode = fs.readFileSync(
  path.join(process.cwd(), 'shared', 'visualDetectors.js'), 'utf8'
).replace(/export /g, '');

test('visual detectors run on real browser-rendered pixels', async () => {
  const browser = await puppeteer.launch();
  const page = await browser.newPage();
  await page.setViewport({ width: 200, height: 200 });
  await page.setContent('<!DOCTYPE html><html><body><canvas id="c" width="200" height="200"></canvas></body></html>');

  const findings = await page.evaluate(async (code) => {
    const script = document.createElement('script');
    script.textContent = code;
    document.body.appendChild(script);

    const canvas = document.getElementById('c');
    const ctx = canvas.getContext('2d');
    // Fill background white.
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 200, 200);

    // Draw a QR-like finder pattern (1:1:3:1:1) in the top area.
    ctx.fillStyle = '#000';
    for (const [x, w] of [[0, 3], [6, 9], [18, 3]]) ctx.fillRect(x, 20, w, 21);

    // Draw a skin-tone face blob in the lower area.
    ctx.fillStyle = 'rgb(210,170,140)';
    ctx.fillRect(60, 80, 60, 60);

    const img = ctx.getImageData(0, 0, 200, 200);
    return window.detectAllVisualSensitive(img.data, img.width, img.height);
  }, visualCode);

  const cats = findings.map(f => f.category);
  assert.ok(cats.includes('qr_code'), 'QR finder pattern must be detected: ' + JSON.stringify(cats));
  assert.ok(cats.includes('face'), 'skin-tone face blob must be detected: ' + JSON.stringify(cats));

  await browser.close();
});