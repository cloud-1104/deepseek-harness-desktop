/**
 * Desktop entry point. The shell owns exactly three things: the backend child's
 * lifetime, the window that loads its loopback URL, and the update check.
 * Everything the user interacts with is the harness web UI served by that
 * backend, unchanged from `dsh web`.
 * @module @deepseek-ai/dsh-desktop/main
 */

import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { app, BrowserWindow, dialog, ipcMain, Menu, shell, type MenuItemConstructorOptions } from 'electron'
import { BackendSupervisor } from './backend.ts'
import { BackendLog } from './logging.ts'
import { resolveLayout } from './paths.ts'
import { APP_ID, PRODUCT_NAME, RELEASES_URL } from './product.ts'
import { parseWindowCommand, WINDOW_COMMAND_CHANNEL, WINDOW_STATE_CHANNEL } from './titlebar.ts'
import { installUpdater } from './updater.ts'

/**
 * First launch heals the profile module links and mounts the full plugin tree,
 * which is far slower than a warm start; the budget covers a cold install on a
 * slow disk rather than a steady-state boot.
 */
const STARTUP_TIMEOUT_MS = 120_000

/** How long the backend tree may take to exit before it is killed outright. */
const SHUTDOWN_GRACE_MS = 5_000

/** Relaunches allowed after an already-ready backend exits unexpectedly. */
const MAX_RESTARTS = 3

/** Size above which the backend log rotates at launch. */
const LOG_MAX_BYTES = 8 * 1024 * 1024

/** Initial window geometry. */
const WINDOW = { width: 1280, height: 860, minWidth: 940, minHeight: 620 }

/** Painted behind the page so a cold start does not flash white. */
const BACKGROUND_COLOR = '#16161a'

/**
 * macOS keeps its native frame — it already rounds the window and owns the
 * traffic lights — while every other platform drops the frame entirely so the
 * page can round its own corners. Windows 10 rounds nothing on its own.
 */
const NATIVE_FRAME = process.platform === 'darwin'

if (app.requestSingleInstanceLock()) {
  void run()
} else {
  app.quit()
}

/** Boot the shell: window first, then the backend it will point at. */
async function run(): Promise<void> {
  // Set explicitly rather than derived from the app name: Electron resolves
  // userData before an early setName can take effect, and the unpackaged
  // default is this workspace's scoped package name.
  app.setName(PRODUCT_NAME)
  app.setPath('userData', join(app.getPath('appData'), PRODUCT_NAME))
  app.setAppUserModelId(APP_ID)
  const layout = resolveLayout({
    packaged: app.isPackaged,
    appPath: app.getAppPath(),
    resourcesPath: process.resourcesPath,
    userData: app.getPath('userData'),
  })
  mkdirSync(layout.workspaceDir, { recursive: true })
  const log = new BackendLog(layout.logDir, LOG_MAX_BYTES)

  await app.whenReady()
  Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate(log.filePath)))
  const window = createWindow(app.getAppPath())
  serveWindowControls(window)

  const backend = new BackendSupervisor({
    execPath: process.execPath,
    layout,
    baseEnv: process.env,
    startupTimeoutMs: STARTUP_TIMEOUT_MS,
    shutdownGraceMs: SHUTDOWN_GRACE_MS,
    maxRestarts: MAX_RESTARTS,
    onOutput: (line) => { log.append(line) },
    onReady: url => void window.loadURL(url),
    onFatal: (error) => { fail(error) },
  })

  /**
   * Report a terminal backend failure and leave. The backend is torn down
   * first: `app.exit` skips `before-quit`, so nothing else would reap the child.
   * @param error - the failure the supervisor gave up on.
   */
  function fail(error: Error): void {
    dialog.showErrorBox(`${PRODUCT_NAME} 无法启动`, `${error.message}\n\n运行日志：${log.filePath}`)
    void backend.stop().finally(() => {
      log.close()
      app.exit(1)
    })
  }

  let stopping = false
  app.on('second-instance', () => {
    if (window.isMinimized()) window.restore()
    window.focus()
  })
  app.on('before-quit', (event) => {
    if (stopping) return
    stopping = true
    event.preventDefault()
    void backend.stop().finally(() => {
      log.close()
      app.quit()
    })
  })
  app.on('window-all-closed', () => { app.quit() })

  if (!existsSync(layout.backendEntry)) {
    fail(new Error(`未找到后端运行时：${layout.backendEntry}\n\n请先执行 pnpm run desktop:prepare 生成 backend-dist。`))
    return
  }

  try {
    const url = await backend.start()
    log.append(`[shell] backend ready at ${url}`)
    await window.loadURL(url)
  } catch (error: unknown) {
    fail(error instanceof Error ? error : new Error(String(error)))
    return
  }

  if (app.isPackaged) {
    installUpdater({
      platform: process.platform,
      log: (line) => { log.append(line) },
      offerManualDownload: (version) => { offerManualDownload(version) },
    })
  }
}

/**
 * Create the window and open every non-loopback link in the system browser.
 * @param appPath - `app.getAppPath()`, the root the loading page is resolved from.
 * @returns the created window.
 */
function createWindow(appPath: string): BrowserWindow {
  const window = new BrowserWindow({
    ...WINDOW,
    title: PRODUCT_NAME,
    // A transparent window may not declare an opaque background, or the page
    // would be composited over it and the rounded corners would be square.
    backgroundColor: NATIVE_FRAME ? BACKGROUND_COLOR : '#00000000',
    // No OS title bar anywhere. macOS keeps the frame and insets its traffic
    // lights over the page; the other platforms drop the frame entirely, and
    // the preload script draws the caption buttons and rounds the corners.
    ...NATIVE_FRAME
      ? { titleBarStyle: 'hidden' as const, trafficLightPosition: { x: 12, y: 10 } }
      : { frame: false, transparent: true, roundedCorners: true },
    // Off-screen until Alt: the menu exists for the macOS editing accelerators
    // and the Help entries, not as part of this window's chrome.
    autoHideMenuBar: !NATIVE_FRAME,
    webPreferences: {
      // The page is the harness UI served over loopback; it needs no Node
      // access, and the preload only measures and paints window chrome.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: join(appPath, 'lib', 'preload.cjs'),
    },
  })
  void window.loadFile(join(appPath, 'assets', 'loading.html'))
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })
  return window
}

/**
 * Serve the caption buttons the missing frame no longer provides, and keep the
 * page's maximized state current so it can drop its corner radius when the
 * window fills the screen.
 * @param window - the window the buttons act on.
 */
function serveWindowControls(window: BrowserWindow): void {
  ipcMain.on(WINDOW_COMMAND_CHANNEL, (event, payload: unknown) => {
    if (event.sender !== window.webContents || window.isDestroyed()) return
    switch (parseWindowCommand(payload)) {
      case 'minimize':
        window.minimize()
        break
      case 'toggle-maximize':
        if (window.isMaximized()) window.unmaximize()
        else window.maximize()
        break
      case 'close':
        window.close()
        break
      case undefined:
        break
    }
  })
  const publish = (): void => {
    if (!window.isDestroyed()) window.webContents.send(WINDOW_STATE_CHANNEL, window.isMaximized())
  }
  window.on('maximize', publish)
  window.on('unmaximize', publish)
  window.webContents.on('did-finish-load', publish)
}

/**
 * Build the menu. It exists mainly so the standard editing accelerators keep
 * working on macOS, where an app without a menu has no copy or paste.
 * @param logPath - the backend log file offered under Help.
 * @returns the menu template.
 */
function menuTemplate(logPath: string): MenuItemConstructorOptions[] {
  const appMenu: MenuItemConstructorOptions[] = process.platform === 'darwin'
    ? [{ role: 'appMenu' }]
    : []
  return [
    ...appMenu,
    { role: 'editMenu', label: '编辑' },
    {
      label: '视图',
      submenu: [
        { role: 'reload', label: '重新加载' },
        { role: 'toggleDevTools', label: '开发者工具' },
        { type: 'separator' },
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏' },
      ],
    },
    { role: 'windowMenu', label: '窗口' },
    {
      label: '帮助',
      submenu: [
        { label: '打开运行日志', click: () => { shell.showItemInFolder(logPath) } },
        { label: '前往发布页', click: () => void shell.openExternal(RELEASES_URL) },
      ],
    },
  ]
}

/**
 * Offer the download page for an update this platform cannot apply in place.
 * @param version - the version found in the update feed.
 */
function offerManualDownload(version: string): void {
  const choice = dialog.showMessageBoxSync({
    type: 'info',
    title: `${PRODUCT_NAME} 有新版本`,
    message: `新版本 ${version} 已发布。`,
    detail: '当前 macOS 构建未签名，无法自动安装更新，请前往发布页下载。',
    buttons: ['前往下载', '稍后'],
    defaultId: 0,
    cancelId: 1,
  })
  if (choice === 0) void shell.openExternal(RELEASES_URL)
}
