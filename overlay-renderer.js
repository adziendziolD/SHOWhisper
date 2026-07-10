/* Renderer – runs in the BrowserWindow (overlay) */

const pill        = document.getElementById('pill')
const canvas      = document.getElementById('waveform')
const timerEl     = document.getElementById('rec-timer')
const ctx         = canvas.getContext('2d')
const loadingBar  = document.getElementById('loading-bar-fill')
const loadingPct  = document.getElementById('loading-pct')

let mediaRecorder = null
let audioChunks   = []
let animFrameId   = null
let analyser      = null
let audioCtx      = null
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
  clearInterval(timerInterval)
  timerEl.textContent = '0:00'
}

// ── Recording ─────────────────────────────────────────────────────────────────

async function startRecording() {
  audioChunks = []

  // Microphone access can fail (permission denied, no device). Without a
  // catch, the pill would stay visible but stuck stateless and the tray/worker
  // toggle desynced - instead abort cleanly and let the main process reset the
  // recording window/tray/worker toggle.
  let stream
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true })
  } catch (err) {
    console.error('[overlay] Mikrofonzugriff fehlgeschlagen:', err)
    setState('')
    window.whisper.recordingFailed(err?.message || String(err))
    return
  }

  audioCtx       = new AudioContext()
  const source   = audioCtx.createMediaStreamSource(stream)
  analyser       = audioCtx.createAnalyser()
  analyser.fftSize = 512
  source.connect(analyser)

  mediaRecorder = new MediaRecorder(stream)
  mediaRecorder.ondataavailable = (e) => audioChunks.push(e.data)
  mediaRecorder.start()

  setState('recording')
  startTimer()
  drawWaveform()
}

const WHISPER_SAMPLE_RATE = 16000

// Whisper expects raw mono PCM at 16kHz. MediaRecorder produces WebM/Opus,
// which can't be decoded in the Node main process (no AudioContext!) - so
// decode + resample here in the renderer.
async function decodeToWhisperPCM(blob) {
  const arrayBuffer = await blob.arrayBuffer()
  const decodeCtx   = new AudioContext()
  const decoded     = await decodeCtx.decodeAudioData(arrayBuffer)
  await decodeCtx.close()

  const offlineCtx = new OfflineAudioContext(
    1,
    Math.ceil(decoded.duration * WHISPER_SAMPLE_RATE),
    WHISPER_SAMPLE_RATE
  )
  const source = offlineCtx.createBufferSource()
  source.buffer = decoded
  source.connect(offlineCtx.destination)
  source.start()

  const rendered = await offlineCtx.startRendering()
  return rendered.getChannelData(0)
}

async function stopRecording() {
  if (!mediaRecorder) return

  stopTimer()
  cancelAnimationFrame(animFrameId)
  ctx.clearRect(0, 0, canvas.width, canvas.height)

  await new Promise((resolve) => {
    mediaRecorder.onstop = resolve
    mediaRecorder.stop()
    mediaRecorder.stream.getTracks().forEach((t) => t.stop())
  })

  // Close the AudioContext - browsers cap the number of open contexts (~6),
  // otherwise new AudioContext() fails after a few recordings.
  if (audioCtx) { audioCtx.close(); audioCtx = null }
  mediaRecorder = null

  const blob = new Blob(audioChunks, { type: 'audio/webm' })
  console.log('[overlay] stopRecording: Blob', blob.size, 'bytes,', audioChunks.length, 'chunks')
  const t0 = performance.now()
  const pcm  = await decodeToWhisperPCM(blob)
  console.log('[overlay] decodeToWhisperPCM fertig nach', (performance.now() - t0).toFixed(0), 'ms,', pcm.length, 'samples')
  window.whisper.sendAudio(pcm)
  console.log('[overlay] sendAudio() aufgerufen')
}

// ── IPC Events ────────────────────────────────────────────────────────────────

window.whisper.onStartRecording(() => startRecording())
window.whisper.onStopRecording(()  => stopRecording())
window.whisper.onTranscribing(()   => setState('transcribing'))
window.whisper.onDone(()           => setState('done'))
window.whisper.onModelLoading(handleModelLoading)

// Tells the main process that we're actually listening now. Without this,
// early model-loading events (app start, before this page has finished
// loading) would be lost - Electron doesn't buffer; a renderer that isn't
// listening yet drops the message entirely.
window.whisper.overlayReady()
