/**
 * Window chrome for the hosted page. The window ships without an OS title bar,
 * so this script supplies what the frame no longer provides: caption buttons,
 * a drag region, rounded corners, and the room the app's own header gives up
 * so its controls clear the buttons.
 *
 * The chrome takes its colors from the app's theme tokens, so it follows light
 * and dark without the shell being told which is active.
 *
 * This script only paints chrome and forwards three window commands. It adds no
 * capability to the page, which is why the renderer stays sandboxed.
 * @module @deepseek-ai/dsh-desktop/preload
 */

import { ipcRenderer } from 'electron'
import {
  CAPTION,
  CAPTION_INSET,
  CORNER_RADIUS,
  DRAG_STRIP_HEIGHT,
  TRAFFIC_LIGHT_INSET,
  WINDOW_COMMAND_CHANNEL,
  WINDOW_STATE_CHANNEL,
  type WindowCommand,
} from './titlebar.ts'

/** Above the app's own overlay layer, which is the highest thing the page stacks. */
const CHROME_Z_INDEX = 2147483000

/** Namespaced so injected chrome cannot collide with app styles. */
const PREFIX = 'dsh-desktop'

/** macOS keeps its native frame: it rounds the window itself and owns the traffic lights. */
const mac = process.platform === 'darwin'

/** The caption buttons, in the order Windows and Linux place them. */
const COMMANDS = ['minimize', 'toggle-maximize', 'close'] as const

/** Caption-button glyphs, stroked on a 10x10 grid. */
const GLYPHS: Record<WindowCommand, string> = {
  'minimize': '<path d="M0 5h10" />',
  'toggle-maximize': '<rect x="0.5" y="0.5" width="9" height="9" rx="1.5" />',
  'close': '<path d="M0 0l10 10M10 0L0 10" />',
}

/** Accessible labels for the caption buttons. */
const LABELS: Record<WindowCommand, string> = {
  'minimize': '最小化',
  'toggle-maximize': '最大化',
  'close': '关闭',
}

/**
 * Everything inside the header that must stay clickable once the header itself
 * becomes a drag surface. Broad on purpose: a control missed here would be
 * dead, while a non-control matched here only loses a drag start.
 */
const INTERACTIVE = 'button,a,input,textarea,select,[role],[tabindex],[contenteditable]'

/**
 * The app frame element. The shell anchors on the overlay layer's parent rather
 * than a class name because the app styles through hashed CSS Modules, while
 * `data-shell-overlay` is a stable attribute of the layout it owns.
 * @returns the frame, or `undefined` before the app has mounted.
 */
function appFrame(): HTMLElement | undefined {
  const overlay = document.querySelector('[data-shell-overlay]')
  return overlay?.parentElement instanceof HTMLElement ? overlay.parentElement : undefined
}

/** Install the stylesheet for the caption buttons, the drag surfaces, and the corners. */
function injectStyles(): void {
  const style = document.createElement('style')
  style.textContent = `
    .${PREFIX}-drag{position:fixed;top:0;left:0;right:0;height:${String(DRAG_STRIP_HEIGHT)}px;
      -webkit-app-region:drag;z-index:${String(CHROME_Z_INDEX)};}
    .${PREFIX}-center header{padding-right:${String(CAPTION_INSET)}px !important;
      -webkit-app-region:drag;}
    .${PREFIX}-center header ${INTERACTIVE}{-webkit-app-region:no-drag;}
    .${PREFIX}-caption{position:fixed;top:${String(CAPTION.top)}px;right:${String(CAPTION.right)}px;
      display:flex;height:${String(CAPTION.height)}px;border-radius:${String(CAPTION.radius)}px;
      overflow:hidden;-webkit-app-region:no-drag;
      color:var(--dsw-alias-label-primary,CanvasText);z-index:${String(CHROME_Z_INDEX + 1)};}
    .${PREFIX}-caption button{width:${String(CAPTION.buttonWidth)}px;border:0;padding:0;
      background:transparent;color:inherit;display:flex;align-items:center;justify-content:center;
      cursor:default;opacity:0.5;transition:background-color 120ms ease,opacity 120ms ease;}
    .${PREFIX}-caption button:hover{opacity:1;background:color-mix(in srgb,currentColor 10%,transparent);}
    .${PREFIX}-caption button[data-command="close"]:hover{background:#e5484d;color:#fff;opacity:1;}
    .${PREFIX}-caption svg{width:10px;height:10px;stroke:currentColor;stroke-width:1.1;fill:none;}
    ${mac ? '' : `html{background:transparent !important;}
    body{border-radius:${String(CORNER_RADIUS)}px;overflow:hidden;
      background:var(--dsw-alias-bg-base,Canvas);}
    body[data-${PREFIX}-maximized]{border-radius:0;}`}
  `
  document.head.append(style)
}

/**
 * Build the caption buttons. macOS is skipped: its traffic lights are part of
 * the frame that window keeps.
 */
function createCaption(): void {
  if (mac) return
  const bar = document.createElement('div')
  bar.className = `${PREFIX}-caption`
  for (const command of COMMANDS) {
    const button = document.createElement('button')
    button.type = 'button'
    button.dataset['command'] = command
    button.title = LABELS[command]
    button.setAttribute('aria-label', LABELS[command])
    button.innerHTML = `<svg viewBox="-1 -1 12 12" aria-hidden="true">${GLYPHS[command]}</svg>`
    button.addEventListener('click', () => { ipcRenderer.send(WINDOW_COMMAND_CHANNEL, command) })
    bar.append(button)
  }
  document.body.append(bar)
}

/** Add the thin drag strip that covers the states rendering no session header. */
function createDragStrip(): void {
  const strip = document.createElement('div')
  strip.className = `${PREFIX}-drag`
  document.body.append(strip)
}

/**
 * Mark the app's center column so the header rules apply to it, and keep the
 * macOS traffic lights clear of the sidebar's first row.
 *
 * The mount observer stops at the first attach on purpose: it watches the whole
 * subtree, and a streaming conversation mutates that subtree constantly. The
 * frame outlives every such mutation, and a reload runs this script again.
 */
function markAppColumns(): void {
  const attach = (): boolean => {
    const frame = appFrame()
    const sidebar = frame?.children[0]
    const center = frame?.children[1]
    if (!(sidebar instanceof HTMLElement) || !(center instanceof HTMLElement)) return false
    center.classList.add(`${PREFIX}-center`)
    if (mac) sidebar.style.paddingTop = `${String(TRAFFIC_LIGHT_INSET)}px`
    return true
  }
  if (attach()) return
  const mounted = new MutationObserver(() => {
    if (attach()) mounted.disconnect()
  })
  mounted.observe(document.body, { childList: true, subtree: true })
}

window.addEventListener('DOMContentLoaded', () => {
  injectStyles()
  createCaption()
  createDragStrip()
  markAppColumns()
  ipcRenderer.on(WINDOW_STATE_CHANNEL, (_event, maximized: unknown) => {
    document.body.toggleAttribute(`data-${PREFIX}-maximized`, maximized === true)
  })
})
