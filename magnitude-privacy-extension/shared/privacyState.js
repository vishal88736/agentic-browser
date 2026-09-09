// shared/privacyState.js
//
// Explicit fail-closed privacy state machine (spec section 14). Every step of
// the pipeline reports signals; this module reduces them to one of four states
// and a human-readable reason. The ONLY state that permits a network request
// is SAFE.
//
//   SAFE        → request may continue
//   SUSPICIOUS  → aggressively redact (do NOT send as-is)
//   BLOCKED     → no request
//   UNVERIFIED  → no request
//
// The state never silently degrades to SAFE when a privacy component failed.

export const PRIVACY_STATE = {
  SAFE: 'SAFE',
  SUSPICIOUS: 'SUSPICIOUS',
  BLOCKED: 'BLOCKED',
  UNVERIFIED: 'UNVERIFIED'
};

/**
 * @param {object} s
 * @param {boolean|null} s.leakScanSafe    - final payload scanner: true/false, or null if the scanner itself failed
 * @param {number}      [s.sensitiveRegions] - count of detected sensitive/DOM/document/visual regions
 * @param {boolean}     [s.redactionOk]    - screenshot/DOM redaction completed without error
 * @param {boolean}     [s.perceptionOk]   - local perception (VLM/OCR/visual) completed
 * @param {boolean}     [s.ocrAvailable]   - local OCR was available
 * @param {boolean}     [s.documentUncertain] - a high-sensitivity document was detected at low confidence
 * @returns {{ state: string, reason: string }}
 */
export function decidePrivacyState({
  leakScanSafe,
  sensitiveRegions = 0,
  redactionOk = true,
  perceptionOk = true,
  ocrAvailable = true,
  documentUncertain = false
} = {}) {
  if (leakScanSafe === false) return { state: PRIVACY_STATE.BLOCKED, reason: 'final payload scanner detected a leak' };
  if (leakScanSafe == null) return { state: PRIVACY_STATE.UNVERIFIED, reason: 'final payload scanner failed (cannot prove safety)' };
  if (!redactionOk) return { state: PRIVACY_STATE.UNVERIFIED, reason: 'redaction layer failed — cannot produce sanitized payload' };
  if (documentUncertain) return { state: PRIVACY_STATE.SUSPICIOUS, reason: 'uncertain high-sensitivity document — must redact whole region' };

  if (sensitiveRegions > 0 && !perceptionOk && !ocrAvailable) {
    return { state: PRIVACY_STATE.UNVERIFIED, reason: 'sensitive content present but perception/OCR unavailable' };
  }

  if (sensitiveRegions > 0) {
    // Sensitive content was identified. It is redactable, but must be redacted
    // before sending — hence SUSPICIOUS until sanitization produces a SAFE payload.
    return { state: PRIVACY_STATE.SUSPICIOUS, reason: 'sensitive content detected — redaction required' };
  }

  return { state: PRIVACY_STATE.SAFE, reason: 'payload proven safe' };
}

/**
 * Convenience: assert a request may proceed only when SAFE.
 */
export function canProceed(state) {
  return state === PRIVACY_STATE.SAFE;
}