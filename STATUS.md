# 派活 · 现状快照

更新于 2026-11-21。每张卡的验收记录在卡片和对应 PR 内，历史见 [开发简报](docs/log/)。

## 已可运行

Windows x64 桌面骨架启动本机内核，显示连接状态和版本。窗口关闭后内核继续运行，内核意外停止后由外壳重启。安装包内的应用在 Windows 11 LTSC 上终止内核后 4.74 秒首次观察到新 PID，随后页面显示恢复。从实际托盘菜单选择“退出”后，两进程均结束；菜单由合成右键通知打开。

空闲 8 秒的 Windows 工作集采样为外壳 27.72 MiB、内核 47.80 MiB、一个 WebView2 渲染进程 63.84 MiB。复现步骤见 [README](README.md)，开发和安装包验收边界见 [T-001](tasks/T-001.md)。

## 本批任务

| 卡片 | 交付与进度 |
| --- | --- |
| [T-001](tasks/T-001.md) | Windows 桌面骨架、内核、鉴权测试与 NSIS 构建已交付。[PR #6](https://github.com/BiranSama/paihuo/pull/6) |
| [T-002](tasks/T-002.md) | SQLite 八表、事务迁移、双向索引分页、独占开库与进程强杀恢复已验证。[PR #8](https://github.com/BiranSama/paihuo/pull/8) |
| [T-003](tasks/T-003.md) | Claude Code 2.1.316 已在 Windows 验证本机命令与合成事件，真实会话待验。[PR #9](https://github.com/BiranSama/paihuo/pull/9) |
| [T-004](tasks/T-004.md) | Codex CLI 0.167.0 已在 Windows 验证本机命令与合成事件，真实会话待验。[PR #10](https://github.com/BiranSama/paihuo/pull/10) |
| [T-005](tasks/T-005.md) | 已交付员工接口、可配置的内存适配器、工厂型契约套件和接入说明。[PR #11](https://github.com/BiranSama/paihuo/pull/11) |

组合工作树通过 46 项 Vitest（含 13 项存储、22 项员工接口、2 项离线客户端、9 项骨架），另有 Rust 核心进程生命周期回归。

## 接下来的任务

已合并[网页端 Claude 的 PR #14](https://github.com/BiranSama/paihuo/pull/14)。[T-008 调度](tasks/T-008.md) 已进入[草稿 PR #15](https://github.com/BiranSama/paihuo/pull/15)，使用假适配器开发。[T-015](tasks/T-015.md) 并行准备隔离验证和命令清单，真实调用待老板核准命令。[T-010](tasks/T-010.md) 接在 T-008 之后。M1 的目标是在桌面完成一次可恢复的真实私聊。

## 决定与待验

- 初始化已用双父提交 `a850010` 合并，`chore/bootstrap` 保留。网页实见 boss、followup 的正文与预选标签及 PR 八栏正文。GitHub 服务端复核发现原名“缺陷”的第三个模板未列出，已改名“缺陷报告”。合并后的服务端逐项验收记录见[初始化 PR #1](https://github.com/BiranSama/paihuo/pull/1)。[修正简报](docs/log/2026-11-20-09-issue-template.md)
- Q-003、Q-007 至 Q-010、Q-012、Q-014 已解决。Q-011 的第一期产物登记约定留待 T-013 前确定，当前两张内核卡仅处理工作项与工作记录。[问题清单](QUESTIONS.md) · [Issue #4](https://github.com/BiranSama/paihuo/issues/4)
- Q-001、Q-002、Q-004、Q-005、Q-006 仍待阶段性决定。T-003、T-004 按 D-018 仅完成离线验证。真实会话能力与计费由 T-015 取证，再决定 Q-013 和 T-006、T-007 路线。[决定记录](DECISIONS.md) · [Issue #7](https://github.com/BiranSama/paihuo/issues/7)
