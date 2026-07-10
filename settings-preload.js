const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('settings', {
  get:          ()     => ipcRenderer.invoke('settings-get'),
  save:         (data) => ipcRenderer.invoke('settings-save', data),
  openExternal: (url)  => ipcRenderer.send('shell-open', url),
  onProgress:   (cb) => ipcRenderer.on('model-progress', (_e, data) => cb(data)),
  cacheList:    ()               => ipcRenderer.invoke('cache-list'),
  cacheDelete:  (provider, model) => ipcRenderer.invoke('cache-delete', { provider, model }),
  cacheClear:   ()               => ipcRenderer.invoke('cache-clear-all'),
  cacheOpen:    ()               => ipcRenderer.send('cache-open'),
})
