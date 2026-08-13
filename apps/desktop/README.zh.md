# `@deepseek-ai/dsh-desktop`

[English](README.md) | 中文

桌面外壳把 harness 的 Web 界面封装成 Windows 与 macOS 应用。它只负责三件事——后端子进程、加载回环 URL 的窗口、更新检查——并且不改动被托管的运行时：用户看到的界面就是 `dsh web` 提供的界面。

## 一次启动经历了什么

1. [`src/main.ts`](src/main.ts) 解析目录布局、创建窗口，并显示 [`assets/loading.html`](assets/loading.html)。
2. [`src/backend.ts`](src/backend.ts) 以 `ELECTRON_RUN_AS_NODE=1` 启动 `<electron> <backend>/lib/bin.js web --host 127.0.0.1 --port 0`。
3. 后端开始监听后打印 `dsh web: http://127.0.0.1:<port>`，监管器捕获这一行。
4. 窗口加载该 URL；由于来源是回环地址，`/api` 的浏览器信任围栏放行。

后端作为子进程而非主进程内运行，因此它崩溃不会带走窗口，agent 的工作也不会阻塞 UI 事件循环。它把 Electron 可执行文件当作自己的 Node 运行时，安装包里因此只有一份运行时，所有原生插件也只需针对一套 ABI 构建。

已经进入监听状态的后端若退出，最多重新拉起三次。预算用尽后外壳会连同日志路径报告失败并退出，因为没有后端就没有可用的窗口。

## 开发

外壳启动的是构建产物而非 TypeScript 源码，所以必须先完成一次工作区构建。

```sh
pnpm install
pnpm run build
pnpm run desktop:dev
```

## 打包

```sh
pnpm run desktop:prepare
pnpm run desktop:dist
```

[`scripts/prepare-backend.ts`](scripts/prepare-backend.ts) 把 `@deepseek-ai/dsh` 的生产依赖闭包部署到 `backend-dist/`，将其中所有包链接物化成真实目录，恢复后端要启动的那些二进制的可执行位，并按 Electron ABI 重建 `node-pty`。随后 [`electron-builder.yml`](electron-builder.yml) 通过 `extraResources` 复制该目录，使它落在 asar 旁边而不是里面。

后端不能放进 asar。Profile 启动会把 `$DSH_HOME/profiles/node_modules` 链接到这些包目录，从磁盘读取各组合包的 `dsh.bundle.patch`，并通过 `require.resolve('@deepseek-ai/dsh-web-frontend/dist/index.html')` 解析前端；这些都无法穿透归档文件。

原生插件按平台编译，因此每个安装包都在各自的构建机上产出：Windows x64 在 `windows-2025`，macOS arm64 与 x64 在 `macos-15`。这套矩阵由 [`.github/workflows/desktop-release.yml`](../../.github/workflows/desktop-release.yml) 负责。

应用图标是 `build/icon.png`，由 electron-builder 转换成各平台所需的 `.ico` 与 `.icns`。它的源文件是 `build/icon.svg`：取自 `dsh-client-ui-primitives` 的 DeepSeek 标识，使安装包、任务栏与侧栏 wordmark 呈现同一个品牌。

## 数据存放位置

所有可写内容都位于 Electron 的 `userData` 之下而非 `~/.dsh`，因此本应用与同一台机器上的 `dsh` CLI 不会共享会话、凭据或愈合出来的 profile 链接。

| `userData` 下的路径 | 内容 |
|---|---|
| `home/` | `$DSH_HOME`：profiles、会话、`settings.yaml`、`.credentials.yaml`、storages |
| `workspace/` | 后端子进程的工作目录，刻意保持为空 |
| `logs/backend.log` | 捕获的后端输出，超过 8 MB 轮转 |

工作目录保持为空，是因为对于不携带工作区的会话，`sandbox-policy` 会回退到启动时的 `process.cwd()`；一个专用的空目录能让这个兜底根目录不覆盖用户主目录。真正的项目目录在界面内添加，并持久化到 `home/storages/workspace.json`。

启动不需要 API key。首次运行时在 Models 页面填写，凭据会写入 `home/.credentials.yaml`。

## 更新

[`src/updater.ts`](src/updater.ts) 检查 electron-builder 写入安装包的 GitHub Releases 更新源。Windows 会下载并就地安装；NSIS 包不需要代码签名即可完成这一步。

macOS 只报告新版本并打开下载页。Squirrel.Mac 在替换应用前会校验运行中应用的代码签名，未签名的构建无法自我更新。补上 Developer ID 证书并在 `electron-builder.yml` 中加入 `notarize` 配置，是打通这条路径所需的全部改动。

## 为这个 fork 更换品牌

[`src/product.ts`](src/product.ts) 保存产品名、应用 id、发布仓库以及 `userData` 子目录名。相同的产品名、`appId` 与 `publish` 目标也出现在 [`electron-builder.yml`](electron-builder.yml) 中，外壳的改名面就是这两个文件。

给 harness 本身更换 npm scope 是另一件事，有专门的工具 [`scripts/change-scope.ts`](../../scripts/change-scope.ts)。

## 已知限制与待办

- 两个安装包都未签名。Windows 首次运行会弹出 SmartScreen 警告，macOS 需要手动放行 Gatekeeper，未签名的 macOS 构建也无法自动更新。
- 尚未构建 Windows arm64 与 Linux 目标。新增任一目标都需要在发布工作流里加一台对应的构建机，因为原生插件要在它所面向的平台上重建。
- 在 macOS 上后端继承应用的 TCC 权限，因此工具首次访问受保护目录时弹出的系统授权提示会归因到应用，而不是触发它的那条命令。
- 不随包分发 `bash`。Windows 走 `pwsh` 路径，要求机器上已安装 PowerShell。
