/**
 * Electron main process entry point.
 *
 * Boots the shared engine (Docker sandbox + LLM orchestration), wires the IPC
 * bridge, and shows the Angular renderer.
 */

import { app, BrowserWindow } from 'electron';
import { configurePaths } from '../src/config.js';
import { Engine } from '../src/engine.js';
import { registerIpc } from './ipc.js';
import { dataDir, devServerUrl, dockerContextDir, preloadPath, uiIndexPath } from './paths.js';
import { applySettingsToEnv, loadDotEnv, loadSettings } from './settings.js';

let engine: Engine | undefined;
let mainWindow: BrowserWindow | undefined;
let shuttingDown = false;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 820,
    minWidth: 800,
    minHeight: 600,
    title: 'LideCode',
    backgroundColor: '#f5f6f8',
    webPreferences: {
      preload: preloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  const devUrl = devServerUrl();
  if (devUrl) {
    void mainWindow.loadURL(devUrl);
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    void mainWindow.loadFile(uiIndexPath());
  }

  mainWindow.webContents.on('did-finish-load', () => {
    console.log('Renderer loaded');
  });
  mainWindow.webContents.on('did-fail-load', (_event, code, description) => {
    console.error(`Renderer failed to load (${code}): ${description}`);
  });

  mainWindow.on('closed', () => {
    mainWindow = undefined;
  });
}

async function bootstrap(): Promise<void> {
  configurePaths({ dataDir: dataDir(), dockerContextDir: dockerContextDir() });
  loadDotEnv();
  applySettingsToEnv(loadSettings());

  engine = new Engine();
  registerIpc(engine);
  await engine.init();

  createWindow();
}

void app.whenReady().then(bootstrap).catch((error: unknown) => {
  console.error('Failed to start LideCode: ' + (error instanceof Error ? error.message : String(error)));
  app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// Stop every sandbox container before exiting.
app.on('before-quit', (event) => {
  if (shuttingDown || engine === undefined) {
    return;
  }
  event.preventDefault();
  shuttingDown = true;
  void engine.shutdown().finally(() => {
    app.exit(0);
  });
});
