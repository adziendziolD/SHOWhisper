const { test } = require('node:test')
const assert = require('node:assert/strict')
const { TRANSCRIPTION_LANGUAGES, isTranscriptionLanguage, languageFromCode, defaultsForLocale } = require('../src/shared/languages')

test('every language has a unique two-letter code', () => {
  const codes = Object.values(TRANSCRIPTION_LANGUAGES)
  assert.equal(new Set(codes).size, codes.length)
  for (const c of codes) assert.match(c, /^[a-z]{2}$/)
})

test('isTranscriptionLanguage', () => {
  assert.ok(isTranscriptionLanguage('auto'))
  assert.ok(isTranscriptionLanguage('german'))
  assert.ok(!isTranscriptionLanguage('klingon'))
  assert.ok(!isTranscriptionLanguage('constructor'))
  assert.ok(!isTranscriptionLanguage(undefined))
})

test('languageFromCode', () => {
  assert.equal(languageFromCode('de'), 'german')
  assert.equal(languageFromCode('ja'), 'japanese')
  assert.equal(languageFromCode('xx'), null)
})

test('defaultsForLocale', () => {
  assert.deepEqual(defaultsForLocale('de-DE'), { language: 'german', uiLanguage: 'german' })
  assert.deepEqual(defaultsForLocale('fr'), { language: 'french', uiLanguage: 'french' })
  assert.deepEqual(defaultsForLocale('es-ES'), { language: 'spanish', uiLanguage: 'english' })
  assert.deepEqual(defaultsForLocale('xx'), { language: 'auto', uiLanguage: 'english' })
  assert.deepEqual(defaultsForLocale(''), { language: 'auto', uiLanguage: 'english' })
})
