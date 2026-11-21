# 调度遵守适配器并行声明并补齐工作读取入口

- 日期：2026-11-21
- 谁：T-008 工人 / Sol / Codex
- 关联：[T-008](../../tasks/T-008.md) · [PR #15 评审意见](https://github.com/BiranSama/paihuo/pull/15#discussion_r4651872166) · [原简报](2026-11-21-03-dispatch.md)

## 做了什么

出队时按会话实际运行时的最新 `parallel` 声明判断。同一成员的串行轮次等当前执行结束，再占用任务槽。等待中的会话轮转获得运行机会，其他成员可以继续执行。适配器未注册时，投递以 `MissingAdapterError` 拒绝。

## 为什么

评审用非并行假适配器发现，私聊活跃时接收的任务被直接记为 `failed` 和 `unsupported_capability`。工作恢复提示需要在订阅之后仍可读取，工作与成员列表也需要支持 WebSocket 分页。

## 改了哪些

- 调度及适配器注册表按会话路由，能力读取异常时采用串行策略并报告错误。
- `store.dispatch.recentWorkNotices(workId, limit = 50)` 按消息顺序返回指定工作的最近恢复提示。`pageWork(afterId?, limit = 51)`、`pageMemberIds(afterId?, limit = 51)` 按 ID 升序读取，排除游标本身。三项查询的 `limit` 接受 1 至 100。

## 结果

旧实现的回归测试重现了 `unsupported_capability`。本机 75 项 Vitest 和 `pnpm check` 通过，新增覆盖串行等待、不同成员继续运行、能力降级、跨重启读取、以及 65 项各含 16 KiB 目标的工作分页。

## 遗留

修正后的独立复评与 Windows CI 待确认。T-010 负责 WebSocket 接线，T-015 负责真实客户端验证。
