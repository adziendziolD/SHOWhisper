const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('whisper', {
  onStartRecording: (cb) => ipcRenderer.on('start-recording', cb),
  onStopRecording:  (cb) => ipcRenderer.on('stop-recording', cb),
  onTranscribing:   (cb) => ipcRenderer.on('transcribing', cb),
  onDone:           (cb) => ipcRenderer.on('done', cb),
  onModelLoading:   (cb) => ipcRenderer.on('model-loading', (_e, data) => cb(data)),
  sendAudio:        (buffer) => ipcRenderer.send('audio-ready', buffer),
  recordingFailed:  (msg) => ipcRenderer.send('recording-failed', msg),
  overlayReady:     () => ipcRenderer.send('overlay-ready'),
})
