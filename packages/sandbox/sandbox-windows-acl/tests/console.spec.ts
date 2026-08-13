/**
 * Host-console provisioning, driven through stub binding tables so every
 * branch runs on any platform. The end-to-end proof that a console-less host
 * can still spawn a confined child lives in runner.spec.ts's real-process lane.
 */

import { describe, expect, it, vi } from 'vitest'

import { ensureHostConsole, hostConsoleIsHidden } from '../src/console.ts'
import { Win32Error } from '../src/errors.ts'
import type { NativePtr, Win32Bindings } from '../src/ffi.ts'
import * as abi from '../src/win32-abi.ts'

/** Observable calls of one stubbed run. */
interface Stub {
  api: Win32Bindings
  allocConsole: ReturnType<typeof vi.fn>
  showWindow: ReturnType<typeof vi.fn>
}

/**
 * Build a stub binding table.
 * @param options - the console code page, the AllocConsole result, its error code, and the console window.
 * @returns the stub table and the spies the assertions read.
 */
function stub(options: {
  consoleCP: number
  allocResult?: number
  lastError?: number
  consoleWindow?: bigint
  windowVisible?: number
}): Stub {
  const allocConsole = vi.fn(() => options.allocResult ?? 1)
  const showWindow = vi.fn(() => 1)
  const api = {
    getConsoleCP: vi.fn(() => options.consoleCP),
    getConsoleWindow: vi.fn(() => (options.consoleWindow ?? 0n) as NativePtr),
    allocConsole,
    showWindow,
    isWindowVisible: vi.fn(() => options.windowVisible ?? 1),
    getLastError: vi.fn(() => options.lastError ?? 0),
    formatMessageW: vi.fn(() => 0),
  } as unknown as Win32Bindings
  return { api, allocConsole, showWindow }
}

describe('host console provisioning', () => {
  it('leaves a host that already owns a console alone', () => {
    const { api, allocConsole, showWindow } = stub({ consoleCP: 65001 })

    ensureHostConsole(api)

    expect(allocConsole).not.toHaveBeenCalled()
    expect(showWindow).not.toHaveBeenCalled()
  })

  it('allocates a console for a console-less host and hides its window', () => {
    const { api, allocConsole, showWindow } = stub({ consoleCP: 0, consoleWindow: 0x2a10n })

    ensureHostConsole(api)

    expect(allocConsole).toHaveBeenCalledOnce()
    expect(showWindow).toHaveBeenCalledWith(0x2a10n, abi.SW_HIDE)
  })

  it('hides nothing when the allocated console has no window of its own', () => {
    const { api, allocConsole, showWindow } = stub({ consoleCP: 0, consoleWindow: 0n })

    ensureHostConsole(api)

    expect(allocConsole).toHaveBeenCalledOnce()
    expect(showWindow).not.toHaveBeenCalled()
  })

  it('accepts a console attached between the probe and the request', () => {
    const { api, showWindow } = stub({
      consoleCP: 0,
      allocResult: 0,
      lastError: abi.ERROR_ACCESS_DENIED,
    })

    ensureHostConsole(api)

    expect(showWindow).not.toHaveBeenCalled()
  })

  it('fails closed when the console cannot be allocated', () => {
    const { api } = stub({ consoleCP: 0, allocResult: 0, lastError: 8 })

    expect(() => { ensureHostConsole(api) }).toThrow(Win32Error)
    expect(() => { ensureHostConsole(api) }).toThrow(/AllocConsole/)
  })
})

describe('hidden-console detection', () => {
  it('reports hidden for the console this process allocated and hid', () => {
    const { api } = stub({ consoleCP: 65001, consoleWindow: 0x2a10n, windowVisible: 0 })

    expect(hostConsoleIsHidden(api)).toBe(true)
  })

  it('reports visible for a terminal host, whose window must never be hidden', () => {
    const { api } = stub({ consoleCP: 65001, consoleWindow: 0x2a10n, windowVisible: 1 })

    expect(hostConsoleIsHidden(api)).toBe(false)
  })

  it('reports visible for a ConPTY console, which has no window to hide', () => {
    const { api } = stub({ consoleCP: 65001, consoleWindow: 0n })

    expect(hostConsoleIsHidden(api)).toBe(false)
  })
})
