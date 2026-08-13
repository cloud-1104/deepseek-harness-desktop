# `@deepseek-ai/dsh-desktop`

English | [中文](README.zh.md)

The desktop shell packages the harness web UI as a Windows and macOS application. It owns three things — the backend child process, the window that loads its loopback URL, and the update check — and changes nothing about the runtime it hosts: what the user sees is exactly what `dsh web` serves.

## How a launch works

1. [`src/main.ts`](src/main.ts) resolves the layout, creates the window, and shows [`assets/loading.html`](assets/loading.html).
2. [`src/backend.ts`](src/backend.ts) spawns `<electron> <backend>/lib/bin.js web --host 127.0.0.1 --port 0` with `ELECTRON_RUN_AS_NODE=1`.
3. The backend prints `dsh web: http://127.0.0.1:<port>` once it is listening, and the supervisor captures that line.
4. The window loads that URL; the `/api` browser-trust fence accepts it because the origin is loopback.

The backend runs as a child rather than inside the main process, so a crash cannot take the window with it and agent work never blocks the UI event loop. It uses the Electron binary as its Node runtime, which keeps a single runtime in the installer and leaves every native addon built against one ABI.

An already-listening backend that exits is relaunched up to three times. Once that budget is spent the shell reports the failure with the log path and quits, because there is no usable window without a backend.

## Development

The shell launches the built CLI, not TypeScript sources, so a workspace build has to exist first.

```sh
pnpm install
pnpm run build
pnpm run desktop:dev
```

## Packaging

```sh
pnpm run desktop:prepare
pnpm run desktop:dist
```

[`scripts/prepare-backend.ts`](scripts/prepare-backend.ts) deploys the `@deepseek-ai/dsh` production closure into `backend-dist/`, materializes every package link into real directories, restores the executable bit on the binaries the backend spawns, and rebuilds `node-pty` against the Electron ABI. [`electron-builder.yml`](electron-builder.yml) then copies that directory through `extraResources`, which lands it beside the asar rather than inside it.

The backend cannot live inside the asar. Profile boot links `$DSH_HOME/profiles/node_modules` into these package directories, reads each bundle's `dsh.bundle.patch` off disk, and resolves the frontend through `require.resolve('@deepseek-ai/dsh-web-frontend/dist/index.html')`; none of that works through an archive.

Native addons are compiled per platform, so each installer is built on its own runner: Windows x64 on `windows-2025`, macOS arm64 and x64 on `macos-15`. [`.github/workflows/desktop-release.yml`](../../.github/workflows/desktop-release.yml) owns that matrix.

The application icon is `build/icon.png`, which electron-builder converts to the `.ico` and `.icns` each platform needs. `build/icon.svg` is its source: the DeepSeek mark from `dsh-client-ui-primitives`, so the installer, the taskbar, and the sidebar wordmark show one brand.

## Where data lives

Everything writable sits under Electron's `userData`, never in `~/.dsh`, so the app and a `dsh` CLI on the same machine never share sessions, credentials, or healed profile links.

| Path under `userData` | Contents |
|---|---|
| `home/` | `$DSH_HOME`: profiles, sessions, `settings.yaml`, `.credentials.yaml`, storages |
| `workspace/` | Working directory of the backend child, deliberately left empty |
| `logs/backend.log` | Captured backend output, rotated at 8 MB |

The working directory stays empty because `sandbox-policy` falls back to the launch `process.cwd()` for sessions that carry no workspace; a dedicated empty directory keeps that fallback root off the user's home. Real project directories are added inside the UI, which persists them to `home/storages/workspace.json`.

No API key is needed to start. The Models page writes the credential into `home/.credentials.yaml` on first run.

## Updates

[`src/updater.ts`](src/updater.ts) checks the GitHub Releases feed that electron-builder writes into the packaged app. Windows downloads and installs in place; NSIS packages need no code signature for that.

macOS only reports the new version and opens the download page. Squirrel.Mac validates the running app's code signature before swapping it, so an unsigned build cannot update itself. Adding a Developer ID certificate and a `notarize` entry to `electron-builder.yml` is the only change that path needs.

## Rebranding this fork

[`src/product.ts`](src/product.ts) holds the product name, application id, releases repository, and the `userData` subdirectory names. The same product name, `appId`, and `publish` target also appear in [`electron-builder.yml`](electron-builder.yml), and those two files are the whole rename surface for the shell.

Renaming the npm scope of the harness itself is a separate change with its own tool, [`scripts/change-scope.ts`](../../scripts/change-scope.ts).

## Known Limitations and Deferred Work

- Neither installer is signed. Windows shows a SmartScreen warning on first run and macOS requires a Gatekeeper override, and the unsigned macOS build cannot auto-update.
- Windows arm64 and Linux targets are unbuilt. Adding either needs its own runner in the release workflow, because native addons are rebuilt on the platform they ship to.
- On macOS the backend inherits the app's TCC permissions, so the first tool access to a protected folder raises a system prompt attributed to the app rather than to the command that triggered it.
- `bash` is not shipped. Windows uses the `pwsh` path, which needs PowerShell present on the machine.
