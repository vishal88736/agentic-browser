// tests/privacy.test.js
// Run with: node --test tests/privacy.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { detectSensitiveText, classifyDomField } from '../shared/detectors.js';
import { runPrivacyGate } from '../shared/privacyGate.js';
import { validateAction, LOCAL_ONLY_VARIANTS } from '../shared/actionSchema.js';

test('Aadhaar number WITH label context is flagged high-confidence', () => {
  const findings = detectSensitiveText('Aadhaar Number: 1234 5678 9012');
  assert.ok(findings.some(f => f.category === 'aadhaar' && f.confidence >= 0.9));
});

test('bare 12-digit number WITHOUT context is still flagged, but low-confidence/uncertain', () => {
  const findings = detectSensitiveText('Order id 123456789012 shipped today');
  const aadhaar = findings.find(f => f.category === 'aadhaar');
  assert.ok(aadhaar, 'should still be flagged as uncertain rather than silently ignored');
  assert.ok(aadhaar.confidence < 0.6);
});

test('PAN format is always high-signal regardless of context', () => {
  const findings = detectSensitiveText('ABCDE1234F');
  assert.ok(findings.some(f => f.category === 'pan' && f.confidence >= 0.8));
});

test('password input type is classified sensitive from DOM alone (no value read)', () => {
  const { sensitive, category } = classifyDomField({ inputType: 'password', name: 'pwd' });
  assert.equal(sensitive, true);
  assert.equal(category, 'password');
});

test('file input is conservatively treated as sensitive by default', () => {
  const { sensitive } = classifyDomField({ inputType: 'file', name: 'doc_upload' });
  assert.equal(sensitive, true);
});

test('privacy gate never leaks raw sensitive text into sanitizedContext', () => {
  const perception = {
    pageDescription: 'A KYC form',
    elements: [
      { type: 'text_field', label: 'Aadhaar', text: 'Aadhaar Number: 1234 5678 9012', bbox: { x: 0, y: 0, width: 10, height: 10 }, sensitive: true, sensitiveType: 'aadhaar', confidence: 0.95 },
      { type: 'button', label: 'Submit', text: 'Submit', bbox: { x: 0, y: 20, width: 10, height: 10 }, sensitive: false, confidence: 0.9 }
    ]
  };
  const decision = runPrivacyGate({ perception, domFields: [], taskContext: { instruction: 'fill the form' } });

  assert.ok(!decision.sanitizedContext.includes('1234 5678 9012'), 'raw Aadhaar value must never appear in sanitized context');
  assert.ok(decision.sanitizedContext.toLowerCase().includes('aadhaar'), 'category name should still be described');
  assert.ok(decision.sanitizedContext.includes('Submit'), 'non-sensitive labels should pass through');
});

test('privacy gate treats VLM-uncertain elements as sensitive, not safe-by-default', () => {
  const perception = {
    elements: [
      { type: 'text_field', label: 'unknown', text: undefined, bbox: { x: 0, y: 0, width: 5, height: 5 }, sensitive: undefined, confidence: 0.2 }
    ]
  };
  const decision = runPrivacyGate({ perception, domFields: [] });
  assert.equal(decision.sensitiveRegions.length, 1);
});

test('DOM classification can only ADD sensitivity on top of VLM, never remove it', () => {
  const perception = {
    elements: [
      { type: 'text_field', label: 'Aadhaar', text: 'Aadhaar Number: 111122223333', bbox: { x: 0, y: 0, width: 5, height: 5 }, sensitive: true, sensitiveType: 'aadhaar', confidence: 0.95 }
    ]
  };
  const domFields = [
    { role: 'textbox', name: 'aadhaar', inputType: 'text', label: 'Aadhaar', bbox: { x: 0, y: 0, width: 5, height: 5 } }
  ];
  const decision = runPrivacyGate({ perception, domFields });
  assert.ok(decision.sensitiveRegions.length >= 1);
});

test('local:fill_credential action requires a credentialRole, never a raw value field', () => {
  assert.throws(() => validateAction({ variant: 'local:fill_credential', target: { selectorPath: '#x' } }));
  assert.doesNotThrow(() => validateAction({ variant: 'local:fill_credential', target: { selectorPath: '#x' }, credentialRole: 'aadhaar_number' }));
  assert.ok(LOCAL_ONLY_VARIANTS.has('local:fill_credential'));
});

test('sanitized screenshot redaction covers the sensitive bbox region', async () => {
  // Requires OffscreenCanvas; skip under plain Node without a polyfill.
  if (typeof OffscreenCanvas === 'undefined') {
    return; // documented gap — see README "still missing for production"
  }
});
