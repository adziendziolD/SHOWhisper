# Demo GIF – shot list

A ~15 second loop for the top of the README (`docs/demo.gif`). Goal: someone scrolling past understands in one viewing that you press a hotkey, talk, and the text appears where you were typing, with no cloud involved.

## Setup

- **Recorder:** [Kap](https://getkap.co) on macOS (export as GIF), [ScreenToGif](https://www.screentogif.com) on Windows, [Peek](https://github.com/phw/peek) or OBS + ffmpeg on Linux.
- **Capture area:** about 1280×720 around a text editor window plus the floating pill. Don't record the full screen.
- **Export:** 960 px wide (the README shows it at 720 px), **12–15 fps**, under **5 MB** (GitHub renders large GIFs slowly). If it's too big, crop tighter or drop to 10 fps rather than lowering the resolution.
- **Clean desktop:** neutral wallpaper, hide other menubar/tray icons, Do Not Disturb on, cursor highlighting on so viewers can see clicks.
- **Model:** `small` already downloaded and loaded (no download progress in the shot). Language: English.
- **Editor:** a plain editor with large font (e.g. TextEdit / Notepad / an email draft) and an empty document, cursor blinking.

## Shots (≈15 s)

| Time | What's on screen | Notes |
|------|------------------|-------|
| 0–2 s | Empty editor with the cursor blinking. Briefly show the SHOWhisper icon in the menubar/tray. | Sets the scene: a normal app, nothing special open. |
| 2–3 s | Press **⌥ Space** and show a key overlay (Kap/ScreenToGif can display keystrokes). The pill appears with the live waveform. | The hotkey is the key moment, so make it visible. |
| 3–8 s | Speak one short, natural sentence, e.g. *"Hey team, the release is ready. I'll send the notes after lunch."* The waveform moves. | Keep it under 5 s. Use a sentence with punctuation so the result looks polished. |
| 8–9 s | Press **⌥ Space** again. The pill switches to *transcribing*, then shows ✓. | |
| 9–12 s | The text appears at the cursor in the editor. | Pause here so it can be read. |
| 12–15 s | *(Optional)* Press **⌥ ⇧ Space**, speak a longer rambling sentence, and the condensed summary is pasted. Otherwise hold on the result. | Skip this if it pushes the GIF over 5 MB. You could make a second GIF for summaries instead. |

## Tips

- Record a few takes and keep the one with the shortest transcription latency. Don't speed up the footage, so it stays honest.
- Turn off Wi-Fi before recording, and optionally show it switched off in the menubar. It shows "offline" without needing a caption.
- The first and last frames should match (empty editor, or the finished text) so the loop doesn't jump.
- Save the file as `docs/demo.gif`, then uncomment the `<img src="docs/demo.gif">` line at the top of `README.md`.
