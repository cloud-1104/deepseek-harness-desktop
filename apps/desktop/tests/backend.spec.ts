import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BackendSupervisor, parseServerUrl, type BackendSupervisorOptions } from '../src/backend.ts'
import type { DesktopLayout } from '../src/paths.ts'

const FIXTURES = join(import.meta.dirname, 'fixtures')

/** Spawning a Node process is slow enough on Windows that a tight budget would flake. */
const STARTUP_BUDGET_MS = 20_000

const running: BackendSupervisor[] = []

afterEach(async () => {
  for (const supervisor of running.splice(0)) await supervisor.stop()
})

/**
 * Build a supervisor over one fixture backend.
 * @param fixture - the fixture file name inside tests/fixtures.
 * @param overrides - options replacing the defaults for this case.
 * @returns the supervisor and the callback records the case asserts on.
 */
function supervise(
  fixture: string,
  overrides: Partial<BackendSupervisorOptions> = {},
): { supervisor: BackendSupervisor; output: string[]; ready: string[]; fatal: Error[] } {
  const workspaceDir = mkdtempSync(join(tmpdir(), 'dsh-desktop-'))
  const layout: DesktopLayout = {
    backendRoot: FIXTURES,
    backendEntry: join(FIXTURES, fixture),
    workspaceDir,
    logDir: join(workspaceDir, 'logs'),
    patchFile: join(FIXTURES, 'unused.patch.yml'),
  }
  const output: string[] = []
  const ready: string[] = []
  const fatal: Error[] = []
  const supervisor = new BackendSupervisor({
    execPath: process.execPath,
    layout,
    baseEnv: process.env,
    startupTimeoutMs: STARTUP_BUDGET_MS,
    shutdownGraceMs: 2_000,
    maxRestarts: 0,
    onOutput: line => void output.push(line),
    onReady: url => void ready.push(url),
    onFatal: error => void fatal.push(error),
    ...overrides,
  })
  running.push(supervisor)
  return { supervisor, output, ready, fatal }
}

describe('ready line parsing', () => {
  it('captures the loopback URL and ignores the LAN suffix', () => {
    expect(parseServerUrl('dsh web: http://127.0.0.1:3080')).toBe('http://127.0.0.1:3080')
    expect(parseServerUrl('dsh web: http://127.0.0.1:51234 (LAN: http://10.0.0.2:51234)'))
      .toBe('http://127.0.0.1:51234')
  })

  it('ignores every other line the backend prints', () => {
    for (const line of [
      '',
      'cordis: loader ready',
      'dsh web: starting',
      'listening on http://127.0.0.1:3080',
      'dsh web: http://192.168.1.4:3080',
    ]) {
      expect(parseServerUrl(line)).toBeUndefined()
    }
  })
})

describe('backend supervision', () => {
  it('resolves with the URL the backend reports and forwards its output', async () => {
    const { supervisor, output } = supervise('ready-backend.mjs')

    await expect(supervisor.start()).resolves.toBe('http://127.0.0.1:45999')
    expect(output).toContain('cordis: loader ready')
  }, STARTUP_BUDGET_MS + 10_000)

  it('reports the captured output when the backend dies before listening', async () => {
    const { supervisor } = supervise('failing-backend.mjs')

    await expect(supervisor.start()).rejects.toThrow(/frontend dist not built/)
  }, STARTUP_BUDGET_MS + 10_000)

  it('fails the launch when no URL arrives within the budget', async () => {
    const { supervisor } = supervise('silent-backend.mjs', { startupTimeoutMs: 800 })

    await expect(supervisor.start()).rejects.toThrow(/no listening URL within 800ms/)
  }, 20_000)

  it('relaunches a backend that dies after listening, then gives up on the budget', async () => {
    const { supervisor, ready, fatal } = supervise('crashing-backend.mjs', { maxRestarts: 1 })

    await expect(supervisor.start()).resolves.toBe('http://127.0.0.1:45998')
    await waitFor(() => fatal.length > 0)

    expect(ready).toEqual(['http://127.0.0.1:45998'])
    expect(fatal[0]?.message).toMatch(/stopped after 1 restarts/)
  }, 30_000)

  it('stops a running backend and tolerates a second stop', async () => {
    const { supervisor } = supervise('ready-backend.mjs')
    await supervisor.start()

    await supervisor.stop()
    await supervisor.stop()
  }, STARTUP_BUDGET_MS + 10_000)
})

/**
 * Poll until a condition holds.
 * @param condition - evaluated on every tick.
 */
async function waitFor(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 20_000
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('waitFor: condition never held')
    await new Promise(settle => setTimeout(settle, 25))
  }
}
