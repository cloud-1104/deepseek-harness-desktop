/**
 * The window-chrome contract shared by the main process and the preload script.
 *
 * The window has no OS title bar. macOS keeps its native frame, which already
 * rounds the corners, and only insets its traffic lights. Every other platform
 * gets a frameless transparent window so the page can round its own corners —
 * Windows 10 does not round windows at all — and the preload script draws the
 * caption buttons that frame would otherwise provide.
 * @module @deepseek-ai/dsh-desktop/titlebar
 */

/**
 * Geometry of the caption-button group, placed on the app's own session-header
 * row rather than in a band of its own: a reserved band reads as a second layer
 * of chrome above an app that already has a header there.
 */
export const CAPTION = { top: 10, right: 12, height: 32, buttonWidth: 38, radius: 8 }

/** Horizontal room the session header gives up so its controls clear the buttons. */
export const CAPTION_INSET = CAPTION.right + 3 * CAPTION.buttonWidth + 12

/**
 * Height of the thin drag strip above the header's own padding. The header
 * itself is the roomy drag target; this covers the states that render no header.
 */
export const DRAG_STRIP_HEIGHT = 12

/** Corner radius of the window, applied by the page on the platforms that need it. */
export const CORNER_RADIUS = 10

/** Space the macOS traffic lights need above the sidebar's first row. */
export const TRAFFIC_LIGHT_INSET = 26

/** Renderer-to-main channel carrying a caption-button press. */
export const WINDOW_COMMAND_CHANNEL = 'desktop:window-command'

/** Main-to-renderer channel carrying the window's maximized state. */
export const WINDOW_STATE_CHANNEL = 'desktop:window-state'

/** What a caption button asks the main process to do. */
export type WindowCommand = 'minimize' | 'toggle-maximize' | 'close'

/** The commands this contract accepts; anything else is rejected at the process boundary. */
const COMMANDS: readonly string[] = ['minimize', 'toggle-maximize', 'close']

/**
 * Validate a window command arriving from the renderer.
 * @param value - the raw IPC argument.
 * @returns the command when it is one of the three, otherwise `undefined`.
 */
export function parseWindowCommand(value: unknown): WindowCommand | undefined {
  return typeof value === 'string' && COMMANDS.includes(value) ? value as WindowCommand : undefined
}
