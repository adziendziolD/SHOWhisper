// Summarization prompt building + output cleanup for the local LLM (see
// loadLlm()/summarize() in main.js). Kept as a pure CommonJS module - no native
// deps, no I/O - so the language logic stays testable and mirrors the shape of
// dictation.js. The actual inference (node-llama-cpp) lives in the main process.
//
// Language keys match the store values 'german' / 'english' / 'french'
// (see i18n.js). The summary is produced in the same language the user dictated.

// Per-language system prompt. The model is told to (a) answer only with the
// summary - no preamble like "Here is the summary:" - and (b) stay in the
// dictation language. cleanSummary() below strips such labels defensively in
// case the model adds them anyway.
const SYSTEM_PROMPTS = {
  german:
    'Du bist ein Assistent, der gesprochene Diktate zusammenfasst. Fasse den ' +
    'folgenden Text prägnant in wenigen Sätzen auf Deutsch zusammen. Gib ' +
    'ausschließlich die Zusammenfassung aus, ohne Einleitung, Anrede oder ' +
    'zusätzliche Erklärungen.',
  english:
    'You are an assistant that summarizes spoken dictations. Summarize the ' +
    'following text concisely in a few sentences in English. Output only the ' +
    'summary, with no preamble, salutation or extra explanation.',
  french:
    'Tu es un assistant qui résume des dictées orales. Résume le texte suivant ' +
    'de manière concise en quelques phrases en français. Ne produis que le ' +
    'résumé, sans introduction, formule d\'appel ni explication supplémentaire.',
}

// Labels the model sometimes prepends despite the instruction above; stripped
// case-insensitively from the very start of the output.
const LEADING_LABELS = /^(zusammenfassung|summary|résumé|resume)\s*[:\-–—]\s*/i

/**
 * System prompt for the given language, falling back to German.
 * @param {string} language  one of 'german' | 'english' | 'french'
 * @returns {string}
 */
function buildSystemPrompt(language) {
  return SYSTEM_PROMPTS[language] || SYSTEM_PROMPTS.german
}

/**
 * Tidy the raw model output: trim, drop a leading "Summary:"-style label, and
 * unwrap a fully quote-wrapped response. Total function, never throws.
 * @param {string} text
 * @returns {string}
 */
function cleanSummary(text) {
  if (!text) return ''
  let s = String(text).trim()
  s = s.replace(LEADING_LABELS, '').trim()
  // Unwrap if the whole thing is wrapped in matching quotes (straight or typographic).
  const m = s.match(/^["“„«]([\s\S]+)["”“»]$/)
  if (m) s = m[1].trim()
  return s
}

module.exports = { buildSystemPrompt, cleanSummary, SYSTEM_PROMPTS }
