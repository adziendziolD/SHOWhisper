// hotkey-worker.js – läuft als eigener Node-Prozess (ELECTRON_RUN_AS_NODE),
// isoliert vom Hauptprozess. Nutzt @mukea/uiohook-napi (aktiv gepflegter
// Fork von SnosMe/uiohook-napi) statt des Originals: Letzteres hat einen
// ungefixten N-API Fatal Error (SnosMe/uiohook-napi#50) und liefert auf
// aktuellem macOS/Electron nach dem ersten Tastendruck gar keine Events
// mehr (CGEventTap wird von macOS deaktiviert und nie wieder aktiviert).
// Isoliert in diesem Worker reißt ein Absturz trotzdem nicht Tray/Overlay/
// das geladene Whisper-Modell im Hauptprozess mit.

function log(...args) {
  try {
    const ts = new Date().toISOString().slice(11, 23)
    console.log(`[${ts}] [hotkey]`, ...args)
  } catch { /* EPIPE ignorieren */ }
}

function logErr(...args) {
  try {
    const ts = new Date().toISOString().slice(11, 23)
    console.error(`[${ts}] [hotkey] ❌`, ...args)
  } catch { /* EPIPE ignorieren */ }
}

const { UiohookKey, uIOhook } = require('@mukea/uiohook-napi')

// Toggle statt Push-to-Talk: ⌥Space startet die Aufnahme, ⌥Space (nochmal
// drücken) stoppt sie wieder. isDown dient nur der Entprellung, damit
// OS-Key-Repeat (mehrere keydown-Events bei gehaltener Taste) nicht mehrfach
// togglet - der eigentliche Toggle passiert ausschließlich bei keydown.
let isDown = false
let isRecording = false

uIOhook.on('keydown', (e) => {
  // ALT + SPACE = uiohook keycode für Space (57) mit alt-flag
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
  // Hauptprozess hat einen start-recording abgelehnt (z.B. Modell lädt noch)
  // - Toggle-Status zurücksetzen, sonst braucht der nächste Tastendruck nur
  // zum Resync (wirkungslos für den Nutzer).
  else if (msg?.type === 'reset') isRecording = false
})

// Falls der Hauptprozess zuerst stirbt: nicht als Zombie weiterlaufen.
// 'disconnect' allein reicht nicht - stirbt der Electron-Hauptprozess abrupt
// (z.B. SIGTERM statt sauberem app.quit()), schließt sich der IPC-Kanal nicht
// zuverlässig, daher zusätzlich Eltern-Prozess aktiv überwachen.
process.on('disconnect', () => shutdown('IPC-Kanal getrennt'))

// process.kill(pid, 0) auf die ursprüngliche PPID ist unzuverlässig: nach
// vielen Neustarts kann diese PID-Nummer vom OS an einen völlig anderen,
// neuen Prozess vergeben worden sein (PID-Reuse) - der Liveness-Check würde
// dann fälschlich "Elternteil lebt noch" melden. process.ppid selbst ändert
// sich beim Reparenting sofort auf 1 (launchd) - das ist der robuste Signal.
const parentPid = process.ppid
setInterval(() => {
  if (process.ppid !== parentPid) {
    shutdown('Eltern-Prozess nicht mehr erreichbar (reparented)')
  }
}, 3000)

function shutdown(reason) {
  logErr(`Beende Worker (${reason})`)
  try { uIOhook.stop() } catch { /* bereits gestoppt */ }
  process.exit(0)
}

// Kurze Verzögerung reduziert das Startup-Race-Risiko, siehe
// SnosMe/uiohook-napi#50. Behebt den Bug nicht, aber die eigentliche
// Absicherung ist jetzt die Prozess-Isolation selbst.
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
