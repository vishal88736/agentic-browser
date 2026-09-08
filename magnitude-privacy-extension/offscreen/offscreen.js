// offscreen/offscreen.js
import { loadModel, runLocalPerception } from './localVLM.js';

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
      } else {
        sendResponse({ ok: false, error: `Unknown message type: ${msg.type}` });
      }
    } catch (err) {
      sendResponse({ ok: false, error: String(err && err.message || err) });
    }
  })();

  return true; // keep the message channel open for the async response
});
