const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('settings', {
  get:        ()     => ipcRenderer.invoke('settings-get'),
  save:       (data) => ipcRenderer.invoke('settings-save', data),
  onProgress: (cb) => ipcRenderer.on('model-progress', (_e, data) => cb(data)),
})
