// Typed contracts for the messages exchanged with the hotkey worker child
// process (see src/main/hotkey-worker.js and spawnHotkeyWorker in main.js).
// Type-only — no runtime code, no build step.

/** Messages the worker sends up to the main process. */
type HotkeyWorkerMessage =
  | { type: 'started' }
  | { type: 'start-recording' }
  | { type: 'stop-recording' }
  | { type: 'log'; level: 'info' | 'error'; msg: string }
  | { type: 'error'; message: string }

/** Commands the main process sends down to the worker. */
type HotkeyWorkerCommand =
  | { type: 'shutdown' }
  | { type: 'reset' }
