# Codex 真实引导停在响应流断开

- 2026-11-21，组长在 Windows 本机执行 T-015 第二批首项，Astra 修正探针，Sol 独立复核。[任务卡](../../tasks/T-015.md) · [PR #16](https://github.com/BiranSama/paihuo/pull/16)
- 固定版 0.167.0 拒绝了探针使用的历史配置值，未发送模型动作。改用 `none` 后，无账号预检和实测共用相同的启动参数；独立全仓测试 102 项通过。真实运行中发出 `turn/start` 和 `turn/steer`，观察到两个用户消息事件，随后客户端报告 `responseStreamDisconnected`、`willRetry=true`，未提供 HTTP 状态。驱动在首个可见重连通知停止。额度窗口前后都是已用 77%。含首批单轮共发出 3 个原生动作，底层请求总数不可见。
- 停止后，本次标记的 Codex 进程和专用临时目录均为 0。未创建持久恢复线程。无凭据的额外连接检查中，直连在 TLS 握手前超时，Windows 现有网络路径到官方 WebSocket 返回 401；这一结果不能确定刚才断流的原因。其余七项继续等待实测，T-006、T-007 和 Q-013 暂缓。[分项证据](../../packages/adapters/codex/README.md)
