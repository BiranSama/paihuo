# STATUS.md · 现状快照

更新时间：2026-11-19｜更新人：Codex（组长）

## 一句话

公开仓库已建立，本地已同步。初始化材料已具备评审条件，下一步由老板转交独立评审并处理合并。T-001 待领。[初始化 PR #1](https://github.com/BiranSama/paihuo/pull/1)

## 已完成

- 宪章、需求、设计、接口、7 条 ADR、任务总表和前 5 张任务卡已纳入初始化分支。36 个必备文件齐全，初始化文档原有的 28 处本地链接均可解析，文档引用编号均有定义。
- 角色分工和版权署名已确定。Codex 主代理担任组长，工人由组长派出，独立评审由老板交给其他模型。[D-016、D-017](DECISIONS.md)
- 本地已连接公开仓库，`main` 和 `chore/bootstrap` 分别跟踪同名远程分支。同步前核对的 40 个文件逐字节一致。已从本地向初始化分支提交和推送，Q-012 已解决。[本次简报](docs/log/2026-11-19-01-repo-bootstrap.md)
- 提交、草稿 PR、Issue、Discussion、留档和交接流程均已有实际记录。Discussions 已开启，bug、followup、boss 标签齐备。GitHub 当前标记 `main` 受保护，原设置记录要求通过 PR 合并并禁止强推。[仓库](https://github.com/BiranSama/paihuo) · [保护规则设置记录](docs/log/2026-11-15-04-bootstrap-remote.md)

## 下一步

1. 老板将 PR #1 交给指定的其他模型评审，根据结果处理合并。`main` 目前只有 README，完整初始化材料在 PR 分支。
2. 合并后，由组长验证 GitHub 新建 issue 页提供三个模板，并验证新建 PR 时自动预填正文。四份模板文件已在 PR 分支核对。
3. 组长从最新 `main` 安排工人领取 T-001。交接单记录了本机工具版本、Git 核对命令和开工顺序。[T-001 交接单](handoffs/2026-11-19-0238-T-001-lead-worker.md)

## 待处理问题

| 编号 | 问题与处理时机 |
| --- | --- |
| Q-009 | 同一场合可并存活跃和休眠两条会话，与 T-002 验收冲突。T-002 开始前处理。[Issue #2](https://github.com/BiranSama/paihuo/issues/2) |
| Q-010 | 协作规则中的代码目录缺少创建时机说明。初始化保留空缺，T-001 按任务卡建目录。[Issue #3](https://github.com/BiranSama/paihuo/issues/3) |
| Q-011 | 第一期产物登记缺少存储和读取约定。编写相关任务卡前确定。[Issue #4](https://github.com/BiranSama/paihuo/issues/4) · [Discussion #5](https://github.com/BiranSama/paihuo/discussions/5) |

Q-001 至 Q-006 继续按各自阶段待老板决定。Q-007、Q-008、Q-012 已解决。[问题清单](QUESTIONS.md)

## 验证边界

- 已检查本机开发工具版本和 Windows 前置组件。Tauri 壳启动、守护和打包内核由 T-001 验证，Claude Code、Codex 的原生接入分别由 T-003、T-004 验证。
- 当前仅有文档。空闲内存数据在第 1 期验收 A-09 时记录。设计覆盖第 1 期，后续阶段已登记需求。
