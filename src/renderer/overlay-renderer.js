/* Renderer – runs in the BrowserWindow (overlay) */

const pill        = /** @type {HTMLElement} */ (document.getElementById('pill'))
const canvas      = /** @type {HTMLCanvasElement} */ (document.getElementById('waveform'))
const timerEl     = /** @type {HTMLElement} */ (document.getElementById('rec-timer'))
const ctx         = /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d'))
const loadingBar  = /** @type {HTMLElement} */ (document.getElementById('loading-bar-fill'))
const loadingPct  = /** @type {HTMLElement} */ (document.getElementById('loading-pct'))
const liveTextEl  = /** @type {HTMLElement} */ (document.getElementById('live-text'))

/**
 * One recording. Everything lives on this object (not in module globals) so a
 * stop that is still draining/flushing can never touch a recording the user
 * already started right after it.
 * @typedef {{
 *   id: number,                        // assigned by main
 *   stream: MediaStream | null,
 *   ctx: AudioContext | null,
 *   node: ScriptProcessorNode | null,
 *   rate: number,                      // capture sample rate
 *   pending: Float32Array[],           // raw PCM since the last flush
 *   pendingLen: number,
 *   total: number,
 *   silentRun: number,                 // samples of silence at the end of `pending`
 *   flushTail: Promise<void>,          // keeps chunks in recording order
 *   stopped: boolean,
 *   failed: boolean,
 * }} Recording
 */
/** @type {Recording | null} */
let rec = null
/** @type {number | null} */
let animFrameId   = null
/** @type {AnalyserNode | null} */
let analyser      = null
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
// Silence trimming/gating and the chunk-cut decision live in src/shared/audio.js
// (loaded before this script, see overlay.html).
const { trimSilence, isSilent, concat, blockPeak, shouldCut, TRIM_PEAK_FLOOR } = window.ShowAudio

// Resample a mono PCM buffer to 16 kHz (what Whisper expects). Node can't
// decode audio, so this runs in the renderer.
async function resampleTo16k(pcm, rate) {
  const buf = new AudioBuffer({ length: pcm.length, numberOfChannels: 1, sampleRate: rate })
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

// Resample one snapshot and send it to main. Never throws: a broken chunk only
// loses its own words, while the `final` message must always arrive (main
// finalizes the dictation on it), so it's sent even when empty.
async function flush(r, chunks, final) {
  let out = new Float32Array(0)
  try {
    const voiced = trimSilence(concat(chunks), r.rate)
    if (voiced.length > 0 && !isSilent(voiced)) out = await resampleTo16k(voiced, r.rate)
  } catch (err) {
    console.error('[overlay] Chunk flush failed:', err)
  }
  if (r.failed) return
  if (out.length > 0 || final) window.whisper.sendChunk(r.id, out, final)
}

// Snapshot the buffered audio synchronously, then flush it in order.
function queueFlush(r, final) {
  const chunks = r.pending
  r.pending = []
  r.pendingLen = 0
  r.silentRun = 0
  r.flushTail = r.flushTail.then(() => flush(r, chunks, final))
}

// Release the mic and the audio graph of a recording.
function teardown(r) {
  if (r.node) {
    r.node.onaudioprocess = null
    try { r.node.disconnect() } catch { /* already disconnected */ }
    r.node = null
  }
  if (r.stream) {
    r.stream.getTracks().forEach((t) => {
      t.onended = null
      try { t.stop() } catch { /* already stopped */ }
    })
  }
  // Close the AudioContext - browsers cap the number of open contexts (~6),
  // otherwise new AudioContext() fails after a few recordings.
  if (r.ctx) { r.ctx.close().catch(() => {}); r.ctx = null }
}

function resetRecordingUi() {
  stopTimer()
  if (animFrameId !== null) cancelAnimationFrame(animFrameId)
  animFrameId = null
  analyser = null
  ctx.clearRect(0, 0, canvas.width, canvas.height)
}

// Tear the recording down and report the failure to the main process, which
// drops its session, resets tray/toggle state and informs the user. Used by
// every error path so the pill can never stay stuck in a recording state.
function failRecording(r, message) {
  if (r.failed) return
  r.failed = true
  r.stopped = true
  teardown(r)
  if (rec === r) rec = null
  // Only reset the pill if no newer recording took it over meanwhile.
  if (rec === null) {
    resetRecordingUi()
    setState('')
  }
  window.whisper.recordingFailed(r.id, message)
}

async function startRecording(id) {
  // Main never starts twice without a stop, but if it did, don't leak the mic.
  if (rec) stopRecording()

  /** @type {Recording} */
  const r = {
    id, stream: null, ctx: null, node: null, rate: 0,
    pending: [], pendingLen: 0, total: 0, silentRun: 0,
    flushTail: Promise.resolve(), stopped: false, failed: false,
  }
  rec = r
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
    failRecording(r, err instanceof Error ? err.message : String(err))
    return
  }
  // Stopped while the permission prompt / device open was pending: stopRecording
  // already sent the (empty) final chunk - just release the mic again.
  if (r.stopped) {
    stream.getTracks().forEach((t) => t.stop())
    return
  }
  r.stream = stream
  // A track ending mid-recording (device unplugged, OS revoked access) would
  // otherwise leave the pill stuck and the main-process toggle desynced.
  stream.getTracks().forEach((t) => { t.onended = () => failRecording(r, 'Microphone disconnected') })

  try {
    r.ctx = new AudioContext()
    r.rate = r.ctx.sampleRate
    const source = r.ctx.createMediaStreamSource(stream)
    analyser = r.ctx.createAnalyser()
    analyser.fftSize = 512
    source.connect(analyser)

    // Raw PCM tap (no WebM/MediaRecorder): ScriptProcessor hands us 4096-sample
    // buffers directly; at the next speech pause (see MIN/MAX_CHUNK_S) the
    // audio is resampled to 16 kHz and streamed to the worker.
    // ponytail: ScriptProcessor (deprecated) instead of an AudioWorklet - one
    // fewer file, same throughput for a single mono mic stream.
    const node = r.ctx.createScriptProcessor(4096, 1, 1)
    r.node = node
    node.onaudioprocess = (e) => {
      // Copy: the engine may overwrite the input buffer between callbacks,
      // storing the view directly would alias every entry to the same memory.
      const d = new Float32Array(e.inputBuffer.getChannelData(0))
      r.pending.push(d)
      r.pendingLen += d.length
      r.total += d.length
      r.silentRun = blockPeak(d) > TRIM_PEAK_FLOOR ? 0 : r.silentRun + d.length
      if (shouldCut(r)) queueFlush(r, false)
    }
    const mute = r.ctx.createGain()
    mute.gain.value = 0
    source.connect(node)
    node.connect(mute)
    mute.connect(r.ctx.destination)
  } catch (err) {
    console.error('[overlay] Audio setup failed:', err)
    failRecording(r, err instanceof Error ? err.message : String(err))
    return
  }

  setState('recording')
  startTimer()
  drawWaveform()
}

// The mic + AudioContext pipeline buffers ~200-400 ms of audio. Tearing the
// graph down immediately would drop the tail of the last word - wait long
// enough for it to arrive in onaudioprocess before the final flush.
const DRAIN_MS = 400

async function stopRecording() {
  const r = rec
  if (!r) return
  // Detach right away: a recording started during the drain below gets its
  // own state and is never touched by this stop.
  rec = null
  r.stopped = true
  resetRecordingUi()
  setState('transcribing')

  if (r.stream) {
    await new Promise((res) => setTimeout(res, DRAIN_MS))
    if (r.failed) return
    teardown(r)
    if (r.total === 0) { failRecording(r, 'No audio data recorded'); return }
  }
  queueFlush(r, true)
}

// ── IPC Events ────────────────────────────────────────────────────────────────

window.whisper.onStartRecording((id) => startRecording(id))
window.whisper.onStopRecording(()  => stopRecording())
window.whisper.onTranscribing(()   => setState('transcribing'))
window.whisper.onLiveText((text)   => {
  // The pill line can't grow - show the tail of the transcript so the newest
  // words are the ones visible.
  liveTextEl.textContent = text.length > 90 ? `…${text.slice(-90)}` : text
})
window.whisper.onSummarizing((mode) => {
  // The AI hotkey does more than summarize (see 'aiMode') - name the action.
  const label = /** @type {HTMLElement} */ (document.getElementById('ai-label'))
  label.dataset.i18n = mode ? `overlay.ai.${mode}` : 'overlay.summarizing'
  label.textContent = window.i18n.t(uiLang, label.dataset.i18n)
  setState('summarizing')
})
window.whisper.onDone(()           => setState('done'))
window.whisper.onModelLoading(handleModelLoading)

// Tells the main process that we're actually listening now. Without this,
// early model-loading events (app start, before this page has finished
// loading) would be lost - Electron doesn't buffer; a renderer that isn't
// listening yet drops the message entirely.
window.whisper.overlayReady()

// ── i18n ──────────────────────────────────────────────────────────────────────
/** @type {Language} */
let uiLang = 'german'
function applyI18n(lang) {
  uiLang = lang
  document.querySelectorAll('[data-i18n]').forEach((el) => {
    const htmlEl = /** @type {HTMLElement} */ (el)
    htmlEl.textContent = window.i18n.t(lang, htmlEl.dataset.i18n ?? '')
  })
}
window.whisper.getLanguage().then(applyI18n)
window.whisper.onLanguageChanged(applyI18n)
