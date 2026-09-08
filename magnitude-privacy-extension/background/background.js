// background/background.js
import { getConfig, decideRoute, shouldReanalyze, cachePerception, getCachedPerception } from './router.js';
import { callRemoteReasoner } from './remoteClient.js';
import { runPrivacyGate } from '../shared/privacyGate.js';
import { sanitizeScreenshot, redactForLog } from '../shared/sanitize.js';
import { validateAction, LOCAL_ONLY_VARIANTS } from '../shared/actionSchema.js';
import { decryptVault } from '../shared/crypto.js';

let offscreenReady = null;
let taskState = { running: false, log: [] };

// --- offscreen document lifecycle --------------------------------------

async function ensureOffscreen() {
  if (offscreenReady) return offscreenReady;
  offscreenReady = (async () => {
    const existing = await chrome.runtime.getContexts?.({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
    if (!existing || existing.length === 0) {
      await chrome.offscreen.createDocument({
        url: 'offscreen/offscreen.html',
        reasons: ['WORKERS'], // model inference; DOM/canvas needed for sanitize too
        justification: 'Runs the local VLM (transformers.js) for on-device visual perception.'
      });
    }
  })();
  return offscreenReady;
}

async function offscreenCall(msg) {
  await ensureOffscreen();
  return chrome.runtime.sendMessage({ target: 'offscreen', ...msg });
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

  await offscreenCall({
    type: 'LOAD_MODEL',
    config: {
      modelId: config.LOCAL_VLM_MODEL,
      device: config.LOCAL_VLM_DEVICE,
      dtype: config.LOCAL_VLM_DTYPE
    }
  });
  log({ event: 'model_loaded', model: config.LOCAL_VLM_MODEL });

  for (let step = 0; step < config.MAX_STEPS && taskState.running; step++) {
    const screenshot = await chrome.tabs.captureVisibleTab(undefined, { format: 'png' });
    const domSnapshot = await chrome.tabs.sendMessage(tabId, { type: 'SNAPSHOT_DOM' });

    const needsReanalysis = await shouldReanalyze(screenshot, config.CHANGE_DETECTION_THRESHOLD);
    let perception;
    if (needsReanalysis) {
      const result = await offscreenCall({
        type: 'RUN_PERCEPTION',
        screenshot,
        domFieldsHint: domSnapshot.fields
      });
      if (!result.ok) throw new Error(result.error);
      perception = result.perception;
      cachePerception(perception);
    } else {
      perception = getCachedPerception();
      log({ event: 'reused_cached_perception' });
    }

    const decision = runPrivacyGate({
      perception,
      domFields: domSnapshot.fields,
      taskContext: { instruction }
    });

    log({
      event: 'privacy_gate',
      sensitiveCategories: [...new Set(decision.sensitiveRegions.map(r => r.category))],
      blockedCount: decision.blockedData.length,
      allowedCount: decision.allowedData.length
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
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          await executeAction(action, tabId);
          success = true;
          break; // Action succeeded
        } catch (err) {
          lastErr = err;
          log({ event: 'action_error', attempt, message: String(err) });
          await new Promise(r => setTimeout(r, 1000 * attempt)); // exponential backoff
        }
      }

      if (!success) {
        log({ event: 'action_failed_final', message: String(lastErr) });
        break; // Stop execution of the current plan if an action consistently fails
      }
      
      log({ event: 'action_executed', variant: action.variant, redactedPayload: LOCAL_ONLY_VARIANTS.has(action.variant) ? '[local-only, not logged]' : action });

      // Visual diffing for stability - Wait a moment for DOM/Network to settle
      await new Promise(r => setTimeout(r, 1000));
      const postActionScreenshot = await chrome.tabs.captureVisibleTab(undefined, { format: 'png' });
      const visuallyChanged = await shouldReanalyze(postActionScreenshot, config.CHANGE_DETECTION_THRESHOLD);
      if (!visuallyChanged) {
        log({ event: 'action_warning', message: 'Screen visually unchanged after action, action may have had no effect.' });
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
      await chrome.tabs.sendMessage(tabId, { type: 'ACTION_CLICK_ELEMENT', target: action.target }); // scroll-into-view fallback
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
  return false;
});
