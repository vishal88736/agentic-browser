// background/router.js

const DEFAULT_CONFIG = {
  LOCAL_FIRST: true,
  ALLOW_REMOTE_REASONING: true,
  PRIVACY_MODE: 'strict', // 'strict' | 'balanced'
  LOCAL_VLM_MODEL: 'onnx-community/Florence-2-base-ft', // verify current transformers.js-compatible id before shipping; see README
  LOCAL_VLM_DEVICE: 'auto',
  LOCAL_VLM_DTYPE: 'auto',
  REMOTE_ENDPOINT: '', // OpenAI-generic compatible chat/completions URL; empty = remote disabled
  REMOTE_API_KEY: '',
  MAX_STEPS: 25,
  CHANGE_DETECTION_THRESHOLD: 0.02 // fraction of pixels changed to trigger re-perception
};

export async function getConfig() {
  const stored = await chrome.storage.local.get('config');
  return { ...DEFAULT_CONFIG, ...(stored.config || {}) };
}

export async function setConfig(partial) {
  const current = await getConfig();
  const next = { ...current, ...partial };
  await chrome.storage.local.set({ config: next });
  return next;
}

/**
 * Decide whether a task step needs remote reasoning at all, per spec
 * section 13's routing diagram. Simple heuristic: if the local plan
 * confidently identifies the next action, stay local; otherwise, and
 * only if remote reasoning is enabled, escalate with sanitized context.
 */
export function decideRoute({ localConfidence, config }) {
  if (config.LOCAL_FIRST && localConfidence >= 0.7) {
    return 'local';
  }
  if (config.ALLOW_REMOTE_REASONING && config.REMOTE_ENDPOINT) {
    return 'remote';
  }
  return 'local'; // never silently fail closed into "do nothing" — local best-effort
}

// --- Cheap change detection (spec section 15) --------------------------
// Avoids re-running the (comparatively expensive) local VLM on every tiny
// DOM mutation or scroll jitter. Downsamples the screenshot and compares
// a small perceptual hash rather than diffing full-resolution pixels.

let lastHash = null;
let lastPerception = null;

export async function shouldReanalyze(dataUrl, threshold) {
  const hash = await cheapImageHash(dataUrl);
  if (lastHash === null) {
    lastHash = hash;
    return true;
  }
  const diff = hammingDistanceNormalized(hash, lastHash);
  lastHash = hash;
  return diff > threshold;
}

export function cachePerception(perception) {
  lastPerception = perception;
}

export function getCachedPerception() {
  return lastPerception;
}

async function cheapImageHash(dataUrl) {
  const blob = await (await fetch(dataUrl)).blob();
  const bitmap = await createImageBitmap(blob);
  const size = 16;
  const canvas = new OffscreenCanvas(size, size);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, 0, 0, size, size);
  const { data } = ctx.getImageData(0, 0, size, size);

  // Average-hash over grayscale.
  const gray = [];
  for (let i = 0; i < data.length; i += 4) {
    gray.push((data[i] + data[i + 1] + data[i + 2]) / 3);
  }
  const avg = gray.reduce((a, b) => a + b, 0) / gray.length;
  return gray.map(v => (v > avg ? 1 : 0));
}

function hammingDistanceNormalized(a, b) {
  let diff = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) diff++;
  return diff / a.length;
}
