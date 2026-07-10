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

contextBridge.exposeInMainWorld('settings', {
  get:               ()     => ipcRenderer.invoke('settings-get'),
  save:              (data) => ipcRenderer.invoke('settings-save', data),
  setLanguage:       (lang) => ipcRenderer.send('set-language', lang),
  openExternal:      (url)  => ipcRenderer.send('shell-open', url),
  onProgress:        (cb) => ipcRenderer.on('model-progress', (_e, data) => cb(data)),
  onLanguageChanged: (cb) => ipcRenderer.on('language-changed', (_e, lang) => cb(lang)),
  cacheList:         ()               => ipcRenderer.invoke('cache-list'),
  cacheDelete:       (provider, model) => ipcRenderer.invoke('cache-delete', { provider, model }),
  cacheClear:        ()               => ipcRenderer.invoke('cache-clear-all'),
  cacheOpen:         ()               => ipcRenderer.send('cache-open'),
})
