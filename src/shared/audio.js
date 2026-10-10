// Pure, DOM-free audio helpers for the overlay's live dictation: silence
// trimming/gating and the "where to cut the next chunk" decision. No Web Audio,
// no I/O - so the logic is unit-testable under plain Node.
//
// Loaded twice: as a classic <script> in the sandboxed overlay renderer (no
// require there - exposes globalThis.ShowAudio) and via require() from Node
// (tests). Hence the IIFE + dual export at the bottom.

;(function () {
  // Chunks are cut at a speech pause once MIN_CHUNK_S of audio accumulated, at
  // the latest after MAX_CHUNK_S. Cutting in a pause instead of a fixed window
  // never splits a word, and the final chunk after stop stays short (fast).
  // Not much shorter: Whisper pads every call to a 30 s window, so each chunk
  // costs about the same - too many small ones would build a backlog.
  // ponytail: peak-floor pause detection, not a real VAD (e.g. webrtcvad).
  const MIN_CHUNK_S = 3
  const MAX_CHUNK_S = 8
  const PAUSE_MS = 350

  // ponytail: peak-floor trim + mean-absolute-value gate instead of a real VAD
  // - Whisper hallucinates full sentences on silent chunks ("Das war's für
  // heute."), so silence must never reach the model. Trimming leading and
  // trailing silence first keeps a short utterance in a mostly-silent chunk
  // above the gate (and shortens every chunk).
  const SILENCE_AVG_ABS = 0.003
  const TRIM_PEAK_FLOOR = 0.005   // per-sample peak that counts as "audible"
  const TRIM_KEEP_MS = 300        // keep a little margin around speech (onset/decay)

  /** @param {Float32Array} pcm */
  function isSilent(pcm) {
    let sum = 0
    for (let i = 0; i < pcm.length; i++) sum += Math.abs(pcm[i])
    return sum / pcm.length < SILENCE_AVG_ABS
  }

  // Cut the silence before the first and after the last audible sample (keeping
  // TRIM_KEEP_MS on both sides). Returns an empty array when nothing is audible.
  /**
   * @param {Float32Array} pcm
   * @param {number} rate  sample rate of pcm in Hz
   * @returns {Float32Array}
   */
  function trimSilence(pcm, rate) {
    let first = -1
    for (let i = 0; i < pcm.length; i++) {
      if (Math.abs(pcm[i]) > TRIM_PEAK_FLOOR) { first = i; break }
    }
    if (first === -1) return new Float32Array(0)
    let last = first
    for (let i = pcm.length - 1; i > first; i--) {
      if (Math.abs(pcm[i]) > TRIM_PEAK_FLOOR) { last = i; break }
    }
    const keep = Math.round((TRIM_KEEP_MS / 1000) * rate)
    return pcm.subarray(Math.max(0, first - keep), Math.min(pcm.length, last + keep + 1))
  }

  /**
   * @param {Float32Array[]} chunks
   * @returns {Float32Array}
   */
  function concat(chunks) {
    const out = new Float32Array(chunks.reduce((n, c) => n + c.length, 0))
    let off = 0
    for (const c of chunks) { out.set(c, off); off += c.length }
    return out
  }

  /**
   * Largest absolute sample value of one audio block (0 for an empty block).
   * @param {Float32Array} samples
   * @returns {number}
   */
  function blockPeak(samples) {
    let peak = 0
    for (let i = 0; i < samples.length; i++) { const a = Math.abs(samples[i]); if (a > peak) peak = a }
    return peak
  }

  /**
   * Whether the buffered audio should be cut into a chunk now: always after
   * MAX_CHUNK_S, otherwise at a pause of PAUSE_MS once MIN_CHUNK_S accumulated.
   * @param {{ pendingLen: number, silentRun: number, rate: number }} state
   *   buffered samples, trailing silent samples, sample rate (Hz)
   * @returns {boolean}
   */
  function shouldCut({ pendingLen, silentRun, rate }) {
    const pauseSamples = (PAUSE_MS / 1000) * rate
    return pendingLen >= MAX_CHUNK_S * rate ||
      (pendingLen >= MIN_CHUNK_S * rate && silentRun >= pauseSamples)
  }

  const api = {
    MIN_CHUNK_S, MAX_CHUNK_S, PAUSE_MS, SILENCE_AVG_ABS, TRIM_PEAK_FLOOR, TRIM_KEEP_MS,
    isSilent, trimSilence, concat, blockPeak, shouldCut,
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = api
  else globalThis.ShowAudio = api
})()
