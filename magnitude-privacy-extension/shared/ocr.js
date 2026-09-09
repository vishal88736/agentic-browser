// shared/ocr.js
//
// LOCAL OCR integration boundary + fail-closed policy (spec section 5).
//
// OCR must run locally and return text WITH bounding boxes so the redaction
// layer can cover the exact region. This module defines:
//   - the result contract ({ text, confidence, bbox })
//   - `analyzeOcrResult` / `analyzeOcrResults`: feed OCR text bbox into the
//     deterministic detectors to produce redaction regions (never raw text)
//   - `ocrFailClosed`: the policy when OCR is unavailable on a suspicious image
//
// The actual engine (Tesseract.js, TrOCR via transformers.js, or a WebGPU
// Vision-Transformer CTC head) plugs in behind these functions. Raw OCR text is
// NEVER returned to the network path by design — only detection decisions.

import { detectSensitiveText } from './detectors.js';

const HIGH_SIGNAL = new Set(['pan', 'email', 'dob', 'ifsc']);

/**
 * Analyse a single OCR line. Returns a redaction decision only — the raw text
 * is deliberately dropped from the result so it cannot be forwarded.
 *
 * @param {{text:string, confidence?:number, bbox?:{x:number,y:number,width:number,height:number}}} ocr
 */
export function analyzeOcrResult({ text, confidence = 0, bbox }) {
  if (!text) return { sensitive: false };
  const findings = detectSensitiveText(text);
  const highSignal = findings.filter(f => HIGH_SIGNAL.has(f.category) || f.confidence >= 0.8);

  if (highSignal.length === 0) return { sensitive: false, findingsCount: findings.length };

  const f = highSignal[0];
  return {
    sensitive: true,
    category: f.category,
    confidence: confidence || f.confidence,
    redactRegion: bbox || null,
    // The number of findings is safe to expose; the matched text is not.
    findingsCount: highSignal.length
  };
}

/**
 * Analyse an array of OCR lines (whole-page OCR) and reduce to redaction
 * regions, categorized. Raw text is not included in the output.
 */
export function analyzeOcrResults(results = []) {
  const regions = [];
  for (const r of results) {
    const decision = analyzeOcrResult(r);
    if (decision.sensitive && decision.redactRegion) {
      regions.push({ category: decision.category, bbox: decision.redactRegion, confidence: decision.confidence });
    }
  }
  return regions;
}

/**
 * Fail-closed policy: if an image/detector says "potentially sensitive" but
 * local OCR is unavailable, we CANNOT prove the image is safe, so the region
 * must be redacted in full and reported UNVERIFIED — never sent.
 *
 * @param {{ocrAvailable:boolean, potentiallySensitiveImage:boolean}} input
 */
export function ocrFailClosed({ ocrAvailable, potentiallySensitiveImage }) {
  if (potentiallySensitiveImage && !ocrAvailable) {
    return {
      state: 'UNVERIFIED',
      redactEntireRegion: true,
      reason: 'local OCR unavailable on a potentially sensitive image — redacting whole region rather than risking leakage'
    };
  }
  return { state: 'SAFE', redactEntireRegion: false, reason: 'OCR available or image not suspicious' };
}