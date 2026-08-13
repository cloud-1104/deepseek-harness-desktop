/**
 * Update checking against the GitHub Releases feed electron-builder writes into
 * the packaged app.
 *
 * Windows installs in place: NSIS packages need no code signature for
 * electron-updater to stage and apply them. macOS does not: Squirrel.Mac
 * validates the running app's code signature before swapping it, so an unsigned
 * build can only report the new version and send the user to the download page.
 * Once the mac build is signed and notarized, `autoDownload` there becomes the
 * same in-place path as Windows.
 * @module @deepseek-ai/dsh-desktop/updater
 */

import electronUpdater from 'electron-updater'

const { autoUpdater } = electronUpdater

/** Callbacks the shell supplies so this module stays free of window and dialog code. */
export interface UpdaterHooks {
  /** Platform deciding the update strategy, normally `process.platform`. */
  platform: NodeJS.Platform
  /** Receives updater progress and errors for the log file. */
  log: (line: string) => void
  /**
   * Invoked on platforms that cannot apply an update in place.
   * @param version - the version found in the feed.
   */
  offerManualDownload: (version: string) => void
}

/**
 * Wire the updater and start one check. Callers must skip this in development:
 * an unpackaged app has no `app-update.yml` and the check would always fail.
 * @param hooks - platform, logging, and the manual-download fallback.
 */
export function installUpdater(hooks: UpdaterHooks): void {
  const inPlace = hooks.platform === 'win32'
  autoUpdater.autoDownload = inPlace
  autoUpdater.autoInstallOnAppQuit = inPlace
  autoUpdater.logger = {
    info: (message: unknown) => { hooks.log(`[updater] ${String(message)}`) },
    warn: (message: unknown) => { hooks.log(`[updater] warn: ${String(message)}`) },
    error: (message: unknown) => { hooks.log(`[updater] error: ${String(message)}`) },
    debug: (message: unknown) => { hooks.log(`[updater] ${String(message)}`) },
  }

  autoUpdater.on('update-available', (info) => {
    hooks.log(`[updater] update available: ${info.version}`)
    if (!inPlace) hooks.offerManualDownload(info.version)
  })
  autoUpdater.on('error', (error) => {
    hooks.log(`[updater] check failed: ${error.message}`)
  })

  void autoUpdater.checkForUpdates().catch((error: unknown) => {
    // Reaching the feed is best-effort: an offline launch must still open the window.
    hooks.log(`[updater] check failed: ${error instanceof Error ? error.message : String(error)}`)
  })
}
