const videoFolderInput = document.getElementById('video-folder');
const portInput = document.getElementById('port');
const browseFolderBtn = document.getElementById('browse-folder');
const startBtn = document.getElementById('start-btn');
const stopBtn = document.getElementById('stop-btn');
const openAppBtn = document.getElementById('open-app-btn');
const clearLogsBtn = document.getElementById('clear-logs');
const statusPill = document.getElementById('status-pill');
const logsEl = document.getElementById('logs');
const messageEl = document.getElementById('message');

let currentUrl = '';

function setMessage(text, kind = 'info') {
  messageEl.textContent = text || '';
  if (kind === 'error') {
    messageEl.style.color = '#fca5a5';
    return;
  }
  if (kind === 'success') {
    messageEl.style.color = '#6ee7b7';
    return;
  }
  messageEl.style.color = '#f7c15a';
}

function appendLog(line) {
  if (!line) {
    return;
  }
  const now = new Date().toLocaleTimeString();
  logsEl.textContent += `[${now}] ${line}\n`;
  logsEl.scrollTop = logsEl.scrollHeight;
}

function setRunningUI(running) {
  if (running) {
    statusPill.classList.remove('stopped');
    statusPill.classList.add('running');
    statusPill.textContent = 'Running';
  } else {
    statusPill.classList.remove('running');
    statusPill.classList.add('stopped');
    statusPill.textContent = 'Stopped';
  }

  startBtn.disabled = running;
  stopBtn.disabled = !running;
  openAppBtn.disabled = !running || !currentUrl;
}

async function loadInitialState() {
  const settings = await window.arkinityAPI.loadSettings();
  videoFolderInput.value = settings.videoSourceDir || '';
  portInput.value = settings.port || 3000;

  const status = await window.arkinityAPI.getServerStatus();
  setRunningUI(Boolean(status && status.running));
}

browseFolderBtn.addEventListener('click', async () => {
  const result = await window.arkinityAPI.pickVideoFolder();
  if (result && result.ok && result.path) {
    videoFolderInput.value = result.path;
    setMessage('Video folder selected.', 'success');
  }
});

startBtn.addEventListener('click', async () => {
  setMessage('Starting server...');
  const payload = {
    videoSourceDir: videoFolderInput.value,
    port: Number(portInput.value)
  };

  const result = await window.arkinityAPI.startServer(payload);
  if (!result || !result.ok) {
    setMessage((result && result.error) || 'Failed to start server.', 'error');
    return;
  }

  currentUrl = result.url;
  setRunningUI(true);
  setMessage(`Server started at ${result.url}`, 'success');
});

stopBtn.addEventListener('click', async () => {
  setMessage('Stopping server...');
  await window.arkinityAPI.stopServer();
  currentUrl = '';
  setRunningUI(false);
  setMessage('Server stopped.', 'success');
});

openAppBtn.addEventListener('click', async () => {
  if (!currentUrl) {
    return;
  }
  await window.arkinityAPI.openBrowser(currentUrl);
});

clearLogsBtn.addEventListener('click', () => {
  logsEl.textContent = '';
});

window.arkinityAPI.onServerLog((line) => {
  appendLog(line);
});

window.arkinityAPI.onServerState((payload) => {
  if (payload && payload.url) {
    currentUrl = payload.url;
  }
  setRunningUI(Boolean(payload && payload.running));
});

loadInitialState().catch((error) => {
  setMessage(`Failed to load launcher state: ${error.message}`, 'error');
});
