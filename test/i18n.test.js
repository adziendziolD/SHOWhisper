const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { translations, t } = require('../src/shared/i18n')

const LANGS = ['german', 'english', 'french']
/** @param {string} s */
const placeholders = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort()

describe('i18n translations', () => {
  it('has exactly the german/english/french dictionaries', () => {
    assert.deepEqual(Object.keys(translations).sort(), [...LANGS].sort())
  })

  it('every key exists in every language', () => {
    const all = new Set(LANGS.flatMap((l) => Object.keys(translations[l])))
    for (const lang of LANGS) {
      const missing = [...all].filter((k) => !(k in translations[lang]))
      assert.deepEqual(missing, [], `${lang} is missing keys`)
    }
  })

  it('has no empty or non-string values', () => {
    for (const lang of LANGS) {
      for (const [key, value] of Object.entries(translations[lang])) {
        assert.equal(typeof value, 'string', `${lang}.${key}`)
        assert.ok(value.trim().length > 0, `${lang}.${key} is empty`)
      }
    }
  })

  it('uses the same {placeholders} for a key in every language', () => {
    for (const key of Object.keys(translations.german)) {
      const expected = placeholders(translations.german[key])
      for (const lang of LANGS) {
        assert.deepEqual(placeholders(translations[lang][key] ?? ''), expected, `${lang}.${key}`)
      }
    }
  })
})

describe('t()', () => {
  // Pick a real key so the tests don't depend on specific wording.
  const key = Object.keys(translations.german)[0]

  it('returns the translation of the requested language', () => {
    for (const lang of LANGS) assert.equal(t(lang, key), translations[lang][key])
  })

  it('falls back to german for an unknown language', () => {
    assert.equal(t('klingon', key), translations.german[key])
    assert.equal(t(/** @type {any} */ (undefined), key), translations.german[key])
  })

  it('falls back to german when a key is missing in the language', () => {
    const k = '__test.onlyGerman'
    translations.german[k] = 'nur deutsch'
    try {
      assert.equal(t('english', k), 'nur deutsch')
    } finally {
      delete translations.german[k]
    }
  })

  it('falls back to the key itself when it exists nowhere', () => {
    assert.equal(t('english', 'no.such.key'), 'no.such.key')
    assert.equal(t('klingon', 'no.such.key'), 'no.such.key')
  })

  it('fills {placeholders} of real keys', () => {
    const withVar = Object.keys(translations.german)
      .find((k) => placeholders(translations.german[k]).length > 0)
    assert.ok(withVar, 'expected at least one key with a placeholder')
    for (const lang of LANGS) {
      const vars = Object.fromEntries(placeholders(translations[lang][withVar]).map((n) => [n, `<${n}>`]))
      const out = t(lang, withVar, vars)
      assert.doesNotMatch(out, /\{\w+\}/)
      for (const n of Object.keys(vars)) assert.ok(out.includes(`<${n}>`))
    }
    assert.equal(t('german', 'tray.loading', { model: 'base' }), 'Lade base…')
  })

  it('replaces repeated placeholders and leaves unknown ones alone', () => {
    const k = '__test.vars'
    translations.german[k] = '{a} und {a} und {b}'
    try {
      assert.equal(t('german', k, { a: 1 }), '1 und 1 und {b}')
      assert.equal(t('german', k, { a: 'x', b: 0 }), 'x und x und 0')
    } finally {
      delete translations.german[k]
    }
  })
})
