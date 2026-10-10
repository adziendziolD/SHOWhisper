// Type-only declarations for the APIs the preload scripts expose on `window`
// via contextBridge (see src/preload/*.js). No runtime code — this file only
// teaches the type checker about the bridges the sandboxed renderers use.

type Language = 'german' | 'english' | 'french'

/** Progress/status payload pushed from the main process during model loading. */
interface ModelLoadingData {
  status: 'progress' | 'ready' | 'error' | string
  progress?: number
  file?: string
  loaded?: number
  total?: number
  [key: string]: unknown
}

interface WhisperBridge {
  onStartRecording(cb: (id: number) => void): void
  onStopRecording(cb: () => void): void
  onTranscribing(cb: () => void): void
  onSummarizing(cb: () => void): void
  onDone(cb: () => void): void
  onModelLoading(cb: (data: ModelLoadingData) => void): void
  sendChunk(id: number, pcm: Float32Array, final: boolean): void
  onLiveText(cb: (text: string) => void): void
  recordingFailed(id: number, message: string): void
  overlayReady(): void
  getLanguage(): Promise<Language>
  onLanguageChanged(cb: (lang: Language) => void): void
}

interface I18nBridge {
  t(lang: Language, key: string, vars?: Record<string, string | number>): string
}

interface Window {
  whisper: WhisperBridge
  i18n: I18nBridge
}

/** Pure audio helpers from src/shared/audio.js, loaded as a classic <script>
 *  before overlay-renderer.js (sets globalThis.ShowAudio in the browser). */
declare var ShowAudio: typeof import('../shared/audio.js')
