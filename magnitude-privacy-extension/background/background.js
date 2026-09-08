// background/background.js
import { getConfig, decideRoute, shouldReanalyze, cachePerception, getCachedPerception } from './router.js';
import { callRemoteReasoner } from './remoteClient.js';
import { runPrivacyGate } from '../shared/privacyGate.js';
import { sanitizeScreenshot, redactForLog } from '../shared/sanitize.js';
import { validateAction, LOCAL_ONLY_VARIANTS } from '../shared/actionSchema.js';
import { detectSensitiveDocument } from '../shared/documentDetector.js';
import { decideRecovery, interpretOutcome } from '../shared/actionSafety.js';
import { decryptVault } from '../shared/crypto.js';

let offscreenReady = null;
let taskState = { running: false, log: [] };
let localVlmAvailable = false; // set to true only after successful LOAD_MODEL

// --- offscreen document lifecycle --------------------------------------

async function ensureOffscreen() {
  if (offscreenReady) return offscreenReady;
  // Store promise but reset on failure so a retry is possible.
  const p = (async () => {
    const existing = await chrome.runtime.getContexts?.({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
    if (!existing || existing.length === 0) {
      await chrome.offscreen.createDocument({
        url: 'offscreen/offscreen.html',
        // BLOBS: needed for fetch(dataUrl)/createImageBitmap in sanitize.js
        // DOM_SCRAPING: needed for OffscreenCanvas and transformers.js model inference
        reasons: ['BLOBS', 'DOM_SCRAPING'],
        justification: 'Runs the local VLM (transformers.js) for on-device visual perception and privacy-safe screenshot redaction.'
      });
    }
  })();
  p.catch(() => { offscreenReady = null; }); // allow retry on failure
  offscreenReady = p;
  return offscreenReady;
}

async function offscreenCall(msg) {
  await ensureOffscreen();
  // The offscreen document uses an ES module script, which may take a few ms to execute
  // and register its listener AFTER createDocument resolves. Retry if undefined.
  for (let i = 0; i < 5; i++) {
    const response = await chrome.runtime.sendMessage({ target: 'offscreen', ...msg });
    if (response !== undefined) {
      return response;
    }
    // wait 200ms before retrying
    await new Promise(r => setTimeout(r, 200));
  }
  if (chrome.runtime.lastError) {
    throw new Error(chrome.runtime.lastError.message);
  }
  throw new Error('offscreenCall returned undefined (channel closed early or script not ready)');
}

// --- credential vault (local only, never leaves the extension) --------
// NOTE: chrome.storage.local is unencrypted at rest by default. For a
// production build, wrap this with the WebCrypto-based encryption layer
// noted in the README's "still missing for production" section.

async function resolveCredential(role) {
  const { vault } = await chrome.storage.local.get('vault');
  if (!vault) throw new Error('Vault is empty.');

  const { masterPassword } = await chrome.storage.session.get('masterPassword');
  if (!masterPassword) {
    throw new Error('Vault is locked. Please enter your Master Password in the extension popup.');
  }

  const decrypted = await decryptVault(masterPassword, vault);
  if (!(role in decrypted)) {
    throw new Error(`No local credential configured for role "${role}"`);
  }
  return decrypted[role];
}

// --- logging (always redacted) -----------------------------------------

function log(entry) {
  const safe = redactForLog(entry);
  taskState.log.push({ t: Date.now(), ...safe });
  chrome.runtime.sendMessage({ type: 'TASK_LOG', entry: safe }).catch(() => {});
}

// --- main task loop ------------------------------------------------------

async function runTask(instruction, tabId) {
  taskState = { running: true, log: [] };
  const config = await getConfig();

  const loadResult = await offscreenCall({
    type: 'LOAD_MODEL',
    config: {
      modelId: config.LOCAL_VLM_MODEL,
      device: config.LOCAL_VLM_DEVICE,
      dtype: config.LOCAL_VLM_DTYPE
    }
  });
  if (!loadResult.ok) {
    log({ event: 'vlm_load_warning', message: `Local VLM unavailable: ${loadResult.error}. Continuing with DOM-only perception + remote reasoning.` });
    localVlmAvailable = false;
  } else {
    localVlmAvailable = true;
    log({ event: 'model_loaded', model: config.LOCAL_VLM_MODEL });
  }

  for (let step = 0; step < config.MAX_STEPS && taskState.running; step++) {
    const screenshot = await chrome.tabs.captureVisibleTab(undefined, { format: 'png' });
    const domSnapshot = await chrome.tabs.sendMessage(tabId, { type: 'SNAPSHOT_DOM' });

    const needsReanalysis = await shouldReanalyze(screenshot, config.CHANGE_DETECTION_THRESHOLD);
    let perception;
    if (localVlmAvailable && needsReanalysis) {
      const result = await offscreenCall({
        type: 'RUN_PERCEPTION',
        screenshot,
        domFieldsHint: domSnapshot.fields
      });
      if (!result.ok) {
        log({ event: 'vlm_perception_warning', message: result.error });
        perception = domOnlyPerception(domSnapshot);
      } else {
        perception = result.perception;
        cachePerception(perception);
      }
    } else if (localVlmAvailable) {
      perception = getCachedPerception() || domOnlyPerception(domSnapshot);
      log({ event: 'reused_cached_perception' });
    } else {
      // No local VLM — build a minimal perception from DOM fields only
      perception = domOnlyPerception(domSnapshot);
    }

    const decision = runPrivacyGate({
      perception,
      domFields: domSnapshot.fields,
      taskContext: { instruction }
    });

    // Local sensitive-document detection (PAN card / Aadhaar / ID / PDF / …).
    // Any detected document region is appended to the redaction set so its
    // ENTIRE region is removed from the outgoing screenshot (spec §6/§7).
    const documentResult = await detectSensitiveDocuments(domSnapshot, screenshot);
    if (documentResult.regions.length) {
      decision.sensitiveRegions.push(...documentResult.regions);
      decision.blockedData.push(...documentResult.blocked);
    }

    // Local CV pass over screenshot pixels: QR, barcode, face, signature.
    const visualResult = await offscreenCall({ type: 'RUN_VISUAL_DETECT', screenshot }).catch(() => ({ ok: false }));
    if (visualResult.ok && visualResult.regions) {
      for (const r of visualResult.regions) {
        decision.sensitiveRegions.push({
          bbox: r.bbox,
          category: r.category,
          source: 'visual_cv',
          confidence: r.confidence,
          mode: r.category === 'face' ? 'blur' : 'redact'
        });
        decision.blockedData.push({ label: r.category, category: r.category });
      }
    }

    log({
      event: 'privacy_gate',
      sensitiveCategories: [...new Set(decision.sensitiveRegions.map(r => r.category))],
      blockedCount: decision.blockedData.length,
      allowedCount: decision.allowedData.length,
      detectedDocuments: documentResult.documents,
      visualFindings: visualResult.ok ? visualResult.regions.map(r => r.category) : []
    });

    // Try a purely local heuristic plan first (spec section 13 "simple task -> local").
    let plan = planLocally({ instruction, decision, domSnapshot });
    let route = 'local';

    if (!plan) {
      route = decideRoute({ localConfidence: 0, config });
      if (route === 'remote') {
        const sanitizedScreenshot = config.PRIVACY_MODE === 'strict' || decision.sensitiveRegions.length
          ? await sanitizeScreenshot(screenshot, decision.sensitiveRegions)
          : screenshot;

        plan = await callRemoteReasoner({
          endpoint: config.REMOTE_ENDPOINT,
          apiKey: config.REMOTE_API_KEY,
          model: config.REMOTE_MODEL || 'gpt-4o-mini',
          sanitizedContext: decision.sanitizedContext,
          sanitizedScreenshot,
          actionSchemaDescription: 'Allowed variants: mouse:click, keyboard:type, mouse:scroll, browser:navigate, browser:tab:switch, browser:tab:new, browser:upload_file, local:fill_credential.'
        });
        log({ event: 'remote_plan_received', actionCount: plan.actions.length, sanitizedContextPreview: decision.sanitizedContext.slice(0, 200) });
      } else {
        log({ event: 'no_route_available', reason: 'remote disabled/unconfigured and no local plan' });
        break;
      }
    }

    for (const action of plan.actions) {
      validateAction(action);

      let success = false;
      let lastErr = null;

      // Action-aware retry (spec section 12). Sensitive/destructive actions
      // are never re-executed blindly; they fail closed and surface for
      // confirmation. Safe actions may retry with fresh state.
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          await executeAction(action, tabId);
          success = true;
          break;
        } catch (err) {
          lastErr = err;
          log({ event: 'action_error', attempt, variant: action.variant, message: String(err) });

          // Re-capture fresh local state to check whether the action already
          // succeeded (e.g. a submit that errored on the response parse).
          const fresh = await chrome.tabs.sendMessage(tabId, { type: 'SNAPSHOT_DOM' }).catch(() => null);
          const postShot = await chrome.tabs.captureVisibleTab(undefined, { format: 'png' }).catch(() => null);
          const alreadySucceeded = fresh && postShot
            ? await shouldReanalyze(postShot, config.CHANGE_DETECTION_THRESHOLD)
            : false;

          const recovery = decideRecovery(action, { alreadySucceeded, attempt, maxAttempts: 3 });
          if (recovery.action !== 'retry') {
            if (recovery.action === 'confirm') {
              log({ event: 'action_needs_confirmation', variant: action.variant, reason: recovery.reason });
            } else {
              log({ event: 'action_failed_final', variant: action.variant, message: String(lastErr), reason: recovery.reason });
            }
            break;
          }
          await new Promise(r => setTimeout(r, 1000 * attempt)); // exponential backoff
        }
      }

      if (!success) {
        break; // Stop execution of the current plan if an action consistently fails
      }

      log({ event: 'action_executed', variant: action.variant, redactedPayload: LOCAL_ONLY_VARIANTS.has(action.variant) ? '[local-only, not logged]' : action });

      // Visual + DOM diffing for verification (spec section 11): confirm the
      // action actually changed state rather than assuming success.
      await new Promise(r => setTimeout(r, 1000));
      const postActionScreenshot = await chrome.tabs.captureVisibleTab(undefined, { format: 'png' });
      const visuallyChanged = await shouldReanalyze(postActionScreenshot, config.CHANGE_DETECTION_THRESHOLD);
      const outcome = interpretOutcome({ visuallyChanged });
      if (!outcome.success) {
        log({ event: 'action_warning', variant: action.variant, message: 'No observable change after action; it may have had no effect.' });
      }
    }

    if (plan.done) {
      log({ event: 'task_complete' });
      break;
    }
  }

  taskState.running = false;
}

/**
 * Local document detection pipeline (spec critical PAN-card requirement).
 * Inspects every image/document candidate in the DOM (img/canvas/object/file
 * input) using metadata signals (alt text, file name, MIME type, aspect
 * ratio) plus any OCR text the local VLM/OCR layer surfaced. A detected
 * document yields a full-region redaction entry; nothing is sent remotely.
 */
async function detectSensitiveDocuments(domSnapshot, screenshot) {
  const regions = [];
  const blocked = [];
  const documents = [];
  const candidates = domSnapshot.mediaCandidates || [];

  for (const cand of candidates) {
    if (!cand.bbox || !cand.visible) continue;

    const res = detectSensitiveDocument({
      imageDataUrl: undefined, // pixel OCR is the local VLM/OCR seam
      ocrText: cand.ocrText,
      fileName: cand.fileName,
      altText: cand.alt || cand.title,
      mimeType: cand.mimeType,
      width: cand.bbox.width,
      height: cand.bbox.height
    });

    if (res.decision === 'redact' || res.decision === 'confirm') {
      // Redact the ENTIRE document/card region, not just a text span.
      regions.push({
        bbox: cand.bbox,
        category: res.category || 'identity_document',
        source: 'document_detector',
        confidence: res.confidence,
        decision: res.decision
      });
      blocked.push({ label: cand.alt || cand.title || cand.tag, category: res.category || 'identity_document' });
      documents.push({ tag: cand.tag, category: res.category, confidence: res.confidence, methods: res.methods });
    }
  }

  return { regions, blocked, documents };
}

/**
 * Fallback when local VLM is unavailable: build a minimal perception
 * object purely from the DOM snapshot so the privacy gate and remote
 * reasoner still have structured context to work with.
 */
function domOnlyPerception(domSnapshot) {
  const elements = (domSnapshot.fields || []).map(f => ({
    type: f.role || f.tag || 'element',
    label: f.label || f.name || f.placeholder,
    text: f.label || f.placeholder,
    bbox: f.bbox,
    sensitive: false,  // DOM layer in privacyGate will re-classify
    confidence: 0.8
  }));
  return {
    elements,
    pageDescription: `Page: ${domSnapshot.title || ''} (${domSnapshot.url || ''})`
  };
}

/**
 * Minimal local-only planner: handles the common "fill a known sensitive
 * field with a locally-stored credential" case entirely on-device, with
 * zero network calls, per spec section 9. Anything more open-ended falls
 * through to remote reasoning (if enabled).
 */
function planLocally({ instruction, decision, domSnapshot }) {
  const lower = instruction.toLowerCase();
  const actions = [];

  for (const field of domSnapshot.fields) {
    if (!field.visible || field.disabled) continue;
    const label = (field.label || field.name || field.placeholder || '').toLowerCase();
    if (!label) continue;

    for (const region of decision.sensitiveRegions) {
      if (region.source !== 'dom') continue;
      // crude match: does the instruction reference this field's category?
    }

    if (lower.includes('aadhaar') && label.includes('aadhaar') && field.inputType === 'file') {
      actions.push({ variant: 'browser:upload_file', target: { selectorPath: field.selectorPath }, credentialRole: 'aadhaar_document' });
    } else if (lower.includes('aadhaar') && label.includes('aadhaar')) {
      actions.push({ variant: 'local:fill_credential', target: { selectorPath: field.selectorPath }, credentialRole: 'aadhaar_number' });
    } else if (field.inputType === 'password') {
      actions.push({ variant: 'local:fill_credential', target: { selectorPath: field.selectorPath }, credentialRole: 'password' });
    }
  }

  if (actions.length === 0) return null;
  return { actions, done: false, confidence: 0.9 };
}

async function executeAction(action, tabId) {
  switch (action.variant) {
    case 'mouse:click':
    case 'mouse:double_click':
      await clickAtCoordinate(tabId, action.x, action.y, action.variant === 'mouse:double_click');
      break;
    case 'keyboard:type':
      await chrome.tabs.sendMessage(tabId, { type: 'ACTION_TYPE', target: action.target, content: action.content });
      break;
    case 'mouse:scroll':
      await chrome.tabs.sendMessage(tabId, { type: 'ACTION_SCROLL', target: action.target, deltaX: action.deltaX || 0, deltaY: action.deltaY || 300 });
      break;
    case 'browser:navigate':
      await chrome.tabs.update(tabId, { url: action.url });
      await waitForTabLoad(tabId);
      break;
    case 'browser:tab:new':
      await chrome.tabs.create({ url: action.url || 'about:blank' });
      break;
    case 'local:fill_credential': {
      const cred = await resolveCredential(action.credentialRole);
      // The resolved value is sent over the (same-machine) runtime
      // messaging channel to the content script and NEVER touches
      // background's own log/network code paths.
      await chrome.tabs.sendMessage(tabId, { type: 'ACTION_TYPE', target: action.target, content: cred.value });
      break;
    }
    case 'browser:upload_file': {
      const cred = await resolveCredential(action.credentialRole);
      await chrome.scripting.executeScript({
        target: { tabId },
        func: injectFile,
        args: [action.target.selectorPath, cred.fileDataUrl, cred.fileName]
      });
      break;
    }
    default:
      throw new Error(`Unsupported action variant for execution: ${action.variant}`);
  }
}

// Runs in the page context via chrome.scripting.executeScript so the file
// bytes never pass through background.js's message bus/log code.
function injectFile(selectorPath, fileDataUrl, fileName) {
  const el = document.querySelector(selectorPath);
  if (!el) return;
  fetch(fileDataUrl)
    .then(r => r.blob())
    .then(blob => {
      const file = new File([blob], fileName, { type: blob.type });
      const dt = new DataTransfer();
      dt.items.add(file);
      el.files = dt.files;
      el.dispatchEvent(new Event('change', { bubbles: true }));
    });
}

async function clickAtCoordinate(tabId, x, y, doubleClick) {
  await chrome.debugger.attach({ tabId }, '1.3');
  try {
    const params = { type: 'mousePressed', x, y, button: 'left', clickCount: doubleClick ? 2 : 1 };
    await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', params);
    await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', { ...params, type: 'mouseReleased' });
  } finally {
    await chrome.debugger.detach({ tabId }).catch(() => {});
  }
}

function waitForTabLoad(tabId) {
  return new Promise(resolve => {
    function listener(id, info) {
      if (id === tabId && info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

// --- messaging entry points ---------------------------------------------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'PRELOAD_MODEL') {
    (async () => {
      try {
        const result = await offscreenCall({
          type: 'LOAD_MODEL',
          config: { modelId: msg.modelId, device: msg.device, dtype: msg.dtype }
        });
        if (result.ok) {
          localVlmAvailable = true;
          sendResponse({ ok: true });
        } else {
          sendResponse({ ok: false, error: result.error });
        }
      } catch (e) {
        sendResponse({ ok: false, error: String(e.message || e) });
      }
    })();
    return true; // async response
  }
  if (msg.type === 'START_TASK') {
    (async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      runTask(msg.instruction, tab.id).catch(err => log({ event: 'error', message: String(err) }));
    })();
    sendResponse({ ok: true });
    return false;
  }
  if (msg.type === 'STOP_TASK') {
    taskState.running = false;
    sendResponse({ ok: true });
    return false;
  }
  if (msg.type === 'GET_TASK_LOG') {
    sendResponse({ log: taskState.log, running: taskState.running });
    return false;
  }
  // Do not return false explicitly for messages we don't handle (like target: 'offscreen')
  // as it can prematurely close the message channel in MV3.
});
