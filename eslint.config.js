// ESLint flat config (ESLint 9+). Deliberately minimal: catches real bugs
// (undefined variables, dead bindings) without style nitpicking. Each file
// group gets its own globals, since main/preload run in Node and the overlay
// renderer runs in the browser.

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
    files: ['src/main/**/*.js', 'src/preload/**/*.js', 'src/shared/**/*.js'],
    languageOptions: { ecmaVersion: 2022, sourceType: 'commonjs', globals: nodeGlobals },
    rules: commonRules,
  },
  {
    files: ['src/renderer/**/*.js'],
    languageOptions: { ecmaVersion: 2022, sourceType: 'script', globals: browserGlobals },
    rules: commonRules,
  },
]
