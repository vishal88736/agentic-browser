// shared/detectors.js
// Deterministic, local-only detectors. These are ONE layer of the privacy
// gate (see privacyGate.js) — never the sole source of truth. They are
// intentionally conservative: prefer false positives (over-redaction) to
// false negatives (leaking sensitive data).
//
// Coverage is broad, not PAN-only: identity/financial documents' text
// signals, PII spans (names, emails, phones, addresses, DOB, account
// numbers, IFSC, PIN), credentials (passwords, OTPs, tokens), and
// transaction metadata.

// --- Regex detectors -------------------------------------------------

const PATTERNS = {
  aadhaar: /\b\d{4}\s?\d{4}\s?\d{4}\b/,
  pan: /\b[A-Z]{5}\d{4}[A-Z]\b/,
  creditCard: /\b(?:\d[ -]*?){13,19}\b/,
  bankAccount: /\b\d{9,18}\b/,
  email: /\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b/,
  phone: /\b(?:\+?\d{1,3}[-\s]?)?\d{10}\b/,
  mobile: /\b[6-9]\d{9}\b/, // Indian mobile — starts 6-9, high-signal
  dob: /\b(0[1-9]|[12]\d|3[01])[\/\-.](0[1-9]|1[0-2])[\/\-.](19|20)\d{2}\b/,
  otp: /\b\d{4,8}\b/,
  pincode: /\b[1-9]\d{5}\b/,
  ifsc: /\b[A-Z]{4}0[A-Z0-9]{6}\b/
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
  bankAccount: ['account number', 'a/c no', 'bank account', 'ifsc', 'account no'],
  creditCard: ['card number', 'credit card', 'debit card', 'cvv', 'expiry'],
  pincode: ['pincode', 'pin code', 'postal code', 'pin', 'postal'],
  phone: ['phone', 'mobile', 'contact', 'call', 'tel']
};

// Format-strong patterns that are high-signal WITHOUT any context word.
const INHERENTLY_HIGH_SIGNAL = new Set(['pan', 'email', 'dob', 'ifsc', 'mobile']);

function hasNearbyContext(text, index, category) {
  const words = CONTEXT_WORDS[category];
  if (!words) return false;
  const windowText = text.slice(Math.max(0, index - 60), index + 60).toLowerCase();
  return words.some(w => windowText.includes(w));
}

// --- Labeled PII (label: value forms) ---------------------------------
// Names, addresses, and other non-numeric PII cannot be matched by a fixed
// regex; they are detected via their surrounding label. Only high-signal
// shapes (capitalized multi-word value after an explicit label) count.

const LABELED_PII = [
  {
    category: 'name',
    re: /(?:(?:full|customer|applicant|holder|card ?holder|account holder|candidate|student|employee)\s+)?name\s*[:=]\s*([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,3})/gi
  },
  {
    category: 'dob',
    re: /\b(?:date of birth|dob|birth ?date)\s*[:=]\s*(\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{2,4})/gi
  }
];

const ADDRESS_LABEL_RE = /(?:residential|permanent|correspondence|postal|current)?\s*address\s*[:=]\s*(.{0,120})/gi;
const ADDRESS_HINTS = /(road|street|lane|nagar|colony|avenue|town|city|apartment|flat|floor|phase|block|sector|p\.?o\.?|district|tehsil|state|pin)/i;

function detectLabeledPii(text) {
  const findings = [];
  for (const { category, re } of LABELED_PII) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      findings.push({
        category,
        match: m[0],
        start: m.index,
        end: m.index + m[0].length,
        confidence: 0.9,
        requiresContext: false
      });
    }
  }

  ADDRESS_LABEL_RE.lastIndex = 0;
  let a;
  while ((a = ADDRESS_LABEL_RE.exec(text)) !== null) {
    const value = a[1] || '';
    // Only flag if the captured value actually looks like an address.
    if (/\d/.test(value) || ADDRESS_HINTS.test(value)) {
      findings.push({
        category: 'address',
        match: a[0].slice(0, 160),
        start: a.index,
        end: a.index + a[0].length,
        confidence: 0.85,
        requiresContext: false
      });
    }
  }

  return findings;
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
      const inherentlyHighSignal = INHERENTLY_HIGH_SIGNAL.has(category);

      if (!inherentlyHighSignal && !contextual) {
        // Conservative default: uncertain content is still flagged, but
        // at LOW confidence, and the privacy gate treats low-confidence
        // findings as "uncertain -> sensitive until verified".
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

  // Labeled PII (names, addresses, labeled DOB) — merged so every consumer
  // (privacy gate, DOM sanitizer, leak scanner) gets the same coverage.
  findings.push(...detectLabeledPii(text));

  return findings;
}

// --- DOM / input-type heuristics --------------------------------------

const SENSITIVE_INPUT_TYPES = new Set(['password', 'tel', 'email']);
const SENSITIVE_AUTOCOMPLETE = new Set([
  'current-password', 'new-password', 'one-time-code', 'cc-number',
  'cc-csc', 'cc-exp', 'bday', 'tel', 'email', 'name', 'given-name',
  'family-name', 'street-address', 'postal-code', 'organization'
]);
const SENSITIVE_NAME_HINTS = [
  'password', 'passwd', 'otp', 'aadhaar', 'aadhar', 'pan', 'ssn',
  'card', 'cvv', 'account', 'dob', 'birth', 'phone', 'mobile',
  'name', 'address', 'pin', 'ifsc', 'upi', 'salary', 'income',
  'medical', 'passport', 'voter', 'employee id', 'college id', 'email'
];

/**
 * Classify a DOM field descriptor (produced by content/domExtractor.js)
 * as sensitive using ONLY structural/semantic signals — no field values
 * are inspected here.
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
    sensitive = true;
    category = category || 'file_upload';
    reasons.push('file input (content unknown, treated conservatively)');
  }

  return { sensitive, category, reasons };
}