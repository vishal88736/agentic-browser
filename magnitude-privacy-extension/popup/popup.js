const instructionEl = document.getElementById('instruction');
const statusEl = document.getElementById('status');
const logEl = document.getElementById('log');

document.getElementById('run').addEventListener('click', () => {
  const instruction = instructionEl.value.trim();
  if (!instruction) return;
  statusEl.textContent = 'Running…';
  chrome.runtime.sendMessage({ type: 'START_TASK', instruction });
});

document.getElementById('stop').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'STOP_TASK' });
  statusEl.textContent = 'Stopping…';
});

document.getElementById('openOptions').addEventListener('click', (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

document.getElementById('unlockVaultBtn').addEventListener('click', async () => {
  const pwd = document.getElementById('popup_password').value;
  if (!pwd) return;
  await chrome.storage.session.set({ masterPassword: pwd });
  document.getElementById('unlockSection').style.display = 'none';
  statusEl.textContent = 'Vault unlocked.';
});

chrome.storage.session.get('masterPassword', (res) => {
  if (res.masterPassword) {
    document.getElementById('unlockSection').style.display = 'none';
  }
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'TASK_LOG') {
    logEl.textContent += JSON.stringify(msg.entry) + '\n';
    logEl.scrollTop = logEl.scrollHeight;
  }
});

function refresh() {
  chrome.runtime.sendMessage({ type: 'GET_TASK_LOG' }, (res) => {
    if (!res) return;
    statusEl.textContent = res.running ? 'Running…' : 'Idle';
    logEl.textContent = res.log.map(e => JSON.stringify(e)).join('\n');
  });
}
refresh();
