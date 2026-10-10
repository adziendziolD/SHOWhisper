// Transcription languages offered in the settings: Whisper language name (the
// store value) -> ISO 639-1 code (what Whisper's language token uses, and what
// the settings window feeds to Intl.DisplayNames for a localized label).
// 'auto' = detect the language once per dictation / file (see whisper-worker).
const TRANSCRIPTION_LANGUAGES = {
  german: 'de', english: 'en', french: 'fr', spanish: 'es', italian: 'it',
  portuguese: 'pt', dutch: 'nl', polish: 'pl', czech: 'cs', swedish: 'sv',
  danish: 'da', norwegian: 'no', finnish: 'fi', greek: 'el', hungarian: 'hu',
  romanian: 'ro', turkish: 'tr', russian: 'ru', ukrainian: 'uk', arabic: 'ar',
  hebrew: 'he', hindi: 'hi', japanese: 'ja', korean: 'ko', chinese: 'zh',
}

// Languages the app UI itself is translated into (see i18n.js).
const UI_LANGUAGES = ['german', 'english', 'french']

/** @param {unknown} lang */
function isTranscriptionLanguage(lang) {
  return lang === 'auto' || (typeof lang === 'string' && Object.prototype.hasOwnProperty.call(TRANSCRIPTION_LANGUAGES, lang))
}

/**
 * Whisper language name for an ISO code (e.g. from language detection), or
 * null if it isn't one of the offered languages.
 * @param {string} code
 * @returns {string | null}
 */
function languageFromCode(code) {
  for (const [name, c] of Object.entries(TRANSCRIPTION_LANGUAGES)) if (c === code) return name
  return null
}

/**
 * Default transcription + UI language for a fresh install, from the OS locale
 * (e.g. 'de-DE'): its language if offered, otherwise auto-detect / English UI.
 * @param {string} locale
 */
function defaultsForLocale(locale) {
  const code = String(locale || '').slice(0, 2).toLowerCase()
  const lang = languageFromCode(code)
  return {
    language: lang || 'auto',
    uiLanguage: lang && UI_LANGUAGES.includes(lang) ? lang : 'english',
  }
}

module.exports = { TRANSCRIPTION_LANGUAGES, UI_LANGUAGES, isTranscriptionLanguage, languageFromCode, defaultsForLocale }
