// Static (text-scan) consistency checks across files that can't be loaded
// under plain Node (HTML pages, Electron preloads and main.js). Read-only.
const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')
const RENDERER = path.join(ROOT, 'src/renderer')
const PRELOAD = path.join(ROOT, 'src/preload')
const MAIN = path.join(ROOT, 'src/main/main.js')

/** @param {string} dir @param {string} ext */
const filesIn = (dir, ext) => fs.readdirSync(dir).filter((f) => f.endsWith(ext)).map((f) => path.join(dir, f))
/** @param {string} s @param {RegExp} re */
const captures = (s, re) => [...s.matchAll(re)].map((m) => m[1])

describe('renderer HTML', () => {
  const pages = filesIn(RENDERER, '.html')

  it('finds the renderer pages', () => {
    assert.ok(pages.length > 0)
  })

  for (const page of pages) {
    it(`${path.basename(page)}: every <script src> exists`, () => {
      const html = fs.readFileSync(page, 'utf8')
      for (const src of captures(html, /<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi)) {
        if (/^[a-z]+:/i.test(src)) continue // absolute URLs aren't files on disk
        const file = path.resolve(path.dirname(page), src)
        assert.ok(fs.existsSync(file), `${path.basename(page)} references missing ${src}`)
      }
    })
  }

  it('overlay.html loads shared/audio.js before overlay-renderer.js', () => {
    const html = fs.readFileSync(path.join(RENDERER, 'overlay.html'), 'utf8')
    const audio = html.indexOf('../shared/audio.js')
    const renderer = html.indexOf('overlay-renderer.js')
    assert.ok(audio !== -1 && renderer !== -1 && audio < renderer)
  })
})

describe('IPC channels', () => {
  const main = fs.readFileSync(MAIN, 'utf8')
  // Channels main listens on (renderer -> main).
  const mainListens = new Set(captures(main, /ipcMain\.(?:on|once|handle|handleOnce)\(\s*['"]([^'"]+)['"]/g))
  // Channels main pushes (main -> renderer): direct webContents.send plus the
  // sendDictationStatus(id, 'channel') helper that forwards to webContents.send.
  const mainSends = new Set([
    ...captures(main, /webContents\.send\(\s*['"]([^'"]+)['"]/g),
    ...captures(main, /sendDictationStatus\(\s*[^,]+,\s*['"]([^'"]+)['"]/g),
  ])

  it('finds channels in main.js (the scan itself works)', () => {
    assert.ok(mainListens.size > 5)
    assert.ok(mainSends.size > 3)
  })

  for (const file of filesIn(PRELOAD, '.js')) {
    const src = fs.readFileSync(file, 'utf8')
    const name = path.basename(file)
    const toMain = captures(src, /ipcRenderer\.(?:send|sendSync|invoke)\(\s*['"]([^'"]+)['"]/g)
    const fromMain = captures(src, /ipcRenderer\.(?:on|once)\(\s*['"]([^'"]+)['"]/g)

    it(`${name}: uses only string-literal channels (so this scan sees all of them)`, () => {
      const calls = (src.match(/ipcRenderer\.(?:send|sendSync|invoke|on|once)\(/g) || []).length
      assert.equal(toMain.length + fromMain.length, calls)
      assert.ok(calls > 0)
    })

    it(`${name}: every send/invoke channel has an ipcMain listener`, () => {
      const missing = toMain.filter((c) => !mainListens.has(c))
      assert.deepEqual(missing, [], `no ipcMain.on/handle in main.js for: ${missing.join(', ')}`)
    })

    it(`${name}: every listened channel is sent by main`, () => {
      const missing = fromMain.filter((c) => !mainSends.has(c))
      assert.deepEqual(missing, [], `no webContents.send in main.js for: ${missing.join(', ')}`)
    })
  }
})
