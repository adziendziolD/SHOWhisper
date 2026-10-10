// Update checks for packaged builds. Two strategies, picked per platform:
//
// - Windows (NSIS) and Linux AppImage: electron-updater downloads the new
//   version in the background (from the latest*.yml files attached to the
//   GitHub release) and offers "restart now / later". If the user picks later,
//   the update is installed automatically on the next quit.
// - macOS and Linux .deb: no silent self-update. macOS builds are ad-hoc signed,
//   not notarized, so Squirrel.Mac refuses to apply updates; a .deb would need
//   root to install. Instead we ask the GitHub API for the latest release and,
//   if it's newer, point the user to the release page (or `brew upgrade`).
//
// A version the user dismissed with "Later" is remembered (via the optional
// store) and never prompted again; the next release will be.

const { app, dialog, shell } = require('electron')

const OWNER = 'adziendziolD'
const REPO = 'SHOWhisper'
const RELEASES_API = `https://api.github.com/repos/${OWNER}/${REPO}/releases/latest`
const RELEASES_PAGE = `https://github.com/${OWNER}/${REPO}/releases/latest`

const INITIAL_DELAY_MS = 10 * 1000            // don't compete with model loading at startup
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000  // every 6 h
const FETCH_TIMEOUT_MS = 15 * 1000
const DISMISSED_KEY = 'updateDismissedVersion'

/**
 * @typedef {(key: string, vars?: Record<string, string | number>) => string} TranslateFn
 * @typedef {{ get(key: string, defaultValue?: unknown): unknown, set(key: string, value: unknown): void }} KeyValueStore
 * @typedef {{
 *   log: (...args: any[]) => void,
 *   logErr: (...args: any[]) => void,
 *   tr: TranslateFn,
 *   isDev: boolean,
 *   store?: KeyValueStore,
 * }} UpdaterOptions
 */

/**
 * Parse "v1.2.3" / "1.2.3-beta.1" into numeric parts and a prerelease tag.
 * Returns null for anything that isn't a plain x.y.z version.
 * @param {string} version
 * @returns {{ parts: number[], prerelease: string } | null}
 */
function parseVersion(version) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(String(version).trim())
  if (!m) return null
  return { parts: [Number(m[1]), Number(m[2]), Number(m[3])], prerelease: m[4] || '' }
}

/**
 * Compare two semver strings. Returns >0 if a is newer than b, <0 if older,
 * 0 if equal or if either can't be parsed (unparseable never counts as newer).
 * Prerelease identifiers are compared simply: a release beats its prereleases.
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function compareVersions(a, b) {
  const va = parseVersion(a)
  const vb = parseVersion(b)
  if (!va || !vb) return 0
  for (let i = 0; i < 3; i++) {
    if (va.parts[i] !== vb.parts[i]) return va.parts[i] - vb.parts[i]
  }
  if (va.prerelease === vb.prerelease) return 0
  if (!va.prerelease) return 1
  if (!vb.prerelease) return -1
  return va.prerelease < vb.prerelease ? -1 : 1
}

/**
 * True when this build can update itself via electron-updater.
 * @returns {boolean}
 */
function canSelfUpdate() {
  if (process.platform === 'win32') return true
  // AppImage runtime sets $APPIMAGE; a .deb install (or an unpacked dir) doesn't.
  return process.platform === 'linux' && Boolean(process.env.APPIMAGE)
}

/**
 * Start background update checks. No-op in development / unpackaged runs.
 * @param {UpdaterOptions} options
 */
function setupAutoUpdate({ log, logErr, tr, isDev, store }) {
  if (isDev || !app.isPackaged) {
    log('Auto-update disabled (development / unpackaged build)')
    return
  }

  /** @param {string} version */
  const isDismissed = (version) => {
    try { return store?.get(DISMISSED_KEY, '') === version } catch { return false }
  }
  /** @param {string} version */
  const dismiss = (version) => {
    try { store?.set(DISMISSED_KEY, version) } catch (e) { logErr('Could not persist dismissed update:', e) }
  }

  if (canSelfUpdate()) {
    setupElectronUpdater({ log, logErr, tr, isDismissed, dismiss })
  } else {
    setupReleaseCheck({ log, logErr, tr, isDismissed, dismiss })
  }
}

/**
 * @typedef {{
 *   log: (...args: any[]) => void,
 *   logErr: (...args: any[]) => void,
 *   tr: TranslateFn,
 *   isDismissed: (version: string) => boolean,
 *   dismiss: (version: string) => void,
 * }} StrategyOptions
 */

/**
 * Windows / AppImage: download in the background, then offer a restart.
 * @param {StrategyOptions} opts
 */
function setupElectronUpdater({ log, logErr, tr, isDismissed, dismiss }) {
  // Required lazily so macOS / deb builds never load it.
  const { autoUpdater } = require('electron-updater')
  autoUpdater.logger = {
    info: (/** @type {unknown} */ m) => log('[updater]', m),
    warn: (/** @type {unknown} */ m) => log('[updater] warn:', m),
    error: (/** @type {unknown} */ m) => logErr('[updater]', m),
    debug: () => {},
  }
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.allowPrerelease = false

  /** @type {string | null} */
  let promptedVersion = null

  autoUpdater.on('error', (err) => logErr('Auto-update error:', err?.message || err))
  autoUpdater.on('update-downloaded', async (info) => {
    const version = info.version
    log(`Update ${version} downloaded`)
    // Only prompt once per version per session, and never for a dismissed one
    // (it still installs on the next quit).
    if (promptedVersion === version || isDismissed(version)) return
    promptedVersion = version
    const { response } = await dialog.showMessageBox({
      type: 'info',
      buttons: [tr('update.ready.restart'), tr('update.later')],
      defaultId: 0,
      cancelId: 1,
      title: tr('update.ready.title'),
      message: tr('update.ready.message', { version }),
      detail: tr('update.ready.detail'),
    })
    if (response === 0) {
      log(`Restarting to install update ${version}`)
      // isSilent: run the NSIS installer without UI; isForceRunAfter: relaunch.
      setImmediate(() => autoUpdater.quitAndInstall(true, true))
    } else {
      dismiss(version)
    }
  })

  const check = () => {
    autoUpdater.checkForUpdates().catch((err) => logErr('Update check failed:', err?.message || err))
  }
  setTimeout(check, INITIAL_DELAY_MS)
  setInterval(check, CHECK_INTERVAL_MS).unref()
}

/**
 * macOS / deb: ask the GitHub API for the latest release and notify.
 * @param {StrategyOptions} opts
 */
function setupReleaseCheck({ log, tr, isDismissed, dismiss }) {
  const current = app.getVersion()
  /** @type {string | null} */
  let promptedVersion = null
  let checking = false

  const check = async () => {
    if (checking) return
    checking = true
    try {
      const res = await fetch(RELEASES_API, {
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': `SHOWhisper/${current}`,
        },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      })
      if (!res.ok) {
        log(`Update check: GitHub API responded ${res.status}`)
        return
      }
      const release = /** @type {{ tag_name?: string, html_url?: string, draft?: boolean, prerelease?: boolean }} */ (await res.json())
      if (!release || release.draft || release.prerelease || !release.tag_name) return
      const latest = release.tag_name.replace(/^v/, '')
      if (parseVersion(latest)?.prerelease) return
      if (compareVersions(latest, current) <= 0) {
        log(`Update check: up to date (${current}, latest ${latest})`)
        return
      }
      log(`Update available: ${latest} (current ${current})`)
      if (promptedVersion === latest || isDismissed(latest)) return
      promptedVersion = latest

      const { response } = await dialog.showMessageBox({
        type: 'info',
        buttons: [tr('update.available.download'), tr('update.later')],
        defaultId: 0,
        cancelId: 1,
        title: tr('update.available.title'),
        message: tr('update.available.message', { version: latest, current }),
        detail: tr(process.platform === 'darwin' ? 'update.available.detailMac' : 'update.available.detail'),
      })
      if (response === 0) {
        const url = release.html_url && release.html_url.startsWith('https://github.com/') ? release.html_url : RELEASES_PAGE
        await shell.openExternal(url)
      } else {
        dismiss(latest)
      }
    } catch (err) {
      // Offline, DNS, timeout, rate limit … never bother the user about it.
      log('Update check failed:', err instanceof Error ? err.message : String(err))
    } finally {
      checking = false
    }
  }

  setTimeout(check, INITIAL_DELAY_MS)
  setInterval(check, CHECK_INTERVAL_MS).unref()
}

module.exports = { setupAutoUpdate, compareVersions, parseVersion }
