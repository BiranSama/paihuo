# 派活 · 接口约定

版本：v0.1｜更新日期：2026-11-20

> 模块之间怎么对接。这里是约定，代码里的类型定义在 `packages/shared`，两者不一致时
> 以代码为准，并在 `QUESTIONS.md` 上报、回头修正本文。
> 下面的 TypeScript 是草图，T-005 实现时可以调整命名，但不能改变语义。

## 1. 员工接口（内核 ↔ 适配器）

每种大脑（Claude Code、Codex、ACP、自研 agent）都实现同一个接口。上层的私聊、群聊、派活、
审批不区分对方是哪种大脑。

```ts
export type RuntimeKind = 'claude-code' | 'codex' | 'acp' | 'native';

/** 适配器如实声明自己能做什么。做不到的能力由内核降级处理，不许假装支持。 */
export interface AdapterCapabilities {
  resume: boolean;        // 休眠后能否恢复原生会话
  guide: boolean;         // 能否把新消息送进正在进行的这一轮
  interrupt: boolean;     // 能否中断正在进行的这一轮
  parallel: boolean;      // 同一成员能否同时跑多条会话
  images: boolean;        // 能否接收图片
  nativeApproval: boolean;// 是否有原生的工具审批事件
}

export interface NativeSessionRef {
  runtimeKind: RuntimeKind;
  nativeSession: string;  // harness 自己的会话 ID
  cwd: string;
}

export interface StartInput {
  memberId: string;
  cwd: string;
  preamble: string;       // 人设 + 长期记忆 + 相关工作日志摘要
  runtimeConfig: Record<string, unknown>;
}

export interface TurnInput {
  text: string;
  attachments?: { path: string; mime: string }[];
}

export type AdapterEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'message_done'; text: string }
  | { type: 'tool_started'; name: string; summary: string }
  | { type: 'tool_finished'; name: string; ok: boolean; summary: string }
  | { type: 'needs_approval'; requestId: string; summary: string }
  | { type: 'error'; message: string; recoverable: boolean }
  | { type: 'turn_done'; reason: 'completed' | 'interrupted' | 'failed' };

export interface StaffAdapter {
  readonly kind: RuntimeKind;
  capabilities(): AdapterCapabilities;

  /** 新开一条原生会话。 */
  start(input: StartInput): Promise<NativeSessionRef>;
  /** 休眠后恢复。失败时抛出可识别的错误，由内核走"接续"流程。 */
  resume(ref: NativeSessionRef, preamble: string): Promise<void>;
  /** 发起一轮。事件流结束于 turn_done。 */
  send(ref: NativeSessionRef, input: TurnInput): AsyncIterable<AdapterEvent>;
  /** 引导当前这一轮。不支持时返回 { accepted: false }，不许悄悄改成中断。 */
  guide(ref: NativeSessionRef, input: TurnInput): Promise<{ accepted: boolean }>;
  /** 中断当前这一轮。已经发生的动作不会撤销。 */
  interrupt(ref: NativeSessionRef): Promise<void>;
  /** 回答原生审批请求。 */
  approve(ref: NativeSessionRef, requestId: string, allow: boolean): Promise<void>;
  /** 关闭进程，保留原生会话。 */
  sleep(ref: NativeSessionRef): Promise<void>;
}
```

约定：

- 适配器不做调度、不排队、不重试整轮。这些归 `core/dispatch`。
- `tool_started` / `tool_finished` 的 `summary` 是一行话。完整的工具输出不经过内核持久化。
- 不为了接口整齐而丢掉 harness 的原生能力。原生有、接口里没有的能力，先在 `QUESTIONS.md`
  提出，再决定是否扩接口。
- 所有适配器必须通过 `packages/shared` 里的同一套契约测试。

平级的验收标准：能直接找到这位成员；它能延续自己的工作背景；能单独追问和停止；
（第 3 期起）能进群；对产物负责。只接一次性命令、结果还要老板手工搬运的，不算员工。

### 1.1 可识别错误与能力拒绝

适配器和调用方从 `@paihuo/shared/staff` 导入同一个 `StaffAdapterError` 类及 `StaffErrorCode` 类型。调用方先检查 `error instanceof StaffAdapterError`，再读 `error.code`。构造形式为 `new StaffAdapterError(code, message, options?)`，可用 `options.cause` 保留底层异常。消息用于解释错误；程序分支使用稳定的错误码。

| `code` | 适用情况 |
| --- | --- |
| `native_session_lost` | 原生会话记录已丢失，按原引用恢复失败。内核据此进入接续流程。 |
| `harness_not_installed` | 找不到该成员所需的客户端或运行时。 |
| `harness_not_authenticated` | 客户端存在，但执行该操作需要有效登录。 |
| `interrupted` | 某次适配器操作因中断而抛错。对已开始并受支持的轮次，`interrupt` 后仍须以唯一的 `turn_done` 事件、原因 `interrupted` 结束事件流。 |
| `unsupported_capability` | 调用要求了能力声明中明确关闭的操作，适配器据此拒绝。各操作的拒绝方式见下表。 |
| `other` | 其余适配器错误，例如审批请求 ID 无效。 |

| 关闭的能力 | 调用结果 |
| --- | --- |
| `guide` | `guide(ref, input)` 返回 `{ accepted: false }`，本轮不接收该输入。 |
| `resume`、`interrupt`、`nativeApproval` | 对应的 `resume`、`interrupt`、`approve` 调用抛出带 `unsupported_capability` 的 `StaffAdapterError`。拒绝中断后，原轮次可以正常完成。 |
| `images` | 对带图片附件的 `send`，在产生首个事件前以同一错误码拒绝。 |
| `parallel` | 同一成员已有活跃轮次时，第二条会话的并行投递必须在产生事件前以同一错误码拒绝，已有轮次继续。 |

真实适配器和内存适配器共用[员工接口契约测试及接入说明](../packages/shared/src/testing/README.md)。

## 2. 内核接口（界面 ↔ 内核）

传输：本机回环地址上的 WebSocket。外壳启动内核时生成一次性令牌，界面连接时带上。
消息是 JSON。命令带 `id`，内核用同一个 `id` 回结果；事件由内核主动推送。

### 2.1 命令（第 1 期）

| 命令 | 作用 |
| --- | --- |
| `member.list` | 列出成员及其状态 |
| `member.create` | 创建成员（来自界面时直接创建） |
| `member.update` | 修改名字、职责、人设、称呼、大脑配置 |
| `member.archive` | 停用成员 |
| `conversation.open` | 打开或新建与某位成员的私聊，返回最近一页消息 |
| `message.page` | 按 `seq` 向前或向后取一页消息 |
| `message.send` | 发送消息；内核立即回"已收到"和消息 ID |
| `work.list` | 列出工作项 |
| `work.get` | 取一项工作的详情和工作记录 |
| `session.sleep` / `session.wake` | 手动休眠或唤醒一条会话 |
| `request.answer` | 回答一条待确认的请求（如成员发起的"创建成员"） |
| `system.info` | 版本、数据目录、已检测到的 harness、内存占用 |

#### 已实现的命令与回包（T-010）

请求使用 `{id, method, params?}`，成功回包使用 `{id, result}`。错误回包使用 `{id, error: {code, message}}`；请求缺少可用 ID 时回包中的 ID 为 `null`。`system.info` 保留 T-001 的字段。所有命令的参数与返回值见[共享类型](../packages/shared/src/api.ts)。

| 命令 | 参数与结果 |
| --- | --- |
| `member.list` | 可不传参数，或传列表游标和页长。返回在职成员及其活动状态，省略运行时私有配置。 |
| `conversation.open` | 传 `memberId`，返回私聊和最近一页消息。 |
| `message.page` | 传 `conversationId`、方向 `before` 或 `after`，可选 `cursor`、`limit`。游标为排他的消息序号，每页默认及上限为 50，两个方向均按序号升序返回。`nextCursor` 为 `null` 时，该方向已读完。 |
| `message.send` | 传 `conversationId` 和 `text`。落库并入队后立即返回 `accepted: true`、`messageId`、`runId`、`sessionId`。运行过程由事件通知。真实适配器接入前向该成员发送会得到 `ADAPTER_NOT_READY`。 |
| `work.list`、`work.get` | 前者分页返回工作项；后者按 `workId` 返回 `work`、最近的运行事件摘要 `events` 和该项的系统恢复提示 `notices`，后两组分别最多 50 条。 |

两个列表命令使用可选的 `{cursor, limit}`，默认和最大页长均为 50。列表按 ID 升序返回，`nextCursor` 为下一次请求的排他游标，取值为 `null` 表示已到列表末尾。

成员管理、休眠唤醒、答复待确认请求在参数合法时返回 `NOT_IMPLEMENTED`，分别由 T-012、T-009、T-013 接续。未知方法返回 `UNKNOWN_METHOD`，参数错误返回 `INVALID_PARAMS`。这些错误保留连接。

WebSocket 单帧上限为 1 MiB，发送消息正文上限为 16 KiB，单个推送事件上限为 64 KiB。分页同时遵守行数和字节限制。单条历史消息的正文超过页预算时，通过 `truncated: true` 标明截短，数据库保留原文。

### 2.2 事件（第 1 期）

| 事件 | 含义 |
| --- | --- |
| `message.created` | 新消息落库 |
| `message.delta` | 成员回复的增量文本 |
| `run.started` / `run.ended` | 一轮开始、结束及结束原因 |
| `run.event` | 一条工作记录摘要 |
| `member.status` | 成员状态变化：空闲、工作中、休眠 |
| `work.updated` | 工作项状态变化 |
| `request.created` | 出现一条需要老板确认的请求 |

客户端完成 WebSocket 鉴权后，发送首个命令完成订阅初始化。现有桌面客户端以 `system.info` 开始；服务端先回首个成功命令的结果，再按序投递初始化期间暂存的事件。每条待初始化连接最多暂存 128 个事件、共 1 MiB；超限时以 1013 关闭连接。T-010 的事件格式为 `{event, data}`，超出字节预算的事件带 `truncated: true`。保留的消息或运行 ID 可用于后续查询。原生适配器的审批请求目前随 `run.event` 转发；`request.created` 已定义类型，待成员请求流程接入。

第 2 期起增加：`message.send` 的 `disposition`（`queue` | `guide` | `interrupt`）、
`decision.*` 系列。第 3 期起增加群相关命令。新增或改动必须同步更新本文和 `packages/shared`。

## 3. 成员工具（成员 ↔ 内核）

内核提供一个 MCP 服务，成员的 harness 启动时连接它。成员通过这些工具做"团队里的事"。

| 工具 | 作用 | 阶段 |
| --- | --- | --- |
| `team_list_members` | 查看成员名册和各自的职责 | 第 1 期 |
| `team_propose_member` | 提议创建一位成员；生成待老板确认的请求，不直接创建 | 第 1 期 |
| `team_propose_member_update` | 提议修改或停用一位成员；同样要确认 | 第 1 期 |
| `worklog_append` | 往自己的工作日志追加一段 | 第 1 期 |
| `work_start` | 把一件事转成工作项，开任务会话 | 第 1 期 |
| `work_finish` | 标记工作完成并登记产物 | 第 1 期 |
| `decision_ask` | 向老板提一个具体问题 | 第 2 期 |
| `handoff_to` | 把一件事交给另一位成员 | 第 3 期 |
| `invoke_once` | 一次性调用某个 harness | 第 4 期 |

约定：

- 工具只表达意图，是否执行由内核决定。成员不能绕过内核直接改数据库或别人的成员目录。
- 「人事」和其他成员用的是同一套工具，区别只在人设。
- 工具返回值要说明结果状态：已执行、已提交待确认、被拒绝及原因。

## 4. 扩展点

第 1 期没有插件机制。预留的两个扩展点：

- **新的大脑**：新建 `packages/adapters/<name>`，实现员工接口并通过契约测试。
- **新的成员工具**：在内核的 MCP 服务里登记，并更新本文第 3 节。
