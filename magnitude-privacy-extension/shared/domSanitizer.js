// shared/domSanitizer.js
//
// Sanitizes DOM/accessibility descriptors before they are serialized for
// transport or logging (spec section 6). The privacy gate classifies
// *sensitivity*, this module *strips values* that must never appear in an
// outgoing representation: input values, password values, hidden values,
// aria-label/alt/placeholder text that itself contains PII, URLs, file names,
// data attributes, and any text node that matched a detector.
//
// The core DOM extractor (content/domExtractor.js) is designed never to read
// field *values* in the first place; this sanitizer is defense-in-depth for
// the labels/metadata it does read (which can legitimately contain PII, e.g.
// aria-label="john.doe@example.com").

import { detectSensitiveText } from './detectors.js';

/**
 * Sanitize a single string. Returns the original string if clean, or a
 * neutral replacement if it contains a sensitive span.
 */
export function sanitizeText(value) {
  if (value === null || value === undefined) return undefined;
  const s = String(value);
  const findings = detectSensitiveText(s);
  if (findings.some(f => f.confidence >= 0.8)) return '[REDACTED]';
  return s;
}

const TO_STRIP_FIELDS = ['value', 'innerText', 'textContent', 'data', 'src', 'href', 'action', 'fileName', 'file_name'];

/**
 * Sanitize a single field descriptor (as produced by domExtractor.js) such
 * that no attribute containing a raw value / PII survives. `selectorPath` is
 * preserved because it is only ever used locally for action execution and is
 * never sent remotely; callers who serialize for transport should call
 * `stripLocalOnlyFields` too.
 */
export function sanitizeDomField(field) {
  const out = { ...field };
  for (const key of TO_STRIP_FIELDS) {
    if (key in out) out[key] = out[key] === undefined || out[key] === null ? out[key] : '[REDACTED]';
  }
  for (const key of ['label', 'placeholder', 'name', 'alt', 'ariaLabel', 'title']) {
    if (out[key] !== undefined) out[key] = sanitizeText(out[key]);
  }
  // Paths/URLs that carry query params or look like a file name with an
  // extension can embed identifiers.
  if (out.href !== undefined) out.href = sanitizeText(out.href);
  return out;
}

/**
 * Remove fields that must never cross the machine boundary.
 */
export function stripLocalOnlyFields(field) {
  const out = { ...field };
  delete out.selectorPath;
  delete out.value;
  delete out.fileDataUrl;
  delete out.fileName;
  return out;
}

/**
 * Sanitize a full DOM snapshot ({ fields, url, title, mediaCandidates })
 * into a transport-safe representation.
 */
export function sanitizeDomSnapshot(snapshot) {
  if (!snapshot) return snapshot;
  const out = {
    ...snapshot,
    fields: (snapshot.fields || []).map(f => stripLocalOnlyFields(sanitizeDomField(f))),
    mediaCandidates: (snapshot.mediaCandidates || []).map(m => stripLocalOnlyFields(sanitizeDomField(m)))
  };
  if (out.url !== undefined) out.url = sanitizeText(out.url);
  if (out.title !== undefined) out.title = sanitizeText(out.title);
  return out;
}