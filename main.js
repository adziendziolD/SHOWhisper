const { app, BrowserWindow, Tray, Menu, ipcMain, clipboard, screen, systemPreferences, dialog, shell, safeStorage } = require('electron')
const path = require('path')
const fs = require('fs')
const { fork } = require('child_process')

const isDev = process.env.NODE_ENV === 'development'

// EPIPE (z.B. wenn Terminal geschlossen wird) nicht crashen lassen
process.stdout.on('error', (e) => { if (e.code !== 'EPIPE') throw e })
process.stderr.on('error', (e) => { if (e.code !== 'EPIPE') throw e })

function log(...args) {
  try {
    const ts = new Date().toISOString().slice(11, 23)
    console.log(`[${ts}]`, ...args)
  } catch { /* EPIPE ignorieren */ }
}

function logErr(...args) {
  try {
    const ts = new Date().toISOString().slice(11, 23)
    console.error(`[${ts}] ❌`, ...args)
  } catch { /* EPIPE ignorieren */ }
}

// electron-store ist ab v9 ESM-only, main.js ist CommonJS -> dynamisch
// importieren, sobald die App bereit ist (siehe app.whenReady())
let store = null

let tray = null
let overlayWindow = null
let settingsWindow = null
let whisperPipeline = null
let isLoadingModel = false
let loadGeneration = 0         // verhindert, dass ein überholter Ladevorgang State überschreibt
let hotkeyWorker = null        // aktueller Child-Process (siehe hotkey-worker.js)
let hotkeyHolding = false      // Crash-Recovery: läuft gerade eine Aufnahme?
let hotkeyRespawnCount = 0
let hotkeyStableTimer = null
let hotkeyDisabled = false     // Circuit-Breaker ausgelöst -> kein weiterer Respawn
let isQuitting = false
// Xenova-Modellnamen (public, kein HF-Token nötig)
const MODELS = ['tiny', 'base', 'small', 'medium', 'large']
const MODEL_LABELS = { tiny: 'tiny (75 MB)', base: 'base (150 MB)', small: 'small (450 MB)', medium: 'medium (1.5 GB)', large: 'large (3 GB)' }
// onnx-community hostet nur tiny/base/small - medium/large existieren dort
// nicht (404 beim Download). Xenova hat alle 5 Größen.
const PROVIDER_MODELS = {
  Xenova: MODELS,
  'onnx-community': ['tiny', 'base', 'small'],
}

// ── Overlay Window ────────────────────────────────────────────────────────────

function createOverlay() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize
  const savedPos = store.get('overlayPosition', {
    x: Math.round(width / 2 - 175),
    y: height - 120,
  })

  overlayWindow = new BrowserWindow({
    x: savedPos.x,
    y: savedPos.y,
    width: 350,
    height: 72,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    hasShadow: false,
    skipTaskbar: true,
    resizable: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
    },
  })

  overlayWindow.loadFile('overlay.html')

  if (isDev) {
    overlayWindow.webContents.openDevTools({ mode: 'detach' })
    log('Overlay DevTools geöffnet')
  }

  overlayWindow.on('moved', () => {
    const [x, y] = overlayWindow.getPosition()
    store.set('overlayPosition', { x, y })
  })
}

// ── Whisper ───────────────────────────────────────────────────────────────────

// Cache im Home-Verzeichnis, nicht in node_modules
const MODEL_CACHE_DIR = path.join(app.getPath('userData'), 'model-cache')

function sendToSettings(data) {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.webContents.send('model-progress', data)
  }
}

// Ladefortschritt ist sonst nur im Tray-Tooltip (leicht übersehen) oder im
// Settings-Fenster (nur sichtbar wenn offen) zu sehen - zusätzlich im
// Overlay-Pill zeigen, das immer verfügbar ist, unabhängig davon wodurch
// der Download ausgelöst wurde (Start, Tray-Menü, Settings).
let lastModelProgress = null
function sendModelProgress(data) {
  lastModelProgress = data
  sendToSettings(data)
  overlayWindow?.webContents.send('model-loading', data)
}

// Overlay lädt in einem eigenen Renderer-Prozess und ist beim App-Start
// evtl. noch nicht fertig geladen, wenn die ersten Fortschritts-Events
// feuern - die gingen dann ersatzlos verloren (Electron puffert nicht).
// Renderer meldet sich hier, sobald er wirklich zuhört, und bekommt den
// zu dem Zeitpunkt aktuellen Stand nachgereicht.
ipcMain.on('overlay-ready', () => {
  if (lastModelProgress) overlayWindow?.webContents.send('model-loading', lastModelProgress)
})

async function loadModel(modelName, force = false) {
  if (isLoadingModel && !force) {
    log('loadModel: bereits am Laden, übersprungen')
    return
  }
  // Jeder Aufruf bekommt eine eigene Generation. Startet ein force-Reload
  // (z.B. Provider-Wechsel) während noch ein Ladevorgang läuft, erkennt der
  // ältere nach seinem await, dass er überholt wurde, und verwirft sein
  // Ergebnis, statt frisch geladenen State zu überschreiben.
  const myGen = ++loadGeneration
  isLoadingModel = true
  updateTrayLabel(`Lade ${modelName}…`)
  overlayWindow?.showInactive()

  try {
    const { pipeline, env } = await import('@huggingface/transformers')

    env.cacheDir = MODEL_CACHE_DIR
    const hfToken = getHfToken()
    if (hfToken) {
      // ab transformers.js v4 kein env.authToken mehr, stattdessen eigener
      // fetch-Wrapper der den Authorization-Header setzt
      env.fetch = (url, options) => fetch(url, {
        ...options,
        headers: { ...options?.headers, Authorization: `Bearer ${hfToken}` },
      })
      log('HF-Token gesetzt')
    }

    const provider = store.get('provider', 'Xenova')
    const modelId  = `${provider}/whisper-${modelName}`
    log(`Lade Modell: ${modelId}`)
    log(`Cache-Dir:   ${MODEL_CACHE_DIR}`)

    // Logging drosseln: pro Datei nur bei ganzen 10%-Schritten
    const lastLoggedPct = {}
    // Mehrere .onnx-Teile (encoder/decoder) laden parallel - würde man pro
    // Datei einzeln an die UI weiterreichen, springt der Balken zwischen
    // unterschiedlichen Datei-Prozentwerten hin und her. Stattdessen über
    // Bytes aller Dateien aggregieren -> ein einziger, ruhiger Gesamtwert.
    const fileBytes = {}
    let lastSentPct = -1
    const progress_callback = (data) => {
      if (data.status === 'progress') {
        const pct  = Math.round(data.progress)
        const file = (data.file || '').split('/').pop()
        const step = Math.floor(pct / 10) * 10
        if (lastLoggedPct[file] !== step) {
          lastLoggedPct[file] = step
          log(`Download [${file}] ${step}%`)
        }

        // Tokenizer/Config-Dateien (auch tokenizer.json, das je nach Modell
        // mehrere MB groß sein kann) laden komplett durch, bevor die
        // eigentlichen Modell-Gewichte (die Minuten dauern können) überhaupt
        // anfangen. Ein Größen-Schwellwert reicht nicht, da tokenizer.json
        // teils größer als die Gewichte eines "tiny"-Modells ist. Deshalb nur
        // Dateien zählen, die ".onnx" im Namen enthalten - das deckt sowohl
        // "encoder_model.onnx" als auch die bei größeren Modellen ausgelagerte
        // "encoder_model.onnx_data" ab (ONNX external data, ab ~2GB Protobuf-
        // Limit nötig; "endsWith('.onnx')" matcht die _data-Variante nicht).
        //
        // Aber selbst innerhalb der .onnx-Dateien gibt es das gleiche Problem
        // nochmal: die kleine "*.onnx"-Graphdatei (ein paar KB-MB) lädt oft in
        // einem einzigen Event sofort komplett, BEVOR die riesige zugehörige
        // "*.onnx_data"-Gewichtsdatei überhaupt anfängt - und friert die
        // Monoton-Sperre unten fälschlich bei 100% ein. Deshalb zusätzlich:
        // nur Dateien zählen, die wir schon mit <100% gesehen haben oder die
        // wir schon verfolgen (schließt sofort-komplette Dateien beim ersten
        // Auftreten aus, ohne spätere Updates einer bereits laufenden Datei
        // zu verpassen).
        if (file.includes('.onnx') && (pct < 100 || fileBytes[file] !== undefined)) {
          fileBytes[file] = { loaded: data.loaded || 0, total: data.total || 0 }
        }
        const totals = Object.values(fileBytes).reduce(
          (acc, f) => ({ loaded: acc.loaded + f.loaded, total: acc.total + f.total }),
          { loaded: 0, total: 0 }
        )
        // totals.total === 0 heißt: noch keine .onnx-Datei gesehen, nur
        // Metadaten - dann noch keinen Fortschritt zeigen.
        if (totals.total === 0) return
        const rawPct = Math.round((totals.loaded / totals.total) * 100)
        // Sobald eine weitere (große) Datei zu laden beginnt, fließt ihre
        // Gesamtgröße sofort in den Nenner ein, während ihr geladener Anteil
        // noch bei 0 liegt -> der Gesamtwert kann kurz zurückspringen. Nie
        // rückwärts anzeigen, das sähe wie ein Fehler aus.
        const overallPct = Math.max(rawPct, lastSentPct)
        updateTrayLabel(`${modelName} ${overallPct}%`)

        // Nur bei tatsächlicher Prozent-Änderung senden, sonst flackert die UI
        if (overallPct !== lastSentPct) {
          lastSentPct = overallPct
          sendModelProgress({ status: 'progress', progress: overallPct })
        }
      } else if (data.status === 'done') {
        log(`Modell-Status: done`, data.file || '')
      }
    }

    // Geräte-/dtype-Historie (siehe PLAN.md-Vorgeschichte):
    // - CoreML + fp32 + Standard-Speicher-Allokator: hängt/stürzt bei der
    //   Inferenz mit echter Sprache und größeren Modellen (medium/large).
    // - CPU + fp32 + Standard-Allokator: gleiches Bild - onnxruntimes
    //   BFCArena-Speicherpool-Allokator crasht (posix_memalign) beim
    //   Extend, reproduzierbar mit echten Audiodaten, aber NUR im echten
    //   Electron-Prozess (deutlich höherer Speicher-Fußabdruck durch
    //   GPU-Prozess/Compositor) - nie in einem isolierten Node-Skript.
    // - fp16 (CoreML und CPU gleichermaßen): scheitert schon beim Laden
    //   mit einem ONNX-Graph-Fehler (LayerNorm-Fusion/
    //   InsertedPrecisionFreeCast) - die fp16-Datei selbst ist mit dieser
    //   onnxruntime-Version inkompatibel, unabhängig vom Gerät.
    // - `session_options: { enableCpuMemArena: false }` deaktiviert den
    //   fehlerhaften Pool-Allokator (normales malloc/free statt Pooling) -
    //   behebt den Crash vollständig. Damit läuft CoreML + fp32 (beste
    //   Qualität + Apple-Silicon-GPU/Neural-Engine) zuverlässig - mit
    //   denselben echten Audiodaten 3x hintereinander verifiziert.
    //   CoreML + q8 stürzt weiterhin (Quantisierung + CoreML verträgt sich
    //   nicht), daher fp32 statt q8 für den CoreML-Pfad.
    const preferredDevice = process.platform === 'darwin' ? 'coreml' : 'cpu'
    let pipe
    try {
      pipe = await pipeline(
        'automatic-speech-recognition',
        modelId,
        { device: preferredDevice, dtype: 'fp32', session_options: { enableCpuMemArena: false }, progress_callback }
      )
    } catch (deviceErr) {
      if (preferredDevice === 'cpu') throw deviceErr
      logErr(`Gerät '${preferredDevice}' fehlgeschlagen, Fallback auf CPU:`, deviceErr.message)
      pipe = await pipeline(
        'automatic-speech-recognition',
        modelId,
        { device: 'cpu', dtype: 'q8', session_options: { enableCpuMemArena: false }, progress_callback }
      )
    }
    // Zwischenzeitlich durch einen neueren Ladevorgang überholt? Dann Ergebnis
    // verwerfen, damit wir nicht das gerade frisch geladene Modell überschreiben.
    if (myGen !== loadGeneration) {
      log(`loadModel: ${modelId} wurde überholt, Ergebnis verworfen`)
      return
    }
    whisperPipeline = pipe
    log(`Modell bereit: ${modelId}`)
    store.set('model', modelName)
    updateTrayLabel(null)
    buildTrayMenu()
    sendModelProgress({ status: 'ready' })
    setTimeout(() => overlayWindow?.hide(), 500)
  } catch (err) {
    // Überholter Ladevorgang: Fehler gehört nicht mehr zum aktiven Modell,
    // still verwerfen (der neuere Ladevorgang besitzt den State jetzt).
    if (myGen !== loadGeneration) {
      log(`loadModel: überholter Ladevorgang mit Fehler verworfen (${err.message})`)
      return
    }
    logErr('Model load error:', err.message)
    updateTrayLabel('Fehler beim Laden')

    // Korrupten Cache löschen damit beim nächsten Versuch frisch geladen wird
    const provider    = store.get('provider', 'Xenova')
    const corruptPath = path.join(MODEL_CACHE_DIR, provider, `whisper-${modelName}`)
    if (fs.existsSync(corruptPath)) {
      fs.rmSync(corruptPath, { recursive: true, force: true })
      log('Korrupter Cache gelöscht:', corruptPath)
    }

    sendModelProgress({ status: 'error', message: err.message })
    overlayWindow?.hide()

    // Tray-Tooltip allein wird leicht übersehen (z.B. bei Auswahl über das
    // Tray-Menü statt über die Settings) - Dialog nur zeigen, wenn die
    // Settings gerade NICHT offen sind (die zeigen den Fehler schon selbst).
    if (!settingsWindow || settingsWindow.isDestroyed()) {
      dialog.showErrorBox(
        'Modell konnte nicht geladen werden',
        `${provider}/whisper-${modelName} konnte nicht geladen werden:\n${err.message}`
      )
    }
  } finally {
    // Nur zurücksetzen, wenn kein neuerer Ladevorgang die Führung übernommen
    // hat - sonst würde ein überholter Alt-Lauf das Flag des aktiven löschen.
    if (myGen === loadGeneration) isLoadingModel = false
  }
}

async function transcribe(pcm) {
  if (!whisperPipeline) return ''

  const genOptions = {
    language: 'german',
    task: 'transcribe',
    // Whisper verarbeitet intern nur ein festes 30s-Fenster - ohne Chunking
    // wird alles danach stillschweigend abgeschnitten. chunk_length_s aktiviert
    // Long-Form-Transkription (überlappende 30s-Fenster werden zusammengefügt).
    chunk_length_s: 30,
    stride_length_s: 5,
    // max_new_tokens als Sicherheitsnetz gegen Wiederholungsschleifen, ein
    // bekanntes Whisper-Fehlerbild bei Stille/Rauschen/unklarer Sprache.
    max_new_tokens: 440,
  }

  // Verbose Diagnostik (PCM-Eckdaten + Live-Token-Streamer) nur im Dev-Modus:
  // im Produktivbetrieb ist das reine Log-Flut und würde u.a. den erkannten
  // Text tokenweise mitschreiben (Datenschutz bei einer Diktat-App).
  if (isDev) {
    let min = Infinity, max = -Infinity, sumAbs = 0
    for (let i = 0; i < pcm.length; i++) {
      const v = pcm[i]
      if (v < min) min = v
      if (v > max) max = v
      sumAbs += Math.abs(v)
    }
    log(`transcribe(): ${pcm.length} samples (${(pcm.length / 16000).toFixed(1)}s), ` +
        `min=${min.toFixed(3)} max=${max.toFixed(3)} avgAbs=${(sumAbs / pcm.length).toFixed(4)}`)

    const { WhisperTextStreamer } = await import('@huggingface/transformers')
    const tStart = Date.now()
    let lastTokenAt = tStart
    let tokenCount = 0
    genOptions.streamer = new WhisperTextStreamer(whisperPipeline.tokenizer, {
      on_chunk_start: (x) => log(`  [streamer] Chunk-Start bei ${x.toFixed(2)}s`),
      token_callback_function: (tokens) => {
        const now = Date.now()
        tokenCount++
        log(`  [streamer] Token #${tokenCount} (+${now - lastTokenAt}ms, gesamt ${now - tStart}ms):`, tokens)
        lastTokenAt = now
      },
      callback_function: (text) => log(`  [streamer] Text:`, JSON.stringify(text)),
      on_chunk_end: (x) => log(`  [streamer] Chunk-Ende bei ${x.toFixed(2)}s`),
      on_finalize: () => log(`  [streamer] Finalisiert`),
    })
  }

  const t0 = Date.now()
  const result = await whisperPipeline(pcm, genOptions)
  log(`transcribe(): fertig nach ${((Date.now() - t0) / 1000).toFixed(1)}s`)
  return result.text.trim()
}

// ── HF-Token (verschlüsselt über die OS-Keychain) ──────────────────────────────
// Den HuggingFace-Token nicht im Klartext in der electron-store-JSON ablegen.
// safeStorage nutzt die System-Keychain (macOS) bzw. DPAPI (Windows). Ist
// Verschlüsselung nicht verfügbar (z.B. Linux ohne Keyring), Fallback auf
// Klartext, damit die Funktion nicht komplett ausfällt.
function setHfToken(token) {
  store.delete('hfToken') // evtl. alten Klartext-Wert entfernen (Migration)
  if (!token) { store.delete('hfTokenEnc'); return }
  if (safeStorage.isEncryptionAvailable()) {
    store.set('hfTokenEnc', safeStorage.encryptString(token).toString('base64'))
  } else {
    store.set('hfToken', token)
  }
}

function getHfToken() {
  const enc = store.get('hfTokenEnc', '')
  if (enc) {
    try {
      return safeStorage.decryptString(Buffer.from(enc, 'base64'))
    } catch (e) {
      logErr('HF-Token konnte nicht entschlüsselt werden:', e.message)
      return ''
    }
  }
  return store.get('hfToken', '') // Fallback / Migration von altem Klartext
}

// ── Settings Window ──────────────────────────────────────────────────────────

function openSettings() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.focus()
    return
  }

  settingsWindow = new BrowserWindow({
    width: 440,
    height: 380,
    resizable: false,
    titleBarStyle: 'default',
    webPreferences: {
      preload: path.join(__dirname, 'settings-preload.js'),
      contextIsolation: true,
    },
  })

  settingsWindow.loadFile('settings.html')
  if (isDev) settingsWindow.webContents.openDevTools({ mode: 'detach' })
  settingsWindow.on('closed', () => { settingsWindow = null })
}

ipcMain.handle('settings-get', () => ({
  provider: store.get('provider', 'Xenova'),
  hfToken:  getHfToken(),
}))

// Externen Link öffnen (HF-Token-Seite aus den Settings). Eigener Kanal statt
// über settings-save gemischt; nur https zulassen, damit kein beliebiges
// Schema (file://, etc.) aus dem Renderer geöffnet werden kann.
ipcMain.on('shell-open', (_e, url) => {
  if (typeof url === 'string' && /^https:\/\//i.test(url)) shell.openExternal(url)
})

ipcMain.handle('settings-save', async (_e, data) => {
  log('Settings gespeichert:', { provider: data.provider, hasToken: !!data.hfToken })
  store.set('provider', data.provider)
  setHfToken(data.hfToken)

  // Modell mit neuen Settings neu laden. force=true umgeht die "lädt bereits"-
  // Sperre; ein evtl. noch laufender Ladevorgang wird über die loadGeneration
  // sauber verworfen (kein manuelles isLoadingModel-Zurücksetzen mehr nötig,
  // das war zuvor die Race-Ursache). whisperPipeline auf null, damit während
  // des Reloads nicht mit dem alten Modell transkribiert wird.
  whisperPipeline = null
  const currentModel = store.get('model', 'small')
  await loadModel(currentModel, true)
})

// ── IPC ───────────────────────────────────────────────────────────────────────

ipcMain.on('audio-ready', async (_event, pcm) => {
  log(`Audio empfangen: ${pcm.length} samples`)
  overlayWindow?.webContents.send('transcribing')

  let text = ''
  try {
    text = await transcribe(Float32Array.from(pcm))
    // Erkannten Text nur im Dev-Modus loggen (Datenschutz bei Diktat).
    log(isDev ? `Transkription: "${text}"` : `Transkription fertig (${text.length} Zeichen)`)
  } catch (err) {
    logErr('Transkriptionsfehler:', err.message)
  }

  if (text) {
    // Alten Clipboard-Inhalt retten
    const prev = clipboard.readText()
    clipboard.writeText(text)

    // Fenster kurz focussieren lassen dann paste simulieren
    overlayWindow?.hide()
    await new Promise(r => setTimeout(r, 80))

    const { keyboard, Key } = require('@nut-tree-fork/nut-js')
    const isMac = process.platform === 'darwin'
    if (isMac) {
      await keyboard.pressKey(Key.LeftSuper, Key.V)
      await keyboard.releaseKey(Key.LeftSuper, Key.V)
    } else {
      await keyboard.pressKey(Key.LeftControl, Key.V)
      await keyboard.releaseKey(Key.LeftControl, Key.V)
    }

    // Clipboard wiederherstellen nach kurzem Delay
    setTimeout(() => clipboard.writeText(prev), 500)
  }

  overlayWindow?.webContents.send('done')
  setTimeout(() => overlayWindow?.hide(), 700)
})

// Renderer meldet, dass die Aufnahme nicht starten konnte (z.B. Mikrofon-
// Berechtigung verweigert). Overlay/Tray zurücksetzen und den Worker-Toggle
// resetten, sonst bleibt der Zustand hängen (nächster ⌥Space nur Resync).
ipcMain.on('recording-failed', (_e, message) => {
  logErr('Aufnahme fehlgeschlagen (Renderer):', message)
  hotkeyHolding = false
  setTrayRecording(false)
  overlayWindow?.hide()
  try { hotkeyWorker?.send({ type: 'reset' }) } catch { /* Kanal evtl. schon zu */ }
  if (!settingsWindow || settingsWindow.isDestroyed()) {
    dialog.showErrorBox(
      'Mikrofon nicht verfügbar',
      `Die Aufnahme konnte nicht gestartet werden:\n${message || 'Unbekannter Fehler'}\n\n` +
      'Bitte Mikrofon-Zugriff erlauben unter:\nSystemeinstellungen → Datenschutz & Sicherheit → Mikrofon'
    )
  }
})

// ── Tray ──────────────────────────────────────────────────────────────────────

function updateTrayLabel(label) {
  if (!tray) return
  tray.setToolTip(label ? `SHOWhisper – ${label}` : 'SHOWhisper')
}

function buildTrayMenu() {
  const currentModel = store.get('model', 'small')
  const provider = store.get('provider', 'Xenova')
  const availableModels = PROVIDER_MODELS[provider] || MODELS
  const modelItems = availableModels.map((m) => ({
    label: MODEL_LABELS[m] || m,
    type: 'radio',
    checked: m === currentModel,
    click: () => loadModel(m),
  }))

  const menu = Menu.buildFromTemplate([
    { label: 'SHOWhisper', enabled: false },
    { type: 'separator' },
    { label: 'Einstellungen…', click: openSettings },
    { type: 'separator' },
    { label: 'Modell', enabled: false },
    ...modelItems,
    { type: 'separator' },
    { label: 'Beenden', click: () => app.quit() },
  ])

  tray.setContextMenu(menu)
}

function createTray() {
  const { nativeImage } = require('electron')
  const idleIcon = nativeImage.createFromPath(path.join(__dirname, 'assets', 'tray-idle.png'))
  idleIcon.setTemplateImage(true) // macOS: auto dark/light mode
  tray = new Tray(idleIcon)
  tray.setToolTip('SHOWhisper')
  buildTrayMenu()
}

function setTrayRecording(recording) {
  const { nativeImage } = require('electron')
  const name = recording ? 'tray-recording' : 'tray-idle'
  const icon = nativeImage.createFromPath(path.join(__dirname, 'assets', `${name}.png`))
  if (!recording) icon.setTemplateImage(true)
  tray.setImage(icon)
}

// ── Hotkey (Push-to-Talk) ─────────────────────────────────────────────────────

function setupHotkey() {
  // Accessibility-Permission prüfen (macOS). Ohne diese kein globales keyup/keydown.
  if (process.platform === 'darwin') {
    const trusted = systemPreferences.isTrustedAccessibilityClient(false)
    log('Accessibility-Check (Hauptprozess):', trusted)
    if (!trusted) {
      dialog.showMessageBoxSync({
        type: 'warning',
        title: 'Accessibility-Zugriff benötigt',
        message: 'SHOWhisper benötigt Zugriff auf Bedienungshilfen für den globalen Hotkey.\n\nBitte erlaube den Zugriff unter:\nSystemeinstellungen → Datenschutz & Sicherheit → Bedienungshilfen',
        buttons: ['Öffnen'],
      })
      // Löst macOS-Prompt aus
      systemPreferences.isTrustedAccessibilityClient(true)
      app.quit()
      return
    }
  }

  spawnHotkeyWorker()
}

// uiohook-napi hat einen bekannten, ungefixten Fatal-Error-Bug
// (SnosMe/uiohook-napi#50), der den ganzen Prozess ohne Vorwarnung beendet.
// Läuft deshalb isoliert in einem eigenen Kindprozess (hotkey-worker.js) -
// stirbt der, sterben nicht Tray/Overlay/das geladene Whisper-Modell mit.
const HOTKEY_BACKOFF_MS = [500, 1000, 2000, 4000, 8000]
const HOTKEY_MAX_RESPAWNS = HOTKEY_BACKOFF_MS.length

function spawnHotkeyWorker() {
  if (isQuitting || hotkeyDisabled) return

  hotkeyWorker = fork(path.join(__dirname, 'hotkey-worker.js'), [], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  })

  hotkeyWorker.on('message', (msg) => {
    if (msg?.type === 'started') {
      log('Hotkey-Worker bereit, PID', hotkeyWorker.pid)
    } else if (msg?.type === 'start-recording') {
      // Solange das Modell noch lädt, ist whisperPipeline entweder null oder
      // wird gerade neu zugewiesen - keine Aufnahme starten, sonst geht der
      // Ton verloren bzw. transcribe() findet kein Modell.
      if (isLoadingModel) {
        log('Aufnahme ignoriert: Modell lädt noch')
        // Worker hat intern schon auf "recording" umgeschaltet - zurücksetzen,
        // sonst braucht der nächste Tastendruck nur zum Resync (wirkungslos).
        try { hotkeyWorker.send({ type: 'reset' }) } catch { /* Kanal evtl. schon zu */ }
        return
      }
      hotkeyHolding = true
      setTrayRecording(true)
      overlayWindow.showInactive()
      overlayWindow.webContents.send('start-recording')
    } else if (msg?.type === 'stop-recording') {
      hotkeyHolding = false
      setTrayRecording(false)
      overlayWindow.webContents.send('stop-recording')
    } else if (msg?.type === 'error') {
      logErr('Hotkey-Worker Fehler:', msg.message)
    }
  })

  hotkeyWorker.on('exit', (code, signal) => handleHotkeyWorkerExit(code, signal))
  hotkeyWorker.on('error', (err) => logErr('Hotkey-Worker konnte nicht gestartet werden:', err.message))

  // Nach stabiler Laufzeit Respawn-Zähler zurücksetzen, damit ein einzelner
  // Crash nach langer fehlerfreier Laufzeit nicht sofort den Circuit-Breaker triggert.
  clearTimeout(hotkeyStableTimer)
  hotkeyStableTimer = setTimeout(() => { hotkeyRespawnCount = 0 }, 30000)
}

function handleHotkeyWorkerExit(code, signal) {
  clearTimeout(hotkeyStableTimer)
  hotkeyWorker = null

  // Mitten in einer gehaltenen Aufnahme abgestürzt -> Overlay/Tray nicht hängen lassen
  if (hotkeyHolding) {
    hotkeyHolding = false
    setTrayRecording(false)
    overlayWindow?.webContents.send('stop-recording')
    overlayWindow?.hide()
  }

  if (isQuitting) return // gewollter Shutdown, kein Respawn

  logErr(`Hotkey-Worker beendet (code=${code}, signal=${signal})`)

  if (hotkeyRespawnCount >= HOTKEY_MAX_RESPAWNS) {
    hotkeyDisabled = true
    logErr('Hotkey-Worker wiederholt abgestürzt, Neustart-Versuche eingestellt')
    updateTrayLabel('Hotkey deaktiviert – App neu starten')
    return
  }

  const delay = HOTKEY_BACKOFF_MS[hotkeyRespawnCount]
  hotkeyRespawnCount++
  setTimeout(spawnHotkeyWorker, delay)
}

// ── App Lifecycle ─────────────────────────────────────────────────────────────

app.commandLine.appendSwitch('disable-features', 'AutofillServerCommunication')

app.whenReady().then(async () => {
  app.dock?.hide() // Mac: kein Dock-Icon

  const { default: Store } = await import('electron-store')
  store = new Store()

  log(`SHOWhisper startet (isDev=${isDev})`)
  log(`userData: ${app.getPath('userData')}`)
  createTray()
  createOverlay()
  setupHotkey()

  let savedModel = store.get('model', 'small')
  if (!MODELS.includes(savedModel)) savedModel = 'small' // Migration: large-v3 → large
  await loadModel(savedModel)
})

app.on('window-all-closed', (e) => e.preventDefault()) // Tray-App bleibt offen

app.on('before-quit', () => { isQuitting = true })

app.on('will-quit', () => {
  if (hotkeyWorker) {
    try { hotkeyWorker.send({ type: 'shutdown' }) } catch { /* Kanal evtl. schon zu */ }
    // Fallback falls Worker nicht rechtzeitig sauber beendet
    const w = hotkeyWorker
    setTimeout(() => { try { w.kill() } catch { /* bereits beendet */ } }, 500)
  }
})
