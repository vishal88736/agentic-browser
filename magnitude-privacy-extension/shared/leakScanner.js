// shared/leakScanner.js
//
// FINAL OUTGOING PAYLOAD LEAKAGE SCANNER (spec section 7, 15, 16).
//
// This is the last line of defense before ANY data leaves the device. It is
// intentionally pessimistic: "If the payload is not proven safe, do not send
// it." It walks the complete object graph of whatever is about to be sent
// (JSON body, metadata, OCR text, DOM text, accessibility data, image
// descriptions, file names, URLs, serialized objects, base64-encoded image
// data) and reports every sensitive span it can find.
//
// It does NOT attempt to redact anything. It only reports. The caller must
// decide to abort (fail closed) when it returns findings.

import { detectSensitiveText } from './detectors.js';

// High-signal patterns that must NEVER appear in an outgoing payload, even
// without surrounding context. These are format-guaranteed enough that a
// false positive is essentially impossible.
const ALWAYS_BLOCK = new Set(['pan', 'email', 'dob']);

// Deterministic "final gate" patterns with tight, high-precision formats that
// the more lenient text detectors deliberately under-classify. These are what
// makes this scanner the last line of defense rather than a re-run of
// detectSensitiveText.
const FINAL_GATE_PATTERNS = [
  { category: 'phone', re: /\b[6-9]\d{9}\b/g }, // Indian mobile (starts 6-9)
  { category: 'phone', re: /\b\+?\d{1,3}[-\s]?\d{10}\b/g },
  { category: 'aadhaar', re: /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/g },
  { category: 'dob', re: /\b(0[1-9]|[12]\d|3[01])[/\-.](0[1-9]|1[0-2])[/\-.](19|20)\d{2}\b/g },
  { category: 'ifsc', re: /\b[A-Z]{4}0[A-Z0-9]{6}\b/g },
  { category: 'upi', re: /\b[\w.-]{2,}@[a-z]{2,}(?!\.)\b/gi } // vpa@bank (no TLD, not email)
];

// Access-token / session-offering headers (Bearer, Basic, cookie session).
const TOKEN_TOKENS = [/Bearer\s+[A-Za-z0-9._~+/=-]{10,}/i];

// Document/identity file names that must never cross the boundary.
const SENSITIVE_FILENAME_HINTS = [
  /pan[_-]?card/i, /aadhaar/i, /uidai/i, /passport/i, /driv(ing)?[_-]?licen/i,
  /voter[_-]?id/i, /employee[_-]?id/i, /student[_-]?id/i, /college[_-]?id/i,
  /statement/i, /cheque/i, /tax|form[_-]?16|26as/i, /salary|payslip/i,
  /medical|prescription/i, /confidential|proprietary|internal/i
];

// API-key / token-shaped strings. A key NAME is not enough (e.g. the word
// "password" in a prompt), but a key name paired with a high-entropy value
// is treated as a leak.
const API_KEY_PATTERNS = [
  /sk-[A-Za-z0-9_-]{16,}/,
  /AKIA[0-9A-Z]{16}/,
  /ghp_[A-Za-z0-9]{20,}/,
  /xox[baprs]-[A-Za-z0-9-]{10,}/,
  /(?:eyJ|gAAAA)[A-Za-z0-9._-]{16,}/, // JWT / Fernet-ish blobs
  /[A-Za-z0-9]{32,}/ // long high-entropy string (keys, hashes, ids)
];

// Key names that are strong evidence a secret is present. Deliberately NOT
// generic ("value"/"content"/"text" appear in legitimate API shapes) — only
// names that are credential/secret specific.
const SENSITIVE_KEY_NAMES = new Set([
  'password', 'passwd', 'pwd', 'secret', 'token', 'apikey', 'api_key',
  'authorization', 'access_token', 'accesstoken', 'credential', 'vault',
  'masterpassword', 'master_password', 'cvv', 'cardnumber', 'ccnumber',
  'cc_csc', 'otp', 'aadhaar', 'aadhar', 'pan'
]);

const DOCUMENT_LEAK_KEYS = new Set([
  'filedataurl', 'file_data_url', 'originalimage', 'original_image',
  'rawscreenshot', 'raw_screenshot', 'unredacted'
]);

/**
 * Scan an arbitrary outgoing payload for sensitive leakage.
 *
 * @param {*} payload - object, array, string, or number to inspect.
 * @param {{strict?: boolean}} [opts]
 * @returns {{ safe: boolean, findings: Array<{path:string, category:string, match?:string, confidence:number, reason:string}> }}
 */
export function scanPayloadForLeaks(payload, { strict = true } = {}) {
  const findings = [];
  const seen = new WeakSet();

  function visit(node, path) {
    if (node === null || node === undefined) return;

    if (typeof node === 'string') {
      scanString(node, path);
      scanBase64(node, path);
      return;
    }

    if (typeof node === 'number' || typeof node === 'boolean') {
      return; // scalars alone are not sensitive
    }

    if (Array.isArray(node)) {
      node.forEach((v, i) => visit(v, `${path}[${i}]`));
      return;
    }

    if (typeof node === 'object') {
      if (seen.has(node)) return;
      seen.add(node);
      for (const [k, v] of Object.entries(node)) {
        const lk = k.toLowerCase();
        if (DOCUMENT_LEAK_KEYS.has(lk) && typeof v === 'string') {
          findings.push({
            path: `${path}.${k}`,
            category: 'original_image_data',
            match: undefined,
            confidence: 1,
            reason: 'original/unredacted image data present in payload'
          });
        }
        if (SENSITIVE_KEY_NAMES.has(lk)) {
          findings.push({
            path: `${path}.${k}`,
            category: 'sensitive_key',
            match: undefined,
            confidence: 0.9,
            reason: `key "${k}" is a sensitive field name`
          });
        }
        // Long high-entropy value under a sensitive key name → leak.
        if (SENSITIVE_KEY_NAMES.has(lk) && typeof v === 'string' && isHighEntropy(v)) {
          findings.push({
            path: `${path}.${k}`,
            category: 'credential_value',
            match: undefined,
            confidence: 1,
            reason: `high-entropy value under sensitive key "${k}"`
          });
        }
        visit(v, `${path}.${k}`);
      }
    }
  }

  function scanString(text, path) {
    // Data URIs / pure base64 are opaque; their decoded bytes are handled by
    // scanBase64. Scanning the raw base64 alphabet here only produces false
    // positives (base64 looks like a long high-entropy token).
    if (extractBase64Body(text)) return;

    // Scan the raw text plus any practically-decodable encodings (percent /
    // URL encoding and fullwidth Unicode homoglyphs) so encoded leaks are
    // caught too (spec section 13).
    const forms = [text];
    const pc = decodePercentEncoding(text);
    if (pc !== text) forms.push(pc);
    const fw = normalizeFullwidth(text);
    if (fw !== text) forms.push(fw);

    const seenMatches = new Set();
    for (const form of forms) scanTextForm(form, path, seenMatches);
  }

  function scanTextForm(text, path, seenMatches) {
    const sliced = text.length > 512 ? text.slice(0, 512) : text;

    const record = (category, match, confidence, reason) => {
      const key = `${category}:${match}`;
      if (seenMatches.has(key)) return;
      seenMatches.add(key);
      findings.push({ path, category, match, confidence, reason });
    };

    // Filename carrying a document hint (only when it looks like a real file).
    for (const re of SENSITIVE_FILENAME_HINTS) {
      if (re.test(text) && looksLikeFileName(text)) {
        record('sensitive_filename', text.trim().slice(0, 120), 0.85, 'sensitive document file name in payload');
        break;
      }
    }

    for (const { category, re } of FINAL_GATE_PATTERNS) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(sliced)) !== null) {
        record(category, m[0], 0.95, 'final-gate sensitive pattern matched in outgoing text');
      }
    }

    for (const finding of detectSensitiveText(sliced)) {
      if (ALWAYS_BLOCK.has(finding.category) || finding.confidence >= 0.8) {
        record(finding.category, finding.match, finding.confidence, 'sensitive pattern matched in outgoing text');
      }
    }

    // Luhn-validated card numbers (high precision, catches spacing variants).
    const cardRe = /\b(?:\d[ -]*?){13,19}\b/g;
    let cm;
    while ((cm = cardRe.exec(sliced)) !== null) {
      if (luhnValid(cm[0].replace(/\D/g, ''))) {
        record('creditCard', cm[0], 0.95, 'Luhn-valid credit-card number');
      }
    }

    for (const re of API_KEY_PATTERNS) {
      if (re.test(sliced)) {
        record('api_key', sliced.match(re)?.[0], 0.8, 'API-key/token-shaped string present');
        break;
      }
    }

    for (const re of TOKEN_TOKENS) {
      if (re.test(sliced)) {
        record('access_token', sliced.match(re)?.[0], 0.9, 'access token / session credential present');
        break;
      }
    }
  }

  function scanBase64(text, path) {
    // Only attempt to decode strings that look like base64 payloads (data URIs
    // or long base64 without punctuation). This catches sensitive text that a
    // dev accidentally embedded as base64 (e.g. a chat message) without
    // producing noise from normal prose.
    const b64 = extractBase64Body(text);
    if (!b64 || b64.length < 12) return;
    const bytes = decodeBase64(b64);
    if (!bytes) return;

    // Extract printable ASCII runs ≥ 6 chars from decoded bytes and scan them.
    const ascii = extractAsciiRuns(bytes, 6);
    for (const run of ascii) {
      if (run.length > 256) continue;
      for (const finding of detectSensitiveText(run)) {
        if (ALWAYS_BLOCK.has(finding.category) || finding.confidence >= 0.8) {
          findings.push({
            path: `${path} (base64)`,
            category: finding.category,
            match: finding.match,
            confidence: finding.confidence,
            reason: 'sensitive pattern found inside base64-encoded data'
          });
        }
      }
    }
  }

  visit(payload, '$');

  return { safe: findings.length === 0, findings };
}

function isHighEntropy(str) {
  return str.length >= 16 && /[A-Za-z0-9]/.test(str) && !/^[\s.,:;!?'"()\[\]{}<>\-]+$/.test(str);
}

function luhnValid(num) {
  if (num.length < 13 || num.length > 19) return false;
  let sum = 0;
  let alt = false;
  for (let i = num.length - 1; i >= 0; i--) {
    let d = num.charCodeAt(i) - 48;
    if (d < 0 || d > 9) return false;
    if (alt) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    alt = !alt;
  }
  return sum % 10 === 0;
}

// Decode percent/URL encoding so `john%40example.com` is caught as an email.
function decodePercentEncoding(text) {
  if (!text.includes('%')) return text;
  try { return decodeURIComponent(text); } catch { return text; }
}

// A string that plausibly references a file by extension.
function looksLikeFileName(text) {
  return /\.\b[a-z0-9]{2,5}\b/i.test(text) && !/https?:\/\//i.test(text);
}

// Normalize fullwidth ASCII homoglyphs (＠０-９Ａ-Ｚａ-ｚ) to their ASCII forms so
// Unicode variants of email/PAN/phone patterns are still detected.
function normalizeFullwidth(text) {
  if (!/[\uFF01-\uFF5E]/.test(text)) return text;
  return text.replace(/[\uFF01-\uFF5E]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0));
}

function extractBase64Body(text) {
  const dataUri = text.match(/^data:[^;,]*;base64,([A-Za-z0-9+/=]+)$/);
  if (dataUri) return dataUri[1];
  if (/^[A-Za-z0-9+/]{32,}={0,2}$/.test(text)) return text;
  return null;
}

function decodeBase64(b64) {
  try {
    if (typeof atob === 'function') {
      const bin = atob(b64);
      const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      return arr;
    }
    return new Uint8Array(Buffer.from(b64, 'base64'));
  } catch {
    return null;
  }
}

function extractAsciiRuns(bytes, minLength) {
  const runs = [];
  let cur = [];
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (b >= 0x20 && b <= 0x7e) {
      cur.push(String.fromCharCode(b));
    } else {
      if (cur.length >= minLength) runs.push(cur.join(''));
      cur = [];
      if (runs.length > 200) break; // bound work on binary blobs
    }
  }
  if (cur.length >= minLength) runs.push(cur.join(''));
  return runs;
}