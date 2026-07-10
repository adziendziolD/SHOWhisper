// ESLint flat config (ESLint 9+). Bewusst schlank gehalten: fängt echte Fehler
// (undefinierte Variablen, tote Bindings) ohne Style-Nörgelei. Pro Dateigruppe
// eigene Globals, da Main/Preload in Node und der Overlay-Renderer im Browser
// laufen.

const nodeGlobals = {
  require: 'readonly', module: 'writable', exports: 'writable', process: 'readonly',
  console: 'readonly', Buffer: 'readonly', __dirname: 'readonly', __filename: 'readonly',
  setTimeout: 'readonly', clearTimeout: 'readonly', setInterval: 'readonly',
  clearInterval: 'readonly', fetch: 'readonly', URL: 'readonly', Float32Array: 'readonly',
}

const browserGlobals = {
  window: 'readonly', document: 'readonly', navigator: 'readonly', console: 'readonly',
  AudioContext: 'readonly', OfflineAudioContext: 'readonly', MediaRecorder: 'readonly',
  Blob: 'readonly', Uint8Array: 'readonly', performance: 'readonly',
  requestAnimationFrame: 'readonly', cancelAnimationFrame: 'readonly',
  setTimeout: 'readonly', clearTimeout: 'readonly', setInterval: 'readonly',
  clearInterval: 'readonly',
}

const commonRules = {
  'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
  'no-undef': 'error',
}

module.exports = [
  { ignores: ['dist/**', 'node_modules/**', 'assets/**'] },
  {
    files: ['main.js', 'hotkey-worker.js', 'preload.js', 'settings-preload.js'],
    languageOptions: { ecmaVersion: 2022, sourceType: 'commonjs', globals: nodeGlobals },
    rules: commonRules,
  },
  {
    files: ['overlay-renderer.js'],
    languageOptions: { ecmaVersion: 2022, sourceType: 'script', globals: browserGlobals },
    rules: commonRules,
  },
]
