#!/usr/bin/env bash
# Local end-to-end regression test of the real dictation path (macOS):
# synthesizes speech with `say`, plays it through Chromium's fake microphone
# into the app (--e2e-dictation) and checks the pasted text. Uses the models
# already in your SHOWhisper cache (symlinked, nothing is downloaded twice).
#
#   scripts/e2e-mac.sh            # small model
#   MODEL=medium scripts/e2e-mac.sh
#   APP="/Applications/SHOWhisper.app/Contents/MacOS/SHOWhisper" scripts/e2e-mac.sh   # packaged app
set -euo pipefail
cd "$(dirname "$0")/.."
MODEL="${MODEL:-small}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
FF="node_modules/ffmpeg-static/ffmpeg"
mkdir -p "$WORK/userdata"
ln -s "$HOME/Library/Application Support/SHOWhisper/model-cache" "$WORK/userdata/model-cache"

speak() { # voice, file, text
  say -v "$1" -o "$WORK/$2.aiff" "$3"
  "$FF" -loglevel error -y -i "$WORK/$2.aiff" -ar 48000 -ac 1 -c:a pcm_s16le "$WORK/$2.wav"
}
speak Anna de "Guten Morgen. [[slnc 700]] Ich teste heute die Live Transkription mit mehreren Sätzen. [[slnc 900]] Er sagte Zitat Anfang das funktioniert erstaunlich gut Zitat Ende. [[slnc 600]] Neue Zeile. Und das ist der letzte Satz für diesen Test."
speak Samantha en "Hello there. [[slnc 800]] This is an end to end test of the dictation pipeline. [[slnc 700]] New paragraph. It should detect English automatically."

run() { # wav, language, expected-regex
  local out
  if [ -n "${APP:-}" ]; then
    out=$(SHOWHISPER_E2E_USER_DATA="$WORK/userdata" SHOWHISPER_E2E_MODEL="$MODEL" SHOWHISPER_E2E_LANGUAGE="$2" "$APP" --e2e-dictation="$WORK/$1.wav" 2>&1 || true)
  else
    out=$(SHOWHISPER_E2E_USER_DATA="$WORK/userdata" SHOWHISPER_E2E_MODEL="$MODEL" SHOWHISPER_E2E_LANGUAGE="$2" env -u ELECTRON_RUN_AS_NODE npx electron . --e2e-dictation="$WORK/$1.wav" 2>&1 || true)
  fi
  local line
  line=$(printf '%s\n' "$out" | grep "E2E TRANSCRIPT" || true)
  echo "$1 ($2): ${line:-<no transcript>}"
  printf '%s\n' "$out" | grep -E "transcribe\(\): done after" | sed 's/^/    /'
  if ! printf '%s' "$line" | grep -Eq "$3"; then echo "FAIL: expected /$3/"; return 1; fi
}
run de german 'Guten Morgen.*Sätzen.*„.*erstaunlich gut.*\\n.*letzte Satz'
run en auto 'Hello there.*\\n\\n.*English automatically.*language: english'
echo "E2E OK"
