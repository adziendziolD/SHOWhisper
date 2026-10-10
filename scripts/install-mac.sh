#!/usr/bin/env bash
# SHOWhisper installer for macOS (Apple Silicon).
#
#   curl -fsSL https://raw.githubusercontent.com/adziendziolD/SHOWhisper/main/scripts/install-mac.sh | bash
#
# Downloads the latest release .dmg from GitHub, copies SHOWhisper.app into
# /Applications (replacing an existing copy), removes the quarantine attribute
# (the app is ad-hoc signed, not notarized) and opens it.
#
# Environment overrides:
#   SHOWHISPER_INSTALL_DIR  target folder (default: /Applications)
#   GITHUB_TOKEN            optional, avoids GitHub API rate limits

set -euo pipefail

REPO="adziendziolD/SHOWhisper"
APP_NAME="SHOWhisper"
BUNDLE_ID="com.showhisper.app"
INSTALL_DIR="${SHOWHISPER_INSTALL_DIR:-/Applications}"
API_URL="https://api.github.com/repos/${REPO}/releases/latest"

info() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m==>\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31mError:\033[0m %s\n' "$*" >&2; exit 1; }

# ── Preconditions ─────────────────────────────────────────────────────────────
[ "$(uname -s)" = "Darwin" ] || die "This installer is for macOS. On Linux use scripts/install-linux.sh."
# `uname -m` reports x86_64 under Rosetta, so ask the hardware directly.
if [ "$(sysctl -n hw.optional.arm64 2>/dev/null || echo 0)" != "1" ]; then
  die "SHOWhisper requires an Apple Silicon Mac (M1 or newer). Intel Macs are not supported (no onnxruntime build)."
fi
for cmd in curl hdiutil ditto xattr; do
  command -v "$cmd" >/dev/null 2>&1 || die "Required command '$cmd' not found."
done

TMP_DIR="$(mktemp -d)"
MOUNT_DIR="$TMP_DIR/mnt"
MOUNTED=0
cleanup() {
  if [ "$MOUNTED" = "1" ]; then hdiutil detach -quiet "$MOUNT_DIR" >/dev/null 2>&1 || true; fi
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

# Run a command with sudo only if the install dir isn't writable.
priv() {
  if [ -w "$INSTALL_DIR" ]; then "$@"; else sudo "$@"; fi
}

# ── Find the latest release ───────────────────────────────────────────────────
info "Looking up the latest SHOWhisper release…"
CURL_AUTH=()
if [ -n "${GITHUB_TOKEN:-}" ]; then CURL_AUTH=(-H "Authorization: Bearer ${GITHUB_TOKEN}"); fi
RELEASE_JSON="$(curl -fsSL -H "Accept: application/vnd.github+json" ${CURL_AUTH[@]+"${CURL_AUTH[@]}"} "$API_URL")" \
  || die "Could not reach the GitHub API. Check your connection (or set GITHUB_TOKEN if you hit the rate limit)."

TAG="$(printf '%s\n' "$RELEASE_JSON" | sed -nE 's/.*"tag_name"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/p' | head -n1)"
DMG_URL="$(printf '%s\n' "$RELEASE_JSON" \
  | grep -Eo '"browser_download_url"[[:space:]]*:[[:space:]]*"[^"]+"' \
  | sed -E 's/.*"(https[^"]+)"$/\1/' \
  | grep -E 'mac-arm64\.dmg$|arm64\.dmg$' | head -n1 || true)"
[ -n "$DMG_URL" ] || die "No Apple Silicon .dmg found in the latest release ${TAG:-}. See https://github.com/${REPO}/releases"

# ── Download + mount ──────────────────────────────────────────────────────────
info "Downloading ${APP_NAME} ${TAG}…"
curl -fL --progress-bar -o "$TMP_DIR/${APP_NAME}.dmg" "$DMG_URL" || die "Download failed: $DMG_URL"

info "Mounting disk image…"
mkdir -p "$MOUNT_DIR"
hdiutil attach -nobrowse -readonly -noautoopen -mountpoint "$MOUNT_DIR" "$TMP_DIR/${APP_NAME}.dmg" >/dev/null \
  || die "Could not mount the disk image."
MOUNTED=1
SRC_APP="$MOUNT_DIR/${APP_NAME}.app"
[ -d "$SRC_APP" ] || die "${APP_NAME}.app not found inside the disk image."

# ── Quit a running copy ───────────────────────────────────────────────────────
if pgrep -x "$APP_NAME" >/dev/null 2>&1; then
  info "Quitting the running ${APP_NAME}…"
  osascript -e "tell application id \"${BUNDLE_ID}\" to quit" >/dev/null 2>&1 || true
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    pgrep -x "$APP_NAME" >/dev/null 2>&1 || break
    sleep 1
  done
  pkill -x "$APP_NAME" >/dev/null 2>&1 || true
fi

# ── Install ───────────────────────────────────────────────────────────────────
TARGET="$INSTALL_DIR/${APP_NAME}.app"
[ -w "$INSTALL_DIR" ] || info "Administrator rights are needed to write to ${INSTALL_DIR}."
info "Installing to ${TARGET}…"
priv mkdir -p "$INSTALL_DIR"
priv rm -rf "$TARGET"
priv ditto "$SRC_APP" "$TARGET"

if hdiutil detach -quiet "$MOUNT_DIR" >/dev/null 2>&1; then MOUNTED=0; fi

# Not notarized → make sure Gatekeeper doesn't block the first launch.
priv xattr -dr com.apple.quarantine "$TARGET" 2>/dev/null || true

ok "${APP_NAME} ${TAG} installed."
echo
echo "  • It lives in the menu bar (no Dock icon). Press ⌥ Space to dictate."
echo "  • On first launch, allow Microphone access, and Accessibility for auto-paste."
echo "  • The Whisper model (~450 MB) downloads on first use, then everything runs offline."
echo

info "Opening ${APP_NAME}…"
open "$TARGET" || echo "Open ${TARGET} manually to start it."
