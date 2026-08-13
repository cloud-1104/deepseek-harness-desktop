# Agent Note: Electron desktop shell hosting the web runtime as a child process

Status: implemented

English | [中文](2026-08-13-electron-desktop-shell.zh.md)

## Problem

The harness reaches its users as an npm CLI. Opening the GUI takes a Node toolchain, an install, a workspace build, a terminal command, and then a browser tab. That is a developer distribution, not a product one.

A desktop distribution has to keep the whole runtime — agent loop, shells, sandbox, PTY, filesystem tools — because that runtime is the product. What must disappear is the terminal, not the capability.

## Decision

[`apps/desktop`](../../../../apps/desktop/README.md) is an Electron 43 shell around the unchanged web runtime. A launch is four steps:

1. The shell resolves its layout and shows a local loading page.
2. It spawns `<electron binary> <backend>/lib/bin.js web --host 127.0.0.1 --port 0` with `ELECTRON_RUN_AS_NODE=1`.
3. It captures `dsh web: http://127.0.0.1:<port>` from the child's stdout, which is the real OS-assigned port.
4. It loads that URL in the window.

No harness package changed. `--port 0`, the fixed ready line, the loopback trust fence on `/api`, credential onboarding inside the UI, and GUI-managed workspaces already made the web runtime hostable by another process; the shell only consumes them.

### Why the backend runs as a child process

Electron's binary doubles as a Node runtime under `ELECTRON_RUN_AS_NODE`, so the child costs nothing in installer size and every native addon still targets one ABI. Running the Cordis tree in the main process would put agent work, compaction, and tool execution on the same event loop that paints the window, and would make a backend crash close the app.

An already-listening backend that exits is relaunched up to three times, after which the shell reports the failure with its log path and quits. Teardown reaches the whole tree — `taskkill /t` on Windows, a process-group signal on POSIX — because the backend spawns shells, sandbox helpers, and PTYs of its own.

### Why the backend ships outside the asar

[`scripts/prepare-backend.ts`](../../../../apps/desktop/scripts/prepare-backend.ts) deploys the `@deepseek-ai/dsh` production closure into a plain directory that `extraResources` copies beside the archive. Three mechanisms in profile boot read real files and would break inside an archive:

- `healProfilesModuleFallback` links `$DSH_HOME/profiles/node_modules` at these package directories.
- Bundle resolution reads each package's `dsh.bundle.patch` file from disk.
- The web bundle resolves the frontend through `require.resolve('@deepseek-ai/dsh-web-frontend/dist/index.html')`.

The same script materializes every pnpm link into a real directory, restores the executable bit on `rg` and node-pty's `spawn-helper`, and rebuilds `node-pty` against the Electron ABI.

### The console the Windows sandbox needs

Hosting the harness under a GUI process surfaced a defect that predates this work and has nothing to do with Electron: the Windows ACL sandbox produces children that abort at DLL initialization with `STATUS_DLL_INIT_FAILED` whenever the host process owns no console. Under the restricted token a child cannot build a console of its own, so the design is to share the host's — and a console-less host makes Windows build one for the child, back on the failing path. A GUI process, a Windows service, and a detached daemon all qualify.

Measured in one process with console ownership as the only variable: attached exits `0`, after `FreeConsole()` exits `0xC0000142` with empty output, and a process created with `CREATE_NO_WINDOW` — which owns a *windowless* console — exits `0` again.

That last row is the fix. `dsh-subprocess-local` now starts every local child with `windowsHide`, so the sandbox runner owns a windowless console the confined grandchildren attach to. `dsh-sandbox-windows-acl` keeps a fallback for a host that owns no console at all: it allocates one and hides the window. The hidden show state reaches a child only when the console is one this process allocated and is currently hidden, asked of the live window through `IsWindowVisible` rather than remembered, so a CLI in a terminal can never have the user's own window hidden.

### What the shell isolates

Everything writable lives under Electron's `userData`, so the app and a `dsh` CLI on the same machine never share state:

| Path | Contents |
|---|---|
| `home/` | `$DSH_HOME`: profiles, sessions, settings, credentials, storages |
| `workspace/` | The backend's working directory, deliberately empty |
| `logs/` | Captured backend output |

The working directory stays empty because `sandbox-policy` falls back to the launch `process.cwd()` for sessions without a workspace. Pointing it at the user's home would widen that fallback root across everything they own; real project directories are added in the UI instead.

## Alternatives considered

**Tauri with a Node sidecar.** The backend is a large Node program that needs `node:sqlite`, node-pty, and subprocess control, so a system-webview shell still has to ship a Node runtime beside it. That trades Electron's bundled Chromium for a separately distributed Node plus a Rust layer and a sidecar lifecycle to maintain, and the size saving mostly evaporates.

**Running the Cordis tree inside the Electron main process.** One less process and no stdout handshake, but the window shares an event loop with agent work and dies with any backend fault. The handshake it avoids is four lines of line-buffered parsing.

**Loading `dist` over `file://` with an IPC fetch bridge**, the shape the comment at the top of `packages/host/webserver/src/index.ts` anticipates. It removes the HTTP server, but it also requires reimplementing the two event WebSockets and the `/plugins` route over IPC, and the browser and desktop surfaces would then diverge in exactly the transport that carries every streaming update. Loopback HTTP keeps one code path under test on both surfaces. The `file://` route stays available later as an optimization.

**Bundling a standalone Node runtime for the backend**, reusing the existing `@yao-pkg/pkg --sea` pipeline. It avoids rebuilding native addons for the Electron ABI, but it adds a second runtime to every installer, and that pipeline explicitly excludes Windows — the platform this work exists to reach.

**`DETACHED_PROCESS` on the confined child**, so no console is involved at all. Measured: the child stops aborting and returns exit code 0, but the command does not run — no output, no file written. A silent no-op is worse than the failure it replaces.

**`STARTF_USESHOWWINDOW` with `SW_HIDE` alone**, without the windowless console. It has no effect on a console window that the runner's own `AllocConsole` has already drawn, which is where the flash came from.

## Consequences

- The installer carries one runtime and one ABI, at the cost of rebuilding `node-pty` per platform. Each target therefore builds on its own runner, and no artifact is cross-built.
- Every `pnpm install` in this repository now downloads the Electron binary, because `apps/desktop` depends on it and pnpm's `allowBuilds` gate had to admit its postinstall.
- The web and desktop surfaces stay behaviorally identical: the desktop window renders the same assets from the same server, so the existing web snapshot and e2e lanes keep covering what the user sees.
- macOS cannot auto-update until the app is signed, because Squirrel.Mac validates the running signature before swapping the bundle. The shell reports the new version and opens the download page there, and Windows NSIS updates in place.
- `apps/desktop` is its own compiler face. The Electron typings require the DOM lib, which neither the Host nor the Client aggregate may see.
