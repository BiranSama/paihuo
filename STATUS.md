# STATUS.md · 现状快照

更新时间：2026-11-20｜更新人：Codex（组长）

## 一句话

初始化 PR #1 已按独立评审结论合并。T-001 已领卡，本机内核首次通过六项测试，桌面壳与安装包正在验证。[开发 PR #6](https://github.com/BiranSama/paihuo/pull/6)

## 已完成

- 宪章、需求、设计、接口、7 条 ADR、任务总表和前 5 张任务卡已纳入初始化分支。36 个必备文件齐全，初始化文档原有的 28 处本地链接均可解析，文档引用编号均有定义。
- 角色分工和版权署名已确定。Codex 主代理担任组长，工人由组长派出，独立评审由老板交给其他模型。[D-016、D-017](DECISIONS.md)
- 本地已连接公开仓库，`main` 和 `chore/bootstrap` 分别跟踪同名远程分支。同步前核对的 40 个文件逐字节一致。已从本地向初始化分支提交和推送，Q-012 已解决。[本次简报](docs/log/2026-11-19-01-repo-bootstrap.md)
- 提交、草稿 PR、Issue、Discussion、留档和交接流程均已有实际记录。Discussions 已开启，bug、followup、boss 标签齐备。GitHub 当前标记 `main` 受保护，原设置记录要求通过 PR 合并并禁止强推。[仓库](https://github.com/BiranSama/paihuo) · [保护规则设置记录](docs/log/2026-11-15-04-bootstrap-remote.md)

## 下一步

1. T-001 工人建立工作区、桌面外壳和内核，验证 Windows 运行、异常恢复、鉴权和打包。[任务卡](tasks/T-001.md)
2. GitHub 已识别模板，已从实际页面核实 boss、followup 正文及标签和 PR 八栏预填。缺陷表单与完整选择页仅有配置和服务端识别证据。初始化分支保留在 `4358e83`，`main` 的合并提交为 `a850010`。[初始化 PR #1](https://github.com/BiranSama/paihuo/pull/1)
3. T-002 至 T-005 依赖 T-001。可并行准备存储约束、两个 harness 的验证项及员工接口契约。

## 待处理问题

| 编号 | 问题与处理时机 |
| --- | --- |
| Q-009 | 同一场合可并存活跃和休眠两条会话，与 T-002 验收冲突。D-019 已定义场合和唯一约束，T-002 同步设计并验证实现。[Issue #2](https://github.com/BiranSama/paihuo/issues/2) |
| Q-010 | 协作规则中的代码目录缺少创建时机说明。已按 D-020 在目录树标明各卡的创建时机。[Issue #3](https://github.com/BiranSama/paihuo/issues/3) |
| Q-011 | 第一期产物登记缺少存储和读取约定。编写相关任务卡前确定。[Issue #4](https://github.com/BiranSama/paihuo/issues/4) · [Discussion #5](https://github.com/BiranSama/paihuo/discussions/5) |

Q-001、Q-002、Q-004、Q-005、Q-006 按阶段待决定。Q-003、Q-007 至 Q-010、Q-012 已解决。[问题清单](QUESTIONS.md)

## 验证边界

- 已检查本机开发工具版本和 Windows 前置组件。Tauri 壳启动、守护和打包内核由 T-001 验证，Claude Code、Codex 的原生接入分别由 T-003、T-004 验证。
- 已发布的初始版本只含文档。工程骨架的运行结果和内存测量随 T-001 记录。
