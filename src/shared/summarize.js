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

// What the AI hotkey (⌥⇧Space by default) does with a dictation. 'summarize'
// keeps the native-language prompts above; the other modes use an English
// instruction plus an explicit output language - small instruct models follow
// English instructions most reliably.
const AI_MODES = ['summarize', 'cleanup', 'email', 'bullets', 'translate-en']

const MODE_INSTRUCTIONS = {
  summarize:
    'You are an assistant that summarizes spoken dictations. Summarize the following text concisely in a few sentences.',
  cleanup:
    'You are an editor for spoken dictations. Clean up the following text: fix grammar, spelling and punctuation, ' +
    'remove filler words, false starts and repetitions. Keep the meaning, tone and wording as close to the original ' +
    'as possible and do not add any content.',
  email:
    'You turn spoken dictations into e-mails. Rewrite the following text as a clear, polite, ready-to-send e-mail ' +
    'with greeting, body and closing. Do not invent facts, names or dates that are not in the text; use ' +
    'placeholders like [Name] where something is missing.',
  bullets:
    'You turn spoken dictations into notes. Rewrite the following text as concise bullet points, one idea per line, ' +
    'each line starting with "- ".',
  'translate-en':
    'You are a translator. Translate the following dictated text into natural, fluent English.',
}

const OUTPUT_RULE = 'Output only the result, with no preamble, explanation or surrounding quotes.'

// English names for the output-language clause (store keys are Whisper names).
function languageName(language) {
  return language ? language.charAt(0).toUpperCase() + language.slice(1) : ''
}

/**
 * System prompt for the given dictation language and AI mode. Summaries in
 * German/English/French use the native prompts (SYSTEM_PROMPTS); every other
 * language - or 'auto' - gets an English instruction to answer in the
 * language of the text.
 * @param {string} language  Whisper language name ('german', ...) or 'auto'
 * @param {string} [mode]    one of AI_MODES, default 'summarize'
 * @returns {string}
 */
function buildSystemPrompt(language, mode = 'summarize') {
  const m = AI_MODES.includes(mode) ? mode : 'summarize'
  if (m === 'summarize' && Object.prototype.hasOwnProperty.call(SYSTEM_PROMPTS, language)) {
    return SYSTEM_PROMPTS[language]
  }
  let langRule = ''
  if (m !== 'translate-en') {
    langRule = language && language !== 'auto'
      ? `Respond in ${languageName(language)}.`
      : 'Respond in the same language as the text.'
  }
  return [MODE_INSTRUCTIONS[m], langRule, OUTPUT_RULE].filter(Boolean).join(' ')
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

module.exports = { buildSystemPrompt, cleanSummary, SYSTEM_PROMPTS, AI_MODES }
