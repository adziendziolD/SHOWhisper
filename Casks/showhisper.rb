# Homebrew cask for SHOWhisper, served straight from this repository:
#
#   brew tap adziendziolD/showhisper https://github.com/adziendziolD/SHOWhisper
#   brew install --cask showhisper
#
# version, sha256 and url are rewritten automatically by the release job in
# .github/workflows/build.yml after each tagged release. (0.6.1 still uses the
# old "-arm64.dmg" asset name; releases from then on are "-mac-arm64.dmg".)
cask "showhisper" do
  version "0.7.0"
  sha256 "0f86444c58c6b51ae80b2b4f8fd2573c41f6745587f955a96fe3220dabe3ab06"

  url "https://github.com/adziendziolD/SHOWhisper/releases/download/v#{version}/SHOWhisper-#{version}-mac-arm64.dmg"
  name "SHOWhisper"
  desc "Local, private Whisper dictation in the menu bar"
  homepage "https://github.com/adziendziolD/SHOWhisper"

  livecheck do
    url :url
    strategy :github_latest
  end

  # onnxruntime-node ships no Intel macOS build, so Apple Silicon only.
  depends_on arch: :arm64
  depends_on macos: :monterey

  app "SHOWhisper.app"

  # The app is ad-hoc signed but not notarized (no paid Apple Developer
  # account). Homebrew quarantines cask downloads, which would make Gatekeeper
  # block the first launch; clear the attribute so it opens normally.
  # must_succeed: false - xattr exits non-zero if the attribute isn't set
  # (e.g. installed with quarantine disabled), which is fine.
  postflight_steps do
    run "/usr/bin/xattr",
        args:         ["-dr", "com.apple.quarantine", "{{appdir}}/SHOWhisper.app"],
        must_succeed: false
  end

  uninstall quit: "com.showhisper.app"

  zap trash: [
    "~/Library/Application Support/SHOWhisper",
    "~/Library/Caches/com.showhisper.app",
    "~/Library/HTTPStorages/com.showhisper.app",
    "~/Library/Logs/SHOWhisper",
    "~/Library/Preferences/com.showhisper.app.plist",
    "~/Library/Saved Application State/com.showhisper.app.savedState",
  ]
end
