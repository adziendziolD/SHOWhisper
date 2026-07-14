// Post-processing of Whisper transcripts: turn spoken quote markers into proper
// typographic quotation marks. Whisper can't reliably infer direct speech from
// audio, so the user delimits it by speaking marker phrases (e.g. German
// "Zitat Anfang … Zitat Ende"), and this module rewrites them deterministically.
//
// Runs in the main process only (see transcribe() in main.js) - plain CommonJS,
// pure string work, no external calls. Language keys match the store values
// 'german' / 'english' / 'french' (see i18n.js).

// Opening/closing quote characters per language (Unicode escapes so the source
// stays unambiguous). French guillemets carry a no-break space (U+00A0) baked
// into the constant, so the space is guaranteed to sit inside the guillemets
// regardless of the surrounding whitespace cleanup.
const QUOTES = {
  german:  { open: '„', close: '“' },          // „ …  “
  english: { open: '“', close: '”' },          // “ …  ”
  french:  { open: '« ', close: ' »' }, // «␣ … ␣»
}

// Spoken marker phrases per language. Matched case-insensitively; internal
// spaces tolerate stray commas/whitespace that Whisper injects (see below).
// The bare single-word openers ('quote', 'citation') carry the highest
// false-positive risk - drop just those array entries to disable them, no code
// change needed.
const MARKERS = {
  german: {
    open:  ['Zitat Anfang', 'Anführungszeichen auf'],
    close: ['Zitat Ende', 'Anführungszeichen zu'],
  },
  english: {
    open:  ['open quote', 'begin quote', 'quote'],
    close: ['close quote', 'end quote', 'unquote'],
  },
  french: {
    open:  ['ouvrez les guillemets', 'ouvrir les guillemets', 'citation'],
    close: ['fermez les guillemets', 'fermer les guillemets', 'fin de citation'],
  },
}

// Escape regex metacharacters in a literal phrase.
function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// Turn a phrase into a regex source: escape it, then let each internal space
// also absorb commas/extra whitespace (Whisper often writes "Zitat, Anfang").
function phraseToSource(phrase) {
  return escapeRegex(phrase).replace(/\s+/g, '[\\s,]+')
}

// Build (once per language) the combined matcher:
//   (lead)(?:(openAlt)|(closeAlt))(trail)
// lead/trail capture spaces and commas hugging the marker - but NOT . ? !, so
// real sentence punctuation is preserved. Phrases are sorted longest-first so a
// longer phrase can't be shadowed by a shorter prefix.
const regexCache = {}
function getRegex(language) {
  if (language in regexCache) return regexCache[language]
  const markers = MARKERS[language]
  if (!markers) { regexCache[language] = null; return null }

  const byLengthDesc = (a, b) => b.length - a.length
  const openAlt  = [...markers.open].sort(byLengthDesc).map(phraseToSource).join('|')
  const closeAlt = [...markers.close].sort(byLengthDesc).map(phraseToSource).join('|')

  const re = new RegExp(`([\\s,]*)(?:(${openAlt})|(${closeAlt}))([\\s,]*)`, 'giu')
  regexCache[language] = re
  return re
}

/**
 * Replace spoken quote markers in a transcript with typographic quotes.
 * Total function: never throws, degrades gracefully on unmatched/odd markers,
 * and returns the input unchanged for unknown languages or empty text.
 * @param {string} text
 * @param {string} language  one of 'german' | 'english' | 'french'
 * @returns {string}
 */
function applyDictationMarkers(text, language) {
  if (!text) return text
  const quotes = QUOTES[language]
  const regex = getRegex(language)
  if (!quotes || !regex) return text

  try {
    // lastIndex reset: the cached regex is global, so a prior partial run must
    // not leave a stale cursor. String.replace resets it, but be explicit.
    regex.lastIndex = 0
    return text.replace(regex, (match, lead, openHit, _closeHit, trail, offset, whole) => {
      const atStart = offset === 0
      const atEnd = offset + match.length === whole.length
      if (openHit) {
        // Opening quote hugs the following word; restore a single leading space
        // only if something separated it from the previous word.
        return (lead && !atStart ? ' ' : '') + quotes.open
      }
      // Closing quote hugs the preceding word; restore a single trailing space
      // only if the marker wasn't at the very end.
      return quotes.close + (trail && !atEnd ? ' ' : '')
    })
  } catch {
    // A post-processing bug must never lose a transcript.
    return text
  }
}

module.exports = { applyDictationMarkers, QUOTES, MARKERS }
