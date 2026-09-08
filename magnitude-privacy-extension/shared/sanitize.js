// shared/sanitize.js
// Runs wherever OffscreenCanvas is available (offscreen document, or the
// service worker via OffscreenCanvas — supported in MV3 workers).

/**
 * Redacts sensitiveRegions out of a screenshot before it may ever be sent
 * to a remote model. Input/output are data URLs (PNG).
 *
 * @param {string} dataUrl
 * @param {Array<{bbox:{x:number,y:number,width:number,height:number}}>} sensitiveRegions
 * @returns {Promise<string>} sanitized data URL
 */
export async function sanitizeScreenshot(dataUrl, sensitiveRegions) {
  const blob = await (await fetch(dataUrl)).blob();
  const bitmap = await createImageBitmap(blob);

  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, 0, 0);

  ctx.fillStyle = '#000000';
  for (const region of sensitiveRegions) {
    if (!region.bbox) continue;
    const { x, y, width, height } = region.bbox;
    // Pad slightly so anti-aliased text edges near the box are also covered.
    ctx.fillRect(x - 2, y - 2, width + 4, height + 4);
  }

  const outBlob = await canvas.convertToBlob({ type: 'image/png' });
  return await blobToDataUrl(outBlob);
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

/**
 * Strips any raw values from an object graph before it's serialized for
 * logging or network transport, keeping only category labels. Defensive
 * belt-and-braces on top of the privacy gate's own filtering — logging
 * code should call this before console.log-ing anything perception- or
 * action-related.
 */
export function redactForLog(obj) {
  const SENSITIVE_KEYS = new Set(['content', 'value', 'text', 'credential', 'file', 'password']);
  const seen = new WeakSet();
  function walk(node) {
    if (node === null || typeof node !== 'object') return node;
    if (seen.has(node)) return '[circular]';
    seen.add(node);
    if (Array.isArray(node)) return node.map(walk);
    const out = {};
    for (const [k, v] of Object.entries(node)) {
      out[k] = SENSITIVE_KEYS.has(k) ? '[REDACTED]' : walk(v);
    }
    return out;
  }
  return walk(obj);
}
