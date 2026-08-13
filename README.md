# deepseek-harness-desktop

中文 | [English](README.en.md)

面向 Windows 与 macOS 的 DeepSeek Harness 桌面客户端。双击启动，不需要终端，也不需要浏览器标签页。

## 简介

DeepSeek Harness 是一个插件化的 agent 运行时：完整的 agent 循环、shell 与终端、写入受限的沙箱、文件系统工具、网页检索、技能、子代理与工作流，全部由一个进程编排。

本项目把它交付成桌面应用。界面、能力与数据格式与上游一致，去掉的只是安装 Node 工具链、构建、敲命令、再开浏览器这一串前置步骤。

## 安装

从 [Releases](https://github.com/cloud-1104/deepseek-harness-desktop/releases) 下载对应平台的安装包：

| 平台 | 文件 |
|---|---|
| Windows x64 | `.exe`（NSIS 安装程序） |
| macOS Apple Silicon | `-arm64.dmg` |
| macOS Intel | `-x64.dmg` |

安装后即可使用，无需另行安装 Node 或其他运行时。首次启动在界面内的「模型」页面填入 API Key 即可开始对话。

当前发布版本尚未做代码签名：Windows 首次运行会出现 SmartScreen 提示，macOS 需要在「系统设置 - 隐私与安全性」中放行一次。

## 从源码构建

需要 Node `^22.19 || >=24` 与 pnpm 11。

```sh
pnpm install
pnpm run build
pnpm run desktop:prepare
pnpm run desktop:dev
```

打包安装包：

```sh
pnpm run desktop:dist
```

产物写入 `apps/desktop/release/`。原生插件按平台编译，因此 Windows 安装包需在 Windows 上构建，macOS 磁盘映像需在 macOS 上构建。[apps/desktop/README.md](apps/desktop/README.md) 描述了桌面外壳的结构与打包流程。

## 数据与配置

会话、凭据与设置存放在 harness 主目录（`$DSH_HOME`，默认 `~/.dsh`），与命令行版本共用同一份数据，两边可以互相看到对方的历史。

工作区在界面内添加，不受启动目录影响。桌面版自身只在应用数据目录下保留后端运行日志。

## 已知限制

- 安装包未签名，首次运行需要手动放行；未签名的 macOS 构建也无法自动更新，只会提示新版本并打开下载页。
- 尚未提供 Windows arm64 与 Linux 构建。
- Windows 下的 shell 工具走 PowerShell，需要系统已安装 PowerShell。
- 桌面版不支持 `cordis.patch.yml` 的热重载，配置改动在下次启动生效。

## 致谢

本项目基于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 开发，保留其完整提交历史。运行时的全部能力来自上游。

## 许可证

MIT。
