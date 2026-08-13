# Agent Note: 以子进程方式托管 Web 运行时的 Electron 桌面外壳

Status: implemented

[English](2026-08-13-electron-desktop-shell.md) | 中文

## Problem

harness 以 npm CLI 的形式触达用户。打开 GUI 需要一套 Node 工具链、一次安装、一次工作区构建、一条终端命令，然后再开一个浏览器标签页。这是面向开发者的分发方式，不是面向产品的。

桌面分发必须保留整个运行时——agent 循环、shell、沙箱、PTY、文件系统工具——因为这个运行时本身就是产品。要消失的是终端，而不是能力。

## Decision

[`apps/desktop`](../../../../apps/desktop/README.md) 是包裹在未改动的 Web 运行时之外的 Electron 43 外壳。一次启动分四步：

1. 外壳解析目录布局并显示一个本地加载页。
2. 它以 `ELECTRON_RUN_AS_NODE=1` 启动 `<electron 可执行文件> <backend>/lib/bin.js web --host 127.0.0.1 --port 0`。
3. 它从子进程 stdout 捕获 `dsh web: http://127.0.0.1:<port>`，其中就是 OS 实际分配的端口。
4. 它在窗口中加载该 URL。

没有任何 harness 包被改动。`--port 0`、固定格式的就绪行、`/api` 上的回环信任围栏、界面内的凭据引导、由 GUI 管理的工作区，早已让 Web 运行时可以被另一个进程托管；外壳只是消费这些既有能力。

### 后端为什么作为子进程运行

在 `ELECTRON_RUN_AS_NODE` 下，Electron 的可执行文件同时就是一个 Node 运行时，因此这个子进程不增加安装包体积，所有原生插件也仍然只面向一套 ABI。把 Cordis 树放进主进程，会让 agent 工作、压缩和工具执行与绘制窗口共用同一个事件循环，也会让后端崩溃直接关掉整个应用。

已进入监听状态的后端若退出，最多重新拉起三次，之后外壳连同日志路径报告失败并退出。清理会覆盖整棵进程树——Windows 用 `taskkill /t`，POSIX 发进程组信号——因为后端自己还会启动 shell、沙箱助手和 PTY。

### 后端为什么放在 asar 之外

[`scripts/prepare-backend.ts`](../../../../apps/desktop/scripts/prepare-backend.ts) 把 `@deepseek-ai/dsh` 的生产依赖闭包部署成一个普通目录，再由 `extraResources` 复制到归档文件旁边。profile 启动中有三处机制要读取真实文件，放进归档就会失效：

- `healProfilesModuleFallback` 会把 `$DSH_HOME/profiles/node_modules` 链接到这些包目录。
- 组合包解析要从磁盘读取每个包的 `dsh.bundle.patch` 文件。
- Web 组合包通过 `require.resolve('@deepseek-ai/dsh-web-frontend/dist/index.html')` 解析前端。

同一个脚本还会把所有 pnpm 链接物化成真实目录、恢复 `rg` 与 node-pty `spawn-helper` 的可执行位，并按 Electron ABI 重建 `node-pty`。

### Windows 沙箱所需要的控制台

把 harness 托管在 GUI 进程下，暴露出一处早于本次工作、且与 Electron 无关的缺陷：只要宿主进程没有控制台，Windows ACL 沙箱产出的子进程就会在 DLL 初始化阶段以 `STATUS_DLL_INIT_FAILED` 中止。在受限令牌下子进程无法自建控制台，因此设计上是共享宿主的——而宿主没有控制台时，Windows 会为子进程新建一个，又回到失败路径。GUI 进程、Windows 服务、后台守护进程都属于这种情况。

在同一个进程内以「是否拥有控制台」为唯一变量实测：已连接时退出码 `0`；`FreeConsole()` 之后退出码 `0xC0000142` 且输出为空；而以 `CREATE_NO_WINDOW` 创建的进程——它拥有一个**无窗口**的控制台——退出码又回到 `0`。

最后一行就是修复。`dsh-subprocess-local` 现在以 `windowsHide` 启动每一个本地子进程，于是沙箱 runner 拥有一个无窗口控制台供受限孙进程附着。`dsh-sandbox-windows-acl` 为「宿主确实一个控制台都没有」保留兜底：分配一个并隐藏其窗口。只有当控制台确实由本进程分配且当前处于隐藏状态时，隐藏显示状态才会传给子进程，而且这一判断是通过 `IsWindowVisible` 现场询问活动窗口而非记住的状态，因此终端里的 CLI 绝不会被隐藏掉用户自己的窗口。

### 外壳隔离了什么

所有可写内容都位于 Electron 的 `userData` 之下，因此本应用与同一台机器上的 `dsh` CLI 不会共享任何状态：

| 路径 | 内容 |
|---|---|
| `home/` | `$DSH_HOME`：profiles、会话、设置、凭据、storages |
| `workspace/` | 后端的工作目录，刻意保持为空 |
| `logs/` | 捕获的后端输出 |

工作目录保持为空，是因为对于不带工作区的会话，`sandbox-policy` 会回退到启动时的 `process.cwd()`。把它指向用户主目录会让这个兜底根目录覆盖用户的全部文件；真正的项目目录改为在界面内添加。

## Alternatives considered

**Tauri 加 Node sidecar。** 后端是一个庞大的 Node 程序，需要 `node:sqlite`、node-pty 和子进程控制，因此即便外壳用系统 WebView，仍要在旁边分发一份 Node 运行时。这等于用 Electron 内置的 Chromium，换来一份单独分发的 Node 加一层 Rust 以及需要维护的 sidecar 生命周期，而体积上的节省基本被抵消。

**把 Cordis 树跑在 Electron 主进程里。** 少一个进程，也不需要 stdout 握手，但窗口要与 agent 工作共用事件循环，并且会随任何后端故障一同崩溃。而它省下的握手不过是四行按行缓冲的解析。

**用 `file://` 加载 `dist` 并通过 IPC 桥接 fetch**，也就是 `packages/host/webserver/src/index.ts` 顶部注释所预设的形态。这确实省掉了 HTTP 服务器，但同时要求把两条事件 WebSocket 和 `/plugins` 路由都在 IPC 上重新实现，而且浏览器与桌面两个界面恰好会在承载所有流式更新的那一层传输上分道扬镳。回环 HTTP 让两个界面共用一条被测试覆盖的代码路径。`file://` 这条路仍可作为后续优化。

**为后端打包一份独立的 Node 运行时**，复用现有的 `@yao-pkg/pkg --sea` 流水线。它免去了按 Electron ABI 重建原生插件，但会给每个安装包塞进第二份运行时，而且那条流水线明确不覆盖 Windows——恰恰是这项工作要触达的平台。

**给受限子进程加 `DETACHED_PROCESS`**，让它完全不涉及控制台。实测：子进程不再中止、退出码为 0，但命令根本没有执行——没有输出，也没有写出文件。静默空转比它所替代的失败更糟。

**只用 `STARTF_USESHOWWINDOW` 配 `SW_HIDE`**，不引入无窗口控制台。对 runner 自己 `AllocConsole` 已经画出来的控制台窗口无效，而闪烁正是从那里来的。

## Consequences

- 安装包只带一份运行时、一套 ABI，代价是要按平台重建 `node-pty`。因此每个目标都在各自的构建机上产出，不做交叉构建。
- 本仓库的每次 `pnpm install` 现在都会下载 Electron 二进制，因为 `apps/desktop` 依赖它，pnpm 的 `allowBuilds` 闸门不得不放行它的 postinstall。
- Web 与桌面两个界面在行为上保持一致：桌面窗口渲染的是同一台服务器上的同一批资源，因此现有的 Web 快照与 e2e 通道仍然覆盖用户看到的内容。
- 在应用被签名之前 macOS 无法自动更新，因为 Squirrel.Mac 在替换应用包前会校验运行中的签名。外壳在那里只报告新版本并打开下载页，而 Windows NSIS 走就地更新。
- `apps/desktop` 自成一个编译面。Electron 的类型定义需要 DOM lib，而 Host 与 Client 两个聚合都不能看到它。
