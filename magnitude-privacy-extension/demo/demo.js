// demo/demo.js — runs the real local detectors on synthetic data and renders
// an honest before/after. No sensitive values (only synthetic) and no network.
import { detectSensitiveText } from '../shared/detectors.js';
import { detectSensitiveDocument, redactionLabelFor } from '../shared/documentDetector.js';
import { buildDemoData } from '../shared/statusModel.js';

const $ = (id) => document.getElementById(id);

function stepHtml(state, label) {
  return `<div class="step" data-state="${state}"><div class="step-dot"></div><div class="step-label">${label}</div></div>`;
}

const PIPELINE = ['Capture', 'Detect', 'Redact', 'Scan', 'Send safe context'];

function renderSteps(states) {
  $('stepper').innerHTML = states.map((s, i) => stepHtml(s, PIPELINE[i])).join('');
}

// Determine if a value is sensitive using the same detector the privacy gate uses.
const isSensitive = (v) =>
  detectSensitiveText(v).some(f => f.confidence >= 0.8 || ['pan', 'email', 'dob', 'ifsc', 'mobile'].includes(f.category));

function run() {
  const demo = buildDemoData();

  // Before panes: show the synthetic values (local only, clearly synthetic).
  $('docBefore').innerHTML = demo.document.lines.map(l =>
    `<div class="doc-line"><span class="dl">${l.label}</span><span class="dv">${l.value}</span></div>`).join('');
  $('fieldsBefore').innerHTML = demo.fields.map(f =>
    `<div class="doc-line"><span class="dl">${f.label}</span><span class="dv">${f.value}</span></div>`).join('');

  // Document classification (whole-region redaction for identity documents).
  const docText = demo.document.lines.map(l => `${l.label}: ${l.value}`).join(' ');
  const doc = detectSensitiveDocument({
    ocrText: docText, fileName: demo.document.fileName, altText: demo.document.title, mimeType: 'image/png', width: 400, height: 252
  });

  let docAfterHtml;
  if (doc.decision !== 'safe') {
    docAfterHtml = `<div class="redacted-tag">${redactionLabelFor(doc.category)}</div><div class="doc-line"><span class="dl">Classification</span><span class="dv">${doc.category}</span></div>`;
  } else {
    docAfterHtml = demo.document.lines.map(l =>
      `<div class="doc-line"><span class="dl">${l.label}</span><span class="dv">${l.value}</span></div>`).join('');
  }
  $('docAfter').innerHTML = docAfterHtml;

  let sensitiveCount = 0;
  const fieldsAfterHtml = demo.fields.map(f => {
    if (isSensitive(f.value)) {
      sensitiveCount++;
      return `<div class="doc-line redacted"><span class="dl">${f.label}</span><span class="dv">••••••••••</span></div>`;
    }
    return `<div class="doc-line"><span class="dl">${f.label}</span><span class="dv">${f.value}</span></div>`;
  }).join('');
  $('fieldsAfter').innerHTML = fieldsAfterHtml;

  $('summary').innerHTML =
    `<b>${1 + sensitiveCount} sensitive region(s) detected.</b> ` +
    `Document → ${doc.decision !== 'safe' ? 'whole-region redacted' : 'no document detected'}. ` +
    `Fields → ${sensitiveCount} redacted. Payload scanner → would approve only the sanitized view.`;

  renderSteps(['completed', 'completed', 'completed', 'completed', 'completed']);
}

$('runDemo').addEventListener('click', () => { renderSteps(['completed', 'running', 'pending', 'pending', 'pending']); setTimeout(run, 400); });

chrome.storage.local.get('theme', (r) => { document.body.dataset.theme = r.theme || 'dark'; });
run();