const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('grokRecorder', {
  chunk: (pcm, level, gen) => ipcRenderer.send('recorder:chunk', pcm, level, gen),
  reply: (id, result) => ipcRenderer.send('recorder:reply', id, result),
  ready: () => ipcRenderer.send('recorder:ready'),
  onCommand: (fn) => ipcRenderer.on('recorder:command', (_e, cmd) => fn(cmd)),
});
