#!/usr/bin/env bash
# SHOWhisper installer for Linux (x86_64, AppImage).
#
#   curl -fsSL https://raw.githubusercontent.com/adziendziolD/SHOWhisper/main/scripts/install-linux.sh | bash
#
# Downloads the latest release AppImage to ~/Applications/SHOWhisper.AppImage,
# makes it executable, links it as ~/.local/bin/showhisper and creates a
# desktop entry + icon so it shows up in your app launcher. The AppImage
# updates itself in place (the stable file name keeps the launcher working).
#
# Environment overrides:
#   SHOWHISPER_INSTALL_DIR  folder for the AppImage (default: ~/Applications)
#   SHOWHISPER_AUTOSTART=1  also start SHOWhisper automatically at login
#   GITHUB_TOKEN            optional, avoids GitHub API rate limits

set -euo pipefail

REPO="adziendziolD/SHOWhisper"
APP_NAME="SHOWhisper"
API_URL="https://api.github.com/repos/${REPO}/releases/latest"
ICON_URL="https://raw.githubusercontent.com/${REPO}/main/assets/icon.png"

INSTALL_DIR="${SHOWHISPER_INSTALL_DIR:-$HOME/Applications}"
APPIMAGE="$INSTALL_DIR/${APP_NAME}.AppImage"
BIN_DIR="$HOME/.local/bin"
DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"
DESKTOP_FILE="$DATA_HOME/applications/showhisper.desktop"
ICON_FILE="$DATA_HOME/icons/showhisper.png"

info() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mNote:\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31mError:\033[0m %s\n' "$*" >&2; exit 1; }

# ── Preconditions ─────────────────────────────────────────────────────────────
[ "$(uname -s)" = "Linux" ] || die "This installer is for Linux. On macOS use scripts/install-mac.sh."
case "$(uname -m)" in
  x86_64|amd64) ;;
  *) die "Only x86_64 Linux builds are published at the moment (this machine: $(uname -m))." ;;
esac
command -v curl >/dev/null 2>&1 || die "curl is required."

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

# ── Find the latest release ───────────────────────────────────────────────────
info "Looking up the latest SHOWhisper release…"
CURL_AUTH=()
if [ -n "${GITHUB_TOKEN:-}" ]; then CURL_AUTH=(-H "Authorization: Bearer ${GITHUB_TOKEN}"); fi
RELEASE_JSON="$(curl -fsSL -H "Accept: application/vnd.github+json" ${CURL_AUTH[@]+"${CURL_AUTH[@]}"} "$API_URL")" \
  || die "Could not reach the GitHub API. Check your connection (or set GITHUB_TOKEN if you hit the rate limit)."

TAG="$(printf '%s\n' "$RELEASE_JSON" | sed -nE 's/.*"tag_name"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/p' | head -n1)"
APPIMAGE_URL="$(printf '%s\n' "$RELEASE_JSON" \
  | grep -Eo '"browser_download_url"[[:space:]]*:[[:space:]]*"[^"]+"' \
  | sed -E 's/.*"(https[^"]+)"$/\1/' \
  | grep -E 'x86_64\.AppImage$' | head -n1 || true)"
[ -n "$APPIMAGE_URL" ] || die "No x86_64 AppImage found in the latest release ${TAG:-}. See https://github.com/${REPO}/releases"

# ── Download ──────────────────────────────────────────────────────────────────
info "Downloading ${APP_NAME} ${TAG}…"
curl -fL --progress-bar -o "$TMP_DIR/${APP_NAME}.AppImage" "$APPIMAGE_URL" || die "Download failed: $APPIMAGE_URL"
chmod +x "$TMP_DIR/${APP_NAME}.AppImage"

# Stop a running copy before replacing the file.
if pgrep -f "$APPIMAGE" >/dev/null 2>&1; then
  info "Stopping the running ${APP_NAME}…"
  pkill -f "$APPIMAGE" >/dev/null 2>&1 || true
  sleep 2
fi

mkdir -p "$INSTALL_DIR" "$BIN_DIR" "$(dirname "$DESKTOP_FILE")" "$(dirname "$ICON_FILE")"
mv -f "$TMP_DIR/${APP_NAME}.AppImage" "$APPIMAGE"
ln -sf "$APPIMAGE" "$BIN_DIR/showhisper"

# ── Icon + desktop entry ──────────────────────────────────────────────────────
if ! curl -fsSL -o "$ICON_FILE" "$ICON_URL"; then
  warn "Could not download the icon; the launcher entry will use a generic icon."
fi

cat > "$DESKTOP_FILE" <<EOF
[Desktop Entry]
Type=Application
Name=${APP_NAME}
GenericName=Voice dictation
Comment=Local, private Whisper dictation
Exec="${APPIMAGE}" %U
Icon=${ICON_FILE}
Terminal=false
Categories=Utility;AudioVideo;
Keywords=whisper;dictation;speech;transcription;voice;
EOF
chmod 644 "$DESKTOP_FILE"
command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$(dirname "$DESKTOP_FILE")" >/dev/null 2>&1 || true

if [ "${SHOWHISPER_AUTOSTART:-0}" = "1" ]; then
  mkdir -p "$CONFIG_HOME/autostart"
  cp "$DESKTOP_FILE" "$CONFIG_HOME/autostart/showhisper.desktop"
  info "Autostart enabled ($CONFIG_HOME/autostart/showhisper.desktop)."
fi

ok "${APP_NAME} ${TAG} installed to ${APPIMAGE}"
echo
echo "  • Start it from your app launcher, or run: showhisper"
echo "  • It lives in the system tray. Press Alt+Space to dictate. (GNOME/KDE bind Alt+Space"
echo "    to the window menu by default; free it in your keyboard settings if needed.)"
echo "  • The Whisper model (~450 MB) downloads on first use, then everything runs offline."
echo "  • Start at login: rerun with SHOWHISPER_AUTOSTART=1, or copy"
echo "    $DESKTOP_FILE to $CONFIG_HOME/autostart/"
echo

# ── Environment hints ─────────────────────────────────────────────────────────
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) warn "$BIN_DIR is not on your PATH, so the 'showhisper' command won't be found (the launcher entry still works)." ;;
esac
if ! { ldconfig -p 2>/dev/null | grep -q 'libfuse\.so\.2'; }; then
  warn "AppImages need FUSE 2. If SHOWhisper doesn't start, install it:"
  echo "      Ubuntu 24.04+:  sudo apt install libfuse2t64"
  echo "      Ubuntu 22.04 / Debian:  sudo apt install libfuse2"
  echo "      Fedora:  sudo dnf install fuse-libs"
fi
if [ "${XDG_SESSION_TYPE:-}" = "wayland" ]; then
  warn "You're on Wayland: the global hotkey goes through the desktop's GlobalShortcuts portal,"
  echo "      and auto-paste may only work in XWayland apps; otherwise the text stays on the clipboard."
fi
