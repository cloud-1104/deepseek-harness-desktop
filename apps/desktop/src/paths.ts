/**
 * Filesystem layout the shell resolves once at startup. Pure so the packaged
 * and development branches are unit-testable without an Electron runtime.
 * @module @deepseek-ai/dsh-desktop/paths
 */

import { join } from 'node:path'
import { LOG_DIR, WORKSPACE_DIR } from './product.ts'

/** Directory `scripts/prepare-backend.ts` stages the backend closure into. */
const STAGING_DIR = 'backend-dist'

/** Composition overlay shipped with the shell. */
const PATCH_FILE = 'desktop.patch.yml'

/** Electron facts the layout is derived from. */
export interface LayoutInput {
  /** `app.isPackaged`: selects the installed layout over the repository layout. */
  packaged: boolean
  /** `app.getAppPath()`: `apps/desktop` in development, the app bundle when packaged. */
  appPath: string
  /** `process.resourcesPath`: the directory `extraResources` are copied into. */
  resourcesPath: string
  /** `app.getPath('userData')`: the per-user, per-product writable root. */
  userData: string
}

/** Absolute directories and entry points the shell hands to the backend child. */
export interface DesktopLayout {
  /** Harness CLI entry the backend child executes under `ELECTRON_RUN_AS_NODE`. */
  backendEntry: string
  /**
   * Directory of the harness CLI install. It is always the staged closure, in
   * development as well: Electron's Node withholds the ESM loader internals the
   * Cordis Loader uses, so bare plugin names fall back to ordinary Node
   * resolution, which only reaches every plugin from one flat `node_modules`.
   * The repository's nested pnpm layout does not satisfy that, and an asar
   * archive satisfies neither it nor the profile link healing.
   */
  backendRoot: string
  /**
   * Working directory of the backend child. It stays an empty directory of the
   * shell's own: `sandbox-policy` falls back to the launch `process.cwd()` for
   * sessions that carry no workspace, and a double-clicked app has no
   * meaningful one. Real project directories are added inside the UI.
   *
   * `$DSH_HOME` is deliberately absent from this layout. The desktop app reads
   * the same harness home as the `dsh` CLI, so sessions, credentials, and
   * settings are shared and a user's own `DSH_HOME` still wins.
   */
  workspaceDir: string
  /** Directory the captured backend output is written to. */
  logDir: string
  /** Composition overlay the backend is launched with, as a `--patch` argument. */
  patchFile: string
}

/**
 * Resolve the layout for the current launch.
 * @param input - the Electron facts to derive from.
 * @returns the absolute paths the shell and the backend child both use.
 */
export function resolveLayout(input: LayoutInput): DesktopLayout {
  // Purely lexical: every input is already absolute, and resolving against the
  // process working directory would rewrite them.
  const backendRoot = input.packaged
    ? join(input.resourcesPath, 'backend')
    : join(input.appPath, STAGING_DIR)
  return {
    backendRoot,
    backendEntry: join(backendRoot, 'lib', 'bin.js'),
    workspaceDir: join(input.userData, WORKSPACE_DIR),
    logDir: join(input.userData, LOG_DIR),
    // Outside the asar when packaged: the backend child reads it as an ordinary file.
    patchFile: input.packaged
      ? join(input.resourcesPath, PATCH_FILE)
      : join(input.appPath, 'assets', PATCH_FILE),
  }
}
