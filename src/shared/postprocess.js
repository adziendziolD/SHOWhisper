// Text post-processing for dictations, applied once to the full transcript
// (after the quote markers, see dictation.js): spoken layout commands and the
// user's own replacement list. Pure CommonJS - no I/O - so it's unit-testable.
//
// Language keys are the Whisper language names used in the store ('german',
// 'english', ...). 'auto' (language detection) applies the commands of every
// language that has some.

const { applyDictationMarkers, MARKERS } = require('./dictation')

/**
 * Quote markers (dictation.js) for a known language; with 'auto' (or a
 * detected language without markers of its own) every marker set is tried.
 * @param {string} text
 * @param {string | null | undefined} language
 * @returns {string}
 */
function applyMarkersFor(text, language) {
  if (language && Object.prototype.hasOwnProperty.call(MARKERS, language)) return applyDictationMarkers(text, language)
  if (language && language !== 'auto') return text
  return Object.keys(MARKERS).reduce((t, lang) => applyDictationMarkers(t, lang), text)
}

/**
 * The full post-processing of a finished dictation: quote markers → spoken
 * layout commands → the user's replacements (last, so they can fix anything).
 * @param {string} text
 * @param {{ language: string, voiceCommands?: boolean, replacements?: Replacement[] | null }} opts
 * @returns {string}
 */
function postprocessDictation(text, { language, voiceCommands = true, replacements = null }) {
  let out = applyMarkersFor(text, language)
  if (voiceCommands) out = applyVoiceCommands(out, language)
  return applyReplacements(out, replacements)
}

// Spoken layout commands per language. Whisper usually wraps them in
// punctuation ("Hallo, neue Zeile, wie geht's"), so a comma right before and
// any punctuation right after the phrase are swallowed with it.
const VOICE_COMMANDS = {
  german: [
    { phrases: ['neuer absatz'], insert: '\n\n' },
    { phrases: ['neue zeile'], insert: '\n' },
  ],
  english: [
    { phrases: ['new paragraph'], insert: '\n\n' },
    { phrases: ['new line', 'newline'], insert: '\n' },
  ],
  french: [
    { phrases: ['nouveau paragraphe'], insert: '\n\n' },
    { phrases: ['nouvelle ligne', 'à la ligne'], insert: '\n' },
  ],
}

// Letters/digits in any script - "word boundary" for non-ASCII text too
// (JS \b only knows [A-Za-z0-9_], so "Größe" would split at "ö").
const NOT_WORD_BEFORE = '(?<![\\p{L}\\p{N}])'
const NOT_WORD_AFTER = '(?![\\p{L}\\p{N}])'

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// Whitespace inside a phrase matches any run of whitespace in the transcript.
function phrasePattern(phrase) {
  return phrase.trim().split(/\s+/).map(escapeRegExp).join('\\s+')
}

/**
 * Replace spoken layout commands ("neue Zeile", "new paragraph", ...) with
 * line breaks.
 * @param {string} text
 * @param {string} language  Whisper language name or 'auto'
 * @returns {string}
 */
function applyVoiceCommands(text, language) {
  const sets = language === 'auto' ? Object.values(VOICE_COMMANDS) : [VOICE_COMMANDS[language] || []]
  let out = text
  for (const commands of sets) {
    // Longer phrases first within a language ("neuer Absatz" before "neue Zeile"
    // doesn't overlap, but keep the order stable and explicit).
    for (const { phrases, insert } of commands) {
      const alt = phrases.map(phrasePattern).join('|')
      const re = new RegExp(`[ \\t]*,?[ \\t]*${NOT_WORD_BEFORE}(?:${alt})${NOT_WORD_AFTER}[,.;:!?]?[ \\t]*`, 'giu')
      out = out.replace(re, insert)
    }
  }
  // A command at the very start/end shouldn't leave stray breaks behind, and
  // the word after a break starts a new line - capitalize it like Whisper would.
  return out
    .replace(/^\n+|\n+$/g, '')
    .replace(/\n(\p{Ll})/gu, (_m, c) => `\n${c.toUpperCase()}`)
}

/**
 * @typedef {{ from: string, to: string }} Replacement
 */

/**
 * Apply the user's replacement list (custom vocabulary: names, product terms,
 * recurring misrecognitions). Matches whole words/phrases, case-insensitively;
 * the replacement is inserted literally.
 * @param {string} text
 * @param {Replacement[] | undefined | null} replacements
 * @returns {string}
 */
function applyReplacements(text, replacements) {
  if (!Array.isArray(replacements)) return text
  let out = text
  for (const r of replacements) {
    if (!r || typeof r.from !== 'string' || typeof r.to !== 'string' || !r.from.trim()) continue
    const re = new RegExp(`${NOT_WORD_BEFORE}${phrasePattern(r.from)}${NOT_WORD_AFTER}`, 'giu')
    out = out.replace(re, () => r.to)
  }
  return out
}

/**
 * Parse the settings textarea format - one rule per line, `from => to` (also
 * accepts `->` and `=`) - into a replacement list. Blank lines and lines
 * starting with # are ignored.
 * @param {string} src
 * @returns {Replacement[]}
 */
function parseReplacements(src) {
  /** @type {Replacement[]} */
  const list = []
  for (const line of String(src || '').split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const m = trimmed.match(/^(.+?)\s*(?:=>|->|=)\s*(.*)$/)
    if (!m || !m[1].trim()) continue
    list.push({ from: m[1].trim(), to: m[2].trim() })
  }
  return list
}

/**
 * Inverse of parseReplacements, for showing the list in the settings textarea.
 * @param {Replacement[]} list
 * @returns {string}
 */
function formatReplacements(list) {
  return (Array.isArray(list) ? list : []).map((r) => `${r.from} => ${r.to}`).join('\n')
}

module.exports = {
  postprocessDictation, applyMarkersFor, applyVoiceCommands, applyReplacements,
  parseReplacements, formatReplacements, VOICE_COMMANDS,
}
