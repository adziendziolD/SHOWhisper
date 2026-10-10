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

contextBridge.exposeInMainWorld('onboarding', {
  status:            ()           => ipcRenderer.invoke('onboarding-status'),
  requestMic:        ()           => ipcRenderer.invoke('onboarding-request-mic'),
  openPrivacy:       (what)       => ipcRenderer.send('onboarding-open-privacy', what),
  loadModel:         (model)      => ipcRenderer.invoke('onboarding-load-model', model),
  setSetting:        (key, value) => ipcRenderer.invoke('settings-set', key, value),
  done:              ()           => ipcRenderer.send('onboarding-done'),
  onProgress:        (cb)         => ipcRenderer.on('model-progress', (_e, data) => cb(data)),
  onLanguageChanged: (cb)         => ipcRenderer.on('language-changed', (_e, lang) => cb(lang)),
})
