// popup/popup.js
import {
  computeStatus, computePipelineSteps, sanitizeActivityLog,
  STATUS_LEVELS
} from '../shared/statusModel.js';

const $ = (id) => document.getElementById(id);

const STAT_META = [
  { key: 'sensitiveRegions', label: 'Sensitive regions', tone: 'warn' },
  { key: 'documentsRedacted', label: 'Documents redacted', tone: 'danger' },
  { key: 'visualProtected', label: 'Visual regions protected', tone: 'warn' },
  { key: 'domSanitized', label: 'DOM values sanitized', tone: 'ok' },
  { key: 'blockedRequests', label: 'Requests blocked', tone: 'danger' }
];

function formatTime(t) {
  if (!t) return '--:--';
  const d = new Date(t);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

const TONE_TO_PILL = {
  [STATUS_LEVELS.PROTECTED]: 'pill-protected',
  [STATUS_LEVELS.PROCESSING]: 'pill-processing',
  [STATUS_LEVELS.ATTENTION]: 'pill-attention',
  [STATUS_LEVELS.BLOCKED]: 'pill-blocked',
  [STATUS_LEVELS.MODEL_UNAVAILABLE]: 'pill-model'
};

function renderStatus(status) {
  const st = computeStatus(status);
  $('statusTitle').textContent = st.title;
  $('statusDetail').textContent = st.detail;
  const pill = $('statusPill');
  pill.className = 'pill ' + (TONE_TO_PILL[st.level] || 'pill-protected');
  $('statusPillText').textContent = st.title;

  const steps = computePipelineSteps(status);
  $('stepper').innerHTML = steps.map((s) => `
    <div class="step" data-state="${s.state}">
      <div class="step-dot"></div>
      <div class="step-label">${s.label}</div>
    </div>`).join('');

  const c = status.counts || {};
  $('statGrid').innerHTML = STAT_META.map((m) => `
    <div class="stat ${m.tone}"><div class="num">${c[m.key] ?? 0}</div><div class="lbl">${m.label}</div></div>
  `).join('');
}

function renderActivity(entries) {
  const items = sanitizeActivityLog(entries, 12);
  const el = $('activity');
  if (!items.length) {
    el.innerHTML = '<li class="empty">No activity yet. Run a task to see the privacy pipeline in action.</li>';
    return;
  }
  el.innerHTML = items.map((i) => `
    <li><span class="t">${formatTime(i.time)}</span><span class="ic ic-${i.tone}"></span><span class="msg">${i.label}</span></li>
  `).join('');
}

async function refresh() {
  const status = await chrome.runtime.sendMessage({ type: 'GET_STATUS' });
  const log = await chrome.runtime.sendMessage({ type: 'GET_TASK_LOG' });
  const vault = await chrome.storage.session.get('masterPassword');

  renderStatus(status || {});
  renderActivity((log && log.log) || []);

  $('vaultLocked').classList.toggle('hidden', !!vault.masterPassword);
  $('vaultUnlocked').classList.toggle('hidden', !vault.masterPassword);

  $('run').disabled = !!status?.agentRunning;
  $('stop').disabled = !status?.agentRunning;
}

// --- controls ---------------------------------------------------------

$('run').addEventListener('click', () => {
  const instruction = $('instruction').value.trim();
  if (!instruction) return;
  chrome.runtime.sendMessage({ type: 'START_TASK', instruction });
});

$('stop').addEventListener('click', () => chrome.runtime.sendMessage({ type: 'STOP_TASK' }));

$('rescan').addEventListener('click', () => {
  $('statusTitle').textContent = 'Scanning…';
  setTimeout(refresh, 1200);
});

$('openOptions').addEventListener('click', (e) => { e.preventDefault(); chrome.runtime.openOptionsPage(); });

$('openDemo').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('demo/demo.html') });
});

$('clearActivity').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'CLEAR_ACTIVITY' });
  refresh();
});

$('unlockVaultBtn').addEventListener('click', async () => {
  const pwd = $('popup_password').value;
  if (!pwd) return;
  await chrome.storage.session.set({ masterPassword: pwd });
  $('popup_password').value = '';
  refresh();
});

// --- theme ------------------------------------------------------------

function applyTheme(theme) {
  document.body.dataset.theme = theme;
}

async function toggleTheme() {
  const { theme = 'dark' } = await chrome.storage.local.get('theme');
  const next = theme === 'dark' ? 'light' : 'dark';
  await chrome.storage.local.set({ theme: next });
  applyTheme(next);
}

$('themeToggle').addEventListener('click', toggleTheme);

chrome.storage.local.get('theme', (r) => applyTheme(r.theme || 'dark'));

// --- live updates -----------------------------------------------------

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'TASK_LOG') refresh();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'session' && changes.masterPassword) refresh();
});

refresh();
setInterval(refresh, 2500);