const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { buildSystemPrompt, cleanSummary, SYSTEM_PROMPTS } = require('../src/shared/summarize')

describe('buildSystemPrompt', () => {
  it('returns the prompt of each language', () => {
    for (const lang of ['german', 'english', 'french']) {
      assert.equal(buildSystemPrompt(lang), SYSTEM_PROMPTS[lang])
      assert.ok(SYSTEM_PROMPTS[lang].length > 0)
    }
  })

  it('asks for the summary in the dictation language', () => {
    assert.match(SYSTEM_PROMPTS.german, /auf Deutsch/)
    assert.match(SYSTEM_PROMPTS.english, /in English/)
    assert.match(SYSTEM_PROMPTS.french, /en français/)
  })

  it('falls back to german for unknown/missing languages', () => {
    assert.equal(buildSystemPrompt('spanish'), SYSTEM_PROMPTS.german)
    assert.equal(buildSystemPrompt(''), SYSTEM_PROMPTS.german)
    assert.equal(buildSystemPrompt(/** @type {any} */ (undefined)), SYSTEM_PROMPTS.german)
  })
})

describe('cleanSummary', () => {
  it('returns "" for empty input', () => {
    assert.equal(cleanSummary(''), '')
    assert.equal(cleanSummary(/** @type {any} */ (null)), '')
    assert.equal(cleanSummary(/** @type {any} */ (undefined)), '')
  })

  it('trims whitespace', () => {
    assert.equal(cleanSummary('  \n Ein Satz. \n'), 'Ein Satz.')
  })

  it('leaves normal text unchanged', () => {
    assert.equal(cleanSummary('Kurz: alles gut.'), 'Kurz: alles gut.')
  })

  it('strips a leading label in any language, case-insensitively, with : - – —', () => {
    assert.equal(cleanSummary('Zusammenfassung: Text.'), 'Text.')
    assert.equal(cleanSummary('SUMMARY - Text.'), 'Text.')
    assert.equal(cleanSummary('summary:Text.'), 'Text.')
    assert.equal(cleanSummary('Résumé – Texte.'), 'Texte.')
    assert.equal(cleanSummary('Resume — Texte.'), 'Texte.')
    assert.equal(cleanSummary('  Summary :  Text. '), 'Text.')
  })

  it('only strips the label at the very start', () => {
    assert.equal(cleanSummary('The summary: fine.'), 'The summary: fine.')
  })

  it('does not strip a label word without a separator', () => {
    assert.equal(cleanSummary('Summary of the meeting.'), 'Summary of the meeting.')
  })

  it('unwraps a fully quote-wrapped response (straight and typographic)', () => {
    assert.equal(cleanSummary('"Text."'), 'Text.')
    assert.equal(cleanSummary('„Text.“'), 'Text.')
    assert.equal(cleanSummary('“Text.”'), 'Text.')
    assert.equal(cleanSummary('« Texte. »'), 'Texte.')
    assert.equal(cleanSummary('Summary: "Text."'), 'Text.')
  })

  it('does not unwrap partially quoted text', () => {
    assert.equal(cleanSummary('"Hallo" sagte er.'), '"Hallo" sagte er.')
    assert.equal(cleanSummary('Er sagte "Hallo"'), 'Er sagte "Hallo"')
  })

  it('stringifies non-string input', () => {
    assert.equal(cleanSummary(/** @type {any} */ (42)), '42')
  })
})
