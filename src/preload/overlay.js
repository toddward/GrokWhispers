const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('grokOverlay', {
  on: (channel, fn) => {
    const allowed = ['overlay:state', 'overlay:level', 'overlay:caption', 'overlay:sound', 'overlay:notice'];
    if (allowed.includes(channel)) ipcRenderer.on(channel, (_e, payload) => fn(payload));
  },
});
