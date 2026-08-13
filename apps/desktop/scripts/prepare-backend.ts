/**
 * Stage the harness backend the desktop installer ships.
 *
 * The result is a plain npm install tree, not an archive: `app-boot` heals
 * `$DSH_HOME/profiles/node_modules` with links into these package directories
 * and reads each bundle's `dsh.bundle.patch` from disk, so the tree must be
 * real directories with no symlinks of its own. electron-builder copies it
 * through `extraResources`, which lands it beside the asar rather than inside.
 */

import { spawn } from 'node:child_process'
import { existsSync, globSync } from 'node:fs'
import { chmod, cp, lstat, mkdir, readFile, readdir, realpath, rm, stat } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { parseArgs } from 'node:util'

/** apps/desktop. */
const desktopRoot = resolve(import.meta.dirname, '..')

/** Repository root. */
const repoRoot = resolve(desktopRoot, '..', '..')

/** Workspace package whose dependency closure is the backend. */
const BACKEND_PACKAGE = '@deepseek-ai/dsh'

/** Directory the deployed closure is written to; `electron-builder.yml` copies it verbatim. */
const STAGING = join(desktopRoot, 'backend-dist')

/** Where `--legacy` deploy may leave direct dependencies instead of the target. */
const DEPLOY_SOURCE_NODE_MODULES = join(repoRoot, 'apps', 'cli', 'node_modules')

/** Build outputs the staged closure cannot be assembled without. */
const REQUIRED_ARTIFACTS = [
  join(repoRoot, 'apps', 'cli', 'lib', 'bin.js'),
  join(repoRoot, 'apps', 'web', 'dist', 'index.html'),
]

/**
 * Files that must stay executable. pnpm's copy and pack paths have both been
 * observed to drop the bit, which turns into a confusing runtime failure far
 * from here: a PTY that never starts, or a search tool that reports no matches.
 */
const EXECUTABLES = [
  join('node_modules', '@vscode', 'ripgrep', 'bin', 'rg'),
  join('node_modules', 'node-pty', 'build', 'Release', 'spawn-helper'),
]

/**
 * Native addons the backend loads eagerly. They ship N-API prebuilds, which the
 * Node inside Electron loads as-is, so the staged tree is checked rather than
 * rebuilt: a blanket `electron-rebuild` would put a C++ toolchain on the
 * critical path of every build to redo work the prebuilds already did.
 */
const NATIVE_MODULES = ['node-pty', 'koffi']

interface Options {
  skipBuild: boolean
  skipDeploy: boolean
  skipNativeCheck: boolean
}

/**
 * Parse the script flags.
 * @param argv - raw arguments, `process.argv.slice(2)`.
 * @returns the resolved options.
 */
function parseOptions(argv: string[]): Options {
  const { values } = parseArgs({
    args: argv,
    options: {
      'skip-build': { type: 'boolean', default: false },
      'skip-deploy': { type: 'boolean', default: false },
      'skip-native-check': { type: 'boolean', default: false },
    },
  })
  return {
    skipBuild: values['skip-build'],
    skipDeploy: values['skip-deploy'],
    skipNativeCheck: values['skip-native-check'],
  }
}

/**
 * Run pnpm with inherited stdio, failing loud on a non-zero exit. The JavaScript
 * entrypoint is spawned through Node directly: Windows refuses to spawn the
 * `pnpm.cmd` shim without a shell, and a shell would need argument quoting.
 * @param label - step name used in log and error lines.
 * @param args - the pnpm arguments.
 */
async function runPnpm(label: string, args: string[]): Promise<void> {
  const entrypoint = process.env.npm_execpath
  if (entrypoint === undefined || entrypoint === '') {
    throw new Error('prepare-backend: npm_execpath is unavailable; invoke this script through a pnpm package script.')
  }
  const printable = ['pnpm', ...args].map(part => (part.includes(' ') ? JSON.stringify(part) : part)).join(' ')
  console.log(`prepare-backend: ${label}: ${printable}`)
  await new Promise<void>((settle, reject) => {
    const child = spawn(process.execPath, [entrypoint, ...args], {
      cwd: repoRoot,
      stdio: 'inherit',
      // Artifact builds must not mutate or validate a developer's Git hooks.
      env: { ...process.env, CI: 'true' },
    })
    child.once('error', error => void reject(new Error(`prepare-backend: ${label} failed to spawn: ${error.message}`)))
    child.once('exit', (code, signal) => {
      if (code === 0) settle()
      else reject(new Error(`prepare-backend: ${label} failed (${code === null ? `signal ${String(signal)}` : `exit code ${String(code)}`}): ${printable}`))
    })
  })
}

/** Build the workspace artifacts the staged closure copies. */
async function buildWorkspace(options: Options): Promise<void> {
  if (!options.skipBuild) await runPnpm('build', ['run', 'build'])
  const missing = REQUIRED_ARTIFACTS.filter(path => !existsSync(path))
  if (missing.length > 0) {
    throw new Error(`prepare-backend: build outputs missing: ${missing.join(', ')}. Run pnpm run build from the repository root.`)
  }
}

/**
 * Clear the staging directory and deploy the backend closure into it.
 * @param options - the resolved script options.
 */
async function deployBackend(options: Options): Promise<void> {
  if (options.skipDeploy) {
    console.log('prepare-backend: reusing the existing staged closure (--skip-deploy)')
    return
  }
  await rm(STAGING, { recursive: true, force: true })
  await runPnpm('deploy', [
    '--filter',
    BACKEND_PACKAGE,
    'deploy',
    '--legacy',
    '--prod',
    '--config.node-linker=hoisted',
    '--config.auto-install-peers=false',
    '--config.link-workspace-packages=true',
    STAGING,
  ])
  await materializeLinks(join(STAGING, 'node_modules'))
}

/** A package manifest, as far as closure repair reads it. */
interface Manifest {
  dependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  peerDependenciesMeta?: Record<string, { optional?: boolean }>
  optionalDependencies?: Record<string, string>
}

/**
 * Index every workspace package by name. Legacy deploy drops packages reached
 * through a `link:` override — the vendored Cordis foundation libraries — and
 * hoists some direct dependencies beside the deploy source instead of into the
 * target, so both have to be restored from the workspace itself.
 * @returns package name to its source directory in this repository.
 */
async function workspaceIndex(): Promise<Map<string, string>> {
  const index = new Map<string, string>()
  const patterns = ['vendor/*', 'packages/*/*', 'apps/*', 'native/landlock-run/packages/*']
  for (const pattern of patterns) {
    for (const match of globSync(`${pattern}/package.json`, { cwd: repoRoot })) {
      const directory = join(repoRoot, dirname(match))
      const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')) as { name?: string }
      if (manifest.name !== undefined) index.set(manifest.name, directory)
    }
  }
  return index
}

/**
 * Copy in every production dependency the deploy left out, repeating until the
 * staged tree closes over itself. A dependency that is neither staged nor a
 * workspace package is a real deploy failure and stops the build rather than
 * turning into a module-not-found at first launch.
 */
async function repairClosure(): Promise<void> {
  const modules = join(STAGING, 'node_modules')
  const workspace = await workspaceIndex()
  const restored: string[] = []
  let pending = [join(STAGING, 'package.json'), ...(await stagedManifests(modules))]
  while (pending.length > 0) {
    const next: string[] = []
    for (const manifestPath of pending) {
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Manifest
      for (const name of requiredDependencies(manifest)) {
        if (resolvable(dirname(manifestPath), name)) continue
        const destination = join(modules, name)
        const source = workspace.get(name) ?? fallbackSource(name)
        if (source === undefined) {
          throw new Error(`prepare-backend: ${name} is required by ${manifestPath} but is neither staged nor a workspace package.`)
        }
        const nested = join(source, 'node_modules')
        await mkdir(dirname(destination), { recursive: true })
        await cp(source, destination, {
          recursive: true,
          dereference: true,
          filter: path => path !== nested && !path.startsWith(nested + sep),
        })
        restored.push(name)
        next.push(join(destination, 'package.json'))
      }
    }
    pending = next
  }
  if (restored.length > 0) {
    console.log(`prepare-backend: restored ${String(restored.length)} package(s) the deploy omitted: ${restored.sort().join(', ')}`)
  }
}

/**
 * Whether a dependency is already reachable from a staged package. A hoisted
 * deploy still nests the packages whose versions conflict, so the check has to
 * walk the `node_modules` ancestors the way Node does rather than look only at
 * the top level.
 * @param fromDir - directory of the package that declares the dependency.
 * @param name - the dependency name.
 * @returns whether Node would find it from that directory.
 */
function resolvable(fromDir: string, name: string): boolean {
  let directory = fromDir
  for (;;) {
    if (existsSync(join(directory, 'node_modules', name))) return true
    if (directory === STAGING) return false
    const parent = dirname(directory)
    if (parent === directory) return false
    directory = parent
  }
}

/**
 * Locate a package the legacy hoister left beside the deploy source.
 * @param name - the package name.
 * @returns its directory, or `undefined` when it is not there either.
 */
function fallbackSource(name: string): string | undefined {
  const candidate = join(DEPLOY_SOURCE_NODE_MODULES, name)
  return existsSync(candidate) ? candidate : undefined
}

/**
 * The dependencies a staged package must find at runtime. Optional peers and
 * optional dependencies are excluded: the Linux-only Landlock platform packages
 * are exactly the case that must stay absent on Windows and macOS.
 * @param manifest - the package manifest.
 * @returns the required dependency names.
 */
function requiredDependencies(manifest: Manifest): string[] {
  const optional = new Set(Object.keys(manifest.optionalDependencies ?? {}))
  const peers = Object.keys(manifest.peerDependencies ?? {})
    .filter(name => manifest.peerDependenciesMeta?.[name]?.optional !== true)
  return [...Object.keys(manifest.dependencies ?? {}), ...peers].filter(name => !optional.has(name))
}

/**
 * List the manifest of every package already staged.
 * @param modules - the staged `node_modules` directory.
 * @returns absolute manifest paths.
 */
async function stagedManifests(modules: string): Promise<string[]> {
  const manifests: string[] = []
  for (const entry of await readdir(modules, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    if (entry.name.startsWith('@')) {
      for (const scoped of await readdir(join(modules, entry.name), { withFileTypes: true })) {
        if (scoped.isDirectory()) manifests.push(join(modules, entry.name, scoped.name, 'package.json'))
      }
      continue
    }
    if (entry.name !== '.bin') manifests.push(join(modules, entry.name, 'package.json'))
  }
  return manifests.filter(path => existsSync(path))
}

/**
 * Replace every link in the staged tree with its contents. The installer must
 * carry real directories: a Windows junction cannot survive the copy into an
 * installer payload, and a macOS bundle with internal symlinks breaks signing.
 * @param nodeModules - the staged `node_modules` directory.
 */
async function materializeLinks(nodeModules: string): Promise<void> {
  let link = await firstLink(nodeModules)
  let count = 0
  while (link !== undefined) {
    const segments = link.slice(nodeModules.length + 1).split(sep)
    const binIndex = segments.lastIndexOf('.bin')
    if (binIndex >= 0) {
      await rm(join(nodeModules, ...segments.slice(0, binIndex + 1)), { recursive: true, force: true })
    } else {
      const source = await realpath(link)
      await rm(link, { recursive: true, force: true })
      await cp(source, link, { recursive: true, dereference: true })
      count += 1
    }
    link = await firstLink(nodeModules)
  }
  console.log(`prepare-backend: materialized ${String(count)} linked packages`)
}

/**
 * Find the first link below a directory.
 * @param directory - the directory to walk.
 * @returns the link path, or `undefined` when the subtree has none.
 */
async function firstLink(directory: string): Promise<string | undefined> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if ((await lstat(path)).isSymbolicLink()) return path
    if (entry.isDirectory()) {
      const nested = await firstLink(path)
      if (nested !== undefined) return nested
    }
  }
  return undefined
}

/** Restore the executable bit on the binaries the backend spawns. */
async function restoreExecutables(): Promise<void> {
  if (process.platform === 'win32') return
  for (const relative of EXECUTABLES) {
    const path = join(STAGING, relative)
    if (!existsSync(path)) continue
    await chmod(path, 0o755)
    console.log(`prepare-backend: chmod 755 ${relative}`)
  }
}

/**
 * Prove every staged native addon loads under the runtime that will actually
 * import it: the Node inside Electron, reached through `ELECTRON_RUN_AS_NODE`.
 *
 * This is the requirement an ABI rebuild exists to satisfy, tested directly. A
 * failure here means the prebuilds genuinely do not match, and the message says
 * what to run; it does not mean the machine is missing a compiler.
 * @param options - the resolved script options.
 */
async function verifyNativeAddons(options: Options): Promise<void> {
  if (options.skipNativeCheck) {
    console.log('prepare-backend: skipping the native addon check (--skip-native-check)')
    return
  }
  const present = NATIVE_MODULES.filter(name => existsSync(join(STAGING, 'node_modules', name)))
  if (present.length === 0) {
    console.log('prepare-backend: no native addons staged; nothing to check')
    return
  }
  const electron = await electronBinary()
  const probe = present.map(name => `require(${JSON.stringify(name)})`).join(';')
  await new Promise<void>((settle, reject) => {
    const child = spawn(electron, ['-e', probe], {
      cwd: STAGING,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'inherit', 'inherit'],
    })
    child.once('error', error => void reject(new Error(`prepare-backend: native addon check failed to spawn: ${error.message}`)))
    child.once('exit', (code) => {
      if (code === 0) {
        console.log(`prepare-backend: native addons load under Electron's Node: ${present.join(', ')}`)
        settle()
        return
      }
      reject(new Error(
        `prepare-backend: ${present.join(', ')} did not load under Electron's Node (exit code ${String(code)}).\n`
        + 'Rebuild them for this ABI with: pnpm --filter @deepseek-ai/dsh-desktop exec electron-rebuild '
        + `--version ${String(process.env.npm_package_version ?? '')} --module-dir ${STAGING} --only ${present.join(',')} --force`,
      ))
    })
  })
}

/**
 * Locate the Electron executable this package is pinned to.
 * @returns the absolute path of the Electron binary.
 */
async function electronBinary(): Promise<string> {
  const packageDir = join(desktopRoot, 'node_modules', 'electron')
  const relative = (await readFile(join(packageDir, 'path.txt'), 'utf8')).trim()
  const binary = join(packageDir, 'dist', relative)
  if (!existsSync(binary)) {
    throw new Error(`prepare-backend: ${binary} is missing; run pnpm install so Electron downloads its binary.`)
  }
  return binary
}

/** Print what was staged so a failed installer build is diagnosable from the log. */
async function report(): Promise<void> {
  const entry = join(STAGING, 'lib', 'bin.js')
  if (!existsSync(entry)) {
    throw new Error(`prepare-backend: ${entry} is missing after deploy; the staged closure has no CLI entry.`)
  }
  const packages = (await readdir(join(STAGING, 'node_modules'))).length
  console.log(`prepare-backend: staged ${String(packages)} top-level packages in ${STAGING}`)
  console.log(`prepare-backend: entry ${entry} (${String((await stat(entry)).size)} bytes)`)
}

const options = parseOptions(process.argv.slice(2))
await buildWorkspace(options)
try {
  await deployBackend(options)
} finally {
  // Legacy deploy writes hoisted copies into the deploy source's node_modules,
  // leaving the workspace out of step with the lockfile. Restoring it here, on
  // failure as well, keeps a failed run from blocking the next pnpm command in
  // this repository on its dependency check.
  if (!options.skipDeploy) await runPnpm('restore workspace', ['install'])
}
await repairClosure()
await restoreExecutables()
await verifyNativeAddons(options)
await report()
