<div align="center">
  <img src="assets/icon.png" alt="SHOWhisper" width="128" height="128" />
  <h1>SHOWhisper</h1>
  <p><strong>Local, private voice dictation for macOS, Windows &amp; Linux.</strong></p>
  <p>Press a hotkey, speak, and your words are transcribed on-device with Whisper and pasted into whatever app you're in. No cloud, no account, nothing leaves your machine.</p>

  <p>
    <a href="https://github.com/adziendziolD/SHOWhisper/releases/latest"><img src="https://img.shields.io/badge/%E2%AC%87%EF%B8%8F%20Download-latest%20release-2ea44f?style=for-the-badge" alt="Download the latest release" height="40" /></a>
  </p>

  <p>
    <a href="https://github.com/adziendziolD/SHOWhisper/releases/latest"><img src="https://img.shields.io/github/v/release/adziendziolD/SHOWhisper?label=release" alt="Latest release" /></a>
    <a href="https://github.com/adziendziolD/SHOWhisper/releases"><img src="https://img.shields.io/github/downloads/adziendziolD/SHOWhisper/total?label=downloads" alt="Downloads" /></a>
    <a href="LICENSE"><img src="https://img.shields.io/github/license/adziendziolD/SHOWhisper" alt="MIT license" /></a>
    <img src="https://img.shields.io/badge/platforms-macOS%20(Apple%20Silicon)%20%7C%20Windows%20%7C%20Linux-blue" alt="Platforms: macOS (Apple Silicon), Windows, Linux" />
  </p>

  <!-- Demo GIF: record it following docs/demo-script.md, save as docs/demo.gif, then uncomment:
  <img src="docs/demo.gif" alt="SHOWhisper demo: press ⌥Space, speak, the text appears at the cursor" width="720" />
  -->
</div>

---

## Install

**→ [Download the latest release](https://github.com/adziendziolD/SHOWhisper/releases/latest)**, or use one of the one-liners below. All builds are free and open source; they just aren't signed with paid Apple/Microsoft certificates, so the OS asks for confirmation once (the Homebrew cask and install scripts handle that for you on macOS).

### macOS (Apple Silicon, macOS 12+)

| Method | How |
|--------|-----|
| **Homebrew** (recommended) | `brew tap adziendziolD/showhisper https://github.com/adziendziolD/SHOWhisper && brew install --cask showhisper` |
| Install script | `curl -fsSL https://raw.githubusercontent.com/adziendziolD/SHOWhisper/main/scripts/install-mac.sh \| bash` |
| Manual | Download `SHOWhisper-<version>-mac-arm64.dmg`, drag **SHOWhisper** into **Applications**, then follow the [Gatekeeper steps](#installing-the-app-manually-macos-dmg) below. |

> Intel Macs are **not supported**: the ONNX runtime used for Whisper (`onnxruntime-node`) ships no Intel macOS build.

### Windows (10/11, x64)

| Method | How |
|--------|-----|
| **Installer** | Download and run `SHOWhisper-<version>-windows-x64-setup.exe`. |
| PowerShell one-liner | `irm https://raw.githubusercontent.com/adziendziolD/SHOWhisper/main/scripts/install-windows.ps1 \| iex` |

The installer is per-user (no admin rights). SmartScreen may show *"Windows protected your PC"* because the build isn't signed with a paid certificate — click **More info → Run anyway**.

### Linux (x86_64)

| Method | How |
|--------|-----|
| **AppImage** (any distro, auto-updates) | `curl -fsSL https://raw.githubusercontent.com/adziendziolD/SHOWhisper/main/scripts/install-linux.sh \| bash` — or download `SHOWhisper-<version>-linux-x86_64.AppImage`, `chmod +x` it and run it. |
| **.deb** (Debian/Ubuntu) | Download `SHOWhisper-<version>-linux-amd64.deb`, then `sudo apt install ./SHOWhisper-<version>-linux-amd64.deb`. |

Honest notes for Linux:

- **X11:** the global hotkey and auto-paste work as on the other platforms.
- **Wayland:** the global hotkey goes through the desktop's *GlobalShortcuts* portal (your desktop may ask you to confirm the shortcut). Auto-paste (simulated <kbd>Ctrl</kbd>+<kbd>V</kbd>) may only work in XWayland apps — otherwise the text simply stays on the clipboard for a manual paste.
- <kbd>Alt</kbd>+<kbd>Space</kbd> is bound to the window menu on GNOME and KDE by default; free it in your keyboard settings if the hotkey doesn't trigger.
- GNOME needs the *AppIndicator* extension (preinstalled on Ubuntu) to show tray icons.
- AppImages need FUSE 2: `sudo apt install libfuse2t64` (Ubuntu 24.04+) or `libfuse2` (older).

### After installing

Grant **Microphone** access (and on macOS **Accessibility** for auto-paste — see [Permissions](#permissions-macos)). The Whisper model (default `small`, ~450 MB) downloads on first launch; after that everything runs offline.

## Updating

| Platform | How updates arrive |
|----------|--------------------|
| **Windows**, **Linux AppImage** | Automatic: SHOWhisper checks for updates in the background, downloads them and asks to restart (or installs on the next quit). |
| **macOS** | You get a notification with a link to the new release. With Homebrew, run `brew upgrade --cask showhisper`; with the install script, simply run it again. |
| **Linux .deb** | You get a notification with a link to the new release; install the new `.deb` the same way. |

Update checks are a single anonymous request to GitHub for the latest release — nothing about you or your dictations is sent. Dismissing an update with **Later** keeps it quiet until the next version.

## Features

- 🎙️ **Global hotkey dictation** — press <kbd>⌥</kbd> <kbd>Space</kbd> to start, press again to stop. You see the text appear *while you speak*; the finished transcript is pasted at your cursor about a second after you stop. Hotkeys are configurable.
- 🌍 **25 languages + auto-detect** — German, English, French, Spanish, Italian, Dutch, Polish, Japanese, Chinese, … or let Whisper detect the language per dictation.
- 🧠 **Local AI actions** — press <kbd>⌥</kbd> <kbd>⇧</kbd> <kbd>Space</kbd> instead and a local LLM turns the dictation into a **summary**, a **polished text**, an **e-mail**, **bullet points** or an **English translation** before it's pasted. Runs fully offline via [node-llama-cpp](https://node-llama-cpp.withcat.ai/).
- ✍️ **Voice commands & your own vocabulary** — say "new line" / "neue Zeile" or "new paragraph", and teach it names and terms with a simple replacement list.
- 🕘 **History** — the last dictations are one click away in the tray menu, so nothing is lost when the paste lands in the wrong window.
- 📁 **File transcription** — pick or drag in a media file (mp4, mov, mp3, m4a, wav …) and get a transcript in a result window, with an optional summary and copy/save.
- 🔒 **Fully local & private** — transcription runs on-device via [Whisper](https://github.com/openai/whisper) (ONNX / [transformers.js](https://github.com/huggingface/transformers.js)), and summaries via a local GGUF model. Nothing leaves your computer.
- 🪟 **Floating pill overlay** — a small, always-on-top capsule shows a live waveform while recording, progress while transcribing, and a ✓ when done. Drag it anywhere; its position is remembered.
- 🍎 **Menubar app** — lives in the tray/menubar, no dock clutter. Pick your model from the menu.
- ⚡ **Fast everywhere** — ~0.7 s per sentence with `small` on Apple Silicon; on Windows the Whisper encoder runs on the GPU (DirectML) with automatic CPU fallback.
- 🧭 **Guided setup & self-updating** — a first-run assistant checks microphone/Accessibility permissions, downloads a model and lets you test the hotkey; updates install automatically on Windows/Linux AppImage and are announced on macOS.
- 🧩 **Model choice** — from `tiny` (fast) to `large` (best quality), downloaded on demand and cached locally.
- 💬 **Spoken quote markers** — say a marker phrase around direct speech and it becomes proper typographic quotes in your language (see below).

## Dictating quotes

Whisper can't tell direct speech from description on its own, so you mark it by voice. Speak an *open* phrase, the quoted words, then a *close* phrase, and the app rewrites them into the correct quotation marks for the selected transcription language.

Example (German): saying *“Er sagte Zitat Anfang das ist unmöglich Zitat Ende”* produces **Er sagte „das ist unmöglich“**.

| Language | Open (say one of) | Close (say one of) | Result |
|----------|-------------------|--------------------|--------|
| German   | „Zitat Anfang“, „Anführungszeichen auf“ | „Zitat Ende“, „Anführungszeichen zu“ | `„…“` |
| English  | “open quote”, “begin quote”, “quote” | “close quote”, “end quote”, “unquote” | `“…”` |
| French   | « ouvrez les guillemets », « ouvrir les guillemets », « citation » | « fermez les guillemets », « fermer les guillemets », « fin de citation » | `« … »` |

Marker matching is case-insensitive and tolerates the commas Whisper tends to insert. It's always on and only changes text when you actually speak a marker.

## Voice commands & custom vocabulary

Say a layout command and it becomes a line break (can be switched off in **Settings**):

| Language | Line break | Paragraph |
|----------|------------|-----------|
| German   | „neue Zeile“ | „neuer Absatz“ |
| English  | “new line” | “new paragraph” |
| French   | « nouvelle ligne », « à la ligne » | « nouveau paragraphe » |

Whisper sometimes misspells names, products or jargon. In **Settings → Replacements** add one rule per line — `heard => correct`, e.g. `show whisper => SHOWhisper`. Rules match whole words, ignore case, and run last, after quotes and voice commands.

## AI actions (summary, polish, e-mail, …)

Press <kbd>⌥</kbd> <kbd>⇧</kbd> <kbd>Space</kbd> (instead of <kbd>⌥</kbd> <kbd>Space</kbd>) to dictate **and** let a local LLM process the text. What it does is chosen in **Settings → AI action**:

| Action | Result |
|--------|--------|
| Summarize *(default)* | A few concise sentences in the language you spoke |
| Polish | Grammar, punctuation and filler words fixed — wording kept |
| E-mail | A ready-to-send e-mail with greeting and closing (placeholders instead of invented facts) |
| Bullet points | One idea per line |
| Translate to English | Natural English translation |

The **result** is pasted at your cursor while the **full transcript** is left on your clipboard.

The AI action runs fully offline. The first time you use it, a GGUF model is downloaded once (~2.5 GB) and cached under the app's user-data directory (`llm-cache`); after that it works with no network. The default model is [`Qwen3-4B-Instruct-2507`](https://huggingface.co/unsloth/Qwen3-4B-Instruct-2507-GGUF) (a current, multilingual, non-thinking instruct model). To use a different model, set the store key `llmModelUri` to any node-llama-cpp `hf:owner/repo:quant` URI or a local `.gguf` path.

> Summaries need noticeably more RAM than dictation (a 4B Q4 model uses roughly 2.5–3.5 GB). On a 16 GB machine, prefer a smaller Whisper model if you summarize a lot.

## Transcribing a file

Choose **Transcribe file…** from the tray menu, or drag a media file onto the result window. The file is decoded with a bundled ffmpeg (so any common container/codec works — mp4, mov, mkv, webm, mp3, m4a, wav, …) and transcribed with Whisper. The result window shows the transcript with **Copy**, **Save…**, and a **Summarize** button (same local LLM as above).

Files can use a **different (larger) Whisper model** than live dictation — pick it in the result window's model selector. Latency doesn't matter for files, so `medium`/`large` gives better accuracy. It's loaded only for the file and disposed afterwards, so your fast dictation model stays loaded and active. The choice is remembered separately (store key `fileModel`); changing it re-transcribes the current file.

## Hotkeys

Both hotkeys are global (work in any app) and toggle: press once to start recording, press again to stop. On macOS <kbd>⌥</kbd> is Option; on Windows and Linux it's <kbd>Alt</kbd>.

| Hotkey | Action |
|--------|--------|
| <kbd>⌥</kbd> <kbd>Space</kbd> | **Dictate.** Transcribe your speech and paste it at the cursor. |
| <kbd>⌥</kbd> <kbd>⇧</kbd> <kbd>Space</kbd> | **Dictate + AI action.** Transcribe, run the chosen AI action (summary by default), paste the result; the full transcript stays on the clipboard. |

Both combos can be changed in **Settings** (click the field, press the new combination); the AI hotkey can also be switched off. If a combo is taken by another app, SHOWhisper keeps the previous one and tells you.

Not a hotkey, but handy: **drag the floating pill** to reposition it anywhere on screen — its position is remembered. Everything else (model choice, history, file transcription, settings, setup, diagnostics, quit) is in the **tray/menubar menu**.

## How it works

```
⌥Space ─► global shortcut (main process)
               ├─ overlay pill: recording (live text) → transcribing → done
               ├─ Web Audio (renderer): capture, cut into chunks at speech pauses,
               │                         resample to 16 kHz mono PCM
               ├─ inference worker (separate Node.js process): Whisper via
               │     transformers.js / onnxruntime — each chunk while you speak
               ├─ post-processing: quotes → voice commands → your replacements
               │     (→ local LLM for the AI hotkey)
               └─ clipboard + simulated ⌘V / Ctrl+V → paste into focused app
```

The hotkeys are registered through Electron's built-in `globalShortcut` (the OS hot-key API), so they never sit in the system-wide input path and can't stall keyboard or mouse input.

Inference runs in its own process under a bundled standalone Node.js runtime instead of inside Electron: Electron's allocator (PartitionAlloc) made the first transcription after a short idle stall for 20 s to over 2 minutes, while plain Node takes ~2 s every time. A crash in the native inference code only restarts that worker, never the app.

## Requirements

- macOS 12+ on **Apple Silicon** (M1 or newer — Intel Macs aren't supported), Windows 10/11 (x64), or Linux x86_64 (X11 recommended, see the [Linux notes](#linux-x86_64))
- [Node.js](https://nodejs.org/) 22+ and npm (for building from source)

### Permissions (macOS)

On first launch macOS will ask for these permissions:

| Permission | Why | Where to grant |
|------------|-----|----------------|
| **Microphone** | recording your voice (required) | System Settings → Privacy & Security → Microphone |
| **Accessibility** | simulated paste of the transcript (optional: without it the text stays on the clipboard for a manual paste) | System Settings → Privacy & Security → Accessibility |

## Installing the app manually (macOS `.dmg`)

> Using Homebrew or the install script? Then you can skip this section — both remove the quarantine flag for you, so the app opens without any prompt.

The `.dmg` is **ad-hoc signed but not notarized** (building a notarized release needs a paid Apple Developer account). It runs perfectly fine, but macOS Gatekeeper shows a warning on the very first launch that you have to click past **once**. This is expected — follow the steps below.

1. **Download** `SHOWhisper-<version>-mac-arm64.dmg` (Apple Silicon — M1/M2/M3/M4 or newer).
2. **Open the `.dmg`** and drag **SHOWhisper** into your **Applications** folder.
3. **First launch — get past Gatekeeper.** Double-clicking will say *"SHOWhisper cannot be opened because Apple cannot check it for malicious software"* (or *"is damaged"* on Apple Silicon). Do **one** of these once:
   - **Right-click** (or Control-click) the app in Applications → **Open** → **Open** in the dialog, **or**
   - open it once normally, then go to **System Settings → Privacy & Security** and click **Open Anyway**, **or**
   - run in Terminal: `xattr -cr /Applications/SHOWhisper.app` and open it normally.

   After this one-time confirmation it launches like any other app.
4. **Grant permissions** when prompted — **Microphone** (required) and, for auto-paste, **Accessibility** (see the table above).
5. **First use downloads the models.** The Whisper model (default `small`, ~450 MB) downloads on first launch; the summarization model (~2.5 GB) downloads the first time you use <kbd>⌥</kbd> <kbd>⇧</kbd> <kbd>Space</kbd>. Both are cached locally and afterwards everything runs offline.

> **Why the warning?** Ad-hoc signing is what avoids the harder "app is damaged" rejection on Apple Silicon, but only full notarization removes the prompt entirely. The app is open source — you can also build it yourself (below).

## Getting started (from source)

```bash
git clone https://github.com/adziendziolD/SHOWhisper.git
cd SHOWhisper
npm install
npm run fetch-node   # standalone Node runtime for the inference worker
npm start
```

The first time you use a model it is downloaded (once) and cached under the app's user-data directory.

## Models

Choose in the tray menu. Larger models are more accurate (especially for German) but need more RAM and are slower.

| Model     | Download | Per sentence¹ | Quality | Notes |
|-----------|----------|---------------|---------|-------|
| tiny      | 75 MB    | fastest       | ⚠️      | |
| base      | 150 MB   | fast          | ✅      | |
| small     | 450 MB   | ~0.7 s        | ✅✅    | default — good for most machines |
| medium    | 1.5 GB   | ~2 s          | ✅✅✅  | needs ≥ 16 GB RAM |
| large     | 3 GB     | slow          | 🏆      | best for file transcription |

¹ Measured on Apple Silicon (CPU) for a ~4 s chunk; text appears while you speak, so you only wait for the last chunk after stopping.

Default: `small`. Models are loaded from the public [`Xenova`](https://huggingface.co/Xenova) HuggingFace namespace, which hosts all five sizes and needs no access token. Pick the model in the tray menu.

> **Languages:** 25 transcription languages plus automatic detection are selectable in **Settings**. The app UI itself is available in German, English and French.

## Building installers

```bash
npm run build
```

Output lands in `dist/`: `.dmg` on macOS, NSIS `.exe` on Windows, `.AppImage` + `.deb` on Linux. Build on the platform you're targeting — the native modules (onnxruntime-node, nut-js/libnut, node-llama-cpp, ffmpeg-static) are installed by `npm install` for the host OS/arch only. `npm run build` first fetches the standalone Node.js runtime for the inference worker (`scripts/fetch-node.js`, pinned version, SHA-256 verified) into `build/node/`; it ships as `resources/node`.

```bash
npm run build -- --mac --arm64   # macOS (Apple Silicon)
npm run build -- --win --x64     # Windows
npm run build -- --linux --x64   # Linux: AppImage + deb
```

On Linux, the `.deb` build needs no extra tools (electron-builder downloads `fpm`); running the app needs `libxtst6` and `libx11-6` for auto-paste.

Releases are built by GitHub Actions (`.github/workflows/build.yml`) when a `v*` tag is pushed: every packaged app is smoke-tested (`--smoke-test` loads all native modules), the installers plus the auto-update metadata (`latest*.yml`) are attached to the release, and the Homebrew cask in `Casks/` is bumped automatically. The tag must match the `version` in `package.json`.

> **After building, launch the packaged app once and run the full flow** (hotkey → model load → dictation → paste) — native modules only fully exercise in the packaged build, not just `npm start`.

### Code signing & notarization (macOS)

The build is **ad-hoc signed** (`mac.identity: "-"` in `electron-builder.yml`), which needs no Apple Developer account. This is what keeps Apple Silicon from rejecting the app with the hard "app is damaged" error. It is **not** notarized, so on first launch Gatekeeper still shows "SHOWhisper cannot be verified". Recipients open it once via:

- **right-click → Open** → *Open* in the dialog, or
- **System Settings → Privacy & Security → Open Anyway**, or
- `xattr -cr /Applications/SHOWhisper.app` in the Terminal.

After that first confirmation it launches normally.

For fully frictionless opening (no prompt at all) you need an [Apple Developer Program](https://developer.apple.com/programs/) membership and a *Developer ID Application* certificate, then set in `electron-builder.yml`:

```yaml
mac:
  identity: "Developer ID Application: Your Name (TEAMID)"
  hardenedRuntime: true
  notarize: true   # needs APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID env vars
```

## Development

```bash
npm run fetch-node  # once: the worker's Node runtime (without it, dev falls back to a utilityProcess)
npm run dev         # electron with NODE_ENV=development + devtools + verbose logs
npm run lint        # eslint
npm run typecheck   # tsc --noEmit (JSDoc-typed JS)
npm test            # unit tests (node:test)
npm run e2e         # macOS: end-to-end dictation test with synthesized speech
                    # through a fake microphone (uses your cached models)
```

`SHOWhisper --smoke-test` (packaged app) loads every native module and exits 0/1 — CI runs it on all three platforms. `--e2e-dictation=<file.wav>` plays a WAV through Chromium's fake microphone into the real dictation path and prints the transcript instead of pasting.

Verbose per-token / PCM diagnostics and transcript logging are only emitted in development mode — production builds keep logs minimal and never log the recognized text.

## Roadmap

- Linux arm64 builds
- Neural voice-activity detection (Silero VAD) for chunking in noisy rooms
- Push-to-talk (needs a key-up event; `globalShortcut` only reports key-down, and a global keyboard hook is deliberately avoided)

## Tech stack

Electron (built-in `globalShortcut` for the hotkey) · [@huggingface/transformers](https://github.com/huggingface/transformers.js) (Whisper via ONNX) · [@nut-tree-fork/nut-js](https://github.com/nut-tree/nut.js) (paste simulation) · electron-store · electron-builder · electron-updater

## License

[MIT](LICENSE) © Adziendz
