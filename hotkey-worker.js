// hotkey-worker.js – runs as its own Node process (ELECTRON_RUN_AS_NODE),
// isolated from the main process. Uses @mukea/uiohook-napi (an actively
// maintained fork of SnosMe/uiohook-napi) instead of the original: the latter
// has an unfixed N-API fatal error (SnosMe/uiohook-napi#50) and, on current
// macOS/Electron, stops delivering any events after the first keypress
// (macOS disables the CGEventTap and never re-enables it). Isolated in this
// worker, a crash still doesn't take the tray/overlay/the loaded Whisper
// model in the main process down with it.

function log(...args) {
  try {
    const ts = new Date().toISOString().slice(11, 23)
    console.log(`[${ts}] [hotkey]`, ...args)
  } catch { /* ignore EPIPE */ }
}

function logErr(...args) {
  try {
    const ts = new Date().toISOString().slice(11, 23)
    console.error(`[${ts}] [hotkey] ❌`, ...args)
  } catch { /* ignore EPIPE */ }
}

const { UiohookKey, uIOhook } = require('@mukea/uiohook-napi')

// Toggle instead of push-to-talk: ⌥Space starts recording, ⌥Space (pressed
// again) stops it. isDown is only for debouncing, so OS key-repeat (multiple
// keydown events while the key is held) doesn't toggle repeatedly - the actual
// toggle happens exclusively on keydown.
let isDown = false
let isRecording = false

uIOhook.on('keydown', (e) => {
  // ALT + SPACE = uiohook keycode for Space (57) with alt flag
  if (e.keycode === UiohookKey.Space && e.altKey && !isDown) {
    isDown = true
    isRecording = !isRecording
    process.send({ type: isRecording ? 'start-recording' : 'stop-recording' })
  }
})

uIOhook.on('keyup', (e) => {
  if (e.keycode === UiohookKey.Space) {
    isDown = false
  }
})

process.on('message', (msg) => {
  if (msg?.type === 'shutdown') shutdown('Shutdown angefordert')
  // main process rejected a start-recording (e.g. model still loading)
  // - reset the toggle state, otherwise the next keypress is only spent
  // resyncing (no effect for the user).
  else if (msg?.type === 'reset') isRecording = false
})

// If the main process dies first: don't keep running as a zombie.
// 'disconnect' alone isn't enough - if the Electron main process dies abruptly
// (e.g. SIGTERM instead of a clean app.quit()), the IPC channel doesn't close
// reliably, so additionally watch the parent process actively.
process.on('disconnect', () => shutdown('IPC-Kanal getrennt'))

// process.kill(pid, 0) on the original PPID is unreliable: after many restarts
// the OS may have reassigned that PID number to a completely different, new
// process (PID reuse) - the liveness check would then falsely report "parent
// still alive". process.ppid itself changes to 1 (launchd) immediately on
// reparenting - that's the robust signal.
const parentPid = process.ppid
setInterval(() => {
  if (process.ppid !== parentPid) {
    shutdown('Eltern-Prozess nicht mehr erreichbar (reparented)')
  }
}, 3000)

function shutdown(reason) {
  logErr(`Beende Worker (${reason})`)
  try { uIOhook.stop() } catch { /* already stopped */ }
  process.exit(0)
}

// A short delay reduces the startup-race risk, see SnosMe/uiohook-napi#50.
// It doesn't fix the bug, but the actual safeguard is now the process
// isolation itself.
setTimeout(() => {
  try {
    uIOhook.start()
    log('uIOhook gestartet')
    process.send({ type: 'started' })
  } catch (err) {
    logErr('Start fehlgeschlagen:', err.message)
    process.send({ type: 'error', message: err.message })
  }
}, 300)
