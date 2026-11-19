# 修复员工接口的下游类型检查并验证并行屏障

- 日期：2026-11-20
- 谁：工人 Astra、独立评审 Sol、组长 Codex
- 关联：[T-005](../../tasks/T-005.md) · [PR #11](https://github.com/BiranSama/paihuo/pull/11)

独立评审从 core 的真实 TypeScript 配置导入测试入口，复现 4 条 TS5097。改用包内映射及公开子入口后诊断为零，保持 Node.js 24 原生 ESM 导入可用；两处 RuntimeKind 复用同一定义。

两个公开迭代器的事件隔离不能证明底层轮次真正重叠。契约新增可选的传输断言，模拟传输用屏障在 B 首事件前保持 A 活跃，整轮预缓冲的反例会超时失败。最终专项 22 项及组合 46 项通过。真实客户端的底层行为见 [Issue #7](https://github.com/BiranSama/paihuo/issues/7)。
