# Claude Code 原生 CLI 与合成事件的离线验证

- 日期：2026-11-20
- 工人：Sol / Codex，组长：Codex，独立评审：Astra / Codex
- 关联：[T-003](../../tasks/T-003.md) · [PR #9](https://github.com/BiranSama/paihuo/pull/9)

## 做了什么

Claude Code 2.1.316 在 Windows 11 LTSC 26100 上运行。三个原生帮助/版本命令退出 0，13 个帮助开关可见。合成样例验证切分 UTF-8、多会话、工具配对、压缩事件和错误输入。

## 结果与后续

本机默认样例通过，可用 `--synthetic-only` 在没有 CLI 和账号的 CI 上运行回归。报告列出 12 项场景及 6 个能力字段。保留 CLI 流式模式和官方 SDK 作为候选，实际恢复、中断、审批、引导、图片和 MCP 等能力待测。 [验证报告](../../packages/adapters/claude-code/README.md) · [Issue #7](https://github.com/BiranSama/paihuo/issues/7)
