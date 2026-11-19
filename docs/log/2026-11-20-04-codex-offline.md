# Codex 原生 CLI 与合成事件的离线验证

- 日期：2026-11-20
- 工人：Sol / Codex，组长：Codex，独立评审：Astra / Codex
- 关联：[T-004](../../tasks/T-004.md) · [PR #10](https://github.com/BiranSama/paihuo/pull/10)

## 做了什么

Codex CLI 0.167.0 在 Windows 11 LTSC 26100 上运行。本机导出的协议列有 8 个客户端请求、1 个客户端通知、6 个服务端通知和 2 种审批。6 条合成消息验证双会话与审批请求关联。

## 结果与后续

本机默认样例通过，可用 `--synthetic-only` 在没有 CLI 和账号的 CI 上运行回归。报告列出 14 项场景及 6 个能力字段。App Server stdio 提供持续会话和轮次控制所需的协议；本轮没有启动服务器，握手、真实轮次、沙箱行为与原生资源占用待测。 [验证报告](../../packages/adapters/codex/README.md) · [Issue #7](https://github.com/BiranSama/paihuo/issues/7)
