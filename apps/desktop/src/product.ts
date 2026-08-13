/**
 * Product identity for the desktop shell. Rebranding the fork edits this module
 * and the matching `productName`/`appId`/`publish` fields in
 * [electron-builder.yml](../electron-builder.yml); nothing else hardcodes the name.
 * @module @deepseek-ai/dsh-desktop/product
 */

/** Human-readable product name shown in the loading page and in error dialogs. */
export const PRODUCT_NAME = 'DeepSeek Harness Desktop'

/**
 * Application identity. Windows groups taskbar entries and toast notifications
 * by this value, so it must stay equal to `appId` in electron-builder.yml.
 */
export const APP_ID = 'com.deepseek.harness.desktop'

/**
 * `owner/repo` the updater feed and the manual macOS download link point at.
 * The owner is this fork's, not the upstream harness repository's; it must
 * match `publish` in electron-builder.yml.
 */
export const GITHUB_REPOSITORY = 'cloud-1104/deepseek-harness-desktop'

/** Releases page offered when an update cannot be applied in place. */
export const RELEASES_URL = `https://github.com/${GITHUB_REPOSITORY}/releases/latest`

/**
 * Directory under Electron's `userData` used as the backend process working
 * directory. It stays empty on purpose: `sandbox-policy` falls back to the
 * launch `process.cwd()` for sessions that carry no workspace, and an empty
 * dedicated directory keeps that fallback root from covering the user's home.
 */
export const WORKSPACE_DIR = 'workspace'

/** Directory under Electron's `userData` holding the captured backend output. */
export const LOG_DIR = 'logs'
