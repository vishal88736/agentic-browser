// shared/detectors.js
// Deterministic, local-only detectors. These are ONE layer of the privacy
// gate (see privacyGate.js) — never the sole source of truth. They are
// intentionally conservative: prefer false positives (over-redaction) to
// false negatives (leaking sensitive data).

// --- Regex detectors -------------------------------------------------

const PATTERNS = {
  aadhaar: /\b\d{4}\s?\d{4}\s?\d{4}\b/,
  pan: /\b[A-Z]{5}\d{4}[A-Z]\b/,
  creditCard: /\b(?:\d[ -]*?){13,19}\b/,
  bankAccount: /\b\d{9,18}\b/,
  email: /\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b/,
  phone: /\b(?:\+?\d{1,3}[-\s]?)?\d{10}\b/,
  dob: /\b(0[1-9]|[12]\d|3[01])[\/\-.](0[1-9]|1[0-2])[\/\-.](19|20)\d{2}\b/,
  otp: /\b\d{4,8}\b/
};

// Context words that, when found near a raw number/string, raise
// confidence that it's the sensitive category rather than an arbitrary
// number. This directly implements the spec's example: a bare 12-digit
// number is NOT automatically an Aadhaar number, but one preceded by an
// "Aadhaar" label is.
const CONTEXT_WORDS = {
  aadhaar: ['aadhaar', 'aadhar', 'uidai', 'unique identification'],
  pan: ['pan number', 'pan card', 'permanent account number'],
  otp: ['otp', 'one time password', 'verification code', 'auth code'],
  dob: ['date of birth', 'dob', 'birth date'],
  bankAccount: ['account number', 'a/c no', 'bank account', 'ifsc'],
  creditCard: ['card number', 'credit card', 'debit card', 'cvv', 'expiry']
};

function hasNearbyContext(text, index, category) {
  const words = CONTEXT_WORDS[category];
  if (!words) return false;
  const windowText = text.slice(Math.max(0, index - 60), index + 60).toLowerCase();
  return words.some(w => windowText.includes(w));
}

/**
 * Scan a block of text (OCR'd screenshot text, DOM innerText, VLM output)
 * for sensitive spans. Returns an array of { category, match, start, end,
 * confidence, requiresContext }.
 */
export function detectSensitiveText(text) {
  if (!text) return [];
  const findings = [];

  for (const [category, pattern] of Object.entries(PATTERNS)) {
    const re = new RegExp(pattern, 'g');
    let m;
    while ((m = re.exec(text)) !== null) {
      const contextual = hasNearbyContext(text, m.index, category);

      // Bare numeric patterns (bankAccount, otp, creditCard-lookalikes,
      // aadhaar) are ambiguous without context — per the spec's explicit
      // example, treat them as sensitive only when either (a) context
      // words are present, or (b) the pattern is inherently high-signal
      // (PAN format, email, DOB format).
      const inherentlyHighSignal = ['pan', 'email', 'dob'].includes(category);

      if (!inherentlyHighSignal && !contextual) {
        // Conservative default: uncertain content is still flagged, but
        // at LOW confidence, and the privacy gate treats low-confidence
        // findings as "uncertain -> sensitive until verified" rather than
        // silently discarding them.
        findings.push({
          category,
          match: m[0],
          start: m.index,
          end: m.index + m[0].length,
          confidence: 0.35,
          requiresContext: true
        });
        continue;
      }

      findings.push({
        category,
        match: m[0],
        start: m.index,
        end: m.index + m[0].length,
        confidence: contextual ? 0.95 : 0.8,
        requiresContext: false
      });
    }
  }

  return findings;
}

// --- DOM / input-type heuristics --------------------------------------

const SENSITIVE_INPUT_TYPES = new Set(['password', 'tel', 'email']);
const SENSITIVE_AUTOCOMPLETE = new Set([
  'current-password', 'new-password', 'one-time-code', 'cc-number',
  'cc-csc', 'cc-exp', 'bday', 'tel', 'email'
]);
const SENSITIVE_NAME_HINTS = [
  'password', 'passwd', 'otp', 'aadhaar', 'aadhar', 'pan', 'ssn',
  'card', 'cvv', 'account', 'dob', 'birth', 'phone', 'mobile'
];

/**
 * Classify a DOM field descriptor (produced by content/domExtractor.js)
 * as sensitive using ONLY structural/semantic signals — no field values
 * are inspected here, since values may not even be read from the DOM.
 */
export function classifyDomField(field) {
  const reasons = [];
  let sensitive = false;
  let category;

  if (field.inputType && SENSITIVE_INPUT_TYPES.has(field.inputType)) {
    sensitive = true;
    category = field.inputType === 'password' ? 'password' : field.inputType;
    reasons.push(`input[type=${field.inputType}]`);
  }

  if (field.autocomplete && SENSITIVE_AUTOCOMPLETE.has(field.autocomplete)) {
    sensitive = true;
    category = category || field.autocomplete;
    reasons.push(`autocomplete=${field.autocomplete}`);
  }

  const haystack = `${field.name || ''} ${field.id || ''} ${field.label || ''} ${field.placeholder || ''}`.toLowerCase();
  for (const hint of SENSITIVE_NAME_HINTS) {
    if (haystack.includes(hint)) {
      sensitive = true;
      category = category || hint;
      reasons.push(`field hint "${hint}"`);
    }
  }

  if (field.inputType === 'file') {
    // File inputs are always treated as potentially sensitive until the
    // task/local policy says otherwise — the *content* of the file must
    // never be inspected remotely.
    sensitive = true;
    category = category || 'file_upload';
    reasons.push('file input (content unknown, treated conservatively)');
  }

  return { sensitive, category, reasons };
}
