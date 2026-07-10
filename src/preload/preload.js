const { contextBridge, ipcRenderer } = require('electron')

// Renderer is sandboxed (can't require local files), so fetch the translation
// dictionary synchronously at preload time and expose a small t() that mirrors
// i18n.js. See main.js 'i18n-sync'.
const translations = ipcRenderer.sendSync('i18n-sync')
function t(lang, key, vars) {
  const dict = translations[lang] || translations.german
  let str = dict[key] || translations.german[key] || key
  if (vars) for (const n of Object.keys(vars)) str = str.split('{' + n + '}').join(vars[n])
  return str
}

contextBridge.exposeInMainWorld('i18n', { t })

contextBridge.exposeInMainWorld('whisper', {
  onStartRecording: (cb) => ipcRenderer.on('start-recording', cb),
  onStopRecording:  (cb) => ipcRenderer.on('stop-recording', cb),
  onTranscribing:   (cb) => ipcRenderer.on('transcribing', cb),
  onDone:           (cb) => ipcRenderer.on('done', cb),
  onModelLoading:   (cb) => ipcRenderer.on('model-loading', (_e, data) => cb(data)),
  sendAudio:        (buffer) => ipcRenderer.send('audio-ready', buffer),
  recordingFailed:  (msg) => ipcRenderer.send('recording-failed', msg),
  overlayReady:     () => ipcRenderer.send('overlay-ready'),
  getLanguage:       () => ipcRenderer.invoke('get-language'),
  onLanguageChanged: (cb) => ipcRenderer.on('language-changed', (_e, lang) => cb(lang)),
})
