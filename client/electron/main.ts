// ============================================================
// PCM Client — Electron Main Process
// ============================================================

import * as electron from 'electron/main';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
import { join } from 'path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import pkg from 'electron-updater';
const { autoUpdater } = pkg;

const { app, BrowserWindow, ipcMain, Notification, Tray, Menu, nativeImage, safeStorage } = electron;

// Parse profile argument or environment variable (to allow multiple instances)
const profile = process.env.PCM_PROFILE || process.argv.find(arg => arg.startsWith('--profile='))?.split('=')[1];
if (profile) {
  const appData = app.getPath('appData');
  const name = app.getName();
  const newPath = join(appData, `${name}-${profile}`);
  app.setPath('userData', newPath);
  app.commandLine.appendSwitch('user-data-dir', newPath); // Force for Chrome
  console.log(`[Main] Profile "${profile}" -> ${newPath}`);
}

const USER_DATA_DIR = join(app.getPath('userData'), 'pcm-data');
const KEYS_FILE = join(USER_DATA_DIR, 'keys.enc');

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let isQuitting = false;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    frame: false,
    titleBarStyle: 'hidden',
    backgroundColor: '#0e1621',
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
    icon: join(__dirname, '../public/icon.png'),
  });

  // Development: load Vite dev server
  if (process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(join(__dirname, '../dist/index.html'));
  }

  mainWindow.on('close', (e) => {
    if (isQuitting) return;
    e.preventDefault();
    mainWindow?.hide();
  });
}

function createTray() {
  const icon = nativeImage.createFromPath(join(__dirname, '../public/icon.png'));
  tray = new Tray(icon);
  tray.setToolTip('PCM — Personal Crypto Messenger');

  const contextMenu = Menu.buildFromTemplate([
    { label: 'Open PCM', click: () => mainWindow?.show() },
    { type: 'separator' },
    { label: 'Quit', click: () => { isQuitting = true; mainWindow?.destroy(); app.quit(); } },
  ]);

  tray.setContextMenu(contextMenu);
  tray.on('click', () => mainWindow?.show());
}

// ---- IPC Handlers ----

// Window controls (for frameless window)
ipcMain.on('window:minimize', () => mainWindow?.minimize());
ipcMain.on('window:maximize', () => {
  if (mainWindow?.isMaximized()) mainWindow.unmaximize();
  else mainWindow?.maximize();
});
ipcMain.on('window:close', () => mainWindow?.hide());

// Safe storage for encryption keys
ipcMain.handle('keys:store', async (_event, data: string) => {
  if (!existsSync(USER_DATA_DIR)) mkdirSync(USER_DATA_DIR, { recursive: true });
  const encrypted = safeStorage.encryptString(data);
  writeFileSync(KEYS_FILE, encrypted);
  return true;
});

ipcMain.handle('keys:load', async () => {
  if (!existsSync(KEYS_FILE)) return null;
  const encrypted = readFileSync(KEYS_FILE);
  return safeStorage.decryptString(encrypted);
});

ipcMain.handle('keys:exists', async () => {
  return existsSync(KEYS_FILE);
});

// Notifications
ipcMain.on('notification:show', (_event, { title, body }: { title: string; body: string }) => {
  new Notification({ title, body }).show();
});

// Get user data path
ipcMain.handle('app:getDataPath', async () => USER_DATA_DIR);

// ---- App lifecycle ----

app.whenReady().then(() => {
  createWindow();
  createTray();

  autoUpdater.checkForUpdatesAndNotify().catch(err => {
    console.error('[AutoUpdate Error]:', err);
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  isQuitting = true;
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
  else mainWindow?.show();
});
