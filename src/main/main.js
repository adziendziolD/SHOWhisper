const { app, BrowserWindow, Tray, Menu, ipcMain, clipboard, screen, systemPreferences, dialog, shell, globalShortcut } = require('electron')
const path = require('path')
const fs = require('fs')
const { t, translations } = require('../shared/i18n')
const { applyDictationMarkers } = require('../shared/dictation')
const { buildSystemPrompt, cleanSummary } = require('../shared/summarize')
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
/** @type {import('electron').BrowserWindow | null} */
let resultWindow = null        // file-transcription result window
/** @type {any} */
let lastFileStatus = null      // replayed to the result window once it's listening
/** @type {string | null} */
let lastFilePath = null        // remembered so a model change can re-transcribe it
/** @type {any} */
let whisperPipeline = null     // @huggingface/transformers pipeline (callable + .tokenizer)
let isLoadingModel = false
let loadGeneration = 0         // prevents a superseded load from overwriting state
let isRecording = false        // hotkey toggle state (⌥Space starts/stops recording)
let lastToggleAt = 0           // debounce against globalShortcut key auto-repeat
let pendingSummarize = false   // set when recording was started via the summarize hotkey
// Supported transcription languages (Whisper language names)
const LANGUAGES = ['german', 'english', 'french']
// All models load from the public Xenova HuggingFace namespace, which hosts all
// five sizes and needs no access token.
const PROVIDER = 'Xenova'
const MODELS = ['tiny', 'base', 'small', 'medium', 'large']
const MODEL_LABELS = { tiny: 'tiny (75 MB)', base: 'base (150 MB)', small: 'small (450 MB)', medium: 'medium (1.5 GB)', large: 'large (3 GB)' }

// ── Local LLM (summarization, node-llama-cpp) ──────────────────────────────────
// Optional, lazily loaded on first summarize. Stays fully offline/local. The
// GGUF is downloaded once into userData/llm-cache (never bundled). Default is a
// current (2025) multilingual instruct model; override via the store key
// 'llmModelUri' (any node-llama-cpp `hf:owner/repo:quant` URI or local path).
const DEFAULT_LLM_URI = 'hf:unsloth/Qwen3-4B-Instruct-2507-GGUF:Q4_K_M'
/** @type {any} */ let llama = null       // getLlama() runtime handle
/** @type {any} */ let llmModel = null    // loaded GGUF model, kept warm between summaries
let isLoadingLlm = false
let llmBusy = false            // single context sequence -> one summarize at a time

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
// Separate cache for the (optional, large) summarization GGUF.
const LLM_CACHE_DIR = path.join(app.getPath('userData'), 'llm-cache')

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

// Build the aggregating transformers.js progress_callback for a model load.
// Multiple .onnx parts load in parallel; this reports one steady, monotonic
// overall percentage to the tray + UI (see the inline reasoning below).
function makeProgressCallback(modelName) {
  const lastLoggedPct = {}
  const fileBytes = {}
  let lastSentPct = -1
  return (data) => {
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
}

// Create (downloading if needed) a Whisper ASR pipeline for the given model,
// with the CoreML->CPU device fallback. Throws on failure. Used both for the
// active dictation model (loadModel) and for temporary per-file models.
async function buildWhisperPipeline(modelName, progress_callback) {
  const { pipeline, env } = await import('@huggingface/transformers')
  env.cacheDir = MODEL_CACHE_DIR
  const modelId = `${PROVIDER}/whisper-${modelName}`
  log(`Loading model: ${modelId}`)

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
  //   Silicon GPU/Neural Engine) runs reliably. CoreML + q8 still crashes
  //   (quantization + CoreML don't get along), so fp32 for the CoreML path.
  const preferredDevice = process.platform === 'darwin' ? 'coreml' : 'cpu'
  try {
    return await pipeline('automatic-speech-recognition', modelId,
      { device: preferredDevice, dtype: 'fp32', session_options: { enableCpuMemArena: false }, progress_callback })
  } catch (deviceErr) {
    if (preferredDevice === 'cpu') throw deviceErr
    logErr(`Device '${preferredDevice}' failed, falling back to CPU:`, errMsg(deviceErr))
    return await pipeline('automatic-speech-recognition', modelId,
      { device: 'cpu', dtype: 'q8', session_options: { enableCpuMemArena: false }, progress_callback })
  }
}

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
    const modelId = `${PROVIDER}/whisper-${modelName}`
    const pipe = await buildWhisperPipeline(modelName, makeProgressCallback(modelName))
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
    const corruptPath = path.join(MODEL_CACHE_DIR, PROVIDER, `whisper-${modelName}`)
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
        tr('dialog.modelError.body', { model: `${PROVIDER}/whisper-${modelName}`, error: errMsg(err) })
      )
    }
  } finally {
    // Only reset if no newer load has taken over - otherwise a superseded old
    // run would clear the active one's flag.
    if (myGen === loadGeneration) isLoadingModel = false
  }
}

async function transcribe(pcm, { maxNewTokens = 440, pipeline = whisperPipeline } = {}) {
  if (!pipeline) return ''

  const language = /** @type {string} */ (store.get('language', 'german'))
  const genOptions = {
    language,
    task: 'transcribe',
    // Whisper internally processes only a fixed 30s window - without chunking
    // everything after that is silently cut off. chunk_length_s enables
    // long-form transcription (overlapping 30s windows are stitched together).
    chunk_length_s: 30,
    stride_length_s: 5,
    // max_new_tokens as a safety net (per 30s chunk) against repetition loops, a
    // known Whisper failure mode on silence/noise/unclear speech. Short dictation
    // uses the tight default; file transcription raises it, since a dense 30s of
    // speech (e.g. a fast speaker in a video) can exceed 440 tokens per chunk.
    max_new_tokens: maxNewTokens,
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
    genOptions.streamer = new WhisperTextStreamer(pipeline.tokenizer, {
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
  const result = await pipeline(pcm, genOptions)
  log(`transcribe(): done after ${((Date.now() - t0) / 1000).toFixed(1)}s`)
  // Rewrite spoken quote markers (e.g. "Zitat Anfang … Zitat Ende") into
  // typographic quotes for the current language (see dictation.js).
  return applyDictationMarkers(result.text.trim(), language)
}

// ── Summarization (local LLM via node-llama-cpp) ───────────────────────────────

// Resolve the GGUF, downloading it once (with progress) if missing. Reuses the
// same progress channel as the Whisper download so the overlay/settings show a
// bar. createModelDownloader validates/resumes, so an already-present model
// completes near-instantly.
async function ensureLlmModel() {
  const { createModelDownloader } = await import('node-llama-cpp')
  const modelUri = /** @type {string} */ (store.get('llmModelUri', DEFAULT_LLM_URI))
  log(`LLM model: ${modelUri}`)
  fs.mkdirSync(LLM_CACHE_DIR, { recursive: true })
  let lastPct = -1
  const downloader = await createModelDownloader({
    modelUri,
    dirPath: LLM_CACHE_DIR,
    onProgress: ({ totalSize, downloadedSize }) => {
      if (!totalSize) return
      const pct = Math.round((downloadedSize / totalSize) * 100)
      if (pct !== lastPct) {
        lastPct = pct
        updateTrayLabel(`LLM ${pct}%`)
        sendModelProgress({ status: 'progress', progress: pct })
      }
    },
  })
  const modelPath = await downloader.download()
  log(`LLM model ready: ${modelPath}`)
  return modelPath
}

// Lazily load the LLM on first use and keep it warm. node-llama-cpp is ESM-only,
// so it's dynamically imported (same pattern as electron-store / transformers).
async function loadLlm() {
  if (llmModel) return
  if (isLoadingLlm) {
    while (isLoadingLlm) await new Promise((r) => setTimeout(r, 100))
    if (llmModel) return
    throw new Error('LLM load failed')
  }
  isLoadingLlm = true
  updateTrayLabel(tr('tray.loadingLlm'))
  overlayWindow?.showInactive()
  try {
    const { getLlama } = await import('node-llama-cpp')
    const modelPath = await ensureLlmModel()
    if (!llama) llama = await getLlama()
    llmModel = await llama.loadModel({ modelPath })
    log('LLM loaded')
    updateTrayLabel(null)
    sendModelProgress({ status: 'ready' })
    setTimeout(() => overlayWindow?.hide(), 500)
  } catch (err) {
    logErr('LLM load error:', errMsg(err))
    updateTrayLabel(tr('tray.loadError'))
    sendModelProgress({ status: 'error', message: errMsg(err) })
    overlayWindow?.hide()
    throw err
  } finally {
    isLoadingLlm = false
  }
}

/**
 * Summarize transcribed text with the local LLM. Returns '' if the model can't
 * be loaded or produces nothing (caller then falls back to the raw transcript).
 * A fresh context is created per call and disposed afterwards so the multi-GB
 * KV cache doesn't accumulate; the model itself stays resident.
 * @param {string} text
 * @param {string} language
 * @returns {Promise<string>}
 */
async function summarize(text, language) {
  if (!text || !text.trim()) return ''
  await loadLlm()
  const { LlamaChatSession } = await import('node-llama-cpp')
  // Single sequence -> serialize requests.
  while (llmBusy) await new Promise((r) => setTimeout(r, 50))
  llmBusy = true
  /** @type {any} */ let context = null
  try {
    context = await llmModel.createContext({ contextSize: 4096 })
    const session = new LlamaChatSession({
      contextSequence: context.getSequence(),
      systemPrompt: buildSystemPrompt(language),
    })
    const t0 = Date.now()
    const out = await session.prompt(text.trim(), { maxTokens: 400, temperature: 0.3 })
    log(`summarize(): done after ${((Date.now() - t0) / 1000).toFixed(1)}s`)
    return cleanSummary(out)
  } finally {
    llmBusy = false
    if (context) { try { await context.dispose() } catch { /* already gone */ } }
  }
}

// ── File transcription (ffmpeg -> Whisper) ─────────────────────────────────────

const WHISPER_SAMPLE_RATE = 16000
// Media containers/codecs offered in the file picker. ffmpeg decodes far more,
// but this keeps the dialog focused on what users actually dictate/record.
const MEDIA_EXTENSIONS = ['mp4', 'mov', 'mkv', 'webm', 'avi', 'm4a', 'mp3', 'wav', 'aac', 'flac', 'ogg', 'opus']

// ffmpeg-static returns a path inside app.asar when packaged; the binary itself
// is unpacked (see electron-builder.yml asarUnpack) and must be spawned from
// there. In dev the path has no app.asar segment, so the replace is a no-op.
function getFfmpegPath() {
  const p = /** @type {unknown} */ (require('ffmpeg-static'))
  return typeof p === 'string' ? p.replace('app.asar', 'app.asar.unpacked') : null
}

// Decode any supported media file to raw 16 kHz mono float32 PCM (what Whisper
// expects) by streaming it through ffmpeg. Robust across containers/codecs and
// memory-friendly for large video files, unlike the renderer's Web Audio path.
function decodeFileToWhisperPCM(filePath) {
  return new Promise((resolve, reject) => {
    const ff = getFfmpegPath()
    if (!ff) { reject(new Error('ffmpeg binary not found')); return }
    const { spawn } = require('child_process')
    const args = [
      '-i', filePath,
      '-f', 'f32le', '-ac', '1', '-ar', String(WHISPER_SAMPLE_RATE),
      '-loglevel', 'error', 'pipe:1',
    ]
    const proc = spawn(ff, args)
    /** @type {Buffer[]} */ const chunks = []
    let stderr = ''
    proc.stdout.on('data', (d) => chunks.push(d))
    proc.stderr.on('data', (d) => { stderr += d.toString() })
    proc.on('error', reject)
    proc.on('close', (code) => {
      if (code !== 0) { reject(new Error(stderr.trim() || `ffmpeg exited with code ${code}`)); return }
      const buf = Buffer.concat(chunks)
      // Reinterpret the little-endian float32 bytes as a Float32Array view.
      const pcm = new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4))
      resolve(pcm)
    })
  })
}

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
  lastFileStatus = data
  resultWindow?.webContents.send('file-status', data)
}

// The Whisper model to use for file transcription. Independent from the live
// dictation model (store 'model') so a big, slow model can be used for files
// without slowing dictation. Defaults to the dictation model until changed.
function getFileModel() {
  const m = /** @type {string} */ (store.get('fileModel', store.get('model', 'small')))
  return MODELS.includes(m) ? m : 'small'
}

// Transcribe file PCM with the chosen model. If it's the active dictation model,
// reuse the warm pipeline; otherwise build a temporary pipeline just for this
// file and dispose it afterwards, leaving the dictation model loaded and active.
async function transcribeFilePCM(pcm, modelName) {
  const activeModel = store.get('model', 'small')
  if (modelName === activeModel && whisperPipeline) {
    return transcribe(pcm, { maxNewTokens: 2048 })
  }
  overlayWindow?.showInactive()
  updateTrayLabel(tr('tray.loading', { model: modelName }))
  /** @type {any} */ let tempPipe = null
  try {
    tempPipe = await buildWhisperPipeline(modelName, makeProgressCallback(modelName))
    sendModelProgress({ status: 'ready' })
    updateTrayLabel(null)
    setTimeout(() => overlayWindow?.hide(), 300)
    return await transcribe(pcm, { maxNewTokens: 2048, pipeline: tempPipe })
  } finally {
    updateTrayLabel(null)
    // Free the temporary model's native memory; best-effort (older transformers
    // builds may not expose dispose()).
    if (tempPipe && typeof tempPipe.dispose === 'function') {
      try { await tempPipe.dispose() } catch { /* already gone */ }
    }
  }
}

// Orchestrate: open/focus the result window, decode the file, transcribe with
// the selected file model, and stream status into the window. The summary is
// offered on demand there (button).
async function transcribeFileFlow(filePath) {
  openResultWindow()
  lastFilePath = filePath
  const model = getFileModel()
  sendFileStatus({ status: 'transcribing', name: path.basename(filePath), model })
  try {
    const pcm = await decodeFileToWhisperPCM(filePath)
    log(`File decoded: ${(pcm.length / WHISPER_SAMPLE_RATE).toFixed(1)}s from ${path.basename(filePath)} (model: ${model})`)
    const transcript = await transcribeFilePCM(pcm, model)
    log(isDev ? `File transcription: "${transcript}"` : `File transcription done (${transcript.length} chars)`)
    sendFileStatus({ status: 'done', name: path.basename(filePath), transcript, model })
  } catch (err) {
    logErr('File transcription error:', errMsg(err))
    sendFileStatus({ status: 'error', message: errMsg(err) })
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

// Model selector in the result window: expose the choices + current selection.
ipcMain.handle('result-config', () => ({
  models: MODELS,
  labels: MODEL_LABELS,
  fileModel: getFileModel(),
}))

// Change the file-transcription model and, if a file is already loaded,
// re-transcribe it with the new model.
ipcMain.on('result-set-file-model', (_e, model) => {
  if (!MODELS.includes(model)) return
  store.set('fileModel', model)
  log('File model set:', model)
  if (lastFilePath) transcribeFileFlow(lastFilePath)
})

ipcMain.on('result-copy', (_e, text) => {
  if (typeof text === 'string') clipboard.writeText(text)
})

ipcMain.handle('result-summarize', async (_e, text) => {
  const language = /** @type {string} */ (store.get('language', 'german'))
  return summarize(String(text || ''), language)
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
  return provider === PROVIDER &&
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
  // Capture and reset the mode immediately - a new recording may start while
  // this one is still transcribing/summarizing.
  const summarizeMode = pendingSummarize
  pendingSummarize = false
  overlayWindow?.webContents.send('transcribing')

  const language = /** @type {string} */ (store.get('language', 'german'))
  let transcript = ''
  try {
    transcript = await transcribe(Float32Array.from(pcm))
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
      const summary = await summarize(transcript, language)
      if (summary) { toPaste = summary; summarized = true }
    } catch (err) {
      logErr('Summarization error:', errMsg(err))
    }
  }

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
  const modelItems = MODELS.map((m) => /** @type {import('electron').MenuItemConstructorOptions} */ ({
    label: MODEL_LABELS[m] || m,
    type: 'radio',
    checked: m === currentModel,
    click: () => loadModel(m),
  }))

  const menu = Menu.buildFromTemplate([
    { label: 'SHOWhisper', enabled: false },
    { type: 'separator' },
    { label: tr('menu.transcribeFile'), click: openFileForTranscription },
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
    // While the model is still loading, whisperPipeline is either null or being
    // reassigned - don't start recording, otherwise the audio is lost or
    // transcribe() finds no model. Just don't flip the toggle.
    if (isLoadingModel) {
      log('Recording ignored: model still loading')
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
