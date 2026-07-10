# SHOWhisper – Plan

Lokale, cross-platform Diktat-App (Mac + Windows) mit Whisper STT,
Menubar-Integration und einem schwebenden Overlay-Effekt.

---

## Stack

| Aufgabe              | Library                         | Begründung                                      |
|----------------------|---------------------------------|-------------------------------------------------|
| App-Shell + Tray     | `electron`                      | Built-in Tray, globalShortcut, BrowserWindow    |
| Hotkey (Toggle)      | `@mukea/uiohook-napi`           | Globales keydown, isoliert in eigenem Kindprozess |
| Audio aufnehmen      | Web Audio API (Renderer)        | Browser-nativ, kein extra Package               |
| STT                  | `@huggingface/transformers`     | Whisper via ONNX, reines JS, kein nativer Build |
| Text einfügen        | `@nut-tree/nut-js`              | Cross-platform Tastatur-Simulation (⌘V/Ctrl+V)  |
| Settings persistieren| `electron-store`                | Modell-Auswahl + Overlay-Position               |
| Packaging            | `electron-builder`              | Mac (.dmg) + Windows (.exe) out of the box      |

---

## Dateistruktur

```
SHOWhisper/
├── PLAN.md
├── package.json
├── electron-builder.yml
├── main.js                  – Hauptprozess (Tray, Hotkey, Whisper, Paste)
├── preload.js               – Context Bridge (IPC Main ↔ Renderer)
├── overlay.html             – Pill-Overlay UI
├── overlay.css              – Styles (Frosted Glass, Animationen)
├── overlay-renderer.js      – Renderer-Logik (Audio, Waveform, States)
└── assets/
    ├── tray-idle.png        – Tray Icon
    └── tray-recording.png   – Tray Icon rot
```

---

## Architektur

```
main.js (Main Process)
├── Tray
│   └── Menü: Modell wählen (tiny/base/small/medium/large) + Beenden
├── hotkey-worker.js (isolierter Kindprozess, @mukea/uiohook-napi)
│   └── keydown ⌥Space (Toggle) → IPC → Renderer: "start-recording" / "stop-recording"
├── IPC Handler: "audio-ready"
│   ├── @huggingface/transformers (Whisper, Modell im RAM gehalten)
│   └── transkribierter Text → @nut-tree/nut-js → ⌘V / Ctrl+V
└── electron-store: Modell-Auswahl + Overlay-Position

preload.js (Context Bridge)
└── exposes: onStart, onStop, sendAudio, onTranscribing, onDone

overlay.html + overlay-renderer.js (Renderer Process)
├── MediaRecorder (getUserMedia) → WAV Buffer
├── AnalyserNode → Waveform-Animation (echte Audiodaten)
└── States: hidden → recording (Pill expandiert) → transcribing → done flash → hidden
```

---

## Overlay Design – "The Pill"

Schwebende, abgerundete Kapsel, immer on-top, frei positionierbar (Position
wird gespeichert). Unsichtbar bis ⌥Space gedrückt wird.

### States

**Recording**
- Hintergrund: `#1a1a1a`, roter Glow (`box-shadow: 0 0 30px rgba(255,50,50,0.4)`)
- Waveform: Echtzeit-Balken aus `AnalyserNode`, Rot→Orange Gradient
- Pill expandiert smooth via CSS transition

**Transcribing**
- Hintergrund wechselt auf Indigo/Blau
- Shimmer-Animation + Text "Wird transkribiert..."
- Spinner

**Done**
- Kurzes grünes `✓` Flash (~600ms)
- Pill schrumpft und verschwindet

### Technisch
```
BrowserWindow:
  transparent: true
  frame: false
  alwaysOnTop: true
  hasShadow: false
  webPreferences: { preload }

Drag: -webkit-app-region: drag
Position: gespeichert in electron-store, default: unten zentriert
```

---

## Modell-Auswahl

Im Tray-Menü wählbar. Modell wird beim Wechsel neu geladen (einmaliger Download).
Aktuell aktives Modell hat Haken.

| Modell    | Größe  | RAM    | Latenz (M1) | Deutsch |
|-----------|--------|--------|-------------|---------|
| tiny      | 75 MB  | ~125MB | ~0.5s       | ⚠️      |
| base      | 150 MB | ~250MB | ~1s         | ✅      |
| small     | 450 MB | ~700MB | ~2-3s       | ✅✅    |
| medium    | 1.5 GB | ~2.5GB | ~6-8s       | ✅✅✅  |
| large-v3  | 3 GB   | ~4.5GB | ~15s        | 🏆      |

Default: `small`

---

## Flow (Toggle)

```
⌥Space drücken (1x)
  → Pill erscheint (fade in), expandiert
  → MediaRecorder startet
  → Waveform animiert live

⌥Space drücken (2x, nochmal)
  → MediaRecorder stoppt → WAV Buffer → IPC → Main
  → Pill: Transcribing-State
  → Whisper transkribiert
  → Text → Clipboard
  → @nut-tree/nut-js simuliert ⌘V (Mac) / Ctrl+V (Windows)
  → Pill: Done-Flash (✓, grün, 600ms)
  → Pill verschwindet

Overlay verschieben:
  → Pill anklicken und ziehen (jederzeit, auch im Idle-State wenn sichtbar)
  → Position wird live in electron-store gespeichert
```

---

## Packaging

```bash
# Dev
npm start

# Build Mac (.dmg) + Windows (.exe)
npm run build
```

`electron-builder.yml` konfiguriert:
- Mac: `.dmg`, arm64 + x64 (Universal Binary)
- Windows: `.exe` NSIS Installer
- Kein Auto-Update in v1

### DMG bauen und ausliefern (macOS)

1. **Build starten:**
   ```bash
   npm run build
   ```
   Ergebnis landet in `dist/` (z.B. `dist/SHOWhisper-0.1.0-arm64.dmg` und `-x64.dmg`).
   Dauert beim ersten Mal etwas länger (Electron-Binaries werden pro Architektur geladen).

2. **Native Module prüfen:** SHOWhisper hat mehrere native Abhängigkeiten
   (`@mukea/uiohook-napi`, `onnxruntime-node`, `@nut-tree-fork/nut-js`). Diese
   werden bereits über den `asarUnpack`-Eintrag in `electron-builder.yml` aus
   dem asar-Archiv ausgepackt. Trotzdem nach dem Build die gepackte App
   **einmal wirklich starten** (`open dist/mac-arm64/SHOWhisper.app` bzw. aus
   dem gemounteten DMG) und den kompletten Flow durchklicken (Hotkey, Modell
   laden, Diktat, Einfügen) - nicht nur `npm run build` als Erfolg werten.

3. **Code-Signing / Gatekeeper (wichtig für „ausliefern" an andere):**
   - **Unsigniert bauen** (aktueller Default) → funktioniert lokal ohne
     Warnung. Auf einem anderen Mac zeigt Gatekeeper „App ist beschädigt"
     oder „kann nicht geöffnet werden, da der Entwickler nicht verifiziert
     werden kann". Empfänger müssen dann manuell im Finder Rechtsklick →
     Öffnen (oder `xattr -cr SHOWhisper.app` im Terminal) machen, um die
     Quarantäne-Warnung zu umgehen. Für einen kleinen, technisch versierten
     Empfängerkreis ok. Setzt ein *Developer ID Application*-Zertifikat
     voraus, das nicht Teil des Repos ist.
   - **Für "normales" Ausliefern** (Empfänger sollen einfach doppelklicken
     können) braucht es eine **Apple Developer Program Mitgliedschaft**
     (99 $/Jahr) und ein **Developer ID Application**-Zertifikat daraus.
     Dann in `electron-builder.yml` ergänzen:
     ```yaml
     mac:
       hardenedRuntime: true
       notarize: true   # electron-builder nutzt automatisch notarytool,
                         # braucht APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD /
                         # APPLE_TEAM_ID als Umgebungsvariablen
     ```
     und den Build mit gesetzten `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`,
     `APPLE_TEAM_ID` env-Variablen laufen lassen - electron-builder signiert
     und notarisiert dann automatisch während `npm run build`.

4. **App-Icon:** Ist konfiguriert - `assets/icon.icns` (macOS) und
   `assets/icon.ico` (Windows) sind in `electron-builder.yml` eingetragen.
   Zum Ändern die Quelle `assets/icon.png` (1024×1024) ersetzen und die
   `.icns`/`.ico` neu generieren.

5. **Versionsnummer:** `package.json` steht auf `0.1.0` - vor dem
   Ausliefern ggf. hochzählen, landet im DMG-Dateinamen.

---

## Offene Punkte (v2)

- Auto-Update via `electron-updater`
- Transkriptions-History (letzten N Texte anzeigen)
- Mehrsprachigkeit (aktuell: Deutsch fest, auto-detect optional)
- Custom Hotkey (aktuell: ⌥Space fest)
