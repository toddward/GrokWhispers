const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('grokSettings', {
  get: () => ipcRenderer.invoke('settings:get'),
  update: (patch) => ipcRenderer.invoke('settings:update', patch),
  setApiKey: (key) => ipcRenderer.invoke('settings:setApiKey', key),
  testApiKey: () => ipcRenderer.invoke('settings:testApiKey'),
  recordHotkey: () => ipcRenderer.invoke('hotkey:record'),
  devices: () => ipcRenderer.invoke('recorder:devices'),
  history: () => ipcRenderer.invoke('history:list'),
  clearHistory: () => ipcRenderer.invoke('history:clear'),
  copy: (text) => ipcRenderer.invoke('clipboard:copy', text),
  permissions: () => ipcRenderer.invoke('app:permissions'),
  openPermission: (kind) => ipcRenderer.invoke('app:openPermission', kind),
  onChange: (fn) => ipcRenderer.on('settings:changed', () => fn()),
});
