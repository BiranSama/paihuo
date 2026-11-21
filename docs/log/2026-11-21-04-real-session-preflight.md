# 两种原生会话的分段探针和首次认证预检

- 日期：2026-11-21
- 谁：T-015 工人 / Codex；本机原生认证由组长执行
- 关联：T-015，PR #16，Q-004、Q-013、Q-014

## 做了什么

准备空配置原生传输、受限单轮、仅显示认证类别的检查，以及两份含 12 项的取证报告。Claude Code 2.1.316 返回未登录，Codex 0.167.0 返回 ChatGPT 登录，两次认证合计使用 0 模型轮。

## 为什么

T-006、T-007 需要按实际会话行为开卡。预检先确认这台机器能走哪条认证路径，以便在许可和费用可核对时开始短轮次。

## 改了哪些

两侧适配器的 spike 和 README，任务卡及领卡登记。共享 Windows Job 管理本次新进程树，本地单次 smoke 预留跨 worktree 防重跑。

## 结果

两种合成协议、固定 MCP 的 stdio 往返、Windows Job 后代回收均通过，适配器 8 项 Vitest 通过。当前实测边界及官方来源见 [Claude Code](../../packages/adapters/claude-code/README.md) 和 [Codex](../../packages/adapters/codex/README.md)。

## 遗留

Claude 原生订阅登录、实际额度、两条路线的完整模型会话及能力表仍需后续证据。卡及草稿 PR 保持进行中。

## 后续取证

组长取得首个 Codex 真实动作的同窗口读数，控制器因未知 item 截止，终态未证实。Claude 未登录，使用 0 模型轮。八个后续 Codex 场景已通过合成 stdio，官方无账号配置验证通过，完整 `pnpm check`、`pnpm test` 共 57 项通过。逐项边界及第二批命令见两侧 README。
