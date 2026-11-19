# 派活 · 设计文档

版本：v0.1｜更新日期：2026-11-15

> 这里写"怎么做"。每个重要选择的理由和被放弃的方案在 `docs/adr/`，模块之间的对接在
> `docs/interfaces.md`。标了【待验证】的方案要先由对应的验证任务卡确认，再动手实现。

## 1. 总览

自己写的只有四层：交互、员工与工作、调度、存储。执行层交给现成的 harness 和开源内核。

```
┌─────────────────────────────────────────────────────────────┐
│ 交互层      私聊、工作群、工作视图                              │  apps/desktop
├─────────────────────────────────────────────────────────────┤
│ 员工与工作层  成员身份、长期记忆与工作日志、工作项、责任人        │  packages/core
├─────────────────────────────────────────────────────────────┤
│ 调度层      直接路由、排队、引导与中断、并行、休眠与恢复、触发器  │  packages/core
├─────────────────────────────────────────────────────────────┤
│ 执行层      Claude Code │ Codex │ ACP 通用入口 │ 自研 agent    │  packages/adapters/*
├─────────────────────────────────────────────────────────────┤
│ 存储层      SQLite + 成员文件目录                              │  packages/core
└─────────────────────────────────────────────────────────────┘
```

消息从上往下走：老板在交互层说话，员工与工作层确定是谁、关于哪项工作，调度层决定现在投递、
排队还是插话，执行层的适配器把它送进对应的原生会话。明确指向某位成员的消息直接投递，
不经过任何"总管模型"转述。

## 2. 进程模型

| 进程 | 是什么 | 生命周期 |
| --- | --- | --- |
| 桌面外壳 | Tauri 应用：窗口、托盘、快捷键 | 老板打开到退出 |
| 内核 | TypeScript 写的本机服务，作为外壳的附带进程启动 | 关窗口后继续运行；从托盘"退出"才停 |
| 成员进程 | 各 harness 的进程，由适配器启动 | 有活时存在；空闲超时后被休眠（关闭） |

- 界面只通过本机连接和内核说话（见 `interfaces.md` 第 2 节），自己不保存业务状态。
- 关窗口 ≠ 停止后台。窗口关闭后内核和正在干活的成员继续运行。
- 内核崩溃或被杀后重启，从存储恢复成员、会话对照表和未结束的运行记录，并把状态不明的运行
  标记为"待核对"，不自动重做。

## 3. 模块划分

| 模块 | 位置 | 职责 | 不负责 |
| --- | --- | --- | --- |
| desktop | `apps/desktop` | 窗口、托盘、界面渲染、启动和守护内核 | 任何业务规则 |
| shared | `packages/shared` | 类型、员工接口、内核接口的消息定义 | 实现 |
| core/members | `packages/core/src/members` | 成员的增删改查、人设与记忆文件、内置成员「人事」 | 调用模型 |
| core/sessions | `packages/core/src/sessions` | 会话对照表：成员 + 场合 → 原生会话 | 原生会话的内容 |
| core/dispatch | `packages/core/src/dispatch` | 路由、每会话队列、并行、休眠与恢复 | 决定"谁该回答"的模型判断（第 3 期才有） |
| core/work | `packages/core/src/work` | 工作项、产物索引、待决定事项 | 文件内容本身 |
| core/store | `packages/core/src/store` | SQLite 访问、迁移 | 业务规则 |
| core/api | `packages/core/src/api` | 对界面的本机接口；对成员暴露的工具 | 界面逻辑 |
| adapters/claude-code | `packages/adapters/claude-code` | 实现员工接口，驱动 Claude Code | 调度 |
| adapters/codex | `packages/adapters/codex` | 实现员工接口，驱动 Codex | 调度 |

依赖方向只能自上而下：`desktop → shared`，`core → shared`，`adapters/* → shared`。
`core` 通过员工接口使用适配器，不直接引用某个适配器的内部。适配器之间互不引用。

## 4. 概念模型：一个身份，四种会话

成员身份只有一个，会话有多条。身份在会话之上；连续性靠身份层，不靠共用上下文。

| 层 | 是什么 | 生命周期 |
| --- | --- | --- |
| 成员身份 | 人设、职责、长期记忆、工作日志 | 一直存在，不属于任何一条会话 |
| 私聊会话 | 老板和这位成员的主对话，只负责说话和派活 | 长期；写满后接续成下一条 |
| 群会话 | 每个群各一条（第 3 期） | 跟群走 |
| 任务会话 | 每项工作各一条，有自己的目录 | 工作结束即归档，可恢复 |
| 一次性调用 | 被别的成员当工具调用（第 4 期） | 用完即弃，不带身份，不写记忆 |

规则：

1. 每条会话启动时注入人设、长期记忆和相关的工作日志摘要；工作做完，把结论写回工作日志。
2. 重活放进任务会话，私聊会话保持随时能回话。
3. 同一位成员同时做两件事，就是两条任务会话，各用各的目录。
4. 休眠就是关掉进程；内核记一张"成员 + 场合 → 原生会话 ID"的对照表，恢复时按表续上。
5. 老板不需要管理会话 ID，界面上只有成员、群和工作项。

## 5. 数据结构

### 5.1 SQLite 表（第 1 期）

```
members
  id              TEXT PK        稳定的成员 ID
  name            TEXT           显示名
  title           TEXT           职责一句话
  salutation      TEXT           对老板的称呼，默认"老板"
  runtime_kind    TEXT           'claude-code' | 'codex' | 'acp' | 'native'
  runtime_config  TEXT(JSON)     模型、工作目录默认值、权限模式等
  builtin         INTEGER        1 = 内置成员（如「人事」）
  status          TEXT           'active' | 'archived'
  created_by      TEXT           'boss' 或发起创建的成员 ID
  created_at      TEXT
  archived_at     TEXT NULL

conversations
  id              TEXT PK
  kind            TEXT           'dm' | 'group'（第 1 期只有 dm）
  title           TEXT
  created_at      TEXT

conversation_members
  conversation_id TEXT
  member_id       TEXT
  PRIMARY KEY (conversation_id, member_id)

sessions                         会话对照表
  id              TEXT PK
  member_id       TEXT
  kind            TEXT           'dm' | 'group' | 'task' | 'oneshot'
  scope_id        TEXT           对应的 conversation 或 work_item 的 ID
  runtime_kind    TEXT
  native_session  TEXT NULL      harness 自己的会话 ID
  cwd             TEXT           这条会话的工作目录
  state           TEXT           'active' | 'sleeping' | 'archived'
  prev_session_id TEXT NULL      接续链：上一条会话
  created_at      TEXT
  last_active_at  TEXT

-- D-019：场合由 kind 与 scope_id 共同标识，休眠仍占用该场合。
CREATE UNIQUE INDEX sessions_current_scope
  ON sessions(member_id, kind, scope_id) WHERE state != 'archived';

messages
  id              TEXT PK
  conversation_id TEXT
  seq             INTEGER        会话内递增序号，用于分页
  author_kind     TEXT           'boss' | 'member' | 'system'
  author_id       TEXT NULL
  body            TEXT
  work_item_id    TEXT NULL      这条消息关联的工作项
  created_at      TEXT

work_items
  id              TEXT PK
  title           TEXT
  goal            TEXT
  owner_member_id TEXT
  status          TEXT           'running' | 'waiting_boss' | 'done' | 'archived'
  conversation_id TEXT           从哪段对话产生
  dir             TEXT           工作目录
  created_at      TEXT
  updated_at      TEXT

runs                             一次执行（一轮）
  id              TEXT PK
  session_id      TEXT
  input_message_id TEXT
  state           TEXT           'queued' | 'running' | 'done' | 'failed' | 'cancelled' | 'unknown'
  started_at      TEXT NULL
  ended_at        TEXT NULL
  end_reason      TEXT NULL

run_events                       工作记录（折叠展示用）
  id              TEXT PK
  run_id          TEXT
  seq             INTEGER
  kind            TEXT           'tool_started' | 'tool_finished' | 'note' | 'error'
  summary         TEXT           一行摘要；不存完整响应内容（约束 C-04）
  created_at      TEXT
```

第 2 期起增加 `pending_decisions`、`artifacts`；第 3 期起增加群相关字段和可见范围。
增加表或字段必须走迁移文件，并在 `docs/log/` 留一条简报。

### 5.2 成员文件目录（D-019）

```
<数据目录>/members/<member_id>/
  persona.md     人设与行为约定（会话启动时注入）
  memory.md      长期记忆：经确认的事实、偏好、决定
  worklog.md     工作日志：按日期追加，每项工作做完写一段
```

### 5.3 数据目录

Windows 上默认在 `%LOCALAPPDATA%\paihuo\`，其下有 `paihuo.db`、`members/`、`work/`（任务目录）、
`logs/`。路径通过外壳提供的接口取得，代码里不写死平台路径。

## 6. 关键流程

### 6.1 发一条私聊消息

1. 界面把消息发给内核。内核写入 `messages`，立即回执"已收到"。
2. `dispatch` 找到这位成员在该私聊的会话；没有就新建。
3. 会话状态为 `sleeping`：调用适配器 `resume`，注入人设与记忆摘要，状态改为 `active`。
4. 该会话没有正在进行的运行：新建 `runs` 记录，调用适配器 `send`。
5. 该会话有正在进行的运行：第 1 期一律排队，界面显示"排队中"；第 2 期起可选引导或中断。
6. 适配器产生的事件流经内核转发给界面；工具类事件只写一行摘要进 `run_events`。
7. 一轮结束：更新 `runs`，写入成员的回复消息，重置空闲计时。

### 6.2 把重活变成任务

1. 成员（或老板）决定某件事需要持续执行：内核新建 `work_items` 和它的目录。
2. 为这位成员新建一条 `kind = 'task'` 的会话，`cwd` 指向工作目录。
3. 任务会话独立运行；私聊会话不被占用。
4. 做完：成员把结论写进 `worklog.md`，工作项状态改为 `done`，在私聊里报一次结果。

### 6.3 休眠与恢复

- 一条会话空闲超过设定时间：适配器 `sleep`，进程关闭，状态改为 `sleeping`，保留 `native_session`。
- 恢复时用 `native_session` 调用适配器 `resume`。
- 恢复失败（原生会话丢失或损坏）：新建会话，`prev_session_id` 指向旧会话，注入长期记忆、
  工作日志和最近若干条消息，并在界面明确说明"这是接续背景，不是无损恢复"。

### 6.4 创建成员

- 界面表单和成员工具都调用同一个内核接口 `member.create`。
- 由成员（如「人事」）发起时，内核不直接创建，而是生成一条待老板确认的请求；老板确认后才落库。【假设 Q-006】
- 创建时生成成员目录和 `persona.md` 初稿。

## 7. 技术方案

| 项 | 选择 | 备注 |
| --- | --- | --- |
| 桌面外壳 | Tauri 2 | ADR-0003 |
| 界面 | React + TypeScript | 与 Electron 方案共用，保留换壳退路 |
| 内核 | TypeScript，运行在 Node.js 长期支持版 | 作为外壳的附带进程 |
| 界面与内核通信 | 本机回环地址上的 WebSocket，带每次启动生成的令牌 | 以后加手机端或聊天软件桥接不用返工 |
| 存储 | SQLite 单文件 + 成员文件目录 | ADR-0004；具体驱动在 T-002 选定 |
| Claude Code 接入 | 它的 SDK 或 CLI 的流式模式，使用原生会话恢复【待验证 T-003】 | ADR-0005 |
| Codex 接入 | 它的 App Server 接口【待验证 T-004】 | ADR-0005 |
| 成员工具 | 内核提供一个 MCP 服务，成员的 harness 连接它 | 第 1 期只开放少量工具 |
| 包管理 | pnpm 工作区 | |
| 测试 | Vitest；适配器有共用的契约测试 | |

### 内存约束（约束 C-04 的落实）

1. 界面按 `seq` 分页拉取消息，只保留当前可见范围附近的内容。
2. 内核不在内存里常驻整段对话历史；需要时从 SQLite 读。
3. 休眠的会话没有进程。同时处于 `active` 的会话数量有上限，可配置。
4. 日志和 `run_events` 只记摘要，不记完整的模型响应和工具输出。
5. 每个版本在 `STATUS.md` 记录一次空闲内存占用。

## 8. 目录结构

仓库的规范目录结构以 `AGENTS.md` 第 3 节为准，此处只列代码部分：

```
apps/
  desktop/
    src/            React 界面
    src-tauri/      Tauri 外壳（Rust，尽量薄）
packages/
  shared/
    src/staff.ts    员工接口
    src/api.ts      界面与内核之间的消息定义
  core/
    src/members/  src/sessions/  src/dispatch/  src/work/  src/store/  src/api/
    migrations/     SQLite 迁移文件
  adapters/
    claude-code/
    codex/
```

## 9. 借用清单

内核自己写，下面这些不必自己发明。借用代码时保留原许可与版权声明。

| 来源 | 借什么 | 方式 |
| --- | --- | --- |
| Clowder AI v0.14.1（MIT） | 插话的两种语义（引导、中断）；会话按"成员 + 线程"存成链；Codex App Server 客户端与 Claude 在 Windows 上的适配可作参考 | 设计为主，代码参考 |
| Hermes Agent v0.23.1 Bot Mode（MIT） | 群规则：被 @ 必答，未 @ 自决或跳过，沉默一轮收场；"需要你"标记；人设文件 | 设计 |
| DeepSeek Super-agent 原型（MIT） | 何时开口的规则；主动工作先只记录再放权；面板只显示需要人的事项 | 设计 |
| Pi SDK（MIT） | 自研 agent 的内核（第 4 期） | 库 |
| ACP | 其他 harness 的通用接入协议 | 协议 |

## 10. 尚未设计的部分

第 2 期以后的内容（引导与中断的具体实现、群聊调度、可见范围、触发器、自研 agent）只在
`requirements.md` 登记了需求，这里没有设计。进入对应阶段时先补设计和 ADR，再写任务卡。
