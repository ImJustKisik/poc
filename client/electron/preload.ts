// ============================================================
// PCM Client — Preload Script (Context Bridge)
// ============================================================

import * as electron from 'electron';

const { contextBridge, ipcRenderer } = electron;

contextBridge.exposeInMainWorld('pcm', {
  // Window controls
  window: {
    minimize: () => ipcRenderer.send('window:minimize'),
    maximize: () => ipcRenderer.send('window:maximize'),
    close: () => ipcRenderer.send('window:close'),
  },

  // Key storage (DPAPI-encrypted)
  keys: {
    store: (data: string) => ipcRenderer.invoke('keys:store', data),
    load: () => ipcRenderer.invoke('keys:load') as Promise<string | null>,
    exists: () => ipcRenderer.invoke('keys:exists') as Promise<boolean>,
  },

  // Notifications
  notification: {
    show: (title: string, body: string) => ipcRenderer.send('notification:show', { title, body }),
  },

  // App data
  app: {
    getDataPath: () => ipcRenderer.invoke('app:getDataPath') as Promise<string>,
  },
});
