/**
 * Supervisor for the harness backend child process. The shell runs
 * `dsh web --port 0` under `ELECTRON_RUN_AS_NODE`, so the backend uses the
 * Node runtime already inside Electron instead of a second bundled runtime,
 * and reads the listening URL off the child's stdout.
 * @module @deepseek-ai/dsh-desktop/backend
 */

import { spawn, type ChildProcess } from 'node:child_process'
import type { DesktopLayout } from './paths.ts'

/**
 * The line `dsh web` prints once the server is listening. Port 0 is resolved by
 * the OS before this line is produced, so the captured port is the real one.
 * A LAN suffix may follow; only the loopback URL is captured.
 */
const READY_LINE = /^dsh web:\s+(http:\/\/127\.0\.0\.1:\d+)\s*(?:\(|$)/

/** Output lines retained for the diagnostic attached to a startup failure. */
const OUTPUT_TAIL_LINES = 40

/**
 * Extract the loopback server URL from one backend output line.
 * @param line - a single line of backend stdout, without its terminator.
 * @returns the loopback URL, or `undefined` when the line is not the ready line.
 */
export function parseServerUrl(line: string): string | undefined {
  return READY_LINE.exec(line)?.[1]
}

/** Everything the supervisor needs to launch and observe the backend. */
export interface BackendSupervisorOptions {
  /** Binary the child runs; the Electron executable in every shipped launch. */
  execPath: string
  /** Resolved directories and the CLI entry. */
  layout: DesktopLayout
  /** Environment the child environment is derived from, normally `process.env`. */
  baseEnv: NodeJS.ProcessEnv
  /** How long a single launch may take to print its ready line before it is failed. */
  startupTimeoutMs: number
  /** Grace period a terminating child gets before it is killed outright. */
  shutdownGraceMs: number
  /** How many times an already-ready backend may be relaunched after an unexpected exit. */
  maxRestarts: number
  /** Receives every backend output line, for the log file. */
  onOutput: (line: string) => void
  /** Called for each successful launch, including relaunches after a crash. */
  onReady: (url: string) => void
  /** Called when the backend cannot be kept alive; the shell surfaces this to the user. */
  onFatal: (error: Error) => void
}

/** Lifecycle phase of the supervised backend. */
type Phase = 'idle' | 'starting' | 'ready' | 'stopping' | 'stopped'

/**
 * Owns the backend child across its whole lifetime: one launch attempt at a
 * time, bounded relaunches after an unexpected exit, and a process-tree
 * teardown that leaves nothing behind when the window closes.
 */
export class BackendSupervisor {
  private readonly options: BackendSupervisorOptions
  private phase: Phase = 'idle'
  private child: ChildProcess | undefined
  private restarts = 0
  private readonly tail: string[] = []

  /**
   * @param options - launch inputs and the callbacks the shell reacts through.
   */
  constructor(options: BackendSupervisorOptions) {
    this.options = options
  }

  /**
   * Launch the backend and wait for it to report its listening URL.
   * @returns the loopback URL the window should load.
   */
  async start(): Promise<string> {
    if (this.phase !== 'idle' && this.phase !== 'stopped') {
      throw new Error(`backend: start() called while ${this.phase}`)
    }
    return await this.launch()
  }

  /** Terminate the backend and its descendants, then settle in the stopped phase. */
  async stop(): Promise<void> {
    if (this.phase === 'stopping' || this.phase === 'stopped' || this.phase === 'idle') {
      this.phase = 'stopped'
      return
    }
    this.phase = 'stopping'
    const child = this.child
    this.child = undefined
    if (child !== undefined) await terminate(child, this.options.shutdownGraceMs)
    this.phase = 'stopped'
  }

  /**
   * Spawn one child and settle on its ready line, its exit, or the timeout.
   * @returns the loopback URL printed by this child.
   */
  private async launch(): Promise<string> {
    this.phase = 'starting'
    const { execPath, layout, baseEnv, startupTimeoutMs } = this.options
    // Launcher flags first, then the web app's own: the launcher hands
    // everything after its own flags to the booted profile.
    const args = [
      layout.backendEntry,
      '--profile', 'web',
      '--patch', layout.patchFile,
      '--host', '127.0.0.1',
      '--port', '0',
    ]
    const child = spawn(execPath, args, {
      cwd: layout.workspaceDir,
      // ELECTRON_RUN_AS_NODE turns the Electron binary into the plain Node the
      // harness expects. `DSH_HOME` is left alone so the app reads the same
      // harness home as the CLI, including a user's own override.
      env: { ...baseEnv, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      // A POSIX process group lets teardown reach the shells and sandbox
      // helpers the backend spawns. On Windows the same flag would open a
      // console window, so the tree is reached with taskkill instead.
      detached: process.platform !== 'win32',
      windowsHide: true,
    })
    this.child = child

    return await new Promise<string>((settleReady, failLaunch) => {
      let settled = false
      const timer = setTimeout(() => {
        finish(new Error(`backend: no listening URL within ${String(startupTimeoutMs)}ms\n${this.tailText()}`))
      }, startupTimeoutMs)

      const finish = (error?: Error, url?: string): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (url !== undefined) {
          this.phase = 'ready'
          settleReady(url)
        } else {
          failLaunch(error ?? new Error('backend: launch failed'))
        }
      }

      readLines(child, (line) => {
        this.record(line)
        const url = parseServerUrl(line)
        if (url !== undefined) finish(undefined, url)
      })

      child.on('error', (error) => {
        finish(new Error(`backend: failed to spawn ${execPath}: ${error.message}`))
      })

      // 'close', not 'exit': a child that prints its ready line and then dies
      // can deliver the exit before the buffered stdout, which would report a
      // silent crash for output the shell has in hand.
      child.on('close', (code, signal) => {
        const description = signal === null ? `exit code ${String(code)}` : `signal ${signal}`
        finish(new Error(`backend: exited during startup (${description})\n${this.tailText()}`))
        this.handleExit(description)
      })
    })
  }

  /**
   * React to a child exit. An exit during teardown is expected; an exit after
   * the backend was ready is relaunched while the budget allows.
   * @param description - how the child ended, for the fatal diagnostic.
   */
  private handleExit(description: string): void {
    if (this.phase === 'stopping' || this.phase === 'stopped') return
    this.child = undefined
    if (this.phase !== 'ready') {
      this.phase = 'stopped'
      return
    }
    if (this.restarts >= this.options.maxRestarts) {
      this.phase = 'stopped'
      this.options.onFatal(new Error(`backend: stopped after ${String(this.restarts)} restarts (${description})\n${this.tailText()}`))
      return
    }
    this.restarts += 1
    this.options.onOutput(`[shell] backend ${description}; restart ${String(this.restarts)} of ${String(this.options.maxRestarts)}`)
    this.launch().then(
      (url) => { this.options.onReady(url) },
      (error: unknown) => { this.options.onFatal(error instanceof Error ? error : new Error(String(error))) },
    )
  }

  /**
   * Forward one output line to the log and keep it in the failure tail.
   * @param line - the backend output line.
   */
  private record(line: string): void {
    this.options.onOutput(line)
    this.tail.push(line)
    if (this.tail.length > OUTPUT_TAIL_LINES) this.tail.shift()
  }

  /**
   * Render the retained output for a diagnostic message.
   * @returns the most recent backend output lines.
   */
  private tailText(): string {
    return this.tail.join('\n')
  }
}

/**
 * Deliver both child output streams as complete lines.
 * @param child - the spawned backend.
 * @param onLine - receives each line without its terminator.
 */
function readLines(child: ChildProcess, onLine: (line: string) => void): void {
  for (const stream of [child.stdout, child.stderr]) {
    if (stream === null) continue
    let buffered = ''
    stream.setEncoding('utf8')
    stream.on('data', (chunk: string) => {
      buffered += chunk
      const parts = buffered.split(/\r?\n/)
      buffered = parts.pop() ?? ''
      for (const part of parts) onLine(part)
    })
    stream.on('end', () => {
      if (buffered.length > 0) onLine(buffered)
      buffered = ''
    })
  }
}

/**
 * Terminate a child and everything it spawned, escalating after the grace period.
 * @param child - the running backend.
 * @param graceMs - how long the tree may take to exit before it is killed.
 */
async function terminate(child: ChildProcess, graceMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = new Promise<void>(settle => child.once('exit', () => { settle() }))
  const { pid } = child
  if (pid === undefined) return
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true })
    await exited
    return
  }
  signalGroup(pid, 'SIGTERM')
  const escalation = setTimeout(() => { signalGroup(pid, 'SIGKILL') }, graceMs)
  await exited
  clearTimeout(escalation)
}

/**
 * Signal a POSIX process group, tolerating a group that has already exited.
 * @param pid - the group leader, which is the spawned child.
 * @param signal - the signal to deliver.
 */
function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal)
  } catch {
    // ESRCH only: the group is already gone, which is the outcome being asked for.
    // No other error is reachable — the pid comes from a child this process spawned.
  }
}
