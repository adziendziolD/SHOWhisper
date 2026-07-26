const { contextBridge, ipcRenderer, webUtils } = require('electron')

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

contextBridge.exposeInMainWorld('result', {
  ready:             ()     => ipcRenderer.send('result-ready'),
  onFileStatus:      (cb)   => ipcRenderer.on('file-status', (_e, data) => cb(data)),
  summarize:         (text) => ipcRenderer.invoke('result-summarize', text),
  save:              (text) => ipcRenderer.invoke('result-save', text),
  copy:              (text) => ipcRenderer.send('result-copy', text),
  openFile:          ()     => ipcRenderer.send('result-open-file'),
  // Resolve a dropped File to its filesystem path (Electron removed File.path;
  // webUtils.getPathForFile is the supported replacement) and hand it to main.
  dropFile:          (file) => ipcRenderer.send('result-drop-file', webUtils.getPathForFile(file)),
  getLanguage:       ()     => ipcRenderer.invoke('get-language'),
  onLanguageChanged: (cb)   => ipcRenderer.on('language-changed', (_e, lang) => cb(lang)),
})
