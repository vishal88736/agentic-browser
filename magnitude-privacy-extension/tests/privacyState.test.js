// tests/privacyState.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { decidePrivacyState, canProceed, PRIVACY_STATE } from '../shared/privacyState.js';

test('completely safe payload → SAFE', () => {
  const s = decidePrivacyState({ leakScanSafe: true, sensitiveRegions: 0 });
  assert.equal(s.state, PRIVACY_STATE.SAFE);
  assert.equal(canProceed(s.state), true);
});

test('payload leak → BLOCKED', () => {
  const s = decidePrivacyState({ leakScanSafe: false });
  assert.equal(s.state, PRIVACY_STATE.BLOCKED);
  assert.equal(canProceed(s.state), false);
});

test('scanner failure → UNVERIFIED', () => {
  const s = decidePrivacyState({ leakScanSafe: null });
  assert.equal(s.state, PRIVACY_STATE.UNVERIFIED);
});

test('redaction failure → UNVERIFIED', () => {
  const s = decidePrivacyState({ leakScanSafe: true, redactionOk: false });
  assert.equal(s.state, PRIVACY_STATE.UNVERIFIED);
});

test('uncertain high-sensitivity document → SUSPICIOUS', () => {
  const s = decidePrivacyState({ leakScanSafe: true, sensitiveRegions: 1, documentUncertain: true });
  assert.equal(s.state, PRIVACY_STATE.SUSPICIOUS);
});

test('sensitive content present → SUSPICIOUS (redaction required)', () => {
  const s = decidePrivacyState({ leakScanSafe: true, sensitiveRegions: 3 });
  assert.equal(s.state, PRIVACY_STATE.SUSPICIOUS);
});

test('sensitive content + no perception + no OCR → UNVERIFIED', () => {
  const s = decidePrivacyState({ leakScanSafe: true, sensitiveRegions: 1, perceptionOk: false, ocrAvailable: false });
  assert.equal(s.state, PRIVACY_STATE.UNVERIFIED);
});