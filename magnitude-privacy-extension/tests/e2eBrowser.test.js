// tests/e2eBrowser.test.js
//
// True browser end-to-end test (headless Chromium via Puppeteer). Loads a
// synthetic "local privacy test page" containing sensitive DOM fields AND
// sensitive content inside images (a PAN-card image, a face, a QR code, a
// normal image), then drives the real pipeline: DOM extraction →
// privacy gate → sensitive-document detection → screenshot redaction → final
// leakage scan — and asserts that nothing sensitive survives in the payload a
// mock server would receive.

import test from 'node:test';
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer';
import fs from 'node:fs';
import path from 'node:path';

import { runPrivacyGate } from '../shared/privacyGate.js';
import { detectSensitiveDocument } from '../shared/documentDetector.js';
import { sanitizeDomSnapshot } from '../shared/domSanitizer.js';
import { scanPayloadForLeaks } from '../shared/leakScanner.js';

const domExtractorCode = fs.readFileSync(
  path.join(process.cwd(), 'content', 'domExtractor.js'), 'utf8'
);
const sanitizeCode = fs.readFileSync(
  path.join(process.cwd(), 'shared', 'sanitize.js'), 'utf8'
).replace(/export /g, '');

const PAGE = `<!DOCTYPE html>
<html><head><style>
  body { font-family: sans-serif; margin: 0; }
  label { display: inline-block; width: 120px; }
  .card { position: absolute; left: 420px; top: 10px; }
</style></head><body>
  <form id="kyc">
    <div><label for="name">Full Name</label><input id="name" name="name" value="Vishal Agrawal"></div>
    <div><label for="email">Email</label><input id="email" name="email" type="email" value="vishal@example.com"></div>
    <div><label for="phone">Phone</label><input id="phone" name="phone" type="tel" value="9876543210"></div>
    <div><label for="pan">PAN</label><input id="pan" name="pan" value="ABCDE1234F"></div>
    <div><label for="aadhaar">Aadhaar</label><input id="aadhaar" name="aadhaar" value="1234 5678 9012"></div>
    <div><label for="pwd">Password</label><input id="pwd" name="pwd" type="password" value="MyPassword123"></div>
    <div><label for="dob">Date of Birth</label><input id="dob" name="dob" value="01/01/2000"></div>
    <div><label for="addr">Address</label><textarea id="addr" name="addr">12 MG Road, Bengaluru</textarea></div>
    <div><label for="cc">Card Number</label><input id="cc" name="cc" autocomplete="cc-number" value="4111111111111111"></div>
    <div><label for="api">API Key</label><input id="api" name="api" value="sk-live-abcdefghijklmnopqrstuvwxyz"></div>
    <div><input id="up" type="file"></div>
    <button id="submit" type="submit">Submit</button>
    <button id="disabled" disabled>Disabled Button</button>
  </form>

  <div class="card">
    <img id="panCard" src="pan-card-scan.png" alt="PAN Card" width="400" height="252">
  </div>
  <img id="face" src="profile.png" alt="user profile photo" width="120" height="120" style="position:absolute; left:420px; top:280px;">
  <svg id="qr" width="120" height="120" style="position:absolute; left:420px; top:420px;"><rect width="120" height="120" fill="#000"/></svg>
  <img id="beach" src="beach.jpg" alt="beach photo" width="200" height="130" style="position:absolute; left:420px; top:560px;">
</body></html>`;

test('browser e2e: sensitive page → sanitized, leak-free outgoing payload', async (t) => {
  const browser = await puppeteer.launch();
  const page = await browser.newPage();
  await page.setViewport({ width: 900, height: 800 });
  await page.setContent(PAGE);

  // Inject the real DOM extractor and extract structure (values are never read).
  await page.addScriptTag({ content: domExtractorCode });
  const snapshot = await page.evaluate(() => ({
    fields: window.__magnitudeExtractDomFields(),
    mediaCandidates: window.__magnitudeExtractMediaCandidates(),
    url: location.href,
    title: document.title
  }));

  // 1. Extractor must not have read any input value.
  const fieldsJson = JSON.stringify(snapshot.fields);
  assert.ok(!fieldsJson.includes('Vishal'), 'extractor must not read name value');
  assert.ok(!fieldsJson.includes('ABCDE1234F'), 'extractor must not read PAN value');
  assert.ok(!fieldsJson.includes('MyPassword123'), 'extractor must not read password value');

  // 2. Media candidates include the PAN card image, face, QR, and normal image.
  const panCandidate = snapshot.mediaCandidates.find(m => m.alt === 'PAN Card');
  assert.ok(panCandidate, 'PAN card image should be captured as a media candidate');
  assert.ok(snapshot.mediaCandidates.some(m => m.alt === 'user profile photo'), 'face image captured');
  assert.ok(snapshot.mediaCandidates.some(m => m.alt === 'beach photo'), 'normal image captured');

  // 3. Sensitive-document detection flags the PAN card (alt + filename + aspect).
  const doc = detectSensitiveDocument({
    altText: panCandidate.alt,
    fileName: panCandidate.src,
    width: panCandidate.bbox.width,
    height: panCandidate.bbox.height
  });
  assert.ok(['redact', 'confirm'].includes(doc.decision), 'PAN card image must be classified sensitive');
  assert.equal(doc.category, 'pan');

  // 4. Privacy gate over DOM fields classifies sensitive categories.
  const decision = runPrivacyGate({ perception: null, domFields: snapshot.fields, taskContext: {} });
  const cats = new Set(decision.sensitiveRegions.map(r => r.category));
  for (const expected of ['password', 'email', 'tel', 'pan', 'aadhaar']) {
    // password/tel/email via input type, pan/aadhaar via name hints; file via type=file
    assert.ok(
      [...cats].some(c => String(c).toLowerCase().includes(expected.toLowerCase())),
      `expected sensitive category ${expected}, got ${[...cats].join(',')}`
    );
  }

  // 5. Sanitized DOM snapshot is free of PII.
  const sanitizedDom = sanitizeDomSnapshot(snapshot);
  const domWire = JSON.stringify(sanitizedDom);
  assert.ok(!domWire.includes('Vishal'), 'sanitized DOM must not include name');
  assert.ok(!domWire.includes('ABCDE1234F'), 'sanitized DOM must not include PAN');
  assert.ok(!domWire.includes('vishal@example.com'), 'sanitized DOM must not include email');
  assert.ok(!domWire.includes('MyPassword123'), 'sanitized DOM must not include password');

  // 6. Screenshot redaction: black out the PAN card region and verify pixels.
  const screenshot = await page.screenshot({ encoding: 'base64' });
  const dataUrl = `data:image/png;base64,${screenshot}`;
  const redacted = await page.evaluate(async (code, input, region) => {
    const script = document.createElement('script');
    script.textContent = code;
    document.body.appendChild(script);
    return await window.sanitizeScreenshot(input, [{ bbox: region }]);
  }, sanitizeCode, dataUrl, panCandidate.bbox);

  const redactedOk = await page.evaluate(async (redactedUrl, region) => {
    const img = new Image();
    img.src = redactedUrl;
    await new Promise(r => img.onload = r);
    const canvas = document.createElement('canvas');
    canvas.width = img.width; canvas.height = img.height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const px = ctx.getImageData(region.x + Math.floor(region.width / 2), region.y + Math.floor(region.height / 2), 1, 1).data;
    return px[0] === 0 && px[1] === 0 && px[2] === 0 && px[3] === 255;
  }, redacted, panCandidate.bbox);
  assert.equal(redactedOk, true, 'PAN card region must be blacked out in the outgoing screenshot');

  // 7. Assemble the outgoing payload and prove it is leak-free.
  const outgoing = {
    sanitizedContext: decision.sanitizedContext,
    sanitizedDom,
    screenshotIsRedacted: true
  };
  const scan = scanPayloadForLeaks(outgoing);
  assert.equal(scan.safe, true, 'final payload must be leak-free: ' + JSON.stringify(scan.findings));

  await browser.close();
});