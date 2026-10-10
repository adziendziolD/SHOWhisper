// Every translation key the code uses must exist (a missing key silently shows
// the raw key in the UI). Static scan of tr('…') in main, T('…') and
// data-i18n="…" in the renderer pages, plus the dynamic key families.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const { translations } = require('../src/shared/i18n')
const { AI_MODES } = require('../src/shared/summarize')

const root = path.join(__dirname, '..')
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8')
const renderer = fs.readdirSync(path.join(root, 'src/renderer')).filter((f) => /\.(html|js)$/.test(f))

function usedKeys() {
  const keys = new Set()
  for (const m of read('src/main/main.js').matchAll(/\btr\('([^'$]+)'/g)) keys.add(m[1])
  for (const f of renderer) {
    const src = read(`src/renderer/${f}`)
    for (const m of src.matchAll(/\bT\('([^'$]+)'/g)) keys.add(m[1])
    for (const m of src.matchAll(/data-i18n="([^"]+)"/g)) keys.add(m[1])
  }
  // Built from a variable at runtime:
  for (const m of AI_MODES) keys.add(`overlay.ai.${m}`).add(`settings.aiMode.${m}`)
  for (const d of ['coreml', 'dml', 'cpu']) keys.add(`settings.gpu.device.${d}`)
  for (const p of ['darwin', 'win32', 'linux']) keys.add(`dialog.mic.hint.${p}`)
  for (const e of ['invalid', 'inUse', 'duplicate', 'unknown']) keys.add(`settings.error.${e}`)
  return keys
}

test('every used translation key exists in every UI language', () => {
  const keys = usedKeys()
  assert.ok(keys.size > 50, `suspiciously few keys found (${keys.size})`)
  for (const [lang, dict] of Object.entries(translations)) {
    const missing = [...keys].filter((k) => !(k in dict))
    assert.deepEqual(missing, [], `${lang} is missing keys`)
  }
})
