// Whisper/LLM worker — runs in an Electron utilityProcess (plain Node context),
// forked from main.js. All heavy work lives here: model loading (ONNX session
// creation), mel-spectrogram + Whisper inference, ffmpeg decoding of media
// files, and the node-llama-cpp summarization model. Keeping this out of the
// main process serves two purposes:
//  - the main process event loop stays free (tray, windows and IPC remain
//    responsive during minute-long transcriptions), and
//  - a native crash (onnxruntime/llama.cpp) kills only this process; main
//    detects the exit, resets state and respawns the worker.
//
// Protocol (structured-clone messages over process.parentPort):
//   in : { type: 'init', cacheDir, llmCacheDir, isDev, gpu }
//        { type: 'config', gpu }                 // settings change, applies to the next load
//        { type: 'smoke',           id }         // packaged-app self test (see main --smoke-test)
//        { type: 'load-model',      id, model }  // -> { loadedModel, device }
//        { type: 'preload-model',   id, model }
//        { type: 'transcribe',      id, pcm, language, maxNewTokens, applyMarkers?, sessionKey? }
//                                                // -> { text, language }  (language: detected name with 'auto')
//        { type: 'transcribe-file', id, filePath, model, language }   // -> { text, language }
//        { type: 'cancel-file' }                 // cancels the active file job
//        { type: 'summarize',       id, text, language, llmModelUri, mode? }
//   out: { type: 'result', id, ok, value?, error?, cancelled? }
//        { type: 'progress', id, pct, chunk, totalChunks }   // file jobs
//        { type: 'model-progress', model, data }             // download/load
// Logging goes through console.log/console.error; main pipes stdout/stderr
// into electron-log.

const path = require('path')
const fs = require('fs')
const { spawn } = require('child_process')
const { applyMarkersFor } = require('../shared/postprocess')
const { buildSystemPrompt, cleanSummary } = require('../shared/summarize')
const { TRANSCRIPTION_LANGUAGES, languageFromCode } = require('../shared/languages')

const parentPort = /** @type {any} */ (process).parentPort

function post(msg) { parentPort.postMessage(msg) }
function log(...args) { console.log(...args) }
function logErr(...args) { console.error(...args) }

/** @param {unknown} e */
function errMsg(e) { return e instanceof Error ? e.message : String(e) }

// Marker error for a user-cancelled transcription (distinguished from real
// failures so the UI can reset quietly instead of showing an error).
function cancelledError() {
  const e = /** @type {any} */ (new Error('cancelled'))
  e.cancelled = true
  return e
}

// ── Config / state ──────────────────────────────────────────────────────────────

/** @type {{ cacheDir: string, llmCacheDir: string, isDev: boolean, gpu: boolean }} */
let cfg = { cacheDir: '', llmCacheDir: '', isDev: false, gpu: true }

const PROVIDER = 'Xenova'
const WHISPER_SAMPLE_RATE = 16000

/** @type {any} */ let whisperPipeline = null
/** @type {string | null} */ let loadedModel = null
/** Device the dictation pipeline runs on ('coreml' | 'dml' | 'cpu'), reported to main */
let loadedDevice = 'cpu'

// Serializes everything that touches the shared dictation pipeline: model
// loads/swaps, dictation transcriptions and file transcriptions that reuse the
// warm pipeline. An ONNX session must never run two generations concurrently,
// and the progress wrapper below monkey-patches model.generate — both are only
// safe strictly one after another. Temp-pipeline file jobs and the LLM run
// outside this chain (independent sessions).
let chain = Promise.resolve()
/**
 * @template T
 * @param {() => T | Promise<T>} fn
 * @returns {Promise<T>}
 */
function enqueue(fn) {
  const run = chain.then(fn, fn)
  chain = run.then(() => {}, () => {}) // keep the chain alive after a failure
  return run
}

// The one running (or decoding) file-transcription job; 'cancel-file' aborts it.
/** @type {{ id: number, cancelled: boolean, stopper: any, ffmpeg: import('child_process').ChildProcess | null } | null} */
let activeFileJob = null

// ── Whisper ─────────────────────────────────────────────────────────────────────

// Build the aggregating transformers.js progress_callback for a model load.
// Multiple .onnx parts load in parallel; this reports one steady, monotonic
// overall percentage (see the inline reasoning below).
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

      // Only send on an actual percentage change, otherwise the UI flickers
      if (overallPct !== lastSentPct) {
        lastSentPct = overallPct
        post({ type: 'model-progress', model: modelName, data: { status: 'progress', progress: overallPct } })
      }
    } else if (data.status === 'done') {
      log(`Model status: done`, data.file || '')
    }
  }
}

// Create (downloading if needed) a Whisper ASR pipeline for the given model,
// on the GPU where possible (CoreML on macOS, DirectML on Windows) with a CPU
// fallback. Throws on failure. Used both for the active dictation model and
// for temporary per-file models. Returns the pipeline and the device it uses.
/** @returns {Promise<{ pipe: any, device: string }>} */
async function buildWhisperPipeline(modelName, progress_callback) {
  const { pipeline, env } = await import('@huggingface/transformers')
  env.cacheDir = cfg.cacheDir
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
  // - 'large' is excluded from CoreML entirely: its fp32 weights exceed the
  //   2GB protobuf limit and use ONNX external data (*.onnx_data), which the
  //   CoreML EP cannot initialize ("model_path must not be empty") - every
  //   attempt deterministically mapped gigabytes and then failed (log-proven),
  //   so skip straight to the CPU/q8 path.
  // - DirectML (Windows): only the encoder runs on the GPU. It's the heavy
  //   part (Whisper always encodes a full 30 s window, even for a 2 s chunk);
  //   the autoregressive decoder is small, and DirectML handles its
  //   past-key-value/If graph poorly - it stays on the CPU with q8. DirectML
  //   doesn't support memory patterns or parallel execution, so both are
  //   switched off explicitly. 'large' stays on the CPU (fp32 weights ~6 GB
  //   of VRAM, more than most GPUs - especially integrated ones - have).
  const progress_cb = progress_callback || makeProgressCallback(modelName)
  /** @type {{ device: string, options: Record<string, unknown> }[]} */
  const attempts = []
  if (cfg.gpu && modelName !== 'large') {
    if (process.platform === 'darwin') {
      attempts.push({ device: 'coreml', options: { device: 'coreml', dtype: 'fp32', session_options: { enableCpuMemArena: false } } })
    } else if (process.platform === 'win32') {
      attempts.push({ device: 'dml', options: {
        device: { encoder_model: 'dml', decoder_model_merged: 'cpu' },
        dtype: { encoder_model: 'fp32', decoder_model_merged: 'q8' },
        session_options: { enableCpuMemArena: false, enableMemPattern: false, executionMode: 'sequential' },
      } })
    }
  }
  attempts.push({ device: 'cpu', options: { device: 'cpu', dtype: 'q8', session_options: { enableCpuMemArena: false } } })

  for (const [i, { device, options }] of attempts.entries()) {
    const last = i === attempts.length - 1
    /** @type {any} */ let pipe = null
    try {
      pipe = await pipeline('automatic-speech-recognition', modelId, { ...options, progress_callback: progress_cb })
      // A GPU session can load fine and still fail on the first real run
      // (driver/EP op support) - one tiny inference proves it works, and it
      // also pays the one-time graph compilation now instead of on the
      // user's first dictation.
      if (device !== 'cpu') await warmUp(pipe)
      log(`Whisper device: ${device}`)
      return { pipe, device }
    } catch (deviceErr) {
      await disposePipeline(pipe)
      if (last) throw deviceErr
      logErr(`Device '${device}' failed, falling back to CPU:`, errMsg(deviceErr))
    }
  }
  throw new Error('unreachable')
}

// One short inference on silence (result discarded).
async function warmUp(pipe) {
  const t0 = Date.now()
  await pipe(new Float32Array(WHISPER_SAMPLE_RATE), { language: 'english', task: 'transcribe', max_new_tokens: 4 })
  log(`Warm-up done after ${((Date.now() - t0) / 1000).toFixed(1)}s`)
}

// ── Language detection ─────────────────────────────────────────────────────────
// transformers.js has no Whisper language detection (with no language it
// silently assumes English). Whisper itself predicts the language as the first
// token after <|startoftranscript|>: one encoder + one decoder step, then the
// most likely language token among the ones we offer.
async function detectLanguage(pipe, pcm) {
  const { Tensor } = await import('@huggingface/transformers')
  const t0 = Date.now()
  const gc = pipe.model.generation_config
  const { input_features } = await pipe.processor(pcm.subarray(0, 30 * WHISPER_SAMPLE_RATE))
  const sot = BigInt(gc.decoder_start_token_id)
  const out = await pipe.model({ input_features, decoder_input_ids: new Tensor('int64', BigInt64Array.from([sot]), [1, 1]) })
  const vocab = out.logits.dims.at(-1)
  const logits = out.logits.data.subarray(out.logits.data.length - vocab)
  let best = 'en'
  let bestScore = -Infinity
  for (const code of Object.values(TRANSCRIPTION_LANGUAGES)) {
    const id = gc.lang_to_id?.[`<|${code}|>`]
    if (id !== undefined && logits[id] > bestScore) { bestScore = logits[id]; best = code }
  }
  log(`Detected language: ${best} (${Date.now() - t0} ms)`)
  return best
}

// A dictation detects once (on its first chunk) and keeps that language for
// every following chunk - consistent output, and the extra encoder pass is
// paid only once. Keyed by main's dictation id; small, bounded cache.
/** @type {Map<unknown, string>} */
const detectedBySession = new Map()

/**
 * Language to transcribe with: the configured one, or for 'auto' the detected
 * ISO code. `name` is the Whisper language name for post-processing (null if
 * the detected language isn't one we offer).
 * @returns {Promise<{ whisper: string, name: string | null }>}
 */
async function resolveLanguage(pipe, pcm, language, sessionKey) {
  if (language !== 'auto') return { whisper: language, name: language }
  let code = sessionKey != null ? detectedBySession.get(sessionKey) : undefined
  if (!code) {
    code = await detectLanguage(pipe, pcm)
    if (sessionKey != null) {
      detectedBySession.set(sessionKey, code)
      if (detectedBySession.size > 20) detectedBySession.delete(detectedBySession.keys().next().value)
    }
  }
  return { whisper: code, name: languageFromCode(code) }
}

/**
 * @param {any} pipeline
 * @param {Float32Array} pcm
 * @param {{ language: string, maxNewTokens?: number, onProgress?: ((pct: number, chunk: number, totalChunks: number) => void) | null, stopper?: any, applyMarkers?: boolean, sessionKey?: unknown }} opts
 * @returns {Promise<{ text: string, language: string | null }>}
 */
async function transcribe(pipeline, pcm, { language, maxNewTokens = 440, onProgress = null, stopper = null, applyMarkers = true, sessionKey = null }) {
  const durationSeconds = pcm.length / WHISPER_SAMPLE_RATE
  const lang = await resolveLanguage(pipeline, pcm, language, sessionKey)
  const genOptions = {
    language: lang.whisper,
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
    // Hard ceiling: Whisper's decoder has only 448 positional embeddings
    // (max_target_positions/max_length = 448). Going past that (e.g. the former
    // 2048) crashes the decoder self-attention reshape once a dense chunk decodes
    // beyond position 448 ("input_shape_size == size was false", KV cache runs to
    // a 0 dimension). The pipeline enforces the cap itself, but we clamp defensively.
    max_new_tokens: Math.min(maxNewTokens, 444),
  }

  // Dev-only PCM stats (pure log noise in production).
  if (cfg.isDev) {
    let min = Infinity, max = -Infinity, sumAbs = 0
    for (let i = 0; i < pcm.length; i++) {
      const v = pcm[i]
      if (v < min) min = v
      if (v > max) max = v
      sumAbs += Math.abs(v)
    }
    log(`transcribe(): ${pcm.length} samples (${durationSeconds.toFixed(1)}s), ` +
        `min=${min.toFixed(3)} max=${max.toFixed(3)} avgAbs=${(sumAbs / pcm.length).toFixed(4)}`)
  }

  // Dev-only streamer for the recognized chunk text (token-level logging is
  // intentionally omitted: it floods the log).
  if (cfg.isDev) {
    const { WhisperTextStreamer } = await import('@huggingface/transformers')
    genOptions.streamer = new WhisperTextStreamer(pipeline.tokenizer, {
      callback_function: (text) => log(`  [streamer] Text:`, JSON.stringify(text)),
      on_finalize: () => log(`  [streamer] Finalized`),
    })
  }

  // Progress bar + cancellation (file transcription): the long-form pipeline
  // calls model.generate() exactly once per 30s window. Wrap it to (a) count
  // completed windows against the total for a real progress %, and (b) inject an
  // InterruptableStoppingCriteria so a Stop button can abort mid-generation.
  // WhisperTextStreamer's on_chunk_start can't drive progress - it only fires
  // with return_timestamps and reports within-window time. This wrapper doesn't
  // otherwise change transcription behaviour. Safe here because the enqueue()
  // chain guarantees only one generation runs on this pipeline at a time.
  /** @type {(() => void) | null} */
  let restoreGenerate = null
  if (onProgress || stopper) {
    const sr = WHISPER_SAMPLE_RATE
    const window = sr * genOptions.chunk_length_s
    const jump = window - 2 * sr * genOptions.stride_length_s
    const totalChunks = pcm.length <= window ? 1 : Math.ceil((pcm.length - window) / jump) + 1
    const model = pipeline.model
    const origGenerate = model.generate.bind(model)
    let done = 0
    if (onProgress) onProgress(0, 0, totalChunks)
    model.generate = async (opts) => {
      if (stopper?.interrupted) throw cancelledError()
      const r = await origGenerate(stopper ? { ...opts, stopping_criteria: stopper } : opts)
      if (stopper?.interrupted) throw cancelledError()  // interrupted mid-window
      done += 1
      if (onProgress) onProgress(Math.max(0, Math.min(99, Math.round((done / totalChunks) * 100))), done, totalChunks)
      return r
    }
    restoreGenerate = () => { model.generate = origGenerate }
  }

  const t0 = Date.now()
  let result
  try {
    result = await pipeline(pcm, genOptions)
  } finally {
    if (restoreGenerate) restoreGenerate()
  }
  log(`transcribe(): done after ${((Date.now() - t0) / 1000).toFixed(1)}s`)
  const text = result.text.trim()
  // Rewrite spoken quote markers (e.g. "Zitat Anfang … Zitat Ende") into
  // typographic quotes for the current language (see dictation.js). Live
  // dictation chunks skip this (applyMarkers: false): a marker phrase can span
  // a chunk boundary, so main applies it once to the full transcript.
  return { text: applyMarkers ? applyMarkersFor(text, lang.name ?? 'auto') : text, language: lang.name }
}

async function disposePipeline(pipe) {
  // Best-effort (older transformers builds may not expose dispose()).
  if (pipe && typeof pipe.dispose === 'function') {
    try { await pipe.dispose() } catch { /* already gone */ }
  }
}

// Rebuild the dictation pipeline if it was freed to make room for a temp file
// model (see handleTranscribeFile/handlePreloadModel). Must run on the chain.
async function ensureDictationPipeline() {
  if (whisperPipeline || !loadedModel) return
  const built = await buildWhisperPipeline(loadedModel, makeProgressCallback(loadedModel))
  whisperPipeline = built.pipe
  loadedDevice = built.device
  log(`Dictation model reloaded: ${PROVIDER}/whisper-${loadedModel}`)
  post({ type: 'model-progress', model: loadedModel, data: { status: 'ready' } })
}

// Queue a background reload of the dictation pipeline (after a temp-model job
// freed it) so the next dictation doesn't pay the load. Failures are logged
// and retried lazily by the next transcribe.
function scheduleDictationReload() {
  enqueue(() => ensureDictationPipeline()).catch((e) => {
    logErr('Dictation model reload failed (will retry on next dictation):', errMsg(e))
  })
}

// ── File decoding (ffmpeg) ──────────────────────────────────────────────────────

// ffmpeg-static returns a path inside app.asar when packaged; the binary itself
// is unpacked (see electron-builder.yml asarUnpack) and must be spawned from
// there. In dev the path has no app.asar segment, so the replace is a no-op.
function getFfmpegPath() {
  const p = /** @type {unknown} */ (require('ffmpeg-static'))
  return typeof p === 'string' ? p.replace('app.asar', 'app.asar.unpacked') : null
}

// Decode any supported media file to raw 16 kHz mono float32 PCM (what Whisper
// expects) by streaming it through ffmpeg. Robust across containers/codecs and
// memory-friendly for large video files. `job.ffmpeg` is set so 'cancel-file'
// can kill a decode that's still running.
function decodeFileToWhisperPCM(filePath, job) {
  return new Promise((resolve, reject) => {
    const ff = getFfmpegPath()
    if (!ff) { reject(new Error('ffmpeg binary not found')); return }
    const args = [
      '-i', filePath,
      '-f', 'f32le', '-ac', '1', '-ar', String(WHISPER_SAMPLE_RATE),
      '-loglevel', 'error', 'pipe:1',
    ]
    const proc = spawn(ff, args)
    if (job) job.ffmpeg = proc
    /** @type {Buffer[]} */ const chunks = []
    let stderr = ''
    proc.stdout.on('data', (d) => chunks.push(d))
    proc.stderr.on('data', (d) => { stderr += d.toString() })
    proc.on('error', reject)
    proc.on('close', (code) => {
      if (job) job.ffmpeg = null
      if (job?.cancelled) { reject(cancelledError()); return }
      if (code !== 0) { reject(new Error(stderr.trim() || `ffmpeg exited with code ${code}`)); return }
      const buf = Buffer.concat(chunks)
      // Reinterpret the little-endian float32 bytes as a Float32Array view.
      const pcm = new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4))
      resolve(pcm)
    })
  })
}

// ── Local LLM (summarization, node-llama-cpp) ──────────────────────────────────

/** @type {any} */ let llama = null       // getLlama() runtime handle
/** @type {any} */ let llmModel = null    // loaded GGUF model, kept warm between summaries
let isLoadingLlm = false
let llmBusy = false            // single context sequence -> one summarize at a time

// Resolve the GGUF, downloading it once (with progress) if missing.
// createModelDownloader validates/resumes, so an already-present model
// completes near-instantly.
async function ensureLlmModel(modelUri) {
  const { createModelDownloader } = await import('node-llama-cpp')
  log(`LLM model: ${modelUri}`)
  fs.mkdirSync(cfg.llmCacheDir, { recursive: true })
  let lastPct = -1
  const downloader = await createModelDownloader({
    modelUri,
    dirPath: cfg.llmCacheDir,
    onProgress: ({ totalSize, downloadedSize }) => {
      if (!totalSize) return
      const pct = Math.round((downloadedSize / totalSize) * 100)
      if (pct !== lastPct) {
        lastPct = pct
        post({ type: 'model-progress', model: 'LLM', data: { status: 'progress', progress: pct } })
      }
    },
  })
  const modelPath = await downloader.download()
  log(`LLM model ready: ${modelPath}`)
  return modelPath
}

// Lazily load the LLM on first use and keep it warm.
async function loadLlm(modelUri) {
  if (llmModel) return
  if (isLoadingLlm) {
    while (isLoadingLlm) await new Promise((r) => setTimeout(r, 100))
    if (llmModel) return
    throw new Error('LLM load failed')
  }
  isLoadingLlm = true
  try {
    const { getLlama } = await import('node-llama-cpp')
    const modelPath = await ensureLlmModel(modelUri)
    if (!llama) llama = await getLlama()
    llmModel = await llama.loadModel({ modelPath })
    log('LLM loaded')
  } finally {
    isLoadingLlm = false
  }
}

/**
 * Summarize transcribed text with the local LLM. Returns '' for empty input.
 * A fresh context is created per call and disposed afterwards so the multi-GB
 * KV cache doesn't accumulate; the model itself stays resident.
 */
async function summarize(text, language, modelUri, mode = 'summarize') {
  if (!text || !text.trim()) return ''
  await loadLlm(modelUri)
  const { LlamaChatSession } = await import('node-llama-cpp')
  // Single sequence -> serialize requests.
  while (llmBusy) await new Promise((r) => setTimeout(r, 50))
  llmBusy = true
  /** @type {any} */ let context = null
  try {
    // Rewriting modes (clean-up, e-mail, translation) produce output about as
    // long as the input, a summary stays short. Rough token estimate: ~3 chars
    // per token. The context must hold prompt + input + output; 4096 covers
    // normal dictations, long ones grow it (bounded - the KV cache is RAM).
    const inputTokens = Math.ceil(text.length / 3)
    const maxTokens = mode === 'summarize' || mode === 'bullets' ? 400 : Math.min(3000, inputTokens + 200)
    const contextSize = Math.min(8192, Math.max(4096, inputTokens + maxTokens + 512))
    context = await llmModel.createContext({ contextSize })
    const session = new LlamaChatSession({
      contextSequence: context.getSequence(),
      systemPrompt: buildSystemPrompt(language, mode),
    })
    const t0 = Date.now()
    const out = await session.prompt(text.trim(), { maxTokens, temperature: 0.3 })
    log(`summarize(): done after ${((Date.now() - t0) / 1000).toFixed(1)}s`)
    return cleanSummary(out)
  } finally {
    llmBusy = false
    if (context) { try { await context.dispose() } catch { /* already gone */ } }
  }
}

// ── Message handlers ────────────────────────────────────────────────────────────

function ok(id, value) { post({ type: 'result', id, ok: true, value }) }
function fail(id, err) {
  post({ type: 'result', id, ok: false, error: errMsg(err), cancelled: !!(/** @type {any} */ (err)?.cancelled) })
}

// Load (or switch) the dictation model. Serialized on the chain, so a load can
// never race another load or a running transcription. On failure the previous
// pipeline stays loaded and usable; the result reports which model is active.
async function handleLoadModel({ id, model }) {
  try {
    await enqueue(async () => {
      const built = await buildWhisperPipeline(model, makeProgressCallback(model))
      const old = whisperPipeline
      whisperPipeline = built.pipe
      loadedModel = model
      loadedDevice = built.device
      log(`Model ready: ${PROVIDER}/whisper-${model}`)
      // Free the previous model's native memory - without this every model
      // switch stacks another multi-GB session (memory pressure was one source
      // of the allocator crashes).
      await disposePipeline(old)
    })
    ok(id, { loadedModel, device: loadedDevice })
  } catch (err) {
    logErr('Model load error:', errMsg(err))
    fail(id, err)
  }
}

// Warm the on-disk cache for a file model (no file loaded yet); the pipeline
// is disposed right after. The dictation model is freed for the duration and
// reloaded afterwards - two multi-GB ONNX sessions in one process is exactly
// the memory regime in which onnxruntime dies natively (see below).
async function handlePreloadModel({ id, model }) {
  try {
    await enqueue(async () => {
      const old = whisperPipeline
      whisperPipeline = null
      await disposePipeline(old)
      /** @type {any} */ let pipe = null
      try {
        pipe = (await buildWhisperPipeline(model, makeProgressCallback(model))).pipe
      } finally {
        await disposePipeline(pipe)
      }
    })
    ok(id, {})
  } catch (err) {
    logErr('File model preload error:', errMsg(err))
    fail(id, err)
  } finally {
    scheduleDictationReload()
  }
}

// Dictation transcription on the warm pipeline (queued). Rebuilds the pipeline
// first if a file job freed it and the background reload didn't run yet.
async function handleTranscribe({ id, pcm, language, maxNewTokens, applyMarkers, sessionKey }) {
  try {
    const res = await enqueue(async () => {
      await ensureDictationPipeline()
      if (!whisperPipeline) throw new Error('No model loaded')
      const samples = pcm instanceof Float32Array ? pcm : Float32Array.from(pcm)
      return transcribe(whisperPipeline, samples, { language, maxNewTokens, applyMarkers: applyMarkers !== false, sessionKey })
    })
    ok(id, res)
  } catch (err) {
    fail(id, err)
  }
}

// File transcription: decode via ffmpeg, then transcribe. If the requested
// model is the loaded dictation model, reuse the warm pipeline (queued);
// otherwise build a temporary pipeline that runs independently of the chain
// (own ONNX session) and dispose it afterwards.
async function handleTranscribeFile({ id, filePath, model, language }) {
  const job = { id, cancelled: false, stopper: /** @type {any} */ (null), ffmpeg: /** @type {any} */ (null) }
  activeFileJob = job
  try {
    const { InterruptableStoppingCriteria } = await import('@huggingface/transformers')
    job.stopper = new InterruptableStoppingCriteria()
    if (job.cancelled) throw cancelledError()

    const pcm = await decodeFileToWhisperPCM(filePath, job)
    log(`File decoded: ${(pcm.length / WHISPER_SAMPLE_RATE).toFixed(1)}s from ${path.basename(filePath)} (model: ${model})`)
    if (job.cancelled) throw cancelledError()

    const onProgress = (pct, chunk, totalChunks) => post({ type: 'progress', id, pct, chunk, totalChunks })
    const opts = { language, maxNewTokens: 444, onProgress, stopper: job.stopper }

    /** @type {{ text: string, language: string | null }} */
    let res
    let usedTempModel = false
    if (model === loadedModel && whisperPipeline) {
      res = await enqueue(() => {
        if (job.cancelled) throw cancelledError() // cancelled while queued
        return transcribe(whisperPipeline, pcm, opts)
      })
    } else {
      usedTempModel = true
      res = await enqueue(async () => {
        if (job.cancelled) throw cancelledError() // cancelled while queued
        // Free the dictation model for the duration of the file job. Two
        // multi-GB ONNX sessions plus inference activations in one process is
        // the regime in which onnxruntime dies natively (reproduced: resident
        // medium fp32/CoreML + large q8 inference killed the worker at ~11 GB
        // RSS on a 64 GB machine, while the same job with the dictation model
        // freed survived). The dictation pipeline is reloaded right after.
        const old = whisperPipeline
        whisperPipeline = null
        await disposePipeline(old)
        /** @type {any} */ let tempPipe = null
        try {
          tempPipe = (await buildWhisperPipeline(model, makeProgressCallback(model))).pipe
          if (job.cancelled) throw cancelledError() // cancelled during download
          post({ type: 'model-progress', model, data: { status: 'ready' } })
          return await transcribe(tempPipe, pcm, opts)
        } finally {
          await disposePipeline(tempPipe)
        }
      })
    }
    ok(id, res)
    if (usedTempModel) scheduleDictationReload()
  } catch (err) {
    if (!(/** @type {any} */ (err)?.cancelled)) logErr('File transcription error:', errMsg(err))
    fail(id, err)
    scheduleDictationReload() // no-op if the pipeline is still loaded
  } finally {
    if (activeFileJob === job) activeFileJob = null
  }
}

function handleCancelFile() {
  if (!activeFileJob) return
  log('File transcription: stop requested')
  activeFileJob.cancelled = true
  activeFileJob.stopper?.interrupt()
  try { activeFileJob.ffmpeg?.kill('SIGKILL') } catch { /* already exited */ }
}

async function handleSummarize({ id, text, language, llmModelUri, mode }) {
  try {
    const summary = await summarize(String(text || ''), language, llmModelUri, mode)
    ok(id, { summary })
  } catch (err) {
    logErr('Summarization error:', errMsg(err))
    fail(id, err)
  }
}

// Packaged-app self test: load every native dependency of the worker without
// downloading any model. Catches the classic packaging failures (a *.node or
// shared library missing from app.asar.unpacked, wrong-arch prebuilds).
async function handleSmoke({ id }) {
  try {
    const ort = require('onnxruntime-node')
    const backends = ort.listSupportedBackends().map((b) => b.name)
    await import('@huggingface/transformers')
    const ff = getFfmpegPath()
    if (!ff || !fs.existsSync(ff)) throw new Error(`ffmpeg binary missing: ${ff}`)
    const ffVersion = await new Promise((resolve, reject) => {
      const p = spawn(ff, ['-version'])
      let out = ''
      p.stdout.on('data', (d) => { out += d.toString() })
      p.on('error', reject)
      p.on('close', (code) => (code === 0 ? resolve(out.split('\n')[0]) : reject(new Error(`ffmpeg -version exited ${code}`))))
    })
    // build: 'never' - a packaged app must ship a working prebuilt binary and
    // never try to compile llama.cpp on the user's machine.
    const { getLlama } = await import('node-llama-cpp')
    const l = await getLlama({ build: 'never' })
    ok(id, { backends, ffmpeg: ffVersion, llamaGpu: l.gpu })
  } catch (err) {
    fail(id, err)
  }
}

parentPort.on('message', (e) => {
  const msg = e.data
  switch (msg?.type) {
    case 'init':
      cfg = { cacheDir: msg.cacheDir, llmCacheDir: msg.llmCacheDir, isDev: !!msg.isDev, gpu: msg.gpu !== false }
      log(`Whisper worker ready (pid ${process.pid}, gpu=${cfg.gpu})`)
      break
    case 'config':          cfg.gpu = msg.gpu !== false; break
    case 'smoke':           handleSmoke(msg); break
    case 'load-model':      handleLoadModel(msg); break
    case 'preload-model':   handlePreloadModel(msg); break
    case 'transcribe':      handleTranscribe(msg); break
    case 'transcribe-file': handleTranscribeFile(msg); break
    case 'cancel-file':     handleCancelFile(); break
    case 'summarize':       handleSummarize(msg); break
    default:                logErr('Unknown worker message:', JSON.stringify(msg))
  }
})
