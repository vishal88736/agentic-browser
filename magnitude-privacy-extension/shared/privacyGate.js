// shared/privacyGate.js
//
// Central rule (spec section 8): the LLM is never the sole source of truth
// for a privacy decision. A region/field is treated as sensitive if ANY
// layer flags it:
//   1. Local VLM's own `sensitive` / `sensitiveType` output on an element
//   2. DOM/input-type heuristics (classifyDomField)
//   3. Regex/context detectors over extracted text (detectSensitiveText)
// Uncertain findings are NOT downgraded to "safe" — they stay sensitive
// until a layer actively clears them with high confidence, and even then
// only DOM/deterministic signals (never the VLM alone) can clear a flag.

import { detectSensitiveText, classifyDomField } from './detectors.js';

const UNCERTAIN_THRESHOLD = 0.6;

/**
 * @param {object} input
 * @param {object} input.perception - LocalPerceptionResult from the local VLM
 *   { elements: [{ type, label, text, bbox, sensitive, sensitiveType, confidence }], pageDescription }
 * @param {object[]} [input.domFields] - field descriptors from content/domExtractor.js
 * @param {object} [input.taskContext] - { instruction, credentialRoles }
 * @returns {PrivacyDecision}
 */
export function runPrivacyGate({ perception, domFields = [], taskContext = {} }) {
  const sensitiveRegions = [];
  const allowedData = [];
  const blockedData = [];

  // Layer 1 + 3: VLM elements + regex over their extracted text
  for (const el of perception?.elements || []) {
    const textFindings = el.text ? detectSensitiveText(el.text) : [];
    const vlmFlagged = !!el.sensitive || (el.confidence !== undefined && el.confidence < UNCERTAIN_THRESHOLD && el.sensitive !== false);

    const isSensitive = vlmFlagged || textFindings.length > 0;

    if (isSensitive) {
      const category = el.sensitiveType || textFindings[0]?.category || 'unknown';
      sensitiveRegions.push({
        bbox: el.bbox,
        category,
        source: vlmFlagged ? 'vlm' : 'regex',
        confidence: Math.max(el.confidence ?? 0, ...textFindings.map(f => f.confidence), 0.5)
      });
      blockedData.push({
        label: el.label || el.type,
        category,
        // NEVER include el.text / raw value here.
      });
    } else {
      allowedData.push({
        type: el.type,
        label: el.label,
        // Non-sensitive descriptive text only (e.g. button labels like
        // "Submit") may pass through — still capped defensively.
        text: safeDescriptiveText(el.text)
      });
    }
  }

  // Layer 2: DOM semantics — can only ADD sensitivity, never remove it.
  for (const field of domFields) {
    const { sensitive, category, reasons } = classifyDomField(field);
    if (sensitive) {
      sensitiveRegions.push({
        bbox: field.bbox,
        category: category || 'unknown',
        source: 'dom',
        confidence: 0.9,
        reasons
      });
      blockedData.push({ label: field.label || field.name, category });
    } else {
      allowedData.push({ type: 'dom_field', label: field.label || field.name, role: field.role });
    }
  }

  const sanitizedContext = buildSanitizedContext({ perception, sensitiveRegions, allowedData, taskContext });

  return {
    sanitizedContext,
    sensitiveRegions,
    blockedData,
    allowedData
  };
}

// Cap length and strip anything that itself matches a detector, in case
// a "safe" label field accidentally contains a value (e.g. a mis-tagged
// placeholder like "Enter Aadhaar: 1234...").
function safeDescriptiveText(text) {
  if (!text) return undefined;
  const findings = detectSensitiveText(text);
  if (findings.length > 0) return '[REDACTED]';
  return text.length > 120 ? text.slice(0, 120) + '…' : text;
}

/**
 * Produces the natural-language summary that IS allowed to reach the
 * remote reasoning model — describing structure/intent, never values.
 * Matches the spec's example:
 *   "This page contains an Aadhaar upload field, a PAN field, and a
 *    Submit button."
 */
function buildSanitizedContext({ perception, sensitiveRegions, allowedData, taskContext }) {
  const sensitiveSummary = summarizeCategories(sensitiveRegions.map(r => r.category));
  const nonSensitiveSummary = allowedData
    .filter(d => d.text || d.label)
    .slice(0, 25)
    .map(d => safeDescriptiveText(d.label || d.text))
    .filter(Boolean)
    .join(', ');

  const parts = [];
  if (perception?.pageDescription) parts.push(safeDescriptiveText(perception.pageDescription) ?? '');
  if (sensitiveSummary.length) {
    parts.push(`This page contains the following sensitive field types (values withheld): ${sensitiveSummary.join(', ')}.`);
  }
  if (nonSensitiveSummary) {
    parts.push(`Other visible non-sensitive elements: ${nonSensitiveSummary}.`);
  }
  if (taskContext?.instruction) {
    parts.push(`User task: ${taskContext.instruction}`);
  }
  return parts.join(' ');
}

function summarizeCategories(categories) {
  return [...new Set(categories)];
}
