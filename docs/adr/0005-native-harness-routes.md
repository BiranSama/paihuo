# ADR-0005 harness 走各自的原生接入，ACP 作通用入口

- 状态：已采纳（具体接入方式待 T-003、T-004 验证）
- 日期：2026-11-15

## 背景

Claude Code 和 Codex 既要能当成员，也要能被成员一次性调用。它们各有自己的会话、取消、
权限和事件机制。另有一个通用协议 ACP，可以用统一方式驱动多种 harness。

## 决定

- Claude Code：用它的 SDK 或 CLI 的流式模式，使用原生会话恢复。
- Codex：用它的 App Server 接口。
- 其他 harness：以后通过 ACP 接入。
- 所有适配器实现 `docs/interfaces.md` 第 1 节的同一个员工接口，并如实声明能力。

## 放弃的方案

| 方案 | 放弃的原因 |
| --- | --- |
| 全部走 ACP | 接口最整齐，但会丢掉部分原生的取消、权限、事件和会话能力 |
| 往终端注入按键或依赖 tmux | 脆弱，Windows 原生不可用 |
| 只支持"被调用"，不支持当成员 | 违反需求：harness 要能当平级员工 |

## 后果

- 每个适配器要单独实现和测试，工作量比全走 ACP 大。
- harness 版本更新可能改变接入方式。适配器要记录自己验证过的 harness 版本，并在启动时检查。
- 先做验证任务（T-003、T-004），确认在 Windows 上能启动、流式输出、恢复会话、中断；
  结果补充到本条。验证不通过则回到 `QUESTIONS.md`，不许硬写。
- Clowder 已有这两条路线的实现（Claude 的 Windows 适配、Codex App Server 客户端），可作参考。

### T-004 的 Windows 离线证据（2026-11-20）

Codex CLI 0.167.0。本机导出的协议列有 8 个客户端请求、1 个客户端通知、6 个服务端通知和 2 种审批。6 条合成消息验证双会话与审批请求关联。App Server stdio 提供持续会话和轮次控制所需的协议；本轮没有启动服务器，握手、真实轮次、沙箱行为与原生资源占用待测。 [Issue #7](https://github.com/BiranSama/paihuo/issues/7) · [验证报告](../../packages/adapters/codex/README.md)
