import { encryptVault, decryptVault } from '../shared/crypto.js';

const CONFIG_FIELDS = [
  'LOCAL_VLM_MODEL', 'LOCAL_VLM_DEVICE', 'LOCAL_VLM_DTYPE',
  'LOCAL_FIRST', 'ALLOW_REMOTE_REASONING', 'PRIVACY_MODE',
  'REMOTE_ENDPOINT', 'REMOTE_MODEL', 'REMOTE_API_KEY'
];

async function load() {
  const { config = {} } = await chrome.storage.local.get('config');

  for (const field of CONFIG_FIELDS) {
    const el = document.getElementById(field);
    if (!el) continue;
    if (el.type === 'checkbox') el.checked = !!config[field];
    else el.value = config[field] ?? el.value;
  }
}

async function unlockVault() {
  const pwd = document.getElementById('master_password').value;
  if (!pwd) {
    alert('Please enter Master Password to unlock.');
    return;
  }
  const { vault = {} } = await chrome.storage.local.get('vault');
  if (!vault.cipherText) {
    // If it's a new or plaintext vault, we just enable the fields.
    if (vault.aadhaar_number) {
      document.getElementById('cred_aadhaar_number').value = vault.aadhaar_number.value || '';
      document.getElementById('cred_pan').value = vault.pan.value || '';
      document.getElementById('cred_password').value = vault.password.value || '';
    }
  } else {
    try {
      const decrypted = await decryptVault(pwd, vault);
      document.getElementById('cred_aadhaar_number').value = decrypted.aadhaar_number?.value || '';
      document.getElementById('cred_pan').value = decrypted.pan?.value || '';
      document.getElementById('cred_password').value = decrypted.password?.value || '';
    } catch (e) {
      alert(e.message);
      return;
    }
  }
  
  // Enable fields
  document.getElementById('cred_aadhaar_number').disabled = false;
  document.getElementById('cred_pan').disabled = false;
  document.getElementById('cred_password').disabled = false;
  
  // Save the password to session for the background script
  await chrome.storage.session.set({ masterPassword: pwd });
}

async function save() {
  const config = {};
  for (const field of CONFIG_FIELDS) {
    const el = document.getElementById(field);
    if (!el) continue;
    config[field] = el.type === 'checkbox' ? el.checked : el.value;
  }

  const pwd = document.getElementById('master_password').value;
  if (!pwd) {
    alert('Please enter Master Password to save the vault securely.');
    return;
  }

  const vaultData = {
    aadhaar_number: { value: document.getElementById('cred_aadhaar_number').value },
    pan: { value: document.getElementById('cred_pan').value },
    password: { value: document.getElementById('cred_password').value }
  };

  const encryptedVault = await encryptVault(pwd, vaultData);

  await chrome.storage.local.set({ config, vault: encryptedVault });
  await chrome.storage.session.set({ masterPassword: pwd });

  const msg = document.getElementById('savedMsg');
  msg.textContent = 'Saved securely.';
  setTimeout(() => (msg.textContent = ''), 1500);
}

document.getElementById('save').addEventListener('click', save);
document.getElementById('unlock').addEventListener('click', unlockVault);
document.getElementById('downloadModel').addEventListener('click', async () => {
  const modelId = document.getElementById('LOCAL_VLM_MODEL').value.trim();
  const device   = document.getElementById('LOCAL_VLM_DEVICE').value;
  const dtype    = document.getElementById('LOCAL_VLM_DTYPE').value;
  const status   = document.getElementById('downloadStatus');

  if (!modelId) {
    status.textContent = '⚠ Enter a Model ID first.';
    status.style.color = '#c00';
    return;
  }

  status.textContent = '⏳ Downloading… this may take a few minutes.';
  status.style.color = '#555';
  document.getElementById('downloadModel').disabled = true;

  try {
    const response = await chrome.runtime.sendMessage({
      type: 'PRELOAD_MODEL',
      modelId,
      device,
      dtype
    });
    if (response && response.ok) {
      status.textContent = '✅ Model cached! Ready to use.';
      status.style.color = 'green';
    } else {
      status.textContent = `❌ Failed: ${response?.error || 'unknown error'}`;
      status.style.color = '#c00';
    }
  } catch (e) {
    status.textContent = `❌ Error: ${e.message}`;
    status.style.color = '#c00';
  } finally {
    document.getElementById('downloadModel').disabled = false;
  }
});
load();
