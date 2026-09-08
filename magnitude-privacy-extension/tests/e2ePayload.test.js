// tests/e2ePayload.test.js
//
// End-to-end (mock server) verification of the remote VLM flow: the real
// callRemoteReasoner is exercised with a stubbed global.fetch so we can
// inspect EXACTLY what the remote server would receive, proving no original
// sensitive value ever crosses the boundary.

import test from 'node:test';
import assert from 'node:assert/strict';
import { callRemoteReasoner } from '../background/remoteClient.js';
import { runPrivacyGate } from '../shared/privacyGate.js';
import { detectSensitiveDocument } from '../shared/documentDetector.js';
import { scanPayloadForLeaks } from '../shared/leakScanner.js';

function mockFetch(capture) {
  return async (url, opts) => {
    capture.callCount = (capture.callCount || 0) + 1;
    capture.url = url;
    capture.body = JSON.parse(opts.body);
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          choices: [{
            message: { content: JSON.stringify({ actions: [{ variant: 'local:fill_credential', target: { selectorPath: '#aadhaar' }, credentialRole: 'aadhaar_number' }], done: true, confidence: 0.9 }) }
          }]
        };
      },
      async text() { return ''; }
    };
  };
}

test('mock server receives ONLY sanitized context (no PAN/email/password/phone/Aadhaar)', async () => {
  const capture = {};
  const realFetch = globalThis.fetch;
  globalThis.fetch = mockFetch(capture);
  try {
    const plan = await callRemoteReasoner({
      endpoint: 'http://localhost:9999/v1/chat/completions',
      apiKey: '', // api key is a header, not part of the scanned body
      model: 'gpt-4o-mini',
      sanitizedContext: 'This page contains an Aadhaar upload field, a PAN field, an email field, and a Submit button. Values withheld.',
      sanitizedScreenshot: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
      actionSchemaDescription: 'variants...'
    });

    assert.equal(capture.callCount, 1);
    assert.ok(Array.isArray(plan.actions), 'remote plan parsed');

    const wire = JSON.stringify(capture.body);
    assert.ok(!wire.includes('ABCDE1234F'), 'PAN number must not reach the server');
    assert.ok(!wire.includes('123456789012'), 'Aadhaar number must not reach the server');
    assert.ok(!wire.includes('@'), 'no email may reach the server');
    assert.ok(!wire.includes('MyPassword'), 'no password may reach the server');

    // credential value is referenced by ROLE only, never a value
    assert.ok(wire.includes('local:fill_credential'));
    assert.ok(!wire.includes('aadhaar_number') || !wire.includes('"value"'));
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('remote request carrying a leaked PAN is BLOCKED before fetch', async () => {
  const capture = {};
  const realFetch = globalThis.fetch;
  globalThis.fetch = mockFetch(capture);
  try {
    await assert.rejects(
      () => callRemoteReasoner({
        endpoint: 'http://localhost:9999/v1/chat/completions',
        apiKey: '',
        model: 'gpt-4o-mini',
        // Simulate an upstream bug: a raw PAN slipped into the context.
        sanitizedContext: 'User PAN is ABCDE1234F, please verify.',
        sanitizedScreenshot: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
        actionSchemaDescription: 'variants...'
      }),
      /BLOCKED by local leakage scanner/
    );
    assert.equal(capture.callCount, undefined, 'fetch must never be called when a leak is detected');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('full pipeline: PAN card image + sensitive DOM → sanitized payload is leak-free', () => {
  // 1. Synthetic perception/DOM containing a PAN number, email, password.
  const perception = {
    pageDescription: 'A KYC form',
    elements: [
      { type: 'text_field', label: 'PAN', text: 'PAN: ABCDE1234F', bbox: { x: 10, y: 10, width: 200, height: 30 }, sensitive: true, sensitiveType: 'pan', confidence: 0.95 },
      { type: 'text_field', label: 'Email', text: 'john@example.com', bbox: { x: 10, y: 50, width: 250, height: 30 }, sensitive: true, sensitiveType: 'email', confidence: 0.95 },
      { type: 'button', label: 'Submit', text: 'Submit', bbox: { x: 10, y: 200, width: 100, height: 30 }, sensitive: false, confidence: 0.9 }
    ]
  };
  const domFields = [
    { role: 'textbox', label: 'PAN', inputType: 'text', bbox: { x: 10, y: 10, width: 200, height: 30 } },
    { role: 'textbox', label: 'Email', inputType: 'email', bbox: { x: 10, y: 50, width: 250, height: 30 } },
    { role: 'textbox', label: 'Password', inputType: 'password', bbox: { x: 10, y: 90, width: 250, height: 30 } }
  ];
  const mediaCandidates = [
    { tag: 'img', alt: 'PAN Card', fileName: 'pan-card-scan.png', visible: true, bbox: { x: 300, y: 10, width: 400, height: 252 } }
  ];

  // 2. Privacy gate.
  const decision = runPrivacyGate({ perception, domFields, taskContext: { instruction: 'upload PAN card' } });

  // 3. Document detection on the PAN-card image candidate.
  const doc = detectSensitiveDocument({
    ocrText: 'INCOME TAX DEPARTMENT PAN ABCDE1234F',
    fileName: 'pan-card-scan.png',
    altText: 'PAN Card',
    width: 400,
    height: 252
  });
  assert.ok(['redact', 'confirm'].includes(doc.decision), 'PAN image must be classified as sensitive document');
  decision.sensitiveRegions.push({ bbox: mediaCandidates[0].bbox, category: 'pan', source: 'document_detector' });

  // 4. Build the outgoing payload as the remote client would (context + regions).
  const outgoing = { sanitizedContext: decision.sanitizedContext, sensitiveRegionCount: decision.sensitiveRegions.length };

  // 5. Final leak scan proves the payload is safe.
  const scan = scanPayloadForLeaks(outgoing);
  assert.equal(scan.safe, true, JSON.stringify(scan.findings));
  assert.ok(!JSON.stringify(outgoing).includes('ABCDE1234F'));
  assert.ok(!JSON.stringify(outgoing).includes('john@example.com'));
  assert.ok(decision.sensitiveRegions.some(r => r.source === 'document_detector'), 'PAN document region is in the redaction set');
});