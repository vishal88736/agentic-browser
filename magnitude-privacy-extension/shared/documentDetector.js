// shared/documentDetector.js
//
// Local sensitive-document / identity-document detector. This is the general
// content-protection layer for DOCUMENTS — PAN cards are just one of many
// protected types. It flags identity cards, financial/medical/legal/employer
// documents, private files, and confidential business material, and decides
// whether the ENTIRE document region must be redacted (vs. a single field).
//
// Methods (all local, no image ever leaves the device):
//   1. PAN / IFSC / account-number pattern detection
//   2. Sensitive keyword detection (per-type dictionaries)
//   3. Document layout / aspect-ratio analysis (from PNG header)
//   4. File name / MIME-type analysis
//   5. DOM metadata / alt-text analysis
//   (+ pixel OCR, face, and QR detection from shared/visualDetectors.js when
//    wired in — those are additive local signals)
//
// FAIL-CLOSED: any positive signal yields a `redact`/`confirm` decision; a
// document is never allowed out as "safe" on the strength of weak evidence.

import { detectSensitiveText } from './detectors.js';

const PAN_REGEX = /\b[A-Z]{5}\d{4}[A-Z]\b/gi;
const IFSC_REGEX = /\b[A-Z]{4}0[A-Z0-9]{6}\b/gi;

const DOCUMENT_KEYWORDS = {
  pan: [
    'permanent account number', 'pan card', 'income tax department', 'pan number'
  ],
  aadhaar: [
    'aadhaar', 'aadhar', 'uidai', 'unique identification authority',
    'government of india', 'my aadhaar', 'aadhaar number'
  ],
  passport: ['passport', 'republic of india', 'mrz', 'machine readable zone'],
  driving_license: ['driving licence', 'driving license', 'driving no', 'dl no'],
  voter_id: ['voter id', 'voter identity', 'election commission', 'epic no', 'elector'],
  employee_id: ['employee id', 'employee code', 'staff id', 'employee identity', 'badge'],
  college_id: ['college id', 'student id', 'university id', 'enrollment no', 'roll no', 'registration no'],
  bank: ['bank statement', 'account statement', 'ifsc', 'account number', 'savings account'],
  credit_card: ['credit card', 'debit card', 'card number', 'cvv', 'expiry', 'cardholder name'],
  cheque: ['cheque', 'check', 'pay to the order of', 'micr'],
  tax_document: ['form 16', 'form 26as', 'income tax return', 'gst', 'tds', 'tax invoice', 'deduction'],
  salary: ['salary slip', 'payslip', 'pay slip', 'basic salary', 'gross pay', 'net pay', 'allowance'],
  medical: ['medical report', 'prescription', 'patient', 'diagnosis', 'clinical', 'lab report', 'x-ray', 'blood report'],
  legal: ['legal document', 'affidavit', 'agreement', 'notary', 'court', 'deed', 'power of attorney'],
  private_message: ['private message', 'direct message', 'chat', 'conversation', 'inbox'],
  confidential: ['confidential', 'internal use only', 'proprietary', 'company confidential', 'restricted'],
  generic_identity: ['identity card', 'id card', 'date of birth', 'signature']
};

const DOCUMENT_FILE_HINTS = [
  { pattern: /pan[_-]?card/i, category: 'pan', weight: 0.9 },
  { pattern: /aadhaar|uidai/i, category: 'aadhaar', weight: 0.9 },
  { pattern: /passport/i, category: 'passport', weight: 0.9 },
  { pattern: /driv(ing)?[_-]?licen/i, category: 'driving_license', weight: 0.9 },
  { pattern: /voter[_-]?id|epic/i, category: 'voter_id', weight: 0.9 },
  { pattern: /employee[_-]?id|staff[_-]?id|badge/i, category: 'employee_id', weight: 0.8 },
  { pattern: /college[_-]?id|student[_-]?id|enrollment|roll[_-]?no/i, category: 'college_id', weight: 0.8 },
  { pattern: /statement|bank/i, category: 'bank', weight: 0.7 },
  { pattern: /cheque|check[_-]?book/i, category: 'cheque', weight: 0.8 },
  { pattern: /tax|form[_-]?16|26as|gst|tds/i, category: 'tax_document', weight: 0.8 },
  { pattern: /salary|payslip|pay[_-]?slip/i, category: 'salary', weight: 0.8 },
  { pattern: /medical|prescription|diagnosis|lab[_-]?report/i, category: 'medical', weight: 0.7 },
  { pattern: /legal|affidavit|agreement|deed/i, category: 'legal', weight: 0.7 },
  { pattern: /confidential|internal|proprietary/i, category: 'confidential', weight: 0.7 },
  { pattern: /id[_-]?card|identity/i, category: 'generic_identity', weight: 0.6 }
];

// MIME types that imply a private document regardless of content.
const DOCUMENT_MIME_TYPES = new Set([
  'application/pdf', 'image/tiff', 'image/x-tiff',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
]);

// Credit-card / ID-card / Aadhaar / PAN cards are all roughly the ISO/IEC 7810
// ID-1 physical aspect ratio (85.6mm x 53.98mm ≈ 1.586). Loose range catches
// screenshots, slight crops, and scans. Portraits and square logos fall well
// outside this window.
const CARD_ASPECT_MIN = 1.35;
const CARD_ASPECT_MAX = 1.85;

// Which categories mandate WHOLE-REGION redaction (never field-level).
const IDENTITY_GROUPS = new Set(['pan', 'aadhaar', 'passport', 'driving_license', 'voter_id', 'employee_id', 'college_id', 'generic_identity']);
const FINANCIAL_GROUPS = new Set(['bank', 'credit_card', 'cheque', 'tax_document', 'salary', 'statement']);
const MEDICAL_GROUPS = new Set(['medical']);
const LEGAL_GROUPS = new Set(['legal']);
const COMMUNICATION_GROUPS = new Set(['private_message', 'confidential']);

/**
 * Human-facing neutral label to replace a redacted document region.
 */
export function redactionLabelFor(category) {
  if (!category) return '[DOCUMENT REDACTED]';
  if (IDENTITY_GROUPS.has(category)) return '[IDENTITY DOCUMENT REDACTED]';
  if (FINANCIAL_GROUPS.has(category)) return '[FINANCIAL DOCUMENT REDACTED]';
  if (MEDICAL_GROUPS.has(category)) return '[MEDICAL DOCUMENT REDACTED]';
  if (LEGAL_GROUPS.has(category)) return '[LEGAL DOCUMENT REDACTED]';
  if (COMMUNICATION_GROUPS.has(category)) return '[PRIVATE CONTENT REDACTED]';
  return '[DOCUMENT REDACTED]';
}

/**
 * Pure helper: classify a width/height pair as card-like or not.
 * Testable without an image.
 */
export function classifyDocumentAspectRatio(width, height) {
  if (!width || !height) return { isCardLike: false, ratio: null };
  const ratio = width / height;
  return {
    ratio,
    isCardLike: ratio >= CARD_ASPECT_MIN && ratio <= CARD_ASPECT_MAX
  };
}

/**
 * Read PNG dimensions straight from the binary header (IHDR chunk), without
 * decoding pixels. Testable under Node without any canvas/WebGPU dependency.
 */
export function readPngDimensions(dataUrl) {
  try {
    const base64 = dataUrl.split(',')[1] || dataUrl;
    let bytes;
    if (typeof atob === 'function') {
      const bin = atob(base64);
      bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    } else {
      bytes = new Uint8Array(Buffer.from(base64, 'base64'));
    }
    const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    for (let i = 0; i < 8; i++) if (bytes[i] !== sig[i]) return null;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const width = view.getUint32(16);
    const height = view.getUint32(20);
    return { width, height };
  } catch {
    return null;
  }
}

/**
 * Analyse extracted OCR/DOM text for document signals.
 */
export function detectDocumentFromText(text) {
  if (!text) return { found: false, category: null, confidence: 0, evidence: [] };
  const evidence = [];

  const panMatches = text.match(PAN_REGEX);
  if (panMatches && panMatches.length) {
    evidence.push({ method: 'pan_pattern', category: 'pan', weight: 0.95, detail: panMatches[0] });
  }

  const ifscMatches = text.match(IFSC_REGEX);
  if (ifscMatches && ifscMatches.length) {
    evidence.push({ method: 'ifsc_pattern', category: 'bank', weight: 0.9, detail: ifscMatches[0] });
  }

  const lower = text.toLowerCase();
  for (const [category, words] of Object.entries(DOCUMENT_KEYWORDS)) {
    for (const w of words) {
      if (lower.includes(w)) {
        evidence.push({ method: 'sensitive_keyword', category, weight: 0.85, detail: w });
        break;
      }
    }
  }

  if (evidence.length === 0) return { found: false, category: null, confidence: 0, evidence };
  return {
    found: true,
    category: evidence[0].category,
    confidence: Math.min(1, Math.max(...evidence.map(e => e.weight)) + 0.05 * (evidence.length - 1)),
    evidence
  };
}

export function detectDocumentFileName(fileName) {
  if (!fileName) return { found: false, category: null, confidence: 0, evidence: [] };
  const evidence = [];
  for (const hint of DOCUMENT_FILE_HINTS) {
    if (hint.pattern.test(fileName)) {
      evidence.push({ method: 'file_name', category: hint.category, weight: hint.weight, detail: fileName });
    }
  }
  if (evidence.length === 0) return { found: false, category: null, confidence: 0, evidence };
  return {
    found: true,
    category: evidence[0].category,
    confidence: Math.min(1, Math.max(...evidence.map(e => e.weight)) + 0.05 * (evidence.length - 1)),
    evidence
  };
}

export function detectDocumentMimeType(mimeType) {
  if (!mimeType) return { found: false, category: null, confidence: 0, evidence: [] };
  if (DOCUMENT_MIME_TYPES.has(mimeType.toLowerCase())) {
    return {
      found: true,
      category: 'document',
      confidence: 0.8,
      evidence: [{ method: 'mime_type', category: 'document', weight: 0.8, detail: mimeType }]
    };
  }
  return { found: false, category: null, confidence: 0, evidence: [] };
}

// --- Aggregation -----------------------------------------------------------

const REDACT_THRESHOLD = 0.7;   // confident sensitive document → redact entirely
const CONFIRM_THRESHOLD = 0.35; // uncertain but suspicious → fail closed (redact + ask user)

/**
 * Combined local sensitive-document classifier.
 *
 * @param {object} input
 * @param {string} [input.imageDataUrl]  - screenshot / image region data URL (PNG)
 * @param {string} [input.ocrText]       - local OCR output (pluggable seam)
 * @param {string} [input.fileName]      - originating file name if any
 * @param {string} [input.altText]       - img[alt] / aria-label text
 * @param {string} [input.mimeType]      - MIME type
 * @param {number} [input.width]         - known pixel width (defaults to PNG header)
 * @param {number} [input.height]        - known pixel height
 * @param {boolean} [input.forceWholeRegion] - set when a companion visual detector already flagged the region
 * @returns {{ decision: 'redact'|'confirm'|'safe', category: string|null, confidence: number, methods: string[], redact: 'whole_region'|'field', label: string|null }}
 */
export function detectSensitiveDocument({
  imageDataUrl,
  ocrText = '',
  fileName = '',
  altText = '',
  mimeType = '',
  width,
  height,
  forceWholeRegion = false
} = {}) {
  const evidence = [];
  const methods = new Set();

  if (ocrText) {
    const r = detectDocumentFromText(ocrText);
    if (r.found) {
      r.evidence.forEach(e => { evidence.push(e); methods.add(e.method); });
    }
  }

  if (altText) {
    const r = detectDocumentFromText(altText);
    if (r.found) {
      r.evidence.forEach(e => { evidence.push({ ...e, method: 'alt_text' }); methods.add('alt_text'); });
    }
  }

  const fname = detectDocumentFileName(fileName);
  if (fname.found) {
    evidence.push(...fname.evidence);
    methods.add('file_name');
  }

  const mime = detectDocumentMimeType(mimeType);
  if (mime.found) {
    evidence.push(...mime.evidence);
    methods.add('mime_type');
  }

  // Aspect-ratio / document-layout analysis (spec method 5).
  const dims = width && height ? { width, height } : (imageDataUrl ? readPngDimensions(imageDataUrl) : null);
  if (dims) {
    const ratioRes = classifyDocumentAspectRatio(dims.width, dims.height);
    if (ratioRes.isCardLike) {
      evidence.push({ method: 'aspect_ratio', category: 'generic_identity', weight: 0.4, detail: ratioRes.ratio.toFixed(3) });
      methods.add('aspect_ratio');
    }
  }

  if (evidence.length === 0 && !forceWholeRegion) {
    return { decision: 'safe', category: null, confidence: 0, methods: [], redact: 'field', label: null };
  }

  const confidence = Math.min(1, Math.max(0, ...evidence.map(e => e.weight)) + 0.05 * (evidence.length - 1));
  const categories = evidence.map(e => e.category);
  const category = categories.find(c => c !== 'generic_identity' && c !== 'document') || categories[0] || 'generic_identity';

  const strongNonAspect = evidence.some(e => e.weight >= 0.7) || forceWholeRegion;
  let decision;
  if (strongNonAspect || confidence >= REDACT_THRESHOLD) {
    decision = 'redact';
  } else if (confidence >= CONFIRM_THRESHOLD) {
    decision = 'confirm'; // fail closed: redact locally AND ask the user
  } else {
    decision = 'safe';
  }

  return {
    decision,
    category,
    confidence,
    methods: [...methods],
    redact: decision === 'safe' ? 'field' : 'whole_region',
    label: decision === 'safe' ? null : redactionLabelFor(category)
  };
}