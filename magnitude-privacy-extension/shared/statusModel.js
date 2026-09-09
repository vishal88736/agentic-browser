// shared/statusModel.js
//
// Pure UI state model. Maps runtime signals into display-ready status objects,
// pipeline step states, sanitized activity summaries, and safe demo data. This
// module has NO DOM / chrome dependencies so it can be unit-tested in Node, and
// the popup/options pages consume it directly to render honest runtime state.
//
// GUARANTEE: nothing returned here ever contains raw sensitive values. Only
// counts, categories, and neutral labels are produced.

import { detectSensitiveText } from './detectors.js';
import { detectSensitiveDocument, redactionLabelFor } from './documentDetector.js';

export const STATUS_LEVELS = {
  PROTECTED: 'protected',
  PROCESSING: 'processing',
  ATTENTION: 'attention',
  BLOCKED: 'blocked',
  MODEL_UNAVAILABLE: 'model_unavailable'
};

export const MODEL_STATES = {
  READY: 'ready',
  LOADING: 'loading',
  UNAVAILABLE: 'unavailable',
  NOT_CONFIGURED: 'not_configured'
};

/**
 * Compute an overall protection status from runtime signals.
 *
 * @param {object} s
 * @param {boolean} s.agentRunning
 * @param {object}  s.model          { state, id, device, dtype }
 * @param {boolean|null} s.webgpu
 * @param {boolean|null} s.ocr.available
 * @param {object}  s.remote         { allowed, configured, endpointHost }
 * @param {object}  s.vault          { locked, count }
 * @param {boolean} s.failClosed
 * @param {string}  s.privacyMode
 * @param {object}  s.counts         { sensitiveRegions, documentsRedacted, visualProtected, blockedRequests }
 * @param {string|null} s.blockedReason
 */
export function computeStatus(s = {}) {
  const model = s.model || { state: MODEL_STATES.NOT_CONFIGURED };

  if (s.blockedReason) {
    return { level: STATUS_LEVELS.BLOCKED, title: 'Request blocked', detail: s.blockedReason };
  }
  if (s.agentRunning) {
    return { level: STATUS_LEVELS.PROCESSING, title: 'Processing locally', detail: 'Inspecting and sanitizing page context before anything leaves the browser.' };
  }
  if (model.state === MODEL_STATES.LOADING) {
    return { level: STATUS_LEVELS.PROCESSING, title: 'Loading local model', detail: 'A local model is initializing on this device.' };
  }
  if (model.state === MODEL_STATES.UNAVAILABLE) {
    return { level: STATUS_LEVELS.MODEL_UNAVAILABLE, title: 'Local model unavailable', detail: 'Visual context cannot be verified; requests are blocked or fall back to DOM-only checks.' };
  }
  if (s.ocr && s.ocr.available === false) {
    return { level: STATUS_LEVELS.ATTENTION, title: 'Needs attention', detail: 'Local OCR is unavailable. Suspicious images are redacted in full or blocked.' };
  }
  if (model.state === MODEL_STATES.READY) {
    const detail = s.remote?.allowed ? 'Local processing active; remote reasoning receives only sanitized context.' : 'Local processing active; remote reasoning is disabled.';
    return { level: STATUS_LEVELS.PROTECTED, title: 'Protected locally', detail };
  }
  // Not configured model, but fail-closed privacy still applies.
  return { level: STATUS_LEVELS.PROTECTED, title: 'Protected', detail: 'Privacy layer is active. Local model not configured (DOM-only protection).' };
}

const STEP_IDS = ['capture', 'detect', 'redact', 'scan', 'send'];

/**
 * Compute the pipeline stepper state. Each step is one of:
 * completed | running | blocked | unavailable | pending
 */
export function computePipelineSteps(s = {}) {
  const model = s.model || {};
  const ocrAvail = !s.ocr ? true : s.ocr.available;
  const canDetect = model.state === MODEL_STATES.READY || model.state === MODEL_STATES.LOADING || ocrAvail !== false;

  const steps = {};

  steps.capture = { id: 'capture', label: 'Capture', state: s.agentRunning ? 'running' : 'completed' };

  steps.detect = { id: 'detect', label: 'Detect', state: 'unavailable' };
  if (canDetect) steps.detect.state = s.agentRunning ? 'running' : 'completed';

  steps.redact = { id: 'redact', label: 'Redact', state: 'pending' };
  if ((s.counts?.sensitiveRegions ?? 0) > 0) steps.redact.state = 'completed';

  steps.scan = { id: 'scan', label: 'Scan', state: 'pending' };
  if (s.leakScanOk === true) steps.scan.state = 'completed';
  if (s.blockedReason) steps.scan.state = 'blocked';

  steps.send = { id: 'send', label: 'Send safe context', state: 'pending' };
  if (s.blockedReason) {
    steps.send.state = 'blocked';
  } else if (s.agentRunning) {
    steps.send.state = 'running';
  } else if (s.leakScanOk === true) {
    steps.send.state = 'completed';
  }

  return STEP_IDS.map((id) => steps[id]);
}

const ACTIVITY_EVENTS = {
  vlm_load_warning: { label: 'Local model unavailable', tone: 'warn' },
  model_loaded: { label: 'Local model loaded', tone: 'ok' },
  vlm_perception_warning: { label: 'Perception warning', tone: 'warn' },
  reused_cached_perception: { label: 'Used cached perception', tone: 'ok' },
  privacy_gate: { label: 'Privacy scan completed', tone: 'ok' },
  privacy_state: { label: 'Privacy state evaluated', tone: 'ok' },
  remote_plan_received: { label: 'Sanitized context sent to remote model', tone: 'ok' },
  no_route_available: { label: 'No route available', tone: 'warn' },
  action_error: { label: 'Action error', tone: 'warn' },
  action_warning: { label: 'Action may have had no effect', tone: 'warn' },
  action_needs_confirmation: { label: 'Sensitive action needs confirmation', tone: 'warn' },
  action_failed_final: { label: 'Action failed', tone: 'warn' },
  action_executed: { label: 'Action executed locally', tone: 'ok' },
  task_complete: { label: 'Task complete', tone: 'ok' },
  error: { label: 'Error', tone: 'warn' },
  screenshot_sanitized: { label: 'Screenshot sanitized', tone: 'ok' },
  sensitive_document_redacted: { label: 'Sensitive document redacted', tone: 'ok' },
  remote_payload_approved: { label: 'Remote payload approved', tone: 'ok' },
  potential_leak_blocked: { label: 'Potential leak blocked', tone: 'blocked' },
  credential_action_local: { label: 'Credential action kept local', tone: 'ok' },
  ocr_blocked: { label: 'OCR unavailable — request blocked', tone: 'blocked' }
};

const ACTIVITY_SENSITIVE_KEYS = new Set([
  'value', 'content', 'text', 'password', 'credential', 'token', 'secret',
  'ocrText', 'ocr_text', 'innerText', 'file', 'fileName', 'fileDataUrl', 'match'
]);

/**
 * Convert raw (already redacted) log entries into safe, display-ready items.
 * Any stray sensitive key is stripped defensively.
 */
export function sanitizeActivityLog(entries = [], limit = 20) {
  return entries.slice(-limit).map((e) => {
    const meta = ACTIVITY_EVENTS[e.event] || { label: e.event || 'Event', tone: 'neutral' };
    const item = { time: e.t, label: meta.label, tone: meta.tone };
    // Attach only explicit safe scalar metadata; never raw values.
    const safeScalars = {};
    for (const [k, v] of Object.entries(e)) {
      if (k === 't' || k === 'event') continue;
      if (ACTIVITY_SENSITIVE_KEYS.has(k)) { safeScalars[k] = '[redacted]'; continue; }
      if (typeof v === 'string' || typeof v === 'number') safeScalars[k] = v;
    }
    item.meta = safeScalars;
    return item;
  });
}

// --- Safe demo mode (synthetic data only) --------------------------------

const DEMO_DOCUMENT = {
  kind: 'pan_card',
  title: 'DEMO Identity Document',
  lines: [
    { label: 'Name', value: 'Demo Person' },
    { label: 'PAN', value: 'ABCDE1234F' },
    { label: 'Date of Birth', value: '01/01/1990' },
    { label: 'ID No', value: 'DMO0000001' }
  ],
  fileName: 'demo-id-card.png'
};

const DEMO_FIELDS = [
  { label: 'Email', value: 'demo@example.in' },
  { label: 'Phone', value: '9876543210' },
  { label: 'Password', value: 'DemoPass!23' },
  { label: 'Address', value: '1 Demo Road, Sample City 000000' }
];

export function buildDemoData() {
  return {
    document: DEMO_DOCUMENT,
    fields: DEMO_FIELDS,
    // Non-sensitive filler to show the pipeline preserves ordinary content.
    neutral: ['Submit', 'Help', 'Privacy Policy', 'Learn more']
  };
}

/**
 * Run the REAL local detectors over the synthetic demo data and return only
 * counts + neutral categories + redaction labels (never the raw values).
 */
export function runDemoAnalysis(demo = buildDemoData()) {
  const docText = demo.document.lines.map(l => `${l.label}: ${l.value}`).join(' ');
  const docDecision = detectSensitiveDocument({
    ocrText: docText,
    fileName: demo.document.fileName,
    altText: demo.document.title,
    mimeType: 'image/png',
    width: 400,
    height: 252
  });

  const fieldFindings = [];
  for (const f of demo.fields) {
    const found = detectSensitiveText(f.value);
    if (found.some(x => x.confidence >= 0.8 || ['pan', 'email', 'dob', 'ifsc', 'mobile'].includes(x.category))) {
      fieldFindings.push({ category: found.find(x => x.confidence >= 0.8)?.category || found[0].category });
    }
  }

  const neutralFindings = demo.neutral.map(t => ({ text: t, findings: detectSensitiveText(t).length }));

  return {
    document: {
      detected: docDecision.decision !== 'safe',
      decision: docDecision.decision,
      category: docDecision.category,
      label: redactionLabelFor(docDecision.category)
    },
    fields: { sensitiveCount: fieldFindings.length, categories: [...new Set(fieldFindings.map(f => f.category))] },
    neutral: neutralFindings.map(n => ({ text: n.text, sensitive: n.findings > 0 }))
  };
}