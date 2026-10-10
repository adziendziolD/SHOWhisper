const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { applyDictationMarkers, QUOTES, MARKERS } = require('../src/shared/dictation')

const apply = applyDictationMarkers

describe('applyDictationMarkers: quote characters', () => {
  it('uses „…“ for German, “…” for English and « … » (no-break spaces) for French', () => {
    assert.deepEqual(QUOTES.german, { open: '„', close: '“' })
    assert.deepEqual(QUOTES.english, { open: '“', close: '”' })
    assert.deepEqual(QUOTES.french, { open: '« ', close: ' »' })
  })

  it('has open and close markers for every quoted language', () => {
    assert.deepEqual(Object.keys(MARKERS).sort(), Object.keys(QUOTES).sort())
    for (const m of Object.values(MARKERS)) {
      assert.ok(m.open.length > 0)
      assert.ok(m.close.length > 0)
    }
  })
})

describe('applyDictationMarkers: every phrase of every language', () => {
  // Every open phrase must pair with every close phrase (README table).
  for (const [lang, { open, close }] of Object.entries(MARKERS)) {
    const q = QUOTES[lang]
    for (const o of open) {
      for (const c of close) {
        it(`${lang}: "${o}" … "${c}"`, () => {
          assert.equal(
            apply(`A ${o} b c ${c} d`, lang),
            `A ${q.open}b c${q.close} d`
          )
        })
      }
    }
  }
})

describe('applyDictationMarkers: README examples', () => {
  it('German example from the README', () => {
    assert.equal(
      apply('Er sagte Zitat Anfang das ist unmöglich Zitat Ende', 'german'),
      'Er sagte „das ist unmöglich“'
    )
  })

  it('English', () => {
    assert.equal(apply('He said quote hello unquote.', 'english'), 'He said “hello”.')
    assert.equal(apply('He said open quote hello close quote and left', 'english'),
      'He said “hello” and left')
  })

  it('French', () => {
    assert.equal(
      apply('Il a dit ouvrez les guillemets bonjour fermez les guillemets.', 'french'),
      'Il a dit « bonjour ».'
    )
    assert.equal(apply('Il a dit citation bonjour fin de citation.', 'french'),
      'Il a dit « bonjour ».')
  })
})

describe('applyDictationMarkers: case-insensitivity', () => {
  it('matches upper, lower and mixed case', () => {
    assert.equal(apply('Er sagte ZITAT ANFANG hallo zitat ende', 'german'), 'Er sagte „hallo“')
    assert.equal(apply('He said Open Quote hi CLOSE quote', 'english'), 'He said “hi”')
    assert.equal(apply('Il a dit Ouvrez Les Guillemets oui FERMEZ LES GUILLEMETS', 'french'),
      'Il a dit « oui »')
  })

  it('handles non-ASCII letters case-insensitively (Anführungszeichen)', () => {
    assert.equal(apply('ANFÜHRUNGSZEICHEN AUF ja anführungszeichen zu', 'german'), '„ja“')
  })
})

describe('applyDictationMarkers: Whisper punctuation around markers', () => {
  it('absorbs commas inside and around the marker phrases', () => {
    assert.equal(
      apply('Er sagte, Zitat, Anfang, das ist unmöglich, Zitat Ende, und ging.', 'german'),
      'Er sagte „das ist unmöglich“ und ging.'
    )
    assert.equal(apply('He said, Quote, hello, End Quote.', 'english'), 'He said “hello”.')
  })

  it('tolerates multiple spaces / newlines inside a marker', () => {
    assert.equal(apply('Er sagte Zitat   Anfang hallo Zitat\nEnde', 'german'), 'Er sagte „hallo“')
  })

  it('drops a period Whisper put after an opening marker', () => {
    assert.equal(
      apply('Er sagte: Zitat Anfang. Das ist unmöglich Zitat Ende.', 'german'),
      'Er sagte: „Das ist unmöglich“.'
    )
  })

  it('does not double the quote\'s own period after the closing marker', () => {
    assert.equal(
      apply('Er sagte: Zitat Anfang. Das ist unmöglich. Zitat Ende.', 'german'),
      'Er sagte: „Das ist unmöglich.“'
    )
    assert.equal(
      apply('Il a dit: citation. Bonjour. Fin de citation.', 'french'),
      'Il a dit: « Bonjour. »'
    )
  })

  it('keeps a period after the closing marker when the quote has none', () => {
    assert.equal(
      apply('Er sagte Zitat Anfang nein Zitat Ende. Dann ging er.', 'german'),
      'Er sagte „nein“. Dann ging er.'
    )
  })

  it('keeps ? and ! inside the quote', () => {
    assert.equal(apply('Er fragte Zitat Anfang wirklich? Zitat Ende Ja.', 'german'),
      'Er fragte „wirklich?“ Ja.')
    assert.equal(apply('He yelled quote stop! unquote', 'english'), 'He yelled “stop!”')
  })

  it('keeps a semicolon / colon after the closing marker', () => {
    assert.equal(apply('He said quote hello unquote; then left', 'english'),
      'He said “hello”; then left')
  })

  it('keeps a sentence-ending period before the opening marker', () => {
    assert.equal(apply('Er schwieg. Zitat Anfang Nein Zitat Ende', 'german'), 'Er schwieg. „Nein“')
  })
})

describe('applyDictationMarkers: multiple quotes', () => {
  it('converts several quotes in one text', () => {
    assert.equal(
      apply('Anführungszeichen auf ja Anführungszeichen zu und Zitat Anfang nein Zitat Ende', 'german'),
      '„ja“ und „nein“'
    )
    assert.equal(
      apply('He said quote yes unquote and she said open quote no end quote.', 'english'),
      'He said “yes” and she said “no”.'
    )
  })

  it('works across repeated calls (cached global regex has no stale lastIndex)', () => {
    for (let i = 0; i < 3; i++) {
      assert.equal(apply('a quote b unquote c', 'english'), 'a “b” c')
    }
  })
})

describe('applyDictationMarkers: unmatched markers', () => {
  it('converts a lone opening marker', () => {
    assert.equal(apply('nur Zitat Anfang offen', 'german'), 'nur „offen')
  })

  it('converts a lone closing marker', () => {
    assert.equal(apply('zu Zitat Ende', 'german'), 'zu“')
    assert.equal(apply('Zitat Ende am Anfang', 'german'), '“ am Anfang')
  })

  it('a text that is only a marker becomes just the quote character', () => {
    assert.equal(apply('Unquote', 'english'), '”')
    assert.equal(apply('quote', 'english'), '“')
  })
})

describe('applyDictationMarkers: whole-word matching', () => {
  it('ignores marker words that are part of a longer word', () => {
    assert.equal(apply('He quoted me', 'english'), 'He quoted me')
    assert.equal(apply('the quotes are here', 'english'), 'the quotes are here')
    assert.equal(apply('misquote it', 'english'), 'misquote it')
    assert.equal(apply('Das Zitat Anfangs war gut', 'german'), 'Das Zitat Anfangs war gut')
    assert.equal(apply('Zitatanfang', 'german'), 'Zitatanfang')
    assert.equal(apply('les citations', 'french'), 'les citations')
  })
})

describe('applyDictationMarkers: no-op cases', () => {
  it('leaves text without markers unchanged', () => {
    const s = 'Ein ganz normaler Satz, mit Komma. Und noch einer!'
    assert.equal(apply(s, 'german'), s)
    assert.equal(apply(s, 'english'), s)
    assert.equal(apply(s, 'french'), s)
  })

  it('only applies the markers of the selected language', () => {
    const s = 'He said quote hello unquote'
    assert.equal(apply(s, 'german'), s)
    assert.equal(apply('Er sagte Zitat Anfang hallo Zitat Ende', 'english'),
      'Er sagte Zitat Anfang hallo Zitat Ende')
  })

  it('returns the input unchanged for unknown languages', () => {
    const s = 'Zitat Anfang x Zitat Ende quote y unquote'
    assert.equal(apply(s, 'spanish'), s)
    assert.equal(apply(s, ''), s)
    assert.equal(apply(s, /** @type {any} */ (undefined)), s)
  })

  it('does not treat inherited object keys as languages', () => {
    const s = 'Zitat Anfang x Zitat Ende quote y unquote'
    assert.equal(apply(s, 'constructor'), s)
    assert.equal(apply(s, 'toString'), s)
    assert.equal(apply(s, '__proto__'), s)
  })

  it('returns empty / falsy input as-is', () => {
    assert.equal(apply('', 'german'), '')
    assert.equal(apply(/** @type {any} */ (null), 'german'), null)
    assert.equal(apply(/** @type {any} */ (undefined), 'german'), undefined)
  })
})
