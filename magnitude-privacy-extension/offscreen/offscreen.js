// offscreen/offscreen.js
import { loadModel, runLocalPerception } from './localVLM.js';
import { detectAllVisualSensitive } from '../shared/visualDetectors.js';

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.target !== 'offscreen') return false;

  (async () => {
    try {
      if (msg.type === 'LOAD_MODEL') {
        const result = await loadModel(msg.config);
        sendResponse({ ok: true, result });
      } else if (msg.type === 'RUN_PERCEPTION') {
        const perception = await runLocalPerception(msg.screenshot, { domFieldsHint: msg.domFieldsHint });
        sendResponse({ ok: true, perception });
      } else if (msg.type === 'RUN_VISUAL_DETECT') {
        // Decode the screenshot locally and run the CV detectors (QR, barcode,
        // face, signature) over its pixels. The image never leaves this device.
        const blob = await (await fetch(msg.screenshot)).blob();
        const bitmap = await createImageBitmap(blob);
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        const ctx = canvas.getContext('2d');
        ctx.drawImage(bitmap, 0, 0);
        const img = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
        const regions = detectAllVisualSensitive(img.data, img.width, img.height);
        sendResponse({ ok: true, regions });
      } else {
        sendResponse({ ok: false, error: `Unknown message type: ${msg.type}` });
      }
    } catch (err) {
      sendResponse({ ok: false, error: String(err && err.message || err) });
    }
  })();

  return true; // keep the message channel open for the async response
});
