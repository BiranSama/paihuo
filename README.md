# 派活

> 老板，派活吧。

派活是一个跑在自己电脑上的个人 Agent 团队。几位有固定身份和记忆的成员，可以私聊、进群讨论、
接任务、交付成果。成员的大脑可以是 Claude Code、Codex 这类现成的 agent 程序，也可以是自研 agent。

它是一个为个人使用而做的项目，公开源码是为了记录和交流，不承诺通用性。

## 现状

**还没有可运行的版本。** 目前仓库里只有文档：宪章、需求、设计、协作规则和第一批任务卡。
最新进度看 [`STATUS.md`](STATUS.md)。

## 安装与运行

### 开发版（Windows x64）

- Windows 10 或 11，已安装 Microsoft Edge WebView2 Runtime。
- Node.js 24 LTS（x64）和 pnpm 11.9.0。安装步骤见 [Node.js](https://nodejs.org/en/download) 和 [pnpm](https://pnpm.io/installation)。
- Rust 的 Windows MSVC 工具链和 Rustfmt（持续集成使用 1.96.0），以及 Visual Studio Build Tools 的「使用 C++ 的桌面开发」工作负载和 Windows SDK。详见 [Tauri 的 Windows 准备步骤](https://v2.tauri.app/start/prerequisites/#windows)。

在仓库根目录打开 PowerShell：

```powershell
pnpm install --frozen-lockfile
pnpm dev
```

窗口会显示「已连接」与「内核版本」。点窗口右上角的关闭按钮可隐藏窗口，后台继续运行。
在 Windows 任务栏通知区域点派活图标可重新打开窗口，或者右键该图标，选择「退出」停止应用和内核。
当前窗口只检查 PATH 中是否有 Claude Code 或 Codex；运行工程骨架无需登录。

### 检查与打包

```powershell
pnpm check
pnpm test
pnpm build
cargo test --release --locked --manifest-path apps/desktop/src-tauri/Cargo.toml --features custom-protocol
```

首次开发启动和首次构建会下载 Node.js 官方 Windows x64 运行时，并校验 SHA-256。
NSIS 安装程序生成在 `apps/desktop/src-tauri/target/release/bundle/nsis/`。
安装程序随附 Node.js 和编译后的内核，安装后的应用可以直接启动。若系统缺少 WebView2，安装程序会下载它。

## 文档导航

| 想知道 | 看哪里 |
| --- | --- |
| 为什么做、什么不做 | [`docs/charter.md`](docs/charter.md) |
| 做什么、这一版的范围 | [`docs/requirements.md`](docs/requirements.md) |
| 怎么做 | [`docs/design.md`](docs/design.md)、[`docs/interfaces.md`](docs/interfaces.md) |
| 为什么这么选 | [`docs/adr/`](docs/adr/) |
| 现在做到哪了 | [`STATUS.md`](STATUS.md) |
| 接下来做什么 | [`docs/plan.md`](docs/plan.md)、[`tasks/`](tasks/) |
| 老板定过什么 | [`DECISIONS.md`](DECISIONS.md) |
| 还有什么没定 | [`QUESTIONS.md`](QUESTIONS.md) |
| AI 协作者该怎么干活 | [`AGENTS.md`](AGENTS.md) |

## 这个项目是怎么开发的

主要由多个 AI 协作编写，一位"组长"负责设计和任务卡，若干"工人"每次领一张卡实现，
规则都在 [`AGENTS.md`](AGENTS.md)。过程留档在 [`docs/log/`](docs/log/)。

## 致谢与借鉴

设计上借鉴了这些项目，代码借用时保留其许可与版权声明：
Clowder AI、Hermes Agent、DeepSeek Super-agent 原型、Pi、Agent Client Protocol。
具体借了什么见 [`docs/design.md`](docs/design.md) 第 9 节。

## 许可

MIT，见 [`LICENSE`](LICENSE)。
