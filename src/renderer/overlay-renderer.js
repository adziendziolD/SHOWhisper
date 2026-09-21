/* Renderer – runs in the BrowserWindow (overlay) */

const pill        = /** @type {HTMLElement} */ (document.getElementById('pill'))
const canvas      = /** @type {HTMLCanvasElement} */ (document.getElementById('waveform'))
const timerEl     = /** @type {HTMLElement} */ (document.getElementById('rec-timer'))
const ctx         = /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d'))
const loadingBar  = /** @type {HTMLElement} */ (document.getElementById('loading-bar-fill'))
const loadingPct  = /** @type {HTMLElement} */ (document.getElementById('loading-pct'))
const liveTextEl  = /** @type {HTMLElement} */ (document.getElementById('live-text'))

/** @type {MediaStream | null} */
let mediaStream = null
/** @type {ScriptProcessorNode | null} */
let scriptNode  = null
/** Raw PCM chunks at captureRate, waiting for the next flush */
let pending     = /** @type {Float32Array[]} */ ([])
let pendingLen  = 0
let totalSamples = 0
/** @type {number} */
let recordingId  = 0
/** @type {number} */
let captureRate  = 0
/** Serializes flushes so chunks reach the worker in recording order */
let flushTail    = Promise.resolve()
/** @type {number | null} */
let animFrameId   = null
/** @type {AnalyserNode | null} */
let analyser      = null
/** @type {AudioContext | null} */
let audioCtx      = null
/** @type {ReturnType<typeof setInterval> | null} */
let timerInterval = null
let startTime     = 0

// ── State Machine ─────────────────────────────────────────────────────────────

function setState(state) {
  pill.className = state // 'loading' | 'recording' | 'transcribing' | 'done' | ''
}

// ── Model loading ─────────────────────────────────────────────────────────────

function handleModelLoading(data) {
  if (data.status === 'progress') {
    setState('loading')
    const pct = Math.round(data.progress)
    loadingBar.style.width = `${pct}%`
    loadingPct.textContent = `${pct}%`
  } else if (data.status === 'ready' || data.status === 'error') {
    setState('')
    loadingBar.style.width = '0%'
    loadingPct.textContent = '0%'
  }
}

// ── Waveform ──────────────────────────────────────────────────────────────────

function drawWaveform() {
  if (!analyser) return

  const bufLen = analyser.frequencyBinCount
  const data   = new Uint8Array(bufLen)
  analyser.getByteFrequencyData(data)

  ctx.clearRect(0, 0, canvas.width, canvas.height)

  const bars    = 28
  const barW    = 4
  const gap     = 2.5
  const totalW  = bars * (barW + gap)
  const offsetX = (canvas.width - totalW) / 2
  const maxH    = canvas.height - 4

  const grad = ctx.createLinearGradient(0, 0, canvas.width, 0)
  grad.addColorStop(0,   '#ff3232')
  grad.addColorStop(0.5, '#ff6a00')
  grad.addColorStop(1,   '#ff3232')
  ctx.fillStyle = grad

  for (let i = 0; i < bars; i++) {
    // Sample from the low frequency range (voice ~80-3000 Hz)
    const sampleIdx = Math.floor((i / bars) * (bufLen * 0.4))
    const norm      = data[sampleIdx] / 255
    const h         = Math.max(3, norm * maxH)
    const x         = offsetX + i * (barW + gap)
    const y         = (canvas.height - h) / 2

    ctx.beginPath()
    ctx.roundRect(x, y, barW, h, 2)
    ctx.fill()
  }

  animFrameId = requestAnimationFrame(drawWaveform)
}

// ── Timer ─────────────────────────────────────────────────────────────────────

function startTimer() {
  startTime = Date.now()
  timerInterval = setInterval(() => {
    const s = Math.floor((Date.now() - startTime) / 1000)
    const m = Math.floor(s / 60)
    timerEl.textContent = `${m}:${String(s % 60).padStart(2, '0')}`
  }, 500)
}

function stopTimer() {
  if (timerInterval) clearInterval(timerInterval)
  timerEl.textContent = '0:00'
}

// ── Recording ─────────────────────────────────────────────────────────────────

const WHISPER_SAMPLE_RATE = 16000
// ponytail: fixed 4 s flush window, not sentence/silence detection - real
// segmentation (e.g. webrtcvad) if mid-sentence chunk edges hurt quality.
const FLUSH_SECONDS = 4

// Resample a mono PCM buffer at `captureRate` to 16 kHz (what Whisper
// expects). Node can't decode audio, so this runs in the renderer.
async function resampleTo16k(pcm) {
  const buf = new AudioBuffer({ length: pcm.length, numberOfChannels: 1, sampleRate: captureRate })
  buf.copyToChannel(pcm, 0)
  const offline = new OfflineAudioContext(
    1,
    Math.ceil(buf.duration * WHISPER_SAMPLE_RATE),
    WHISPER_SAMPLE_RATE
  )
  const src = offline.createBufferSource()
  src.buffer = buf
  src.connect(offline.destination)
  src.start()
  return (await offline.startRendering()).getChannelData(0)
}

// ponytail: peak-floor trim + mean-absolute-value gate instead of a real VAD
// - Whisper hallucinates full sentences on silent chunks ("Das war's für
// heute."), so silence must never reach the model. Trimming the trailing
// silence first also keeps a short utterance at the end of a mostly-silent
// final buffer above the gate (and shortens every chunk).
const SILENCE_AVG_ABS = 0.003
const TRIM_PEAK_FLOOR = 0.005   // per-sample peak that counts as "audible"
const TRIM_KEEP_MS = 300        // keep a little tail after the last peak (decay)

function isSilent(pcm) {
  let sum = 0
  for (let i = 0; i < pcm.length; i++) sum += Math.abs(pcm[i])
  return sum / pcm.length < SILENCE_AVG_ABS
}

// Cut everything after the last audible sample (+ TRIM_KEEP_MS). pcm is at
// captureRate. Returns an empty array when nothing audible was found.
function trimTrailingSilence(pcm) {
  let last = -1
  for (let i = pcm.length - 1; i >= 0; i--) {
    if (Math.abs(pcm[i]) > TRIM_PEAK_FLOOR) { last = i; break }
  }
  if (last === -1) return new Float32Array(0)
  const end = Math.min(pcm.length, last + Math.round((TRIM_KEEP_MS / 1000) * captureRate) + 1)
  return pcm.slice(0, end)
}

// Take a snapshot of the buffered audio, resample it and send it to main.
// `final` chunks are always sent (even empty) - main finalizes the dictation
// on that message, so it must arrive.
async function doFlush(final) {
  const chunks = pending
  pending = []
  pendingLen = 0
  const len = chunks.reduce((n, c) => n + c.length, 0)
  if (len === 0) {
    if (final) window.whisper.sendChunk(recordingId, new Float32Array(0), true)
    return
  }
  const pcm = new Float32Array(len)
  let off = 0
  for (const c of chunks) { pcm.set(c, off); off += c.length }
  const voiced = trimTrailingSilence(pcm)
  if (voiced.length === 0 || isSilent(voiced)) {
    if (final) window.whisper.sendChunk(recordingId, new Float32Array(0), true)
    return
  }
  window.whisper.sendChunk(recordingId, await resampleTo16k(voiced), final)
}

function queueFlush(final) {
  const run = flushTail.then(() => doFlush(final))
  flushTail = run.then(() => {}, () => {})
  return run
}

// Tear everything down and report the failure to the main process, which
// resets tray/toggle state and informs the user. Used by every error path so
// the pill can never stay stuck in a recording/transcribing state.
function failRecording(message) {
  stopTimer()
  if (animFrameId !== null) cancelAnimationFrame(animFrameId)
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  if (scriptNode) {
    scriptNode.onaudioprocess = null
    try { scriptNode.disconnect() } catch { /* already disconnected */ }
    scriptNode = null
  }
  if (mediaStream) {
    try { mediaStream.getTracks().forEach((t) => t.stop()) } catch { /* already stopped */ }
    mediaStream = null
  }
  if (audioCtx) { audioCtx.close(); audioCtx = null }
  pending = []
  pendingLen = 0
  setState('')
  window.whisper.recordingFailed(message)
}

async function startRecording() {
  pending = []
  pendingLen = 0
  totalSamples = 0
  flushTail = Promise.resolve()
  liveTextEl.textContent = ''

  // Microphone access can fail (permission denied, no device). Without a
  // catch, the pill would stay visible but stuck stateless and the tray/worker
  // toggle desynced - instead abort cleanly and let the main process reset the
  // recording window/tray/worker toggle.
  let stream
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true })
  } catch (err) {
    console.error('[overlay] Microphone access failed:', err)
    setState('')
    window.whisper.recordingFailed(err instanceof Error ? err.message : String(err))
    return
  }
  mediaStream = stream
  // A track ending mid-recording (device unplugged, OS revoked access) would
  // otherwise leave the pill stuck and the main-process toggle desynced.
  stream.getTracks().forEach((t) => { t.onended = () => failRecording('Microphone disconnected') })

  audioCtx = new AudioContext()
  captureRate = audioCtx.sampleRate
  const source = audioCtx.createMediaStreamSource(stream)
  analyser = audioCtx.createAnalyser()
  analyser.fftSize = 512
  source.connect(analyser)

  // Raw PCM tap (no WebM/MediaRecorder): ScriptProcessor hands us 4096-sample
  // buffers directly; once FLUSH_SECONDS of audio accumulated, it's resampled
  // to 16 kHz and streamed to the worker for live transcription.
  // ponytail: ScriptProcessor (deprecated) instead of an AudioWorklet - one
  // fewer file, same throughput for a single mono mic stream.
  scriptNode = audioCtx.createScriptProcessor(4096, 1, 1)
  scriptNode.onaudioprocess = (e) => {
    // Copy: the engine may overwrite the input buffer between callbacks,
    // storing the view directly would alias every entry to the same memory.
    const d = new Float32Array(e.inputBuffer.getChannelData(0))
    pending.push(d)
    pendingLen += d.length
    totalSamples += d.length
    if (pendingLen >= FLUSH_SECONDS * captureRate) queueFlush(false)
  }
  const mute = audioCtx.createGain()
  mute.gain.value = 0
  source.connect(scriptNode)
  scriptNode.connect(mute)
  mute.connect(audioCtx.destination)

  recordingId = Date.now()
  setState('recording')
  startTimer()
  drawWaveform()
}

// The mic + AudioContext pipeline buffers ~200-400 ms of audio. Tearing the
// graph down immediately would drop the tail of the last word - wait long
// enough for it to arrive in onaudioprocess before the final flush.
const DRAIN_MS = 400

async function stopRecording() {
  if (!mediaStream) return

  stopTimer()
  if (animFrameId !== null) cancelAnimationFrame(animFrameId)
  ctx.clearRect(0, 0, canvas.width, canvas.height)

  await new Promise((r) => setTimeout(r, DRAIN_MS))

  // Stop capturing. The final flush only reads its PCM snapshot, so tearing
  // the graph down now is safe.
  if (scriptNode) {
    scriptNode.onaudioprocess = null
    try { scriptNode.disconnect() } catch { /* already disconnected */ }
    scriptNode = null
  }
  try { mediaStream.getTracks().forEach((t) => t.stop()) } catch { /* already stopped */ }
  mediaStream = null
  // Close the AudioContext - browsers cap the number of open contexts (~6),
  // otherwise new AudioContext() fails after a few recordings.
  if (audioCtx) { audioCtx.close(); audioCtx = null }

  if (totalSamples === 0) { failRecording('No audio data recorded'); return }

  const finalize = queueFlush(true)
  // A failed final flush means main never sees the 'final' chunk and would
  // stay stuck in dictation state - report it like any other failure.
  try {
    await finalize
  } catch (err) {
    console.error('[overlay] Final flush failed:', err)
    failRecording(err instanceof Error ? err.message : String(err))
  }
}

// ── IPC Events ────────────────────────────────────────────────────────────────

window.whisper.onStartRecording(() => startRecording())
window.whisper.onStopRecording(()  => stopRecording())
window.whisper.onTranscribing(()   => setState('transcribing'))
window.whisper.onLiveText((text)   => {
  // The pill line can't grow - show the tail of the transcript so the newest
  // words are the ones visible.
  liveTextEl.textContent = text.length > 90 ? `…${text.slice(-90)}` : text
})
window.whisper.onSummarizing(()    => setState('summarizing'))
window.whisper.onDone(()           => setState('done'))
window.whisper.onModelLoading(handleModelLoading)

// Tells the main process that we're actually listening now. Without this,
// early model-loading events (app start, before this page has finished
// loading) would be lost - Electron doesn't buffer; a renderer that isn't
// listening yet drops the message entirely.
window.whisper.overlayReady()

// ── i18n ──────────────────────────────────────────────────────────────────────
function applyI18n(lang) {
  document.querySelectorAll('[data-i18n]').forEach((el) => {
    const htmlEl = /** @type {HTMLElement} */ (el)
    htmlEl.textContent = window.i18n.t(lang, htmlEl.dataset.i18n ?? '')
  })
}
window.whisper.getLanguage().then(applyI18n)
window.whisper.onLanguageChanged(applyI18n)
