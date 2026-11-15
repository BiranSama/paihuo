# 派活

> 老板，派活吧。

派活是一个跑在自己电脑上的个人 Agent 团队。几位有固定身份和记忆的成员，可以私聊、进群讨论、
接任务、交付成果。成员的大脑可以是 Claude Code、Codex 这类现成的 agent 程序，也可以是自研 agent。

它是一个为个人使用而做的项目，公开源码是为了记录和交流，不承诺通用性。

## 现状

**还没有可运行的版本。** 目前仓库里只有文档：宪章、需求、设计、协作规则和第一批任务卡。
最新进度看 [`STATUS.md`](STATUS.md)。

## 安装与运行

等 T-001 完成后补充。届时这里会写明：需要预先安装什么、怎么启动开发版、怎么打包。

计划中的运行条件：

- Windows 10 或 11（首要平台）。Mac 在之后的阶段支持。
- 至少安装并登录了一种 harness：Claude Code 或 Codex。派活使用你已有的登录，不另外提供模型。

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
