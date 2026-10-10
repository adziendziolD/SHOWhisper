const { test } = require('node:test')
const assert = require('node:assert/strict')
const {
  postprocessDictation, applyMarkersFor, applyVoiceCommands, applyReplacements, parseReplacements, formatReplacements,
} = require('../src/shared/postprocess')

test('voice commands: German line and paragraph breaks', () => {
  assert.equal(applyVoiceCommands('Hallo, neue Zeile, wie geht es dir?', 'german'), 'Hallo\nWie geht es dir?')
  assert.equal(applyVoiceCommands('Erster Punkt. Neuer Absatz. Zweiter Punkt.', 'german'), 'Erster Punkt.\n\nZweiter Punkt.')
})

test('voice commands: English and French', () => {
  assert.equal(applyVoiceCommands('Hi there new line how are you', 'english'), 'Hi there\nHow are you')
  assert.equal(applyVoiceCommands('Bonjour. Nouveau paragraphe. Merci.', 'french'), 'Bonjour.\n\nMerci.')
})

test('voice commands: auto applies all languages, other languages none', () => {
  assert.equal(applyVoiceCommands('A neue Zeile B new line C', 'auto'), 'A\nB\nC')
  assert.equal(applyVoiceCommands('A neue Zeile B', 'spanish'), 'A neue Zeile B')
})

test('voice commands: only whole phrases, no stray breaks at the edges', () => {
  assert.equal(applyVoiceCommands('Die neue Zeilenlänge', 'german'), 'Die neue Zeilenlänge')
  assert.equal(applyVoiceCommands('Neue Zeile. Text. Neue Zeile.', 'german'), 'Text.')
})

test('replacements: whole words, case-insensitive, literal output', () => {
  const rules = [{ from: 'show whisper', to: 'SHOWhisper' }, { from: 'kubernetes', to: 'Kubernetes' }, { from: 'preis', to: '$1 €' }]
  assert.equal(applyReplacements('Ich nutze Show  Whisper mit kubernetes.', rules), 'Ich nutze SHOWhisper mit Kubernetes.')
  assert.equal(applyReplacements('Der Preis ist gut', rules), 'Der $1 € ist gut')
  assert.equal(applyReplacements('Preisliste', rules), 'Preisliste')
})

test('replacements: unicode word boundaries', () => {
  assert.equal(applyReplacements('Größe und groß', [{ from: 'groß', to: 'GROSS' }]), 'Größe und GROSS')
})

test('replacements: tolerate bad input', () => {
  assert.equal(applyReplacements('abc', null), 'abc')
  assert.equal(applyReplacements('abc', [/** @type {any} */ (null), { from: ' ', to: 'x' }]), 'abc')
})

test('parse/format replacements round-trip', () => {
  const src = '# comment\nshow whisper => SHOWhisper\n\nfoo->bar\nbaz = \n=> nope'
  const list = parseReplacements(src)
  assert.deepEqual(list, [
    { from: 'show whisper', to: 'SHOWhisper' },
    { from: 'foo', to: 'bar' },
    { from: 'baz', to: '' },
  ])
  assert.deepEqual(parseReplacements(formatReplacements(list)), list)
})

test('markers: known language, auto tries all, other languages untouched', () => {
  assert.equal(applyMarkersFor('Er sagte Zitat Anfang hallo Zitat Ende', 'german'), 'Er sagte „hallo“')
  assert.equal(applyMarkersFor('He said open quote hi close quote', 'auto'), 'He said “hi”')
  assert.equal(applyMarkersFor('Er sagte Zitat Anfang hallo Zitat Ende', null), 'Er sagte „hallo“')
  assert.equal(applyMarkersFor('Dijo Zitat Anfang hola Zitat Ende', 'spanish'), 'Dijo Zitat Anfang hola Zitat Ende')
})

test('postprocessDictation: markers, commands, then replacements', () => {
  const out = postprocessDictation('Zitat Anfang show whisper Zitat Ende neue Zeile fertig', {
    language: 'german', replacements: [{ from: 'show whisper', to: 'SHOWhisper' }],
  })
  assert.equal(out, '„SHOWhisper“\nFertig')
  assert.equal(postprocessDictation('a neue Zeile b', { language: 'german', voiceCommands: false }), 'a neue Zeile b')
})
