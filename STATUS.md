# 派活 · 现状快照

更新于 2026-11-20。每张卡的验收记录在卡片和对应 PR 内，历史见 [开发简报](docs/log/)。

## 已可运行

Windows x64 桌面骨架启动本机内核，显示连接状态和版本。窗口关闭后内核继续运行，内核意外停止后由外壳重启。安装包内的应用在 Windows 11 LTSC 上终止内核后 4.74 秒首次观察到新 PID，随后页面显示恢复。从实际托盘菜单选择“退出”后，两进程均结束；菜单由合成右键通知打开。

空闲 8 秒的 Windows 工作集采样为外壳 27.72 MiB、内核 47.80 MiB、一个 WebView2 渲染进程 63.84 MiB。复现步骤见 [README](README.md)，开发和安装包验收边界见 [T-001](tasks/T-001.md)。

## 本批任务

| 卡片 | 交付与进度 |
| --- | --- |
| [T-001](tasks/T-001.md) | Windows 桌面骨架、内核、鉴权测试与 NSIS 构建已交付。[PR #6](https://github.com/BiranSama/paihuo/pull/6) |
| [T-002](tasks/T-002.md) | 存储层待集成，按 D-019 验证 SQLite 迁移与未归档会话唯一性。 |
| [T-003](tasks/T-003.md) | Claude Code 离线验证待集成。 |
| [T-004](tasks/T-004.md) | Codex 离线验证待集成。 |
| [T-005](tasks/T-005.md) | 已交付员工接口、可配置的内存适配器、工厂型契约套件和接入说明。[PR #11](https://github.com/BiranSama/paihuo/pull/11) |

## 决定与待验

- 初始化已用双父提交 `a850010` 合并，`chore/bootstrap` 保留。GitHub 上实见 boss、followup 的正文和预选标签，以及新建 PR 的八栏正文。缺陷模板和三项选择页的证据为默认分支配置与 GitHub 服务端识别，尚缺登录界面实测。[PR #1](https://github.com/BiranSama/paihuo/pull/1)
- Q-003、Q-007 至 Q-010、Q-012 已解决。Q-011 的第一期产物登记约定须在 T-008、T-010、T-013 之前确定。[问题清单](QUESTIONS.md) · [Issue #4](https://github.com/BiranSama/paihuo/issues/4)
- Q-001、Q-002、Q-004、Q-005、Q-006 仍待阶段性决定。D-018 限定两张客户端卡只做离线验证，真实会话行为和压缩后记忆需另行取证。[决定记录](DECISIONS.md) · [Issue #7](https://github.com/BiranSama/paihuo/issues/7)
