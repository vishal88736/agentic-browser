// options/options.js
import { encryptVault, decryptVault } from '../shared/crypto.js';

const $ = (id) => document.getElementById(id);

const CONFIG_FIELDS = [
  'LOCAL_VLM_MODEL', 'LOCAL_VLM_DEVICE', 'LOCAL_VLM_DTYPE',
  'LOCAL_FIRST', 'ALLOW_REMOTE_REASONING', 'PRIVACY_MODE',
  'REMOTE_ENDPOINT', 'REMOTE_MODEL', 'REMOTE_API_KEY',
  'ENABLE_FACE_REDACTION', 'ENABLE_QR_BARCODE', 'ENABLE_SIGNATURE',
  'ACTIVITY_RETENTION', 'FAIL_CLOSED'
];

async function load() {
  const { config = {} } = await chrome.storage.local.get('config');
  for (const field of CONFIG_FIELDS) {
    const el = $(field);
    if (!el) continue;
    if (el.type === 'checkbox') el.checked = config[field] !== undefined ? !!config[field] : el.checked;
    else el.value = config[field] ?? el.value;
  }
  await renderStatus();
}

async function renderStatus() {
  const status = await chrome.runtime.sendMessage({ type: 'GET_STATUS' }).catch(() => null);
  const { vault } = await chrome.storage.local.get('vault');

  if (status) {
    const model = status.model || {};
    $('vlmStatus').textContent = ({
      ready: 'Ready', loading: 'Loading…', unavailable: 'Unavailable', not_configured: 'Not configured'
    })[model.state] || 'Unknown';
    $('webgpuStatus').textContent = status.webgpu == null ? 'unknown' : (status.webgpu ? 'available' : 'not available');
  }

  const credCount = vault && vault.cipherText ? 3 : 0;
  $('vaultCount').textContent = credCount === 0 ? '0 credentials (empty)' : `${credCount} roles encrypted`;

  const diagItems = [
    ['Extension version', chrome.runtime.getManifest().version],
    ['Browser', navigator.userAgent.includes('Firefox') ? 'Firefox' : 'Chromium'],
    ['WebGPU', $('webgpuStatus').textContent],
    ['OCR', 'Not bundled (fail-closed seam)'],
    ['Local VLM', $('vlmStatus').textContent],
    ['Leak scanner', 'Active'],
    ['Fail-closed', 'Active']
  ];
  $('diag').innerHTML = diagItems.map(([k, v]) => `<div class="kv"><span class="k">${k}</span><span class="v">${v}</span></div>`).join('');
}

async function unlockVault() {
  const pwd = $('master_password').value;
  if (!pwd) { alert('Please enter the master password to unlock.'); return; }
  const { vault = {} } = await chrome.storage.local.get('vault');
  if (vault.cipherText) {
    try {
      const d = await decryptVault(pwd, vault);
      $('cred_aadhaar_number').value = d.aadhaar_number?.value || '';
      $('cred_pan').value = d.pan?.value || '';
      $('cred_password').value = d.password?.value || '';
    } catch (e) { alert(e.message); return; }
  }
  $('cred_aadhaar_number').disabled = false;
  $('cred_pan').disabled = false;
  $('cred_password').disabled = false;
  $('vaultFields').classList.remove('hidden');
  await chrome.storage.session.set({ masterPassword: pwd });
}

async function save() {
  const config = {};
  for (const field of CONFIG_FIELDS) {
    const el = $(field);
    if (!el) continue;
    config[field] = el.type === 'checkbox' ? el.checked : el.value;
  }
  config.FAIL_CLOSED = true; // always enforced
  config.ACTIVITY_RETENTION = Number(config.ACTIVITY_RETENTION) || 50;

  await chrome.runtime.sendMessage({ type: 'SET_CONFIG', config }).catch(() => {});
  // Fallback direct write (SET_CONFIG handler should exist; keep local persistence robust).
  await chrome.storage.local.set({ config });

  const pwd = $('master_password').value;
  if (pwd) {
    const vaultData = {
      aadhaar_number: { value: $('cred_aadhaar_number').value },
      pan: { value: $('cred_pan').value },
      password: { value: $('cred_password').value }
    };
    const encryptedVault = await encryptVault(pwd, vaultData);
    await chrome.storage.local.set({ vault: encryptedVault });
    await chrome.storage.session.set({ masterPassword: pwd });
  }

  $('savedMsg').textContent = 'Saved securely.';
  setTimeout(() => ($('savedMsg').textContent = ''), 1500);
}

function applyTheme(theme) { document.body.dataset.theme = theme; }

$('save').addEventListener('click', save);
$('unlock').addEventListener('click', unlockVault);
$('themeToggle').addEventListener('click', async () => {
  const { theme = 'dark' } = await chrome.storage.local.get('theme');
  await chrome.storage.local.set({ theme: theme === 'dark' ? 'light' : 'dark' });
  applyTheme(theme === 'dark' ? 'light' : 'dark');
});
$('openDemo').addEventListener('click', () => chrome.tabs.create({ url: chrome.runtime.getURL('demo/demo.html') }));

$('downloadModel').addEventListener('click', async () => {
  const modelId = $('LOCAL_VLM_MODEL').value.trim();
  const device = $('LOCAL_VLM_DEVICE').value;
  const dtype = $('LOCAL_VLM_DTYPE').value;
  const status = $('downloadStatus');
  if (!modelId) { status.textContent = 'Enter a Model ID first.'; return; }
  status.textContent = 'Downloading…';
  $('downloadModel').disabled = true;
  try {
    const response = await chrome.runtime.sendMessage({ type: 'PRELOAD_MODEL', modelId, device, dtype });
    status.textContent = response?.ok ? 'Model cached.' : `Failed: ${response?.error || 'unknown'}`;
  } catch (e) {
    status.textContent = `Error: ${e.message}`;
  } finally {
    $('downloadModel').disabled = false;
  }
});

$('exportDiag').addEventListener('click', () => {
  const items = Array.from($('diag').querySelectorAll('.kv')).map((r) => ({
    k: r.querySelector('.k').textContent,
    v: r.querySelector('.v').textContent
  }));
  const report = {
    generatedAt: new Date().toISOString(),
    safe: true,
    diagnostics: items.reduce((acc, i) => { acc[i.k] = i.v; return acc; }, {})
  };
  const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'privacy-shield-report.json';
  a.click();
  URL.revokeObjectURL(a.href);
});

chrome.storage.local.get('theme', (r) => applyTheme(r.theme || 'dark'));
load();