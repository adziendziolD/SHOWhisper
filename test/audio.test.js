const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const audio = require('../src/shared/audio')

const {
  trimSilence, isSilent, concat, blockPeak, shouldCut,
  MIN_CHUNK_S, MAX_CHUNK_S, PAUSE_MS, SILENCE_AVG_ABS, TRIM_PEAK_FLOOR, TRIM_KEEP_MS,
} = audio

const RATE = 1000 // 1 sample per ms keeps the arithmetic readable
const KEEP = Math.round((TRIM_KEEP_MS / 1000) * RATE)

/** Float32Array of `n` samples, all `v`. */
const fill = (n, v = 0) => new Float32Array(n).fill(v)

describe('constants', () => {
  it('keep their documented values', () => {
    assert.equal(MIN_CHUNK_S, 3)
    assert.equal(MAX_CHUNK_S, 8)
    assert.equal(PAUSE_MS, 350)
    assert.equal(SILENCE_AVG_ABS, 0.003)
    assert.equal(TRIM_PEAK_FLOOR, 0.005)
    assert.equal(TRIM_KEEP_MS, 300)
  })
})

describe('trimSilence', () => {
  it('returns an empty array for all-silent input', () => {
    assert.equal(trimSilence(fill(5000), RATE).length, 0)
    assert.equal(trimSilence(fill(5000, TRIM_PEAK_FLOOR), RATE).length, 0, 'floor itself is not audible')
    assert.equal(trimSilence(fill(5000, -TRIM_PEAK_FLOOR), RATE).length, 0)
  })

  it('returns an empty array for empty input', () => {
    assert.equal(trimSilence(new Float32Array(0), RATE).length, 0)
  })

  it('trims leading and trailing silence, keeping TRIM_KEEP_MS on both sides', () => {
    const pcm = fill(5000)
    pcm.fill(0.5, 2000, 2100) // audible samples 2000..2099
    const out = trimSilence(pcm, RATE)
    assert.equal(out.length, 100 + 2 * KEEP)
    // starts KEEP samples before the first audible sample
    assert.equal(out[KEEP - 1], 0)
    assert.equal(out[KEEP], 0.5)
    assert.equal(out[KEEP + 99], 0.5)
    assert.equal(out[KEEP + 100], 0)
  })

  it('returns a view on the input (no copy)', () => {
    const pcm = fill(5000)
    pcm.fill(0.5, 2000, 2100)
    const out = trimSilence(pcm, RATE)
    assert.equal(out.buffer, pcm.buffer)
    assert.equal(out.byteOffset, (2000 - KEEP) * 4)
  })

  it('clamps the keep margin at the buffer edges', () => {
    const pcm = fill(1000)
    pcm[10] = 0.5
    pcm[990] = -0.5
    const out = trimSilence(pcm, RATE)
    assert.equal(out.length, 1000)
    assert.equal(out.byteOffset, 0)
  })

  it('treats negative samples as audible', () => {
    const pcm = fill(3000)
    pcm[1500] = -0.2
    const out = trimSilence(pcm, RATE)
    assert.equal(out.length, 1 + 2 * KEEP)
    assert.equal(out[KEEP], pcm[1500])
  })

  it('a single audible sample keeps the margin around it', () => {
    const pcm = fill(3000)
    pcm[0] = 0.1
    assert.equal(trimSilence(pcm, RATE).length, 1 + KEEP)
  })

  it('scales the keep margin with the sample rate', () => {
    const rate = 48000
    const keep = Math.round((TRIM_KEEP_MS / 1000) * rate)
    const pcm = fill(rate * 3)
    pcm.fill(0.3, rate, rate + 10)
    assert.equal(trimSilence(pcm, rate).length, 10 + 2 * keep)
  })

  it('keeps quiet stretches between two audible parts', () => {
    const pcm = fill(5000)
    pcm[1000] = 0.5
    pcm[4000] = 0.5
    assert.equal(trimSilence(pcm, RATE).length, 3001 + 2 * KEEP)
  })
})

describe('isSilent', () => {
  it('is true for zeros', () => {
    assert.equal(isSilent(fill(100)), true)
  })

  it('compares the mean absolute value against SILENCE_AVG_ABS', () => {
    assert.equal(isSilent(fill(100, SILENCE_AVG_ABS * 0.9)), true)
    assert.equal(isSilent(fill(100, SILENCE_AVG_ABS * 1.1)), false)
    assert.equal(isSilent(fill(100, -SILENCE_AVG_ABS * 1.1)), false, 'uses absolute values')
  })

  it('averages over the whole buffer (a short loud burst in silence)', () => {
    const pcm = fill(1000)
    pcm[0] = 1 // mean 0.001 < 0.003
    assert.equal(isSilent(pcm), true)
    pcm.fill(1, 0, 10) // mean 0.01
    assert.equal(isSilent(pcm), false)
  })

  it('does not cancel out positive and negative samples', () => {
    const pcm = new Float32Array(100)
    for (let i = 0; i < pcm.length; i++) pcm[i] = i % 2 ? 0.1 : -0.1
    assert.equal(isSilent(pcm), false)
  })

  it('treats an empty buffer as not silent (NaN mean) - callers check length first', () => {
    assert.equal(isSilent(new Float32Array(0)), false)
  })
})

describe('concat', () => {
  it('joins chunks in order', () => {
    const out = concat([Float32Array.of(1, 2), Float32Array.of(3), Float32Array.of(4, 5, 6)])
    assert.deepEqual([...out], [1, 2, 3, 4, 5, 6])
    assert.ok(out instanceof Float32Array)
  })

  it('handles no chunks and empty chunks', () => {
    assert.equal(concat([]).length, 0)
    assert.deepEqual([...concat([new Float32Array(0), Float32Array.of(7), new Float32Array(0)])], [7])
  })

  it('copies (does not alias the input)', () => {
    const a = Float32Array.of(1, 2)
    const out = concat([a])
    a[0] = 9
    assert.equal(out[0], 1)
  })
})

describe('blockPeak', () => {
  it('returns the largest absolute value', () => {
    assert.equal(blockPeak(Float32Array.of(0.1, 0.5, 0.2)), Math.fround(0.5))
  })

  it('counts negative samples by magnitude', () => {
    assert.equal(blockPeak(Float32Array.of(0.1, -0.8, 0.3)), Math.fround(0.8))
    assert.equal(blockPeak(Float32Array.of(-0.25, -0.5)), 0.5)
  })

  it('is 0 for silence and for an empty block', () => {
    assert.equal(blockPeak(fill(4096)), 0)
    assert.equal(blockPeak(new Float32Array(0)), 0)
  })
})

describe('shouldCut', () => {
  const rate = 48000
  const pause = (PAUSE_MS / 1000) * rate
  const min = MIN_CHUNK_S * rate
  const max = MAX_CHUNK_S * rate

  it('never cuts below MIN_CHUNK_S, even in a long pause', () => {
    assert.equal(shouldCut({ pendingLen: 0, silentRun: 0, rate }), false)
    assert.equal(shouldCut({ pendingLen: min - 1, silentRun: min - 1, rate }), false)
  })

  it('does not cut after MIN_CHUNK_S while speech continues', () => {
    assert.equal(shouldCut({ pendingLen: min, silentRun: 0, rate }), false)
    assert.equal(shouldCut({ pendingLen: max - 1, silentRun: pause - 1, rate }), false)
  })

  it('cuts at a pause of PAUSE_MS once MIN_CHUNK_S accumulated', () => {
    assert.equal(shouldCut({ pendingLen: min, silentRun: pause, rate }), true)
    assert.equal(shouldCut({ pendingLen: min + 12345, silentRun: pause * 3, rate }), true)
  })

  it('always cuts at MAX_CHUNK_S, pause or not', () => {
    assert.equal(shouldCut({ pendingLen: max, silentRun: 0, rate }), true)
    assert.equal(shouldCut({ pendingLen: max + 4096, silentRun: 0, rate }), true)
  })

  it('scales with the sample rate', () => {
    const r = 16000
    assert.equal(shouldCut({ pendingLen: MIN_CHUNK_S * r, silentRun: (PAUSE_MS / 1000) * r, rate: r }), true)
    // The same sample counts are too short at 48 kHz.
    assert.equal(shouldCut({ pendingLen: MIN_CHUNK_S * r, silentRun: (PAUSE_MS / 1000) * r, rate }), false)
  })

  it('ignores extra properties (the renderer passes its recording object)', () => {
    const rec = { pendingLen: max, silentRun: 0, rate, id: 1, pending: [] }
    assert.equal(shouldCut(rec), true)
  })
})

describe('simulated ScriptProcessor stream', () => {
  // Mirrors the renderer's onaudioprocess loop: 4096-sample blocks, silentRun
  // reset on any audible block, cut when shouldCut() says so.
  function simulate(blocks, rate) {
    const r = { pendingLen: 0, silentRun: 0, rate }
    const cuts = []
    blocks.forEach((d, i) => {
      r.pendingLen += d.length
      r.silentRun = blockPeak(d) > TRIM_PEAK_FLOOR ? 0 : r.silentRun + d.length
      if (shouldCut(r)) { cuts.push(i); r.pendingLen = 0; r.silentRun = 0 }
    })
    return cuts
  }

  it('cuts in the first pause after MIN_CHUNK_S', () => {
    const rate = 48000
    const speech = fill(4096, 0.2)
    const quiet = fill(4096, 0.001)
    const blocksPerPause = Math.ceil(((PAUSE_MS / 1000) * rate) / 4096) // 5
    // 4 s of speech, then a pause
    const blocks = [...Array(Math.ceil((4 * rate) / 4096)).fill(speech), ...Array(10).fill(quiet)]
    const cuts = simulate(blocks, rate)
    assert.deepEqual(cuts, [Math.ceil((4 * rate) / 4096) + blocksPerPause - 1])
  })

  it('cuts continuous speech every MAX_CHUNK_S', () => {
    const rate = 48000
    const blocks = Array(300).fill(fill(4096, 0.2)) // ~25.6 s
    const cuts = simulate(blocks, rate)
    const per = Math.ceil((MAX_CHUNK_S * rate) / 4096)
    assert.deepEqual(cuts, [per - 1, 2 * per - 1, 3 * per - 1])
  })
})

describe('module shape', () => {
  it('exports exactly the documented API', () => {
    assert.deepEqual(Object.keys(audio).sort(), [
      'MAX_CHUNK_S', 'MIN_CHUNK_S', 'PAUSE_MS', 'SILENCE_AVG_ABS', 'TRIM_KEEP_MS', 'TRIM_PEAK_FLOOR',
      'blockPeak', 'concat', 'isSilent', 'shouldCut', 'trimSilence',
    ])
  })

  it('sets globalThis.ShowAudio when loaded as a classic script (no module)', () => {
    const vm = require('node:vm')
    const fs = require('node:fs')
    const path = require('node:path')
    const src = fs.readFileSync(path.join(__dirname, '../src/shared/audio.js'), 'utf8')
    const sandbox = { Float32Array, Math }
    vm.createContext(sandbox)
    vm.runInContext(src, sandbox)
    assert.equal(typeof sandbox.ShowAudio.trimSilence, 'function')
    assert.equal(sandbox.ShowAudio.MAX_CHUNK_S, MAX_CHUNK_S)
  })
})
