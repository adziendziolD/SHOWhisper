const { app, BrowserWindow, Tray, Menu, ipcMain, clipboard, screen, systemPreferences, dialog, shell, safeStorage, globalShortcut } = require('electron')
const path = require('path')
const fs = require('fs')
const { t, translations } = require('../shared/i18n')
const { applyDictationMarkers } = require('../shared/dictation')
const elog = require('electron-log/main')

const isDev = process.env.NODE_ENV === 'development'

// Don't crash on EPIPE (e.g. when the terminal is closed)
process.stdout.on('error', (e) => { if (/** @type {NodeJS.ErrnoException} */ (e).code !== 'EPIPE') throw e })
process.stderr.on('error', (e) => { if (/** @type {NodeJS.ErrnoException} */ (e).code !== 'EPIPE') throw e })

// ── Logging (electron-log, size-based rotation) ────────────────────────────────
// Persisted to the OS log dir (macOS: ~/Library/Logs/<AppName>/main.log,
// Windows: %APPDATA%\<AppName>\logs\main.log) and echoed to the console.
// Rotate at 1 MB and keep at most LOG_FILES files total (main.log + archives).
const LOG_MAX_SIZE = 1024 * 1024 // 1 MB
const LOG_FILES = 3              // e.g. main.log + main.1.log + main.2.log
elog.transports.file.maxSize = LOG_MAX_SIZE
elog.transports.file.archiveLogFn = (file) => {
  const oldPath = file.toString()
  const { dir, name, ext } = path.parse(oldPath)
  try {
    const archives = LOG_FILES - 1
    const oldest = path.join(dir, `${name}.${archives}${ext}`)
    if (fs.existsSync(oldest)) fs.rmSync(oldest, { force: true })
    for (let i = archives - 1; i >= 1; i--) {
      const from = path.join(dir, `${name}.${i}${ext}`)
      if (fs.existsSync(from)) fs.renameSync(from, path.join(dir, `${name}.${i + 1}${ext}`))
    }
    fs.renameSync(oldPath, path.join(dir, `${name}.1${ext}`))
  } catch {
    // Fallback: crop the current file rather than lose logging entirely.
    try { /** @type {any} */ (file).crop(Math.min(Math.round(LOG_MAX_SIZE / 4), 256 * 1024)) } catch { /* ignore */ }
  }
}

function log(...args) { elog.info(...args) }
function logErr(...args) { elog.error(...args) }

/**
 * Extract a human-readable message from an unknown thrown value.
 * @param {unknown} e
 * @returns {string}
 */
function errMsg(e) { return e instanceof Error ? e.message : String(e) }

// electron-store is ESM-only since v9, main.js is CommonJS -> import it
// dynamically once the app is ready (see app.whenReady()). Typed non-null:
// every access happens after whenReady has assigned it.
/** @type {import('electron-store').default<Record<string, unknown>>} */
let store

// Translate a UI string into the currently selected language (see i18n.js).
// Only called after the store is ready (tray/dialogs run after whenReady).
function tr(key, vars) {
  return t(store.get('language', 'german'), key, vars)
}

/** @type {import('electron').Tray} */
let tray                       // assigned in createTray() during whenReady
/** @type {import('electron').BrowserWindow | null} */
let overlayWindow = null
/** @type {import('electron').BrowserWindow | null} */
let settingsWindow = null
/** @type {any} */
let whisperPipeline = null     // @huggingface/transformers pipeline (callable + .tokenizer)
let isLoadingModel = false
let loadGeneration = 0         // prevents a superseded load from overwriting state
let isRecording = false        // hotkey toggle state (⌥Space starts/stops recording)
let lastToggleAt = 0           // debounce against globalShortcut key auto-repeat
// Supported transcription languages (Whisper language names)
const LANGUAGES = ['german', 'english', 'french']
// Xenova model names (public, no HF token needed)
const MODELS = ['tiny', 'base', 'small', 'medium', 'large']
const MODEL_LABELS = { tiny: 'tiny (75 MB)', base: 'base (150 MB)', small: 'small (450 MB)', medium: 'medium (1.5 GB)', large: 'large (3 GB)' }
// onnx-community only hosts tiny/base/small - medium/large don't exist there
// (404 on download). Xenova has all 5 sizes.
const PROVIDER_MODELS = {
  Xenova: MODELS,
  'onnx-community': ['tiny', 'base', 'small'],
}

// ── Overlay Window ────────────────────────────────────────────────────────────

function createOverlay() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize
  const savedPos = /** @type {{ x: number, y: number }} */ (store.get('overlayPosition', {
    x: Math.round(width / 2 - 175),
    y: height - 120,
  }))

  overlayWindow = new BrowserWindow({
    x: savedPos.x,
    y: savedPos.y,
    width: 350,
    height: 72,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    hasShadow: false,
    skipTaskbar: true,
    resizable: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
    },
  })

  overlayWindow.loadFile(path.join(__dirname, '../renderer/overlay.html'))

  if (isDev) {
    overlayWindow.webContents.openDevTools({ mode: 'detach' })
    log('Overlay DevTools opened')
  }

  overlayWindow.on('moved', () => {
    if (!overlayWindow) return
    const [x, y] = overlayWindow.getPosition()
    store.set('overlayPosition', { x, y })
  })
}

// ── Whisper ───────────────────────────────────────────────────────────────────

// Cache in the home directory, not in node_modules
const MODEL_CACHE_DIR = path.join(app.getPath('userData'), 'model-cache')

function sendToSettings(data) {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.webContents.send('model-progress', data)
  }
}

// Otherwise the load progress is only visible in the tray tooltip (easily
// missed) or the settings window (only when open) - also show it in the
// overlay pill, which is always available, regardless of what triggered the
// download (startup, tray menu, settings).
/** @type {ModelLoadingData | null} */
let lastModelProgress = null
function sendModelProgress(data) {
  lastModelProgress = data
  sendToSettings(data)
  overlayWindow?.webContents.send('model-loading', data)
}

// The overlay loads in its own renderer process and may not be fully loaded
// at app start when the first progress events fire - those would then be lost
// (Electron doesn't buffer). The renderer reports in here as soon as it's
// actually listening, and gets the state current at that moment replayed.
ipcMain.on('overlay-ready', () => {
  if (lastModelProgress) overlayWindow?.webContents.send('model-loading', lastModelProgress)
})

async function loadModel(modelName, force = false) {
  if (isLoadingModel && !force) {
    log('loadModel: already loading, skipped')
    return
  }
  // Every call gets its own generation. If a forced reload (e.g. provider
  // change) starts while a load is still running, the older one detects after
  // its await that it was superseded and discards its result instead of
  // overwriting freshly loaded state.
  const myGen = ++loadGeneration
  isLoadingModel = true
  updateTrayLabel(tr('tray.loading', { model: modelName }))
  overlayWindow?.showInactive()

  try {
    const { pipeline, env } = await import('@huggingface/transformers')

    env.cacheDir = MODEL_CACHE_DIR
    const hfToken = getHfToken()
    if (hfToken) {
      // since transformers.js v4 there's no env.authToken anymore, instead a
      // custom fetch wrapper that sets the Authorization header
      env.fetch = (url, options) => fetch(url, {
        ...options,
        headers: { ...options?.headers, Authorization: `Bearer ${hfToken}` },
      })
      log('HF token set')
    }

    const provider = store.get('provider', 'Xenova')
    const modelId  = `${provider}/whisper-${modelName}`
    log(`Loading model: ${modelId}`)
    log(`Cache dir:    ${MODEL_CACHE_DIR}`)

    // Throttle logging: per file only at whole 10% steps
    const lastLoggedPct = {}
    // Multiple .onnx parts (encoder/decoder) load in parallel - passing each
    // file's percentage to the UI individually would make the bar jump back
    // and forth between different per-file values. Instead aggregate over the
    // bytes of all files -> a single, steady overall value.
    const fileBytes = {}
    let lastSentPct = -1
    const progress_callback = (data) => {
      if (data.status === 'progress') {
        const pct  = Math.round(data.progress)
        const file = (data.file || '').split('/').pop()
        const step = Math.floor(pct / 10) * 10
        if (lastLoggedPct[file] !== step) {
          lastLoggedPct[file] = step
          log(`Download [${file}] ${step}%`)
        }

        // Tokenizer/config files (including tokenizer.json, which depending on
        // the model can be several MB) load completely before the actual model
        // weights (which can take minutes) even start. A size threshold isn't
        // enough, since tokenizer.json is sometimes larger than the weights of
        // a "tiny" model. So only count files that contain ".onnx" in the name
        // - that covers both "encoder_model.onnx" and, for larger models, the
        // externalized "encoder_model.onnx_data" (ONNX external data, needed
        // above the ~2GB protobuf limit; "endsWith('.onnx')" wouldn't match the
        // _data variant).
        //
        // But even within the .onnx files the same problem recurs: the small
        // "*.onnx" graph file (a few KB-MB) often loads completely in a single
        // event, BEFORE the huge associated "*.onnx_data" weights file even
        // starts - and would falsely freeze the monotonic lock below at 100%.
        // So additionally: only count files we've already seen at <100% or are
        // already tracking (excludes instantly-complete files on first
        // appearance, without missing later updates of an already-running file).
        if (file.includes('.onnx') && (pct < 100 || fileBytes[file] !== undefined)) {
          fileBytes[file] = { loaded: data.loaded || 0, total: data.total || 0 }
        }
        const totals = Object.values(fileBytes).reduce(
          (acc, f) => ({ loaded: acc.loaded + f.loaded, total: acc.total + f.total }),
          { loaded: 0, total: 0 }
        )
        // totals.total === 0 means: no .onnx file seen yet, only metadata -
        // so don't show any progress yet.
        if (totals.total === 0) return
        const rawPct = Math.round((totals.loaded / totals.total) * 100)
        // As soon as another (large) file starts loading, its total size
        // immediately enters the denominator while its loaded portion is still
        // 0 -> the overall value can briefly jump back. Never display
        // backwards, that would look like an error.
        const overallPct = Math.max(rawPct, lastSentPct)
        updateTrayLabel(`${modelName} ${overallPct}%`)

        // Only send on an actual percentage change, otherwise the UI flickers
        if (overallPct !== lastSentPct) {
          lastSentPct = overallPct
          sendModelProgress({ status: 'progress', progress: overallPct })
        }
      } else if (data.status === 'done') {
        log(`Model status: done`, data.file || '')
      }
    }

    // Device/dtype history (see PLAN.md background):
    // - CoreML + fp32 + default memory allocator: hangs/crashes during
    //   inference with real speech and larger models (medium/large).
    // - CPU + fp32 + default allocator: same picture - onnxruntime's
    //   BFCArena memory-pool allocator crashes (posix_memalign) on extend,
    //   reproducible with real audio data, but ONLY in the real Electron
    //   process (much higher memory footprint due to the GPU
    //   process/compositor) - never in an isolated Node script.
    // - fp16 (CoreML and CPU alike): already fails at load time with an
    //   ONNX graph error (LayerNorm fusion/InsertedPrecisionFreeCast) - the
    //   fp16 file itself is incompatible with this onnxruntime version,
    //   regardless of device.
    // - `session_options: { enableCpuMemArena: false }` disables the buggy
    //   pool allocator (plain malloc/free instead of pooling) - fixes the
    //   crash completely. With that, CoreML + fp32 (best quality + Apple
    //   Silicon GPU/Neural Engine) runs reliably - verified 3 times in a row
    //   with the same real audio data. CoreML + q8 still crashes
    //   (quantization + CoreML don't get along), so fp32 instead of q8 for
    //   the CoreML path.
    const preferredDevice = process.platform === 'darwin' ? 'coreml' : 'cpu'
    let pipe
    try {
      pipe = await pipeline(
        'automatic-speech-recognition',
        modelId,
        { device: preferredDevice, dtype: 'fp32', session_options: { enableCpuMemArena: false }, progress_callback }
      )
    } catch (deviceErr) {
      if (preferredDevice === 'cpu') throw deviceErr
      logErr(`Device '${preferredDevice}' failed, falling back to CPU:`, errMsg(deviceErr))
      pipe = await pipeline(
        'automatic-speech-recognition',
        modelId,
        { device: 'cpu', dtype: 'q8', session_options: { enableCpuMemArena: false }, progress_callback }
      )
    }
    // Superseded by a newer load in the meantime? Then discard the result, so
    // we don't overwrite the model that was just freshly loaded.
    if (myGen !== loadGeneration) {
      log(`loadModel: ${modelId} was superseded, result discarded`)
      return
    }
    whisperPipeline = pipe
    log(`Model ready: ${modelId}`)
    store.set('model', modelName)
    updateTrayLabel(null)
    buildTrayMenu()
    sendModelProgress({ status: 'ready' })
    setTimeout(() => overlayWindow?.hide(), 500)
  } catch (err) {
    // Superseded load: the error no longer belongs to the active model,
    // discard it silently (the newer load owns the state now).
    if (myGen !== loadGeneration) {
      log(`loadModel: superseded load with error discarded (${errMsg(err)})`)
      return
    }
    logErr('Model load error:', errMsg(err))
    updateTrayLabel(tr('tray.loadError'))

    // Delete the corrupt cache so the next attempt downloads fresh
    const provider    = /** @type {string} */ (store.get('provider', 'Xenova'))
    const corruptPath = path.join(MODEL_CACHE_DIR, provider, `whisper-${modelName}`)
    if (fs.existsSync(corruptPath)) {
      fs.rmSync(corruptPath, { recursive: true, force: true })
      log('Deleted corrupt cache:', corruptPath)
    }

    sendModelProgress({ status: 'error', message: errMsg(err) })
    overlayWindow?.hide()

    // The tray tooltip alone is easily missed (e.g. when selecting via the
    // tray menu instead of the settings) - only show a dialog when the
    // settings are NOT currently open (they show the error themselves).
    if (!settingsWindow || settingsWindow.isDestroyed()) {
      dialog.showErrorBox(
        tr('dialog.modelError.title'),
        tr('dialog.modelError.body', { model: `${provider}/whisper-${modelName}`, error: errMsg(err) })
      )
    }
  } finally {
    // Only reset if no newer load has taken over - otherwise a superseded old
    // run would clear the active one's flag.
    if (myGen === loadGeneration) isLoadingModel = false
  }
}

async function transcribe(pcm) {
  if (!whisperPipeline) return ''

  const language = /** @type {string} */ (store.get('language', 'german'))
  const genOptions = {
    language,
    task: 'transcribe',
    // Whisper internally processes only a fixed 30s window - without chunking
    // everything after that is silently cut off. chunk_length_s enables
    // long-form transcription (overlapping 30s windows are stitched together).
    chunk_length_s: 30,
    stride_length_s: 5,
    // max_new_tokens as a safety net against repetition loops, a known Whisper
    // failure mode on silence/noise/unclear speech.
    max_new_tokens: 440,
  }

  // Verbose diagnostics (PCM stats + live token streamer) only in dev mode:
  // in production this is pure log noise and would, among other things, write
  // the recognized text token by token (privacy for a dictation app).
  if (isDev) {
    let min = Infinity, max = -Infinity, sumAbs = 0
    for (let i = 0; i < pcm.length; i++) {
      const v = pcm[i]
      if (v < min) min = v
      if (v > max) max = v
      sumAbs += Math.abs(v)
    }
    log(`transcribe(): ${pcm.length} samples (${(pcm.length / 16000).toFixed(1)}s), ` +
        `min=${min.toFixed(3)} max=${max.toFixed(3)} avgAbs=${(sumAbs / pcm.length).toFixed(4)}`)

    const { WhisperTextStreamer } = await import('@huggingface/transformers')
    const tStart = Date.now()
    let lastTokenAt = tStart
    let tokenCount = 0
    genOptions.streamer = new WhisperTextStreamer(whisperPipeline.tokenizer, {
      on_chunk_start: (x) => log(`  [streamer] Chunk start at ${x.toFixed(2)}s`),
      token_callback_function: (tokens) => {
        const now = Date.now()
        tokenCount++
        log(`  [streamer] Token #${tokenCount} (+${now - lastTokenAt}ms, total ${now - tStart}ms):`, tokens)
        lastTokenAt = now
      },
      callback_function: (text) => log(`  [streamer] Text:`, JSON.stringify(text)),
      on_chunk_end: (x) => log(`  [streamer] Chunk end at ${x.toFixed(2)}s`),
      on_finalize: () => log(`  [streamer] Finalized`),
    })
  }

  const t0 = Date.now()
  const result = await whisperPipeline(pcm, genOptions)
  log(`transcribe(): done after ${((Date.now() - t0) / 1000).toFixed(1)}s`)
  // Rewrite spoken quote markers (e.g. "Zitat Anfang … Zitat Ende") into
  // typographic quotes for the current language (see dictation.js).
  return applyDictationMarkers(result.text.trim(), language)
}

// ── HF token (encrypted via the OS keychain) ───────────────────────────────────
// Don't store the HuggingFace token in plaintext in the electron-store JSON.
// safeStorage uses the system keychain (macOS) / DPAPI (Windows). If
// encryption isn't available (e.g. Linux without a keyring), fall back to
// plaintext so the feature doesn't fail entirely.
function setHfToken(token) {
  store.delete('hfToken') // remove any old plaintext value (migration)
  if (!token) { store.delete('hfTokenEnc'); return }
  if (safeStorage.isEncryptionAvailable()) {
    store.set('hfTokenEnc', safeStorage.encryptString(token).toString('base64'))
  } else {
    store.set('hfToken', token)
  }
}

function getHfToken() {
  const enc = /** @type {string} */ (store.get('hfTokenEnc', ''))
  if (enc) {
    try {
      return safeStorage.decryptString(Buffer.from(enc, 'base64'))
    } catch (e) {
      logErr('Could not decrypt HF token:', errMsg(e))
      return ''
    }
  }
  return store.get('hfToken', '') // fallback / migration from old plaintext
}

// ── Settings Window ──────────────────────────────────────────────────────────

function openSettings() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.focus()
    return
  }

  settingsWindow = new BrowserWindow({
    width: 440,
    height: 600,
    // Size given as content (not outer frame) size, so the height the renderer
    // reports maps 1:1 to setContentSize (see 'settings-resize').
    useContentSize: true,
    resizable: false,
    show: false,
    titleBarStyle: 'default',
    webPreferences: {
      preload: path.join(__dirname, '../preload/settings-preload.js'),
      contextIsolation: true,
    },
  })

  settingsWindow.loadFile(path.join(__dirname, '../renderer/settings.html'))
  // Wait for the renderer's first height report before showing, so the window
  // never flashes at the wrong size.
  settingsWindow.once('ready-to-show', () => settingsWindow?.show())
  if (isDev) settingsWindow.webContents.openDevTools({ mode: 'detach' })
  settingsWindow.on('closed', () => { settingsWindow = null })
}

// The settings content height is dynamic: the cache list grows with the number
// of cached models, and the download progress box appears/disappears. A fixed
// window height either cut off the cache list or left dead space. The renderer
// reports its rendered height (see settings.html) and we size the window to fit,
// clamped to the screen so a very long list falls back to scrolling.
ipcMain.on('settings-resize', (_e, height) => {
  if (!settingsWindow || settingsWindow.isDestroyed()) return
  const h = Math.round(height)
  if (!Number.isFinite(h) || h <= 0) return
  const { height: screenH } = screen.getPrimaryDisplay().workAreaSize
  const clamped = Math.max(200, Math.min(h, screenH - 40))
  const [w, currentH] = settingsWindow.getContentSize()
  if (currentH !== clamped) settingsWindow.setContentSize(w, clamped)
})

ipcMain.handle('settings-get', () => ({
  provider: store.get('provider', 'Xenova'),
  hfToken:  getHfToken(),
  language: store.get('language', 'german'),
}))

// Transcription language is a per-transcribe option, not baked into the loaded
// model - so save it instantly on change, no model reload needed.
ipcMain.on('set-language', (_e, lang) => {
  if (!LANGUAGES.includes(lang)) return
  store.set('language', lang)
  log('Language set:', lang)
  // Live-update the localized UI: rebuild the tray menu and tell the windows
  // to re-apply their translations.
  buildTrayMenu()
  overlayWindow?.webContents.send('language-changed', lang)
  settingsWindow?.webContents.send('language-changed', lang)
})

ipcMain.handle('get-language', () => store.get('language', 'german'))

// Renderers are sandboxed and can't require('./i18n'), so hand them the whole
// dictionary synchronously at preload time; they run the same small t() locally.
ipcMain.on('i18n-sync', (e) => { e.returnValue = translations })

// Open an external link (the HF token page from the settings). A dedicated
// channel instead of mixing it into settings-save; only allow https so no
// arbitrary scheme (file://, etc.) can be opened from the renderer.
ipcMain.on('shell-open', (_e, url) => {
  if (typeof url === 'string' && /^https:\/\//i.test(url)) shell.openExternal(url)
})

ipcMain.handle('settings-save', async (_e, data) => {
  log('Settings gespeichert:', { provider: data.provider, hasToken: !!data.hfToken })
  store.set('provider', data.provider)
  setHfToken(data.hfToken)

  // Reload the model with the new settings. force=true bypasses the "already
  // loading" guard; any still-running load is discarded cleanly via the
  // loadGeneration (no manual isLoadingModel reset needed anymore, that was
  // previously the cause of the race). whisperPipeline set to null so we don't
  // transcribe with the old model during the reload.
  whisperPipeline = null
  const currentModel = store.get('model', 'small')
  await loadModel(currentModel, true)
})

// ── Model cache ────────────────────────────────────────────────────────────────
// Cached models live as `<provider>/whisper-<model>/` folders under
// MODEL_CACHE_DIR (see env.cacheDir in loadModel). Determine the size per
// folder and allow deletion so large models don't silently fill the disk.

function getDirSize(dir) {
  let total = 0
  let entries
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return 0 }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    try {
      if (entry.isDirectory()) total += getDirSize(full)
      else total += fs.statSync(full).size
    } catch { /* file gone in the meantime - skip */ }
  }
  return total
}

// true if this model is currently loaded in RAM or loading - then not
// deletable (would force a re-download on the next dictation, or corrupt an
// in-progress download).
function isModelLocked(provider, model) {
  return provider === store.get('provider', 'Xenova') &&
         model === store.get('model', 'small') &&
         (whisperPipeline !== null || isLoadingModel)
}

function listCachedModels() {
  const models = []
  let providers
  try { providers = fs.readdirSync(MODEL_CACHE_DIR, { withFileTypes: true }) } catch { return models }
  for (const prov of providers) {
    if (!prov.isDirectory()) continue
    const provDir = path.join(MODEL_CACHE_DIR, prov.name)
    let entries
    try { entries = fs.readdirSync(provDir, { withFileTypes: true }) } catch { continue }
    for (const entry of entries) {
      const match = entry.isDirectory() && entry.name.match(/^whisper-(.+)$/)
      if (!match) continue
      const model = match[1]
      models.push({
        provider: prov.name,
        model,
        label: MODEL_LABELS[model] || model,
        sizeBytes: getDirSize(path.join(provDir, entry.name)),
        locked: isModelLocked(prov.name, model),
      })
    }
  }
  return models
}

function cacheSnapshot() {
  const models = listCachedModels()
  return {
    dir: MODEL_CACHE_DIR,
    totalBytes: models.reduce((sum, m) => sum + m.sizeBytes, 0),
    models,
  }
}

// Never put renderer input into a path unchecked: only allow simple names and
// make sure the resolved path really lies within MODEL_CACHE_DIR (no `..`
// traversal).
function safeModelDir(provider, model) {
  const NAME = /^[\w.-]+$/
  if (!NAME.test(provider || '') || !NAME.test(model || '')) return null
  const dir = path.resolve(MODEL_CACHE_DIR, provider, `whisper-${model}`)
  const base = path.resolve(MODEL_CACHE_DIR)
  if (dir !== path.join(base, provider, `whisper-${model}`)) return null
  if (!dir.startsWith(base + path.sep)) return null
  return dir
}

ipcMain.handle('cache-list', () => cacheSnapshot())

ipcMain.handle('cache-delete', (_e, { provider, model } = {}) => {
  if (isModelLocked(provider, model)) {
    logErr('Cache delete refused: active model', provider, model)
    return cacheSnapshot()
  }
  const dir = safeModelDir(provider, model)
  if (dir && fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true })
    log('Cache deleted:', dir)
  }
  return cacheSnapshot()
})

ipcMain.handle('cache-clear-all', () => {
  for (const m of listCachedModels()) {
    if (m.locked) continue // keep the active model
    const dir = safeModelDir(m.provider, m.model)
    if (dir && fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true })
      log('Cache deleted:', dir)
    }
  }
  return cacheSnapshot()
})

ipcMain.on('cache-open', () => {
  try { fs.mkdirSync(MODEL_CACHE_DIR, { recursive: true }) } catch { /* already exists */ }
  shell.openPath(MODEL_CACHE_DIR)
})

// ── IPC ───────────────────────────────────────────────────────────────────────

ipcMain.on('audio-ready', async (_event, pcm) => {
  log(`Audio received: ${pcm.length} samples`)
  overlayWindow?.webContents.send('transcribing')

  let text = ''
  try {
    text = await transcribe(Float32Array.from(pcm))
    // Only log the recognized text in dev mode (privacy for dictation).
    log(isDev ? `Transcription: "${text}"` : `Transcription done (${text.length} chars)`)
  } catch (err) {
    logErr('Transcription error:', errMsg(err))
  }

  if (text) {
    // Save the old clipboard content
    const prev = clipboard.readText()
    clipboard.writeText(text)

    // Briefly let the window lose focus, then simulate paste
    overlayWindow?.hide()
    await new Promise(r => setTimeout(r, 80))

    const { keyboard, Key } = require('@nut-tree-fork/nut-js')
    const isMac = process.platform === 'darwin'
    if (isMac) {
      await keyboard.pressKey(Key.LeftSuper, Key.V)
      await keyboard.releaseKey(Key.LeftSuper, Key.V)
    } else {
      await keyboard.pressKey(Key.LeftControl, Key.V)
      await keyboard.releaseKey(Key.LeftControl, Key.V)
    }

    // Restore the clipboard after a short delay
    setTimeout(() => clipboard.writeText(prev), 500)
  }

  overlayWindow?.webContents.send('done')
  setTimeout(() => overlayWindow?.hide(), 700)
})

// Renderer reports that recording couldn't start (e.g. microphone permission
// denied). Reset overlay/tray and the worker toggle, otherwise the state stays
// stuck (the next ⌥Space would only resync).
ipcMain.on('recording-failed', (_e, message) => {
  logErr('Recording failed (renderer):', message)
  isRecording = false
  setTrayRecording(false)
  overlayWindow?.hide()
  if (!settingsWindow || settingsWindow.isDestroyed()) {
    dialog.showErrorBox(
      tr('dialog.mic.title'),
      tr('dialog.mic.body', { error: message || tr('error.unknown') })
    )
  }
})

// ── Tray ──────────────────────────────────────────────────────────────────────

function updateTrayLabel(label) {
  if (!tray) return
  tray.setToolTip(label ? `SHOWhisper – ${label}` : 'SHOWhisper')
}

function buildTrayMenu() {
  const currentModel = store.get('model', 'small')
  const provider = store.get('provider', 'Xenova')
  const availableModels = PROVIDER_MODELS[provider] || MODELS
  const modelItems = availableModels.map((m) => ({
    label: MODEL_LABELS[m] || m,
    type: 'radio',
    checked: m === currentModel,
    click: () => loadModel(m),
  }))

  const menu = Menu.buildFromTemplate([
    { label: 'SHOWhisper', enabled: false },
    { type: 'separator' },
    { label: tr('menu.settings'), click: openSettings },
    {
      label: tr('menu.autostart'),
      type: 'checkbox',
      // getLoginItemSettings/setLoginItemSettings are backed by the OS launch
      // service on macOS and the registry Run key on Windows - one API for both
      // targets, no extra dependency. Electron toggles the checkmark itself and
      // hands us the new state in item.checked.
      checked: app.getLoginItemSettings().openAtLogin,
      click: (item) => {
        app.setLoginItemSettings({ openAtLogin: item.checked })
        log('Autostart set:', item.checked)
      },
    },
    { type: 'separator' },
    { label: tr('menu.model'), enabled: false },
    ...modelItems,
    { type: 'separator' },
    { label: tr('menu.quit'), click: () => app.quit() },
  ])

  tray.setContextMenu(menu)
}

function createTray() {
  const { nativeImage } = require('electron')
  const idleIcon = nativeImage.createFromPath(path.join(__dirname, '..', '..', 'assets', 'tray-idle.png'))
  idleIcon.setTemplateImage(true) // macOS: auto dark/light mode
  tray = new Tray(idleIcon)
  tray.setToolTip('SHOWhisper')
  buildTrayMenu()
}

function setTrayRecording(recording) {
  const { nativeImage } = require('electron')
  const name = recording ? 'tray-recording' : 'tray-idle'
  const icon = nativeImage.createFromPath(path.join(__dirname, '..', '..', 'assets', `${name}.png`))
  if (!recording) icon.setTemplateImage(true)
  tray.setImage(icon)
}

// ── Hotkey (Toggle) ────────────────────────────────────────────────────────────

const HOTKEY_ACCELERATOR = 'Alt+Space' // Alt == ⌥ Option on macOS

// ⌥Space toggles recording. Registered via Electron's globalShortcut, which uses
// the OS hot-key API (Carbon RegisterEventHotKey on macOS, RegisterHotKey on
// Windows). Unlike a global keyboard hook (uiohook/CGEventTap), this never sits
// in the system-wide input delivery path, so it can't freeze keyboard/mouse
// input for the whole machine.
function toggleRecording() {
  // globalShortcut can fire repeatedly while the combo is held (OS key auto-
  // repeat). Debounce so a brief hold doesn't rapidly flip start/stop.
  const now = Date.now()
  if (now - lastToggleAt < 300) return
  lastToggleAt = now

  if (!isRecording) {
    // While the model is still loading, whisperPipeline is either null or being
    // reassigned - don't start recording, otherwise the audio is lost or
    // transcribe() finds no model. Just don't flip the toggle.
    if (isLoadingModel) {
      log('Recording ignored: model still loading')
      return
    }
    isRecording = true
    setTrayRecording(true)
    overlayWindow?.showInactive()
    overlayWindow?.webContents.send('start-recording')
  } else {
    isRecording = false
    setTrayRecording(false)
    overlayWindow?.webContents.send('stop-recording')
  }
}

function setupHotkey() {
  const ok = globalShortcut.register(HOTKEY_ACCELERATOR, toggleRecording)
  if (!ok || !globalShortcut.isRegistered(HOTKEY_ACCELERATOR)) {
    // Registration fails when another app already owns the combo. The hotkey is
    // the only way to trigger recording, so surface it rather than fail silently
    // - but don't block startup (the tray/settings still work).
    logErr(`Global shortcut ${HOTKEY_ACCELERATOR} could not be registered (already in use)`)
    updateTrayLabel(tr('tray.hotkeyUnavailable'))
    dialog.showMessageBox({
      type: 'warning',
      title: tr('dialog.hotkey.title'),
      message: tr('dialog.hotkey.body'),
    })
    return
  }
  log(`Global shortcut registered: ${HOTKEY_ACCELERATOR}`)
}

// nut-js simulates ⌘V/Ctrl+V to paste the transcript (see 'audio-ready'). On
// macOS that needs Accessibility permission. globalShortcut itself does NOT, so
// this is non-fatal: without it, recording/transcription still work and the text
// stays on the clipboard for a manual paste - just the auto-paste is skipped.
function checkAccessibilityForPaste() {
  if (process.platform !== 'darwin') return
  const trusted = systemPreferences.isTrustedAccessibilityClient(false)
  log('Accessibility check (main process):', trusted)
  if (!trusted) {
    // Triggers the macOS prompt, then inform (non-blocking) and continue.
    systemPreferences.isTrustedAccessibilityClient(true)
    dialog.showMessageBox({
      type: 'info',
      title: tr('dialog.a11y.title'),
      message: tr('dialog.a11y.body'),
      buttons: [tr('dialog.a11y.open')],
    })
  }
}

// ── App Lifecycle ─────────────────────────────────────────────────────────────

app.commandLine.appendSwitch('disable-features', 'AutofillServerCommunication')

app.whenReady().then(async () => {
  app.dock?.hide() // Mac: no dock icon

  const { default: Store } = await import('electron-store')
  store = new Store()

  log(`SHOWhisper starting (isDev=${isDev})`)
  log(`userData: ${app.getPath('userData')}`)
  log(`Log file: ${elog.transports.file.getFile()?.path}`)
  createTray()
  createOverlay()
  checkAccessibilityForPaste()
  setupHotkey()

  let savedModel = /** @type {string} */ (store.get('model', 'small'))
  if (!MODELS.includes(savedModel)) savedModel = 'small' // migration: large-v3 → large
  await loadModel(savedModel)
})

// Electron types this listener as () => void; the running app does receive an
// event, so keep calling preventDefault to keep the tray app alive.
app.on('window-all-closed', /** @type {() => void} */ ((e) => /** @type {any} */ (e).preventDefault())) // tray app stays open

app.on('will-quit', () => { globalShortcut.unregisterAll() })
