const { app, BrowserWindow, Tray, Menu, ipcMain, clipboard, screen, systemPreferences, dialog, shell, globalShortcut, utilityProcess } = require('electron')
const path = require('path')
const fs = require('fs')
const { t, translations } = require('../shared/i18n')
const { postprocessDictation, applyReplacements, parseReplacements, formatReplacements } = require('../shared/postprocess')
const { TRANSCRIPTION_LANGUAGES, UI_LANGUAGES, isTranscriptionLanguage, defaultsForLocale } = require('../shared/languages')
const { AI_MODES } = require('../shared/summarize')
const elog = require('electron-log/main')

const isDev = process.env.NODE_ENV === 'development'
// `SHOWhisper --smoke-test`: CI check of the packaged app - load every native
// module (in main and in the worker), print SMOKE OK and exit. See runSmokeTest.
const isSmokeTest = process.argv.includes('--smoke-test')
// `SHOWhisper --e2e-dictation=<file.wav>`: end-to-end test of the real
// dictation path (overlay capture → chunking → worker → post-processing)
// with Chromium's fake microphone playing the WAV. Prints the transcript
// instead of pasting and exits. Model: env SHOWHISPER_E2E_MODEL (default tiny).
const e2eAudio = process.argv.find((a) => a.startsWith('--e2e-dictation='))?.slice('--e2e-dictation='.length) || null
if (e2eAudio) {
  app.commandLine.appendSwitch('use-fake-device-for-media-stream')
  app.commandLine.appendSwitch('use-fake-ui-for-media-stream')
  app.commandLine.appendSwitch('use-file-for-fake-audio-capture', `${path.resolve(e2eAudio)}%noloop`)
  if (process.env.SHOWHISPER_E2E_USER_DATA) app.setPath('userData', process.env.SHOWHISPER_E2E_USER_DATA)
}

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

// The language you speak (Whisper language name, or 'auto' = detect) and the
// language of the app's own UI are separate settings: Whisper knows ~100
// languages, the UI is translated into three. Installs from before the split
// only have 'language' - if that's a UI language, the UI follows it.
function transcriptionLanguage() {
  const lang = store.get('language')
  return isTranscriptionLanguage(lang) ? /** @type {string} */ (lang) : defaultsForLocale(app.getLocale()).language
}

function uiLang() {
  const ui = store.get('uiLanguage')
  if (typeof ui === 'string' && UI_LANGUAGES.includes(ui)) return ui
  const lang = store.get('language')
  if (typeof lang === 'string' && UI_LANGUAGES.includes(lang)) return lang
  return defaultsForLocale(app.getLocale()).uiLanguage
}

// Translate a UI string into the current UI language (see i18n.js).
// Only called after the store is ready (tray/dialogs run after whenReady).
function tr(key, vars) {
  return t(uiLang(), key, vars)
}

/** @type {import('electron').Tray} */
let tray                       // assigned in createTray() during whenReady
/** @type {import('electron').BrowserWindow | null} */
let overlayWindow = null
/** @type {import('electron').BrowserWindow | null} */
let settingsWindow = null
/** @type {import('electron').BrowserWindow | null} */
let resultWindow = null        // file-transcription result window
/** @type {import('electron').BrowserWindow | null} */
let onboardingWindow = null    // first-run setup
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
let dictationCount = 0         // >0 while a live-dictation flow (transcribe/summarize/paste) runs
let lastToggleAt = 0           // debounce against globalShortcut key auto-repeat
let loadedDevice = 'cpu'       // device of the dictation model ('coreml' | 'dml' | 'cpu')
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
  worker.postMessage({ type: 'init', cacheDir: MODEL_CACHE_DIR, llmCacheDir: LLM_CACHE_DIR, isDev, gpu: gpuEnabled() })
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

// GPU inference (CoreML / DirectML) unless the user switched it off, or a
// DirectML driver crashed the worker before (see handleWorkerExit).
function gpuEnabled() {
  if (!store) return true // smoke test: no store
  return store.get('gpu', true) !== false && store.get('gpuAutoDisabled', false) !== true
}

function handleWorkerExit(code) {
  // A GPU driver/EP crash takes the whole worker down natively - no exception
  // reaches the CPU fallback in buildWhisperPipeline. If the worker died while
  // the dictation model was on (or loading onto) DirectML, run on the CPU from
  // now on; otherwise every respawn would crash again. Not for CoreML: it has
  // been stable, and a crash there is far more likely unrelated.
  if (!quitting && process.platform === 'win32' && gpuEnabled() && (loadedDevice === 'dml' || loadingCount > 0)) {
    logErr('Worker crashed with DirectML active - disabling GPU inference')
    store.set('gpuAutoDisabled', true)
  }
  loadedDevice = 'cpu'
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
    // 72 px pill + the live-transcript line shown while recording
    height: 108,
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
  // Recording runs in this renderer - in the e2e run, its console is the only
  // window into capture/chunking problems.
  if (e2eAudio) overlayWindow.webContents.on('console-message', (e) => log(`[overlay] ${/** @type {any} */ (e).message}`))

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
    abandonLiveSessions()
    isRecording = false
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
  if (onboardingWindow && !onboardingWindow.isDestroyed()) onboardingWindow.webContents.send('model-progress', data)
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
      loadedDevice = res.device || 'cpu'
      log(`Dictation model ${loadedModel} on ${loadedDevice}`)
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

function summarizeText(text, language, mode = 'summarize') {
  return workerRequest('summarize', {
    text,
    language,
    mode,
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
  // A file job holds the worker queue for minutes to hours - live chunks of a
  // running dictation would wait behind it and get pasted much later into
  // whatever has focus then. (The reverse case is handled in toggleRecording.)
  if (isRecording || dictationCount > 0) {
    log('File transcription refused: dictation in progress')
    sendFileStatus({ status: 'busy', message: tr('result.dictationBusy') })
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
      language: transcriptionLanguage(),
    }, {
      onProgress: (p) => sendFileStatus({ status: 'progress', progress: p.pct, chunk: p.chunk, totalChunks: p.totalChunks }),
    })
    const transcript = applyReplacements(res.text, getReplacements())
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
  return summarizeText(String(text || ''), transcriptionLanguage())
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

// ── First-run setup (onboarding) ───────────────────────────────────────────────
// Walks through what otherwise surfaces as "it doesn't work": microphone and
// (macOS) Accessibility permission, choosing + downloading a model, and a
// live test of the hotkey into a text field.

function openOnboarding() {
  if (onboardingWindow && !onboardingWindow.isDestroyed()) { onboardingWindow.focus(); return }
  onboardingWindow = new BrowserWindow({
    width: 520,
    height: 680,
    resizable: false,
    show: false,
    title: 'SHOWhisper',
    webPreferences: {
      preload: path.join(__dirname, '../preload/onboarding-preload.js'),
      contextIsolation: true,
    },
  })
  onboardingWindow.loadFile(path.join(__dirname, '../renderer/onboarding.html'))
  onboardingWindow.once('ready-to-show', () => { onboardingWindow?.show(); onboardingWindow?.focus() })
  if (isDev) onboardingWindow.webContents.openDevTools({ mode: 'detach' })
  onboardingWindow.on('closed', () => {
    onboardingWindow = null
    // Closed without picking a model: load the default, so the hotkey works.
    if (!loadedModel && loadingCount === 0) loadModel(/** @type {string} */ (store.get('model', 'small')))
  })
}

function permissionStatus() {
  const mac = process.platform === 'darwin'
  return {
    platform: process.platform,
    // Linux has no OS-level microphone permission API.
    microphone: process.platform === 'linux' ? 'granted' : systemPreferences.getMediaAccessStatus('microphone'),
    accessibility: mac ? systemPreferences.isTrustedAccessibilityClient(false) : true,
  }
}

ipcMain.handle('onboarding-status', () => ({
  ...permissionStatus(),
  models: MODELS.filter((m) => m !== 'large'), // large is for file transcription, too slow live
  labels: MODEL_LABELS,
  model: store.get('model', 'small'),
  loadedModel,
  loading: loadingCount > 0,
  cached: MODELS.filter((m) => isModelCached(m)),
  settings: settingsSnapshot(),
}))

ipcMain.handle('onboarding-request-mic', async () => {
  if (process.platform === 'darwin') {
    try { await systemPreferences.askForMediaAccess('microphone') } catch (err) { logErr('Mic access request failed:', errMsg(err)) }
  }
  return permissionStatus()
})

ipcMain.on('onboarding-open-privacy', (_e, what) => {
  const urls = {
    darwin: {
      microphone: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
      accessibility: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
    },
    win32: { microphone: 'ms-settings:privacy-microphone' },
  }
  // Registers the app in the Accessibility list (and shows Apple's prompt), so
  // the user only has to flip the switch.
  if (process.platform === 'darwin' && what === 'accessibility') systemPreferences.isTrustedAccessibilityClient(true)
  const url = urls[process.platform]?.[what]
  if (url) shell.openExternal(url)
})

ipcMain.handle('onboarding-load-model', async (_e, model) => {
  if (!MODELS.includes(model)) return false
  return loadModel(model)
})

ipcMain.on('onboarding-done', () => {
  store.set('onboarded', true)
  log('Onboarding completed')
  onboardingWindow?.close()
})

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
// Live-update the localized UI: rebuild the tray menu and tell every window
// to re-apply its translations.
function broadcastUiLanguage() {
  const lang = uiLang()
  buildTrayMenu()
  for (const w of [overlayWindow, settingsWindow, resultWindow, onboardingWindow]) {
    if (w && !w.isDestroyed()) w.webContents.send('language-changed', lang)
  }
}

// Transcription language (kept for the settings/onboarding pages; the generic
// 'settings-set' covers it too).
ipcMain.on('set-language', (_e, lang) => {
  if (!isTranscriptionLanguage(lang)) return
  store.set('language', lang)
  log('Language set:', lang)
  broadcastUiLanguage() // the UI follows it while no explicit UI language is set
})

// The UI language - what every window localizes itself into.
ipcMain.handle('get-language', () => uiLang())

// Renderers are sandboxed and can't require('./i18n'), so hand them the whole
// dictionary synchronously at preload time; they run the same small t() locally.
ipcMain.on('i18n-sync', (e) => { e.returnValue = translations })

// ── Settings (generic get/set for the settings + onboarding windows) ─────────

/** @returns {import('../shared/postprocess').Replacement[]} */
function getReplacements() {
  const r = store.get('replacements', [])
  return Array.isArray(r) ? r : []
}

function getAiMode() {
  const m = store.get('aiMode', 'summarize')
  return typeof m === 'string' && AI_MODES.includes(m) ? m : 'summarize'
}

function settingsSnapshot() {
  return {
    language: transcriptionLanguage(),
    uiLanguage: uiLang(),
    languages: TRANSCRIPTION_LANGUAGES,     // name -> ISO code (labels via Intl.DisplayNames)
    uiLanguages: UI_LANGUAGES,
    hotkeyDictate: hotkeyFor('hotkeyDictate'),
    hotkeyAi: hotkeyFor('hotkeyAi'),
    hotkeyDictateLabel: formatAccelerator(hotkeyFor('hotkeyDictate')),
    hotkeyAiLabel: formatAccelerator(hotkeyFor('hotkeyAi')),
    hotkeyStatus: { ...hotkeyStatus },
    aiMode: getAiMode(),
    aiModes: AI_MODES,
    gpu: store.get('gpu', true) !== false,
    gpuAutoDisabled: store.get('gpuAutoDisabled', false) === true,
    device: loadedDevice,
    voiceCommands: store.get('voiceCommands', true) !== false,
    history: store.get('history', true) !== false,
    replacements: formatReplacements(getReplacements()),
    platform: process.platform,
    version: app.getVersion(),
  }
}

/** @returns {string | null} error code, null on success */
function applySetting(key, value) {
  switch (key) {
    case 'language':
      if (!isTranscriptionLanguage(value)) return 'invalid'
      store.set('language', value)
      broadcastUiLanguage()
      return null
    case 'uiLanguage':
      if (!UI_LANGUAGES.includes(value)) return 'invalid'
      store.set('uiLanguage', value)
      broadcastUiLanguage()
      return null
    case 'hotkeyDictate':
    case 'hotkeyAi':
      return setHotkey(key, value)
    case 'aiMode':
      if (!AI_MODES.includes(value)) return 'invalid'
      store.set('aiMode', value)
      return null
    case 'gpu':
      if (typeof value !== 'boolean') return 'invalid'
      store.set('gpu', value)
      if (value) store.delete('gpuAutoDisabled') // explicit opt-in: try again
      worker?.postMessage({ type: 'config', gpu: gpuEnabled() })
      // Rebuild the dictation pipeline on the new device (queued behind any
      // running transcription on the worker).
      if (loadedModel) loadModel(loadedModel)
      return null
    case 'voiceCommands':
    case 'history':
      if (typeof value !== 'boolean') return 'invalid'
      store.set(key, value)
      if (key === 'history' && !value) clearHistory()
      return null
    case 'replacements':
      if (typeof value !== 'string' || value.length > 100_000) return 'invalid'
      store.set('replacements', parseReplacements(value).slice(0, 1000))
      return null
    default:
      return 'unknown'
  }
}

ipcMain.handle('settings-get', () => settingsSnapshot())
ipcMain.handle('settings-set', (_e, key, value) => {
  const error = applySetting(key, value)
  if (error) logErr(`Setting ${key} rejected: ${error}`)
  return { error, settings: settingsSnapshot() }
})

// While the settings window records a new hotkey, the current ones must not
// fire (pressing ⌥Space to re-enter it would start a dictation).
ipcMain.on('hotkeys-suspend', (_e, suspend) => {
  if (suspend) globalShortcut.unregisterAll()
  else registerHotkeys()
})

ipcMain.on('history-clear', () => clearHistory())

// ── Dictation history ──────────────────────────────────────────────────────────
// The last few pasted texts, so nothing is lost when auto-paste lands in the
// wrong window (or none). Local file only, can be switched off in the settings.

const HISTORY_FILE = path.join(app.getPath('userData'), 'history.json')
const HISTORY_MAX = 30

/** @returns {{ at: number, text: string }[]} */
function readHistory() {
  try {
    const h = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'))
    return Array.isArray(h) ? h.filter((e) => e && typeof e.text === 'string') : []
  } catch {
    return []
  }
}

function addHistory(text) {
  if (!text || store.get('history', true) === false) return
  const h = [{ at: Date.now(), text }, ...readHistory()].slice(0, HISTORY_MAX)
  try {
    // Write + rename: a crash mid-write never leaves a truncated file.
    fs.writeFileSync(`${HISTORY_FILE}.tmp`, JSON.stringify(h), 'utf8')
    fs.renameSync(`${HISTORY_FILE}.tmp`, HISTORY_FILE)
  } catch (err) {
    logErr('History write failed:', errMsg(err))
  }
  buildTrayMenu()
}

function clearHistory() {
  try { fs.rmSync(HISTORY_FILE, { force: true }) } catch (err) { logErr('History clear failed:', errMsg(err)) }
  buildTrayMenu()
}

function historyMenu() {
  const entries = readHistory().slice(0, 10)
  /** @type {import('electron').MenuItemConstructorOptions[]} */
  const items = entries.map((e) => {
    const time = new Date(e.at).toLocaleTimeString(app.getLocale(), { hour: '2-digit', minute: '2-digit' })
    const oneLine = e.text.replace(/\s+/g, ' ').trim()
    return {
      label: `${time}  ${oneLine.length > 48 ? `${oneLine.slice(0, 48)}…` : oneLine}`,
      click: () => clipboard.writeText(e.text),
    }
  })
  if (items.length === 0) items.push({ label: tr('menu.history.empty'), enabled: false })
  else items.push({ type: 'separator' }, { label: tr('menu.history.clear'), click: clearHistory })
  return items
}

// ── Diagnostics export ─────────────────────────────────────────────────────────
// One text file with versions, system info, settings and the recent log, for
// bug reports. Production logs never contain dictated text (see log()).

async function exportDiagnostics() {
  const os = require('os')
  const stamp = new Date().toISOString().slice(0, 10)
  const res = await dialog.showSaveDialog({
    defaultPath: path.join(app.getPath('desktop'), `showhisper-diagnostics-${stamp}.txt`),
    filters: [{ name: 'Text', extensions: ['txt'] }],
  })
  if (res.canceled || !res.filePath) return
  const settings = settingsSnapshot()
  const info = {
    app: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    os: `${process.platform} ${os.release()} (${process.arch})`,
    cpu: `${os.cpus()[0]?.model ?? '?'} ×${os.cpus().length}`,
    memoryGB: Math.round(os.totalmem() / 1e9),
    model: store.get('model'),
    loadedModel,
    device: loadedDevice,
    accessibility: process.platform === 'darwin' ? systemPreferences.isTrustedAccessibilityClient(false) : 'n/a',
    microphone: process.platform === 'linux' ? 'n/a' : systemPreferences.getMediaAccessStatus('microphone'),
    settings: { ...settings, languages: undefined, replacements: `${getReplacements().length} rules` },
    cache: listCachedModels().map((m) => `${m.provider}/${m.model} ${Math.round(m.sizeBytes / 1e6)} MB`),
  }
  const logPath = elog.transports.file.getFile()?.path
  let logs = ''
  if (logPath) {
    for (const f of [logPath.replace(/\.log$/, '.1.log'), logPath]) {
      try { logs += `\n===== ${path.basename(f)} =====\n${fs.readFileSync(f, 'utf8').slice(-400_000)}` } catch { /* missing */ }
    }
  }
  fs.writeFileSync(res.filePath, `SHOWhisper diagnostics\n${JSON.stringify(info, null, 2)}\n${logs}`, 'utf8')
  log('Diagnostics exported:', res.filePath)
  shell.showItemInFolder(res.filePath)
}

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

// Live dictation: while the user speaks, the renderer streams PCM chunks (cut
// at speech pauses) plus one final chunk (possibly empty) at stop. Each chunk
// is sent to the worker right away (its queue keeps them in order, and they
// wait there behind a still-running model load - the overlay shows the load
// progress meanwhile); results are appended strictly in recording order via
// the session's `tail` promise, and the growing text is mirrored to the pill.
// Quote markers are applied once at the end - a marker phrase can span a chunk
// boundary. Sessions are created by toggleRecording (main owns the ids), so a
// chunk for an unknown/abandoned id is simply ignored.
/**
 * @typedef {{ text: string, summarizeMode: boolean, language: string,
 *             detectedLanguage: string | null,
 *             tail: Promise<void>, finalizing: boolean }} LiveSession
 */
/** @type {Map<number, LiveSession>} */
const liveSessions = new Map()
let dictationSeq = 0
let currentDictationId = 0     // the most recently started recording - only it drives the pill

// Status messages for an older dictation that finishes while a newer one is
// recording/transcribing must not flip the pill out of the newer one's state.
function sendDictationStatus(id, channel, payload) {
  if (id === currentDictationId) overlayWindow?.webContents.send(channel, payload)
}

// Drop recordings that died before their 'final' chunk (mic unplugged, renderer
// crash): no finalize will ever run for them, so release their dictationCount
// here - otherwise the overlay could never hide again. Sessions that already
// got their final chunk are left alone: they finish (and decrement) normally.
// Without an id, every not-yet-finalizing session is dropped.
function abandonLiveSessions(id) {
  for (const [sid, s] of liveSessions) {
    if (s.finalizing || (id !== undefined && sid !== id)) continue
    liveSessions.delete(sid)
    dictationCount--
  }
}

ipcMain.on('dictation-chunk', (_event, { id, pcm, final }) => {
  const session = liveSessions.get(id)
  if (!session || session.finalizing) return

  if (pcm.length > 0) {
    // Catch right here, not via `tail`: the request may fail while earlier
    // chunks are still pending (unhandled rejection otherwise). A lost chunk
    // only loses its words - the dictation itself still finishes.
    // sessionKey: with 'auto', the worker detects the language on the first
    // chunk and keeps it for the rest of this dictation.
    const req = workerRequest('transcribe', { pcm, language: session.language, maxNewTokens: 440, applyMarkers: false, sessionKey: id })
      .catch((err) => { logErr('Live transcription error:', errMsg(err)); return { text: '', language: null } })
    session.tail = session.tail.then(() => req).then((res) => {
      if (res.language && !session.detectedLanguage) session.detectedLanguage = res.language
      if (!res.text) return
      session.text = session.text ? `${session.text} ${res.text}` : res.text
      // Only log the recognized text in dev mode (privacy for dictation).
      log(isDev || e2eAudio ? `Live transcription: "${res.text}"` : `Live transcription done (${res.text.length} chars)`)
      if (isRecording) sendDictationStatus(id, 'live-text', session.text)
    }).catch((err) => logErr('Live transcription error:', errMsg(err))) // never break the tail
  }

  if (final) {
    session.finalizing = true
    finalizeDictation(id, session)
  }
})

// Wait for every outstanding chunk of the session, then markers → (summarize) → paste.
async function finalizeDictation(id, session) {
  sendDictationStatus(id, 'transcribing')
  await session.tail
  liveSessions.delete(id)
  // With auto-detect, post-process for the language actually spoken.
  const language = session.language === 'auto' ? (session.detectedLanguage || 'auto') : session.language
  const transcript = postprocessDictation(session.text.trim(), {
    language,
    voiceCommands: store.get('voiceCommands', true) !== false,
    replacements: getReplacements(),
  })
  log(isDev ? `Transcription: "${transcript}"` : `Transcription done (${transcript.length} chars)`)

  // With the AI hotkey, run the transcript through the local LLM (summary,
  // e-mail, clean-up, ... - see 'aiMode'). On any failure fall back to
  // pasting the raw transcript (dictation must never be lost).
  let toPaste = transcript
  let summarized = false
  if (session.summarizeMode && transcript) {
    const mode = getAiMode()
    sendDictationStatus(id, 'summarizing', mode)
    try {
      const summary = await summarizeText(transcript, language, mode)
      if (summary) { toPaste = summary; summarized = true }
    } catch (err) {
      logErr('AI action error:', errMsg(err))
    }
  }
  addHistory(toPaste)

  if (e2eAudio) {
    console.log(`E2E TRANSCRIPT: ${JSON.stringify(toPaste)} (language: ${language})`)
    app.exit(toPaste ? 0 : 1)
    return
  }

  try {
    if (toPaste) {
      const prev = snapshotClipboard()
      clipboard.writeText(toPaste)

      // Briefly let the window lose focus, then simulate paste (but keep the
      // pill of a recording the user already started meanwhile)
      if (!isRecording) overlayWindow?.hide()
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
      // Only if it still holds our text: if the user copied something new in
      // the meantime, that must win.
      setTimeout(() => {
        if (clipboard.readText() !== toPaste) return
        if (summarized) clipboard.writeText(transcript)
        else restoreClipboard(prev)
      }, 600)
    }
  } catch (err) {
    // Auto-paste failed (e.g. Accessibility revoked after startup) - the text
    // is still on the clipboard for a manual paste. Never skip the reset below,
    // otherwise the overlay pill stays stuck in 'transcribing'.
    logErr('Paste error:', errMsg(err))
  } finally {
    dictationCount--
    sendDictationStatus(id, 'done')
    // Don't hide if the user has already started the next recording (or a
    // second dictation flow is still running).
    setTimeout(() => { if (!isRecording && dictationCount === 0) overlayWindow?.hide() }, 700)
  }
}

// Snapshot every clipboard flavour Electron can write back - not just text:
// an image or rich text the user copied before dictating must survive the
// paste. Formats that clipboard.write() can't express (e.g. copied files) are
// kept as one raw buffer of their first format.
/**
 * @typedef {{ text?: string, html?: string, rtf?: string, image?: import('electron').NativeImage,
 *             raw?: { format: string, buffer: Buffer } } | null} ClipboardSnapshot
 */
/** @returns {ClipboardSnapshot} */
function snapshotClipboard() {
  try {
    const formats = clipboard.availableFormats()
    if (formats.length === 0) return null
    /** @type {NonNullable<ClipboardSnapshot>} */
    const snap = {}
    const text = clipboard.readText()
    if (text) snap.text = text
    const html = clipboard.readHTML()
    if (html) snap.html = html
    const rtf = clipboard.readRTF()
    if (rtf) snap.rtf = rtf
    const image = clipboard.readImage()
    if (!image.isEmpty()) snap.image = image
    if (Object.keys(snap).length === 0) snap.raw = { format: formats[0], buffer: clipboard.readBuffer(formats[0]) }
    return snap
  } catch (err) {
    logErr('Clipboard snapshot failed:', errMsg(err))
    return null
  }
}

/** @param {ClipboardSnapshot} snap */
function restoreClipboard(snap) {
  try {
    if (!snap) clipboard.clear()
    else if (snap.raw) clipboard.writeBuffer(snap.raw.format, snap.raw.buffer)
    else clipboard.write(snap)
  } catch (err) {
    logErr('Clipboard restore failed:', errMsg(err))
  }
}

// Renderer reports that recording couldn't start (e.g. microphone permission
// denied) or produced no usable audio. Reset overlay/tray and the toggle,
// otherwise the state stays stuck (the next ⌥Space would only resync).
ipcMain.on('recording-failed', (_e, { id, message }) => {
  logErr('Recording failed (renderer):', message)
  abandonLiveSessions(id)
  // A late failure of an older recording (e.g. its stop produced no audio)
  // while a newer one already runs must not reset the newer one's state.
  if (id !== currentDictationId) return
  isRecording = false
  setTrayRecording(false)
  overlayWindow?.hide()
  if (!settingsWindow || settingsWindow.isDestroyed()) {
    dialog.showErrorBox(
      tr('dialog.mic.title'),
      tr('dialog.mic.body', { error: message || tr('error.unknown'), hint: tr(`dialog.mic.hint.${process.platform}`) })
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
    { label: tr('menu.history'), submenu: historyMenu() },
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
    { label: tr('menu.onboarding'), click: openOnboarding },
    { label: tr('menu.diagnostics'), click: () => { exportDiagnostics().catch((err) => logErr('Diagnostics export failed:', errMsg(err))) } },
    { label: `${tr('menu.quit')}  (v${app.getVersion()})`, click: () => app.quit() },
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

// Defaults: ⌥Space = dictation, ⌥⇧Space = dictation + AI action (summary by
// default, see 'aiMode'). Both are configurable in the settings; the AI
// hotkey may be empty (disabled).
const DEFAULT_HOTKEYS = { hotkeyDictate: 'Alt+Space', hotkeyAi: 'Alt+Shift+Space' }
/** @type {{ hotkeyDictate: boolean, hotkeyAi: boolean }} */
const hotkeyStatus = { hotkeyDictate: false, hotkeyAi: false }

/** @param {'hotkeyDictate' | 'hotkeyAi'} key */
function hotkeyFor(key) {
  const v = store.get(key)
  return typeof v === 'string' ? v : DEFAULT_HOTKEYS[key]
}

// Human-readable accelerator: macOS symbols (⌥⇧Space), elsewhere "Alt+Shift+Space".
function formatAccelerator(acc) {
  if (!acc) return ''
  if (process.platform !== 'darwin') return acc.replace(/CommandOrControl|CmdOrCtrl/g, 'Ctrl').replace(/Super|Meta/g, 'Win')
  const SYMBOLS = {
    Command: '⌘', Cmd: '⌘', CommandOrControl: '⌘', CmdOrCtrl: '⌘', Super: '⌘', Meta: '⌘',
    Control: '⌃', Ctrl: '⌃', Alt: '⌥', Option: '⌥', AltGr: '⌥', Shift: '⇧',
  }
  return acc.split('+').map((k) => SYMBOLS[k] ?? k).join('')
}

// (Re)register both hotkeys from the store. Registration fails when another
// app already owns the combo (or the accelerator is malformed).
function registerHotkeys() {
  globalShortcut.unregisterAll()
  /** @type {Record<'hotkeyDictate' | 'hotkeyAi', () => void>} */
  const handlers = { hotkeyDictate: () => toggleRecording(false), hotkeyAi: () => toggleRecording(true) }
  for (const key of /** @type {const} */ (['hotkeyDictate', 'hotkeyAi'])) {
    const acc = hotkeyFor(key)
    let ok = false
    if (acc) {
      try {
        ok = globalShortcut.register(acc, handlers[key]) && globalShortcut.isRegistered(acc)
      } catch (err) {
        logErr(`Invalid accelerator ${acc}:`, errMsg(err))
      }
      if (ok) log(`Global shortcut registered: ${acc}`)
      else logErr(`Global shortcut ${acc} could not be registered (already in use?)`)
    }
    hotkeyStatus[key] = ok
  }
  if (!hotkeyStatus.hotkeyDictate) {
    updateTrayLabel(tr('tray.hotkeyUnavailable', { hotkey: formatAccelerator(hotkeyFor('hotkeyDictate')) }))
  }
}

// Change one hotkey. Rolls back (and reports why) if the new combo can't be
// registered, so the user is never left without a working dictation hotkey.
/** @returns {string | null} error code */
function setHotkey(key, acc) {
  if (typeof acc !== 'string' || acc.length > 60) return 'invalid'
  if (key === 'hotkeyDictate' && !acc) return 'invalid'
  const other = key === 'hotkeyDictate' ? 'hotkeyAi' : 'hotkeyDictate'
  if (acc && acc === hotkeyFor(other)) return 'duplicate'
  const prev = hotkeyFor(key)
  store.set(key, acc)
  registerHotkeys()
  if (acc && !hotkeyStatus[key]) {
    store.set(key, prev)
    registerHotkeys()
    return 'inUse'
  }
  if (hotkeyStatus.hotkeyDictate) updateTrayLabel(null)
  log(`Hotkey ${key} set: ${acc || '(disabled)'}`)
  return null
}

// Toggles recording. Registered via Electron's globalShortcut, which uses the OS
// hot-key API (Carbon RegisterEventHotKey on macOS, RegisterHotKey on Windows).
// Unlike a global keyboard hook (uiohook/CGEventTap), this never sits in the
// system-wide input delivery path, so it can't freeze keyboard/mouse input for
// the whole machine. `summarizeMode` (from the AI hotkey) is captured at start
// and makes the finalize step run the AI action before pasting.
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
    // load in 'dictation-chunk'. But when there is no model and none is loading
    // (the load failed), transcription could never follow: retry the load
    // (with visible progress) instead of recording into the void.
    if (!loadedModel && loadingCount === 0) {
      log('Recording refused: no model loaded - retrying model load')
      loadModel(/** @type {string} */ (store.get('model', 'small')))
      return
    }
    // Main owns the dictation ids: mode and language are fixed per recording,
    // and chunks/failures for an id that is no longer live are ignored.
    const id = ++dictationSeq
    currentDictationId = id
    liveSessions.set(id, {
      text: '',
      summarizeMode,
      language: transcriptionLanguage(),
      detectedLanguage: null,
      tail: Promise.resolve(),
      finalizing: false,
    })
    dictationCount++
    isRecording = true
    setTrayRecording(true)
    overlayWindow?.showInactive()
    overlayWindow?.webContents.send('start-recording', id)
  } else {
    isRecording = false
    setTrayRecording(false)
    overlayWindow?.webContents.send('stop-recording')
  }
}

function setupHotkey() {
  registerHotkeys()
  if (hotkeyStatus.hotkeyDictate) return
  // The hotkey is the only way to start a dictation, so surface the conflict
  // (non-blocking) and offer the settings, where another combo can be chosen.
  dialog.showMessageBox({
    type: 'warning',
    title: tr('dialog.hotkey.title'),
    message: tr('dialog.hotkey.body', { hotkey: formatAccelerator(hotkeyFor('hotkeyDictate')) }),
    buttons: [tr('dialog.hotkey.openSettings'), tr('dialog.ok')],
    defaultId: 0,
    cancelId: 1,
  }).then(({ response }) => { if (response === 0) openSettings() })
}

// nut-js simulates ⌘V/Ctrl+V to paste the transcript (see 'dictation-chunk'). On
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

// (The e2e run's fake microphone can't read its WAV from inside the sandboxed
// out-of-process audio service - run that service in-process there.)
app.commandLine.appendSwitch('disable-features', e2eAudio ? 'AutofillServerCommunication,AudioServiceOutOfProcess' : 'AutofillServerCommunication')
// Wayland has no global key grabs; Electron routes globalShortcut through the
// xdg-desktop-portal GlobalShortcuts API when this is on (no-op under X11).
if (process.platform === 'linux') app.commandLine.appendSwitch('enable-features', 'GlobalShortcutsPortal')

// One instance only: a second one (autostart + a manual launch) would add a
// second tray icon and fail to register the hotkeys. Bring up the settings of
// the running instance instead, so the click visibly did something.
const gotInstanceLock = isSmokeTest || !!e2eAudio || app.requestSingleInstanceLock()
if (!gotInstanceLock) {
  app.exit(0)
} else {
  app.on('second-instance', () => { if (store) openSettings() })
}

// Packaged-app self test (CI): every native module must load - in main
// (nut-js) and in the worker (onnxruntime, transformers, ffmpeg, llama.cpp).
// No model download, no windows, no user data touched. Exit code tells CI.
async function runSmokeTest() {
  const timer = setTimeout(() => { console.error('SMOKE FAIL: timeout'); app.exit(1) }, 60_000)
  try {
    require('@nut-tree-fork/nut-js')
    spawnWorker()
    const res = await workerRequest('smoke')
    console.log(`SMOKE OK ${JSON.stringify(res)}`)
    clearTimeout(timer)
    quitting = true
    worker?.kill()
    app.exit(0)
  } catch (err) {
    console.error(`SMOKE FAIL: ${errMsg(err)}`)
    app.exit(1)
  }
}

// Length of a PCM WAV in seconds (from its header), for the e2e run.
function wavDurationSeconds(file) {
  const buf = fs.readFileSync(file)
  const byteRate = buf.readUInt32LE(28)
  let off = 12
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4)
    const size = buf.readUInt32LE(off + 4)
    if (id === 'data') return size / byteRate
    off += 8 + size + (size % 2)
  }
  throw new Error('no data chunk in WAV')
}

async function runE2E() {
  const audio = /** @type {string} */ (e2eAudio)
  setTimeout(() => { console.error('E2E FAIL: timeout'); app.exit(1) }, 300_000)
  createTray()
  createOverlay()
  spawnWorker()
  if (process.env.SHOWHISPER_E2E_LANGUAGE) store.set('language', process.env.SHOWHISPER_E2E_LANGUAGE)
  const model = process.env.SHOWHISPER_E2E_MODEL || 'tiny'
  if (!(await loadModel(model))) { console.error('E2E FAIL: model load'); app.exit(1); return }
  while (!overlayReady) await new Promise((r) => setTimeout(r, 100))
  const seconds = wavDurationSeconds(audio)
  log(`E2E: recording ${seconds.toFixed(1)}s of ${path.basename(audio)} with ${model}`)
  toggleRecording(false)
  await new Promise((r) => setTimeout(r, seconds * 1000 + 800))
  toggleRecording(false) // finalizeDictation prints the transcript and exits
}

app.whenReady().then(async () => {
  if (!gotInstanceLock) return
  if (isSmokeTest) { await runSmokeTest(); return }
  app.dock?.hide() // Mac: no dock icon

  const { default: Store } = await import('electron-store')
  store = new Store()

  // Migration: the provider/HF-token settings were removed (all models now load
  // from the public Xenova namespace). Drop the now-unused keys so nothing dead
  // lingers in the store.
  for (const key of ['provider', 'hfToken', 'hfTokenEnc']) store.delete(key)

  if (e2eAudio) { await runE2E(); return }
  log(`SHOWhisper ${app.getVersion()} starting (isDev=${isDev}, ${process.platform} ${process.arch})`)
  log(`userData: ${app.getPath('userData')}`)
  log(`Log file: ${elog.transports.file.getFile()?.path}`)
  cleanupPartialDownloads()

  // Fresh install: language defaults from the OS locale, and the first-run
  // setup chooses (and downloads) the model. Installs from before the setup
  // existed already have a model - they skip it.
  if (!store.has('language')) store.set('language', defaultsForLocale(app.getLocale()).language)
  if (!store.has('onboarded')) store.set('onboarded', store.has('model'))
  const firstRun = store.get('onboarded') !== true

  createTray()
  createOverlay()
  spawnWorker()
  setupHotkey()
  if (firstRun) {
    openOnboarding()
    return
  }
  checkAccessibilityForPaste()

  let savedModel = /** @type {string} */ (store.get('model', 'small'))
  if (!MODELS.includes(savedModel)) savedModel = 'small' // migration: large-v3 → large
  await loadModel(savedModel)
})

// transformers.js downloads into `<file>.tmp.<pid>.<rand>` and renames when
// complete. A download interrupted by a crash/quit leaves that temp file
// behind forever - observed: ~1 GB of orphans in one cache. At startup no
// download can be running yet, so every such file is garbage.
function cleanupPartialDownloads() {
  let freed = 0
  const walk = (dir) => {
    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) walk(full)
      else if (/\.tmp\.\d+\.\w+$/.test(e.name)) {
        try { freed += fs.statSync(full).size; fs.rmSync(full, { force: true }) } catch { /* in use / gone */ }
      }
    }
  }
  walk(MODEL_CACHE_DIR)
  if (freed > 0) log(`Removed partial downloads: ${Math.round(freed / 1e6)} MB`)
}

// Electron types this listener as () => void; the running app does receive an
// event, so keep calling preventDefault to keep the tray app alive.
app.on('window-all-closed', /** @type {() => void} */ ((e) => /** @type {any} */ (e).preventDefault())) // tray app stays open

app.on('before-quit', () => { quitting = true })

app.on('will-quit', () => {
  quitting = true
  globalShortcut.unregisterAll()
  worker?.kill()
})
