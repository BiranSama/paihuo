# 图片场景断流，本轮实测结束

- 2026-11-21，T-015 组长在 Windows 本机按批准命令执行图片场景。Codex 已经创建临时线程、开始轮次并收到用户消息事件，随后报 `responseStreamDisconnected`、`willRetry=true`，没有可信的 HTTP 状态或模型输出。没有可见重连满足全部放行条件，宿主共计 1 个动作。按老板指示结束本轮。[引导阶段](2026-11-21-07-native-stream.md) · [任务卡](../../tasks/T-015.md)
- 同一共享七天窗口在图片阶段前后均为 78%。账本计单轮执行 1、引导 2、图片 1，Codex 共 4 个原生动作，其中第二批 3 个，Claude Code 0 轮。底层请求次数和单次扣量不可见。引导和图片各退出后，系统中带本次哨兵的 Codex 进程和专用临时目录计数均为 0；实际子树未逐一按 PID 追踪。恢复场景未创建持久会话。
- 中断、跨进程恢复、并行、原生审批、原生 MCP、活跃与空闲内存这六项未发起。真实能力表保留待验。Q-013 及两张正式适配器卡暂缓，Q-016 跟踪接续条件。[Codex 报告](../../packages/adapters/codex/README.md) · [Claude Code 报告](../../packages/adapters/claude-code/README.md) · [Issue #7](https://github.com/BiranSama/paihuo/issues/7)
