const { app, BrowserWindow, Tray, Menu, ipcMain, clipboard, screen, systemPreferences, dialog, shell, globalShortcut, utilityProcess } = require('electron')
const path = require('path')
const fs = require('fs')
const { t, translations } = require('../shared/i18n')
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

// electron-log serializes args via JSON.stringify, which throws on BigInt
// ("Do not know how to serialize a BigInt"). Whisper token ids arrive as
// BigInt64Array, so sanitize defensively: BigInt -> string, big-int typed
// arrays -> string arrays. Keeps any stray BigInt from ever crashing logging.
function safeArg(a) {
  if (typeof a === 'bigint') return a.toString()
  if (a instanceof BigInt64Array || a instanceof BigUint64Array) return Array.from(a, (x) => x.toString())
  return a
}
function log(...args) { elog.info(...args.map(safeArg)) }
function logErr(...args) { elog.error(...args.map(safeArg)) }

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
/** @type {import('electron').BrowserWindow | null} */
let resultWindow = null        // file-transcription result window
/** @type {any} */
let lastFileStatus = null      // replayed to the result window once it's listening
/** @type {string | null} */
let lastFilePath = null        // remembered so a model change can re-transcribe it
let fileJobRunning = false     // one file transcription at a time
let fileBusyNotified = false   // the "dictation unavailable during file job" hint was shown
let overlayReady = false       // the overlay renderer is loaded and listening
/** @type {string | null} */
let loadedModel = null         // mirror of the worker's loaded dictation model
let loadingCount = 0           // >0 while a dictation-model load is in flight
/** @type {Promise<boolean>} */
let modelReadyPromise = Promise.resolve(false) // resolves true once the model is usable
let isRecording = false        // hotkey toggle state (⌥Space starts/stops recording)
let dictationCount = 0         // >0 while an 'audio-ready' flow (transcribe/summarize/paste) runs
let lastToggleAt = 0           // debounce against globalShortcut key auto-repeat
let pendingSummarize = false   // set when recording was started via the summarize hotkey
// Supported transcription languages (Whisper language names)
const LANGUAGES = ['german', 'english', 'french']
// All models load from the public Xenova HuggingFace namespace, which hosts all
// five sizes and needs no access token.
const PROVIDER = 'Xenova'
const MODELS = ['tiny', 'base', 'small', 'medium', 'large']
const MODEL_LABELS = { tiny: 'tiny (75 MB)', base: 'base (150 MB)', small: 'small (450 MB)', medium: 'medium (1.5 GB)', large: 'large (3 GB)' }

// Default summarization model (see whisper-worker.js); override via the store
// key 'llmModelUri' (any node-llama-cpp `hf:owner/repo:quant` URI or local path).
const DEFAULT_LLM_URI = 'hf:unsloth/Qwen3-4B-Instruct-2507-GGUF:Q4_K_M'

// Cache in the home directory, not in node_modules
const MODEL_CACHE_DIR = path.join(app.getPath('userData'), 'model-cache')
// Separate cache for the (optional, large) summarization GGUF.
const LLM_CACHE_DIR = path.join(app.getPath('userData'), 'llm-cache')

// ── Inference worker (utilityProcess) ───────────────────────────────────────────
// All heavy lifting (Whisper, ffmpeg decode, LLM) runs in whisper-worker.js so
// the main process event loop - which drives the tray, all windows and IPC -
// never blocks, and a native crash (onnxruntime/llama.cpp) doesn't take the
// whole app down: we detect the exit, reset state and respawn.

/** @type {import('electron').UtilityProcess | null} */
let worker = null
let workerReqId = 0
/** @type {Map<number, { resolve: (v: any) => void, reject: (e: any) => void, onProgress?: (p: any) => void }>} */
const pendingRequests = new Map()
let quitting = false
/** @type {number[]} */
let workerRestarts = []        // timestamps, to detect a crash loop

function spawnWorker() {
  worker = utilityProcess.fork(path.join(__dirname, 'whisper-worker.js'), [], {
    serviceName: 'SHOWhisper Inference',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  // The worker logs via console; pipe its output into the main log file.
  worker.stdout?.on('data', (d) => { const s = d.toString().trimEnd(); if (s) elog.info('[worker]', s) })
  worker.stderr?.on('data', (d) => { const s = d.toString().trimEnd(); if (s) elog.error('[worker]', s) })
  // postMessage is queued until the child has spawned, and ordering is
  // preserved - so init is always the first message the worker sees.
  worker.postMessage({ type: 'init', cacheDir: MODEL_CACHE_DIR, llmCacheDir: LLM_CACHE_DIR, isDev })
  worker.on('message', handleWorkerMessage)
  worker.on('exit', handleWorkerExit)
}

function handleWorkerMessage(msg) {
  if (msg.type === 'result') {
    const req = pendingRequests.get(msg.id)
    if (!req) return
    pendingRequests.delete(msg.id)
    if (msg.ok) {
      req.resolve(msg.value)
    } else {
      const e = /** @type {any} */ (new Error(msg.error || 'Worker error'))
      e.cancelled = !!msg.cancelled
      req.reject(e)
    }
  } else if (msg.type === 'progress') {
    pendingRequests.get(msg.id)?.onProgress?.(msg)
  } else if (msg.type === 'model-progress') {
    // Download/load progress of any model (dictation, temp file model, LLM).
    if (msg.data?.status === 'progress') updateTrayLabel(`${msg.model} ${msg.data.progress}%`)
    else if (msg.data?.status === 'ready') updateTrayLabel(null)
    sendModelProgress(msg.data)
  }
}

function handleWorkerExit(code) {
  const requests = [...pendingRequests.values()]
  pendingRequests.clear()
  worker = null
  loadedModel = null
  // Note: fileJobRunning is NOT reset here - the rejections below propagate to
  // transcribeFileFlow, whose finally block resets it in the right order.
  for (const req of requests) {
    const e = /** @type {any} */ (new Error(`Whisper worker exited unexpectedly (code ${code})`))
    e.workerExit = true
    req.reject(e)
  }
  if (quitting) return
  logErr(`Whisper worker exited (code ${code}) - restarting`)
  sendModelProgress({ status: 'error', message: `Worker exited (code ${code})` })

  // Crash-loop brake: if the worker keeps dying right away, stop auto-reloading
  // (the next explicit action respawns it via workerRequest).
  workerRestarts = workerRestarts.filter((ts) => Date.now() - ts < 5 * 60_000)
  workerRestarts.push(Date.now())
  if (workerRestarts.length > 3) {
    logErr('Worker crash loop detected - not restarting automatically')
    updateTrayLabel(tr('tray.loadError'))
    return
  }
  spawnWorker()
  // Reload the dictation model so the next hotkey press works again.
  loadModel(/** @type {string} */ (store.get('model', 'small')))
}

/**
 * Send one request to the worker and await its result. Progress messages for
 * this request are delivered to onProgress.
 * @param {string} type
 * @param {Record<string, unknown>} [payload]
 * @param {{ onProgress?: (p: any) => void }} [opts]
 * @returns {Promise<any>}
 */
function workerRequest(type, payload = {}, { onProgress } = {}) {
  if (!worker) spawnWorker()
  const id = ++workerReqId
  return new Promise((resolve, reject) => {
    pendingRequests.set(id, { resolve, reject, onProgress })
    const w = /** @type {import('electron').UtilityProcess} */ (worker)
    w.postMessage({ type, id, ...payload })
  })
}

// ── Overlay Window ────────────────────────────────────────────────────────────

function createOverlay() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize
  const savedPos = /** @type {{ x: number, y: number }} */ (store.get('overlayPosition', {
    x: Math.round(width / 2 - 175),
    y: height - 120,
  }))

  overlayReady = false
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

  // The overlay renderer records the audio; if its process dies, recording is
  // broken until it's back - reload it and reset the toggle state.
  overlayWindow.webContents.on('render-process-gone', (_e, details) => {
    logErr('Overlay renderer gone:', details.reason)
    overlayReady = false
    isRecording = false
    pendingSummarize = false
    setTrayRecording(false)
    overlayWindow?.webContents.reload()
  })
}

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
// The flag also gates the recording hotkey: a 'start-recording' sent before
// this point would be dropped silently and desync the toggle state.
ipcMain.on('overlay-ready', () => {
  overlayReady = true
  if (lastModelProgress) overlayWindow?.webContents.send('model-loading', lastModelProgress)
})

// ── Whisper (via worker) ──────────────────────────────────────────────────────

/**
 * Load (or switch) the dictation model in the worker. Loads are serialized by
 * the worker's job queue, so concurrent calls can't race each other or a
 * running transcription. Returns (and stores in modelReadyPromise) whether the
 * model is usable - never rejects, so fire-and-forget callers (tray menu) are
 * safe.
 * @param {string} modelName
 * @returns {Promise<boolean>}
 */
function loadModel(modelName) {
  loadingCount++
  updateTrayLabel(tr('tray.loading', { model: modelName }))
  overlayWindow?.showInactive()

  modelReadyPromise = (async () => {
    try {
      const res = await workerRequest('load-model', { model: modelName })
      loadedModel = res.loadedModel
      store.set('model', modelName)
      updateTrayLabel(null)
      buildTrayMenu()
      sendModelProgress({ status: 'ready' })
      // Don't hide the pill from under a recording or a dictation that was
      // waiting for this load and is about to transcribe.
      setTimeout(() => { if (!isRecording && dictationCount === 0) overlayWindow?.hide() }, 500)
      return true
    } catch (err) {
      logErr('Model load error:', errMsg(err))
      updateTrayLabel(tr('tray.loadError'))

      // Delete the corrupt cache so the next attempt downloads fresh - but not
      // when the worker process died (a crash says nothing about the files).
      if (!(/** @type {any} */ (err)?.workerExit)) {
        const corruptPath = path.join(MODEL_CACHE_DIR, PROVIDER, `whisper-${modelName}`)
        if (fs.existsSync(corruptPath)) {
          fs.rmSync(corruptPath, { recursive: true, force: true })
          log('Deleted corrupt cache:', corruptPath)
        }
      }

      sendModelProgress({ status: 'error', message: errMsg(err) })
      if (!isRecording && dictationCount === 0) overlayWindow?.hide()

      // The tray tooltip alone is easily missed (e.g. when selecting via the
      // tray menu instead of the settings) - only show a dialog when the
      // settings are NOT currently open (they show the error themselves).
      if (!settingsWindow || settingsWindow.isDestroyed()) {
        dialog.showErrorBox(
          tr('dialog.modelError.title'),
          tr('dialog.modelError.body', { model: `${PROVIDER}/whisper-${modelName}`, error: errMsg(err) })
        )
      }
      return false
    } finally {
      loadingCount--
    }
  })()
  return modelReadyPromise
}

function summarizeText(text, language) {
  return workerRequest('summarize', {
    text,
    language,
    llmModelUri: /** @type {string} */ (store.get('llmModelUri', DEFAULT_LLM_URI)),
  }).then((r) => r.summary)
}

// ── File transcription ──────────────────────────────────────────────────────────

// Media containers/codecs offered in the file picker. ffmpeg decodes far more,
// but this keeps the dialog focused on what users actually dictate/record.
const MEDIA_EXTENSIONS = ['mp4', 'mov', 'mkv', 'webm', 'avi', 'm4a', 'mp3', 'wav', 'aac', 'flac', 'ogg', 'opus']

function createResultWindow() {
  resultWindow = new BrowserWindow({
    width: 620,
    height: 560,
    minWidth: 420,
    minHeight: 360,
    show: false,
    title: 'SHOWhisper',
    webPreferences: {
      preload: path.join(__dirname, '../preload/result-preload.js'),
      contextIsolation: true,
    },
  })
  resultWindow.loadFile(path.join(__dirname, '../renderer/result.html'))
  resultWindow.once('ready-to-show', () => resultWindow?.show())
  if (isDev) resultWindow.webContents.openDevTools({ mode: 'detach' })
  resultWindow.on('closed', () => { resultWindow = null; lastFileStatus = null })
}

function openResultWindow() {
  if (resultWindow && !resultWindow.isDestroyed()) { resultWindow.focus(); return }
  createResultWindow()
}

function sendFileStatus(data) {
  if (data.status === 'progress' && lastFileStatus?.status === 'transcribing') {
    // Merge progress into the stored 'transcribing' status instead of replacing
    // it: a window reload replays lastFileStatus, which must keep the context
    // (file name, model), not just a bare progress tick.
    lastFileStatus = { ...lastFileStatus, progress: data.progress, chunk: data.chunk, totalChunks: data.totalChunks }
  } else if (data.status !== 'busy') {
    // 'busy' is a transient notice about a rejected second request - it must
    // not overwrite the state of the run that's still in progress.
    lastFileStatus = data
  }
  resultWindow?.webContents.send('file-status', data)
}

// The Whisper model to use for file transcription. Independent from the live
// dictation model (store 'model') so a big, slow model can be used for files
// without slowing dictation. Defaults to the dictation model until changed.
function getFileModel() {
  const m = /** @type {string} */ (store.get('fileModel', store.get('model', 'small')))
  return MODELS.includes(m) ? m : 'small'
}

// Orchestrate: open/focus the result window, then let the worker decode +
// transcribe the file and stream status into the window. Only one file job at
// a time: a second request while one runs is rejected with a notice instead of
// silently spawning a parallel run (or killing a possibly hours-long one).
async function transcribeFileFlow(filePath) {
  openResultWindow()
  if (fileJobRunning) {
    log('File transcription refused: another one is still running')
    sendFileStatus({ status: 'busy', message: tr('result.busy') })
    return
  }
  fileJobRunning = true
  lastFilePath = filePath
  const model = getFileModel()
  sendFileStatus({ status: 'transcribing', name: path.basename(filePath), model, progress: 0 })
  try {
    // If the file model is the dictation model and that's still loading, wait
    // for the load instead of racing it with a second pipeline build.
    if (model === store.get('model', 'small')) await modelReadyPromise
    const res = await workerRequest('transcribe-file', {
      filePath,
      model,
      language: /** @type {string} */ (store.get('language', 'german')),
    }, {
      onProgress: (p) => sendFileStatus({ status: 'progress', progress: p.pct, chunk: p.chunk, totalChunks: p.totalChunks }),
    })
    const transcript = res.text
    log(isDev ? `File transcription: "${transcript}"` : `File transcription done (${transcript.length} chars)`)
    sendFileStatus({ status: 'done', name: path.basename(filePath), transcript, model })
  } catch (err) {
    if (/** @type {any} */ (err)?.cancelled) {
      log('File transcription cancelled')
      sendFileStatus({ status: 'cancelled' })
    } else {
      logErr('File transcription error:', errMsg(err))
      sendFileStatus({ status: 'error', message: errMsg(err) })
    }
  } finally {
    fileJobRunning = false
    fileBusyNotified = false
    updateTrayLabel(null)
  }
}

// Tray/menu entry: pick a media file, then transcribe it.
async function openFileForTranscription() {
  const res = await dialog.showOpenDialog({
    properties: ['openFile'],
    filters: [{ name: tr('result.mediaFilter'), extensions: MEDIA_EXTENSIONS }],
  })
  if (res.canceled || !res.filePaths[0]) return
  transcribeFileFlow(res.filePaths[0])
}

// Replay the latest status once the result renderer signals it's listening.
ipcMain.on('result-ready', () => {
  if (lastFileStatus) resultWindow?.webContents.send('file-status', lastFileStatus)
})

// A file was dropped onto the result window (path resolved via webUtils in the
// preload). Only accept plausible media extensions.
ipcMain.on('result-drop-file', (_e, filePath) => {
  if (typeof filePath !== 'string') return
  const ext = path.extname(filePath).slice(1).toLowerCase()
  if (!MEDIA_EXTENSIONS.includes(ext)) {
    sendFileStatus({ status: 'error', message: tr('result.unsupported') })
    return
  }
  transcribeFileFlow(filePath)
})

ipcMain.on('result-open-file', () => openFileForTranscription())

// Stop button: interrupt the running file transcription. The worker checks the
// stopping criteria per token and aborts at the next opportunity (or kills a
// still-running ffmpeg decode).
ipcMain.on('result-cancel', () => {
  if (fileJobRunning) worker?.postMessage({ type: 'cancel-file' })
})

// Model selector in the result window: expose the choices + current selection.
ipcMain.handle('result-config', () => ({
  models: MODELS,
  labels: MODEL_LABELS,
  fileModel: getFileModel(),
}))

// True if the model's weights are already on disk (not just a metadata stub).
// Even a "tiny" model is tens of MB, so a small threshold reliably tells an
// uncached/partial folder from a real one.
function isModelCached(model) {
  const dir = safeModelDir(PROVIDER, model)
  if (!dir || !fs.existsSync(dir)) return false
  return getDirSize(dir) > 5_000_000
}

// Download a file model in the background (no file loaded yet) so it's ready for
// the next transcription. Progress shows in the overlay pill; the worker
// disposes the pipeline right after - we only want to warm the on-disk cache.
async function preloadFileModel(model) {
  overlayWindow?.showInactive()
  updateTrayLabel(tr('tray.loading', { model }))
  try {
    await workerRequest('preload-model', { model })
    sendModelProgress({ status: 'ready' })
  } catch (err) {
    logErr('File model preload error:', errMsg(err))
    sendModelProgress({ status: 'error', message: errMsg(err) })
  } finally {
    updateTrayLabel(null)
    setTimeout(() => { if (!isRecording && dictationCount === 0) overlayWindow?.hide() }, 500)
  }
}

// Change the file-transcription model. If the model isn't downloaded yet, ask
// for confirmation first (the download can be large). Returns the model that is
// now in effect, so the renderer can revert its dropdown if the user declined.
ipcMain.handle('result-set-file-model', async (_e, model) => {
  if (!MODELS.includes(model)) return getFileModel()

  if (!isModelCached(model)) {
    const opts = /** @type {import('electron').MessageBoxOptions} */ ({
      type: 'question',
      buttons: [tr('dialog.downloadModel.download'), tr('dialog.downloadModel.cancel')],
      defaultId: 0,
      cancelId: 1,
      title: tr('dialog.downloadModel.title'),
      message: tr('dialog.downloadModel.message', { model: MODEL_LABELS[model] || model }),
    })
    const win = resultWindow && !resultWindow.isDestroyed() ? resultWindow : null
    const { response } = await (win ? dialog.showMessageBox(win, opts) : dialog.showMessageBox(opts))
    if (response !== 0) return getFileModel() // declined -> keep current model
  }

  store.set('fileModel', model)
  log('File model set:', model)
  if (fileJobRunning) {
    // A run is in progress (the dropdown is disabled then, but stay safe):
    // the new model simply applies to the next transcription.
  } else if (lastFilePath) {
    transcribeFileFlow(lastFilePath)          // re-transcribes (downloads if needed)
  } else if (!isModelCached(model)) {
    preloadFileModel(model)                   // no file yet -> download now as confirmed
  }
  return model
})

ipcMain.on('result-copy', (_e, text) => {
  if (typeof text === 'string') clipboard.writeText(text)
})

ipcMain.handle('result-summarize', async (_e, text) => {
  const language = /** @type {string} */ (store.get('language', 'german'))
  return summarizeText(String(text || ''), language)
})

ipcMain.handle('result-save', async (_e, text) => {
  const res = await dialog.showSaveDialog({
    defaultPath: 'transkript.txt',
    filters: [{ name: 'Text', extensions: ['txt'] }],
  })
  if (res.canceled || !res.filePath) return false
  fs.writeFileSync(res.filePath, String(text || ''), 'utf8')
  log('Transcript saved:', res.filePath)
  return true
})

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

// ── Model cache ────────────────────────────────────────────────────────────────
// Cached models live as `<provider>/whisper-<model>/` folders under
// MODEL_CACHE_DIR (see env.cacheDir in the worker). Determine the size per
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
  return provider === PROVIDER &&
         model === store.get('model', 'small') &&
         (loadedModel !== null || loadingCount > 0)
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
  // Capture and reset the mode immediately - a new recording may start while
  // this one is still transcribing/summarizing.
  const summarizeMode = pendingSummarize
  pendingSummarize = false
  dictationCount++
  overlayWindow?.webContents.send('transcribing')

  const language = /** @type {string} */ (store.get('language', 'german'))
  let transcript = ''
  try {
    // Recording is allowed while the model still loads - so wait for the load
    // before transcribing (the overlay shows the load progress meanwhile).
    const modelOk = await modelReadyPromise
    if (!modelOk && !loadedModel) throw new Error('No model loaded')
    overlayWindow?.webContents.send('transcribing')
    const res = await workerRequest('transcribe', { pcm, language, maxNewTokens: 440 })
    transcript = res.text
    // Only log the recognized text in dev mode (privacy for dictation).
    log(isDev ? `Transcription: "${transcript}"` : `Transcription done (${transcript.length} chars)`)
  } catch (err) {
    logErr('Transcription error:', errMsg(err))
  }

  // In summarize mode, run the transcript through the local LLM. On any failure
  // fall back to pasting the raw transcript (dictation must never be lost).
  let toPaste = transcript
  let summarized = false
  if (summarizeMode && transcript) {
    overlayWindow?.webContents.send('summarizing')
    try {
      const summary = await summarizeText(transcript, language)
      if (summary) { toPaste = summary; summarized = true }
    } catch (err) {
      logErr('Summarization error:', errMsg(err))
    }
  }

  try {
    if (toPaste) {
      // Save the old clipboard content
      const prev = clipboard.readText()
      clipboard.writeText(toPaste)

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

      // After pasting the summary, leave the full transcript on the clipboard as a
      // fallback; for a plain dictation, restore the user's previous clipboard.
      setTimeout(() => clipboard.writeText(summarized ? transcript : prev), 500)
    }
  } catch (err) {
    // Auto-paste failed (e.g. Accessibility revoked after startup) - the text
    // is still on the clipboard for a manual paste. Never skip the reset below,
    // otherwise the overlay pill stays stuck in 'transcribing'.
    logErr('Paste error:', errMsg(err))
  } finally {
    dictationCount--
    overlayWindow?.webContents.send('done')
    // Don't hide if the user has already started the next recording (or a
    // second dictation flow is still running).
    setTimeout(() => { if (!isRecording && dictationCount === 0) overlayWindow?.hide() }, 700)
  }
})

// Renderer reports that recording couldn't start (e.g. microphone permission
// denied) or produced no usable audio. Reset overlay/tray and the toggle,
// otherwise the state stays stuck (the next ⌥Space would only resync).
ipcMain.on('recording-failed', (_e, message) => {
  logErr('Recording failed (renderer):', message)
  isRecording = false
  pendingSummarize = false
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
  const modelItems = MODELS.map((m) => /** @type {import('electron').MenuItemConstructorOptions} */ ({
    label: MODEL_LABELS[m] || m,
    type: 'radio',
    checked: m === currentModel,
    click: () => loadModel(m),
  }))

  const menu = Menu.buildFromTemplate([
    { label: 'SHOWhisper', enabled: false },
    { type: 'separator' },
    { label: tr('menu.transcribeFile'), click: () => openResultWindow() },
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

const HOTKEY_ACCELERATOR = 'Alt+Space'             // ⌥Space: raw dictation
const HOTKEY_SUMMARIZE = 'Alt+Shift+Space'         // ⌥⇧Space: dictation + summary

// Toggles recording. Registered via Electron's globalShortcut, which uses the OS
// hot-key API (Carbon RegisterEventHotKey on macOS, RegisterHotKey on Windows).
// Unlike a global keyboard hook (uiohook/CGEventTap), this never sits in the
// system-wide input delivery path, so it can't freeze keyboard/mouse input for
// the whole machine. `summarizeMode` (from ⌥⇧Space) is captured at start and
// makes 'audio-ready' summarize the transcript before pasting.
function toggleRecording(summarizeMode = false) {
  // globalShortcut can fire repeatedly while the combo is held (OS key auto-
  // repeat). Debounce so a brief hold doesn't rapidly flip start/stop.
  const now = Date.now()
  if (now - lastToggleAt < 300) return
  lastToggleAt = now

  if (!isRecording) {
    // The overlay renderer does the recording. Until it has loaded and is
    // listening, 'start-recording' would be dropped silently (Electron doesn't
    // buffer webContents.send) and the toggle state would desync.
    if (!overlayReady) {
      log('Recording ignored: overlay renderer not ready yet')
      return
    }
    // While a file transcription runs, the worker queue would hold a dictation
    // until the file is done - potentially hours later, pasting into whatever
    // has focus then. Refuse the recording instead and say so (once per job).
    if (fileJobRunning) {
      log('Recording refused: file transcription running')
      if (!fileBusyNotified) {
        fileBusyNotified = true
        dialog.showMessageBox({
          type: 'info',
          title: tr('dialog.fileBusy.title'),
          message: tr('dialog.fileBusy.body'),
        })
      }
      return
    }
    // Recording itself doesn't need the model - transcription waits for the
    // load in 'audio-ready'. But when there is no model and none is loading
    // (the load failed), transcription could never follow: retry the load
    // (with visible progress) instead of recording into the void.
    if (!loadedModel && loadingCount === 0) {
      log('Recording refused: no model loaded - retrying model load')
      loadModel(/** @type {string} */ (store.get('model', 'small')))
      return
    }
    pendingSummarize = summarizeMode
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
  const ok = globalShortcut.register(HOTKEY_ACCELERATOR, () => toggleRecording(false))
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

  // Summarize hotkey is optional - if the combo is taken, just log it; plain
  // dictation still works.
  const okSum = globalShortcut.register(HOTKEY_SUMMARIZE, () => toggleRecording(true))
  if (okSum && globalShortcut.isRegistered(HOTKEY_SUMMARIZE)) {
    log(`Global shortcut registered: ${HOTKEY_SUMMARIZE}`)
  } else {
    logErr(`Global shortcut ${HOTKEY_SUMMARIZE} could not be registered (already in use)`)
  }
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

  // Migration: the provider/HF-token settings were removed (all models now load
  // from the public Xenova namespace). Drop the now-unused keys so nothing dead
  // lingers in the store.
  for (const key of ['provider', 'hfToken', 'hfTokenEnc']) store.delete(key)

  log(`SHOWhisper starting (isDev=${isDev})`)
  log(`userData: ${app.getPath('userData')}`)
  log(`Log file: ${elog.transports.file.getFile()?.path}`)
  createTray()
  createOverlay()
  spawnWorker()
  checkAccessibilityForPaste()
  setupHotkey()

  let savedModel = /** @type {string} */ (store.get('model', 'small'))
  if (!MODELS.includes(savedModel)) savedModel = 'small' // migration: large-v3 → large
  await loadModel(savedModel)
})

// Electron types this listener as () => void; the running app does receive an
// event, so keep calling preventDefault to keep the tray app alive.
app.on('window-all-closed', /** @type {() => void} */ ((e) => /** @type {any} */ (e).preventDefault())) // tray app stays open

app.on('before-quit', () => { quitting = true })

app.on('will-quit', () => {
  quitting = true
  globalShortcut.unregisterAll()
  worker?.kill()
})
