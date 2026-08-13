/**
 * Host-console provisioning for the restricted-token backend.
 *
 * A confined child is created without `CREATE_NO_WINDOW` and without
 * `CREATE_NEW_CONSOLE`, because under this restriction scheme a child that has
 * to build its own console dies with `STATUS_DLL_INIT_FAILED` (0xC0000142)
 * before running a line of its own code. That leaves sharing the host's
 * console as the only working arrangement — and a host that owns no console
 * puts every console child back on the failing path, since Windows then
 * allocates one for the child under the restricted token.
 *
 * Console-less hosts are ordinary: a GUI process, a Windows service, a
 * detached daemon. So the backend gives itself a console when it has none and
 * hides its window immediately, rather than emitting children that abort with
 * an opaque exit code and empty output.
 * @module @deepseek-ai/dsh-sandbox-windows-acl/console
 */

import { isNullPtr, throwWin32, type Win32Bindings } from './ffi.ts'
import * as abi from './win32-abi.ts'

/**
 * Ensure this process owns a console, allocating a hidden one when it does not.
 *
 * Idempotent by observation rather than by a cached flag: once a console
 * exists, the code-page probe reports it and the call returns. Fails closed —
 * an allocation this backend cannot complete would otherwise surface as a
 * confined child that exits 0xC0000142 with no output.
 * @param api - the resolved Win32 bindings.
 */
export function ensureHostConsole(api: Win32Bindings): void {
  if (api.getConsoleCP() !== 0) return
  if (api.allocConsole() === 0) {
    const code = api.getLastError()
    // A console attached between the probe and the request is the outcome asked for.
    if (code === abi.ERROR_ACCESS_DENIED) return
    throwWin32(api, 'AllocConsole', code, 'confined children need a console this process can share')
  }
  const window = api.getConsoleWindow()
  // A ConPTY console has no window of its own and is already invisible.
  if (!isNullPtr(window)) api.showWindow(window, abi.SW_HIDE)
}

/**
 * Whether this process's console window is currently hidden — which it is
 * exactly when {@link ensureHostConsole} had to create it.
 *
 * A confined child attaching to a shared console brings that console's window
 * back up unless it asks for the hidden show state, so the spawn passes
 * `SW_HIDE` on this condition alone. Asking it of the live window rather than
 * remembering an earlier decision is what keeps a terminal host safe: hiding a
 * console this process did not create would take the user's terminal with it.
 * @param api - the resolved Win32 bindings.
 * @returns whether children must be started with the hidden show state.
 */
export function hostConsoleIsHidden(api: Win32Bindings): boolean {
  const window = api.getConsoleWindow()
  return !isNullPtr(window) && api.isWindowVisible(window) === 0
}
