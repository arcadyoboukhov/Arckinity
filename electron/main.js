const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

let mainWindow = null;
let serverProcess = null;

function getSettingsPath() {
  return path.join(app.getPath('userData'), 'launcher-settings.json');
}

function defaultSettings() {
  const fallbackVideoRoot = path.join(require('os').homedir(), 'Videos', 'categorized_videos');
  return {
    videoSourceDir: fallbackVideoRoot,
    port: 3000
  };
}

function readSettings() {
  const settingsPath = getSettingsPath();
  try {
    if (!fs.existsSync(settingsPath)) {
      return defaultSettings();
    }
    const raw = fs.readFileSync(settingsPath, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      ...defaultSettings(),
      ...parsed
    };
  } catch {
    return defaultSettings();
  }
}

function writeSettings(settings) {
  const settingsPath = getSettingsPath();
  const payload = {
    ...defaultSettings(),
    ...settings
  };
  fs.writeFileSync(settingsPath, JSON.stringify(payload, null, 2), 'utf8');
}

function getServerEntry() {
  const candidates = [
    path.resolve(__dirname, '..', 'server.js')
  ];

  if (process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, 'app.asar', 'server.js'));
    candidates.push(path.join(process.resourcesPath, 'app.asar.unpacked', 'server.js'));
  }

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    } catch {
      // Continue trying other candidates.
    }
  }

  return candidates[0];
}

function getServerCwd() {
  // In packaged Electron apps, __dirname may be inside app.asar (not a real cwd).
  // Use resourcesPath to avoid spawn ENOENT caused by invalid cwd.
  if (!app.isPackaged) {
    return path.resolve(__dirname, '..');
  }
  return process.resourcesPath || path.dirname(process.execPath);
}

function getRuntimeDataDir() {
  return path.join(app.getPath('userData'), 'data');
}

function resolveLauncherFfmpegPath() {
  const candidates = [];

  if (!app.isPackaged) {
    candidates.push(path.resolve(__dirname, '..', 'node_modules', 'ffmpeg-static', 'ffmpeg.exe'));
  }

  if (process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', 'ffmpeg-static', 'ffmpeg.exe'));
    candidates.push(path.join(process.resourcesPath, 'node_modules', 'ffmpeg-static', 'ffmpeg.exe'));
  }

  for (const candidate of candidates) {
    try {
      if (candidate && fs.existsSync(candidate)) {
        return candidate;
      }
    } catch {
      // Keep checking fallbacks.
    }
  }

  return null;
}

function emitServerState(extra) {
  if (!mainWindow) {
    return;
  }

  const payload = {
    running: Boolean(serverProcess),
    ...extra
  };

  mainWindow.webContents.send('server:state', payload);
}

function appendLog(line) {
  if (!mainWindow) {
    return;
  }
  mainWindow.webContents.send('server:log', line);
}

function stopServer() {
  return new Promise((resolve) => {
    if (!serverProcess) {
      resolve({ ok: true, alreadyStopped: true });
      return;
    }

    const proc = serverProcess;
    serverProcess = null;

    const timeout = setTimeout(() => {
      try {
        proc.kill('SIGKILL');
      } catch {
        // No-op
      }
    }, 2500);

    proc.once('exit', () => {
      clearTimeout(timeout);
      emitServerState({ running: false });
      appendLog('[launcher] Server stopped');
      resolve({ ok: true });
    });

    try {
      proc.kill('SIGINT');
    } catch {
      clearTimeout(timeout);
      emitServerState({ running: false });
      resolve({ ok: true });
    }
  });
}

function validateStartInput(input) {
  const errors = [];
  const folder = String(input.videoSourceDir || '').trim();
  const port = Number(input.port);

  if (!folder) {
    errors.push('Please choose a video folder.');
  } else {
    try {
      const stat = fs.statSync(folder);
      if (!stat.isDirectory()) {
        errors.push('Selected video path is not a directory.');
      }
    } catch {
      errors.push('Selected video folder does not exist.');
    }
  }

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    errors.push('Port must be a number between 1 and 65535.');
  }

  return {
    errors,
    normalized: {
      videoSourceDir: folder,
      port
    }
  };
}

async function startServer(input) {
  if (serverProcess) {
    return { ok: false, error: 'Server is already running.' };
  }

  const { errors, normalized } = validateStartInput(input || {});
  if (errors.length) {
    return { ok: false, error: errors.join(' ') };
  }

  writeSettings(normalized);

  const serverEntry = getServerEntry();
  const runtimeDataDir = getRuntimeDataDir();
  try {
    fs.mkdirSync(runtimeDataDir, { recursive: true });
  } catch {
    // Let server handle fallback errors if this creation fails.
  }

  const ffmpegPath = resolveLauncherFfmpegPath();
  const childEnv = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    VIDEO_SOURCE_DIR: normalized.videoSourceDir,
    PORT: String(normalized.port),
    ARKINITY_DATA_DIR: runtimeDataDir
  };
  if (ffmpegPath) {
    childEnv.FFMPEG_PATH = ffmpegPath;
  }

  const serverCwd = getServerCwd();

  try {
    serverProcess = spawn(process.execPath, [serverEntry], {
      cwd: serverCwd,
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });
  } catch (error) {
    serverProcess = null;
    return { ok: false, error: `Failed to start server: ${error.message}` };
  }

  serverProcess.stdout.on('data', (chunk) => appendLog(String(chunk).trimEnd()));
  serverProcess.stderr.on('data', (chunk) => appendLog(String(chunk).trimEnd()));
  serverProcess.on('error', (error) => {
    appendLog(`[server error] ${error.message}`);
    serverProcess = null;
    emitServerState({ running: false });
  });
  serverProcess.on('exit', (code, signal) => {
    const detail = `code=${String(code)} signal=${String(signal)}`;
    appendLog(`[launcher] Server exited (${detail})`);
    serverProcess = null;
    emitServerState({ running: false });
  });

  const url = `http://localhost:${normalized.port}`;
  emitServerState({ running: true, url });
  appendLog(`[launcher] Server started at ${url}`);
  return { ok: true, url };
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 960,
    height: 700,
    minWidth: 840,
    minHeight: 620,
    backgroundColor: '#0f1727',
    title: 'Arkinity Launcher',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer.html'));
}

app.whenReady().then(() => {
  ipcMain.handle('settings:load', () => readSettings());

  ipcMain.handle('settings:pickFolder', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Select Arkinity Video Folder',
      properties: ['openDirectory']
    });

    if (result.canceled || !result.filePaths.length) {
      return { ok: false };
    }

    return { ok: true, path: result.filePaths[0] };
  });

  ipcMain.handle('server:start', async (_event, input) => startServer(input));
  ipcMain.handle('server:stop', async () => stopServer());
  ipcMain.handle('server:status', async () => ({ running: Boolean(serverProcess) }));
  ipcMain.handle('server:openBrowser', async (_event, url) => {
    if (!url) {
      return { ok: false };
    }
    await shell.openExternal(url);
    return { ok: true };
  });

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('before-quit', async (event) => {
  if (!serverProcess) {
    return;
  }
  event.preventDefault();
  await stopServer();
  app.quit();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
