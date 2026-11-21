# T-004 Codex 接入离线验证

2026-11-20｜Windows 原生 x64，系统版本 10.0.26100.0｜Node.js v24.18.0｜Codex CLI 0.167.0

本机原生 CLI 的帮助与协议导出均通过。合成测试通过两会话的 JSONL 分流、审批请求 ID 关联和轮次完成状态读取。D-018 将本轮限定为离线验证，真实模型与原生运行状态待验。

## 复现

在 Windows PowerShell 中从仓库根目录运行本机检查，使用已有的 Node.js 与 Codex CLI。

```powershell
node ./packages/adapters/codex/spike/offline-check.mjs
```

样例沿 PATH 顺序查找原生 CLI。同一个 PATH 条目提供 npm 启动器时，会解析其对应的 `codex.exe`。也可以在命令末尾加上已安装的 `codex.exe` 绝对路径。测试机的 npm 启动器为 0.167.0，PATH 中另外提供了 0.169.0-alpha.11.1，因此以样例 JSON 中的 `cli` 为准。

CLI 调用限 `--version`、`app-server --help`、`exec --help`、`exec resume --help` 与 `app-server generate-json-schema --out`。这些命令在每次运行新建的临时目录内执行，子进程的工作目录、Codex 配置目录和临时目录均指向该目录，环境变量按最小范围传递。每条命令限时 15 秒，临时目录在退出前清理。样例在内存处理合成事件，执行时将汇总写到标准输出。

无 Codex CLI 或账号的 CI 可以只运行内存中的 JSONL 断言。此模式只需要 Node.js，并在标准输出标明 `mode: "synthetic-only"`。

```powershell
node ./packages/adapters/codex/spike/offline-check.mjs --synthetic-only
```

本机检查退出 `0`。汇总列出八个客户端请求、一个客户端通知、六个服务端通知、两种服务端审批请求，以及启动、恢复、引导和中断所需字段。合成断言处理六条消息、两轮输出、一条关联的审批请求。显式传入本机 0.169.0-alpha.11.1 原生程序也通过同组离线检查。清空测试进程 PATH 后，`--synthetic-only` 退出 `0`，本机检查明确提示找不到 CLI 并退出 `1`。执行后未发现残留的临时目录。

握手只完成静态核对。导出的 schema 定义了 `initialize` 及其必填 `clientInfo`，也定义了 `initialized` 通知。官方文档说明 App Server 默认启动本地 Code Mode 主机。当前环境无法确认整个启动过程满足网络和账号隔离条件，本次未启动原生 App Server，stdio 握手和正常退出仍待验证。[Codex App Server](https://learn.chatgpt.com/docs/app-server)

## 交付文件

- [README.md](README.md) 记录命令、14 项结果、六个能力字段和实测边界。
- [spike/offline-check.mjs](spike/offline-check.mjs) 验证本机 CLI 导出的协议，也可单独运行合成断言。
- [spike/offline-check.test.mjs](spike/offline-check.test.mjs) 是 Vitest 回归测试。根目录运行 `pnpm test` 会自动发现并执行它，验证 `--synthetic-only` 的退出码和 JSON 覆盖汇总。

## 14 项验证

表中「样例」指上面的离线命令。协议列来自本机二进制实际导出的 JSON Schema。「合成通过」表示本地样例处理预制输入的断言通过。

| 项目                        | 离线结果                   | 可重复命令或样例                                                               | 已观察到的现象                                                                                               | 实测边界                                               |
| --------------------------- | -------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------ |
| 1. 启动与前言               | CLI 可用，握手协议有定义   | 样例的 `localHelp`、`initializeRequired`、`clientNotifications`、`startFields` | 帮助列出 stdio，schema 定义 `initialize`、`initialized`，`thread/start` 参数包含 `cwd` 和 `baseInstructions` | App Server 握手、指定目录及前言实际生效待验            |
| 2. 流式输出                 | 协议有定义，合成通过       | 样例的 `serverNotifications`、`syntheticEvents`                                | 本机协议有项目开始与完成、文本增量通知。切分 UTF-8 字节和交错消息后，合成文本仍正确拼接到各自会话            | 真实模型增量、工具事件及顺序待验                       |
| 3. 会话 ID                  | 协议有定义                 | 样例的 `startResponseRequired`、`serverNotifications`                          | `thread/start` 响应要求 `thread`，协议列有 `thread/started`                                                  | 服务端实际生成的 ID 与持久化待验                       |
| 4. 恢复                     | 协议有定义                 | 样例的 `resumeRequired`                                                        | `thread/resume` 要求 `threadId`                                                                              | 进程退出后按 ID 恢复与上下文保留待验                   |
| 5. 并行                     | 合成通过                   | 样例的 `syntheticEvents`                                                       | 两条会话的交错消息依 `threadId` 分流，并核对所属轮次                                                         | 原生并行执行、工作目录隔离与资源占用待验               |
| 6. 中断                     | 协议有定义，合成通过       | 样例的 `interruptRequired`、`syntheticEvents`                                  | `turn/interrupt` 要求 `threadId`、`turnId`，样例从预制 `turn/completed` 读出 `interrupted`                   | 发出中断后的模型、工具与会话状态待验                   |
| 7. 引导                     | 协议有定义                 | 样例的 `steerRequired`                                                         | `turn/steer` 要求 `threadId`、`expectedTurnId` 和输入                                                        | 活跃轮次接收引导、输入生效时机及结束竞态待验           |
| 8. 权限                     | 协议有定义，合成通过       | 样例的 `serverRequests`、`syntheticEvents`                                     | 本机协议有命令和文件修改审批。样例将预制命令审批与原请求 ID 关联，并在内存构造拒绝响应                       | 原生审批往返、权限模式与 Windows 执行限制待验          |
| 9. 长对话                   | 协议有定义                 | 样例的 `clientRequests`、`serverNotifications`                                 | 协议有 `thread/compact/start` 和 `thread/tokenUsage/updated`                                                 | 自动压缩阈值、触发条件、压缩质量及恢复效果待验         |
| 10. 成员工具                | 协议有定义                 | 样例的 `clientRequests`                                                        | 协议有 `mcpServerStatus/list`                                                                                | 本机测试 MCP 的初始化及模型工具调用待验                |
| 11. 登录与计费              | 待验                       | 样例只查版本、帮助和协议导出                                                   | 这三类命令在空白 Codex 配置目录下成功运行                                                                    | 现有订阅登录、账号限制及计费需要独立授权验证           |
| 12. 资源                    | CLI 子进程退出已观察       | 执行样例并核对退出码与临时目录                                                 | 版本、帮助、协议导出均返回，样例结束时临时目录已清理                                                         | App Server 空闲、运行、休眠和退出的内存及进程树待测    |
| 13. App Server 与非交互 CLI | CLI 帮助已观察，协议有定义 | 样例的 `localHelp`、`clientRequests`、`serverRequests`                         | `exec` 提供 `--json`，`exec resume` 支持传会话 ID。App Server 协议另外列出活跃轮次引导、中断及双向审批       | 真实轮次的两种入口对比待验                             |
| 14. Windows 原生运行        | CLI 原生执行已观察         | 在 Windows PowerShell 执行样例                                                 | npm 对应的 `codex.exe` 成功输出帮助并导出协议                                                                | App Server 运行和 Windows 沙箱就绪、文件与网络策略待验 |

## AdapterCapabilities

| 字段             | 离线证据                                                     | 原生能力状态             |
| ---------------- | ------------------------------------------------------------ | ------------------------ |
| `resume`         | `thread/resume` 与 `threadId`                                | 持久化恢复待验           |
| `guide`          | `turn/steer` 与 `expectedTurnId`                             | 对活跃轮次的引导待验     |
| `interrupt`      | `turn/interrupt` 与合成 `interrupted`                        | 原生中断及子进程行为待验 |
| `parallel`       | 合成数据按会话和轮次关联                                     | 原生并行待验             |
| `images`         | 从 `turn/start` schema 分别断言 `image`、`localImage` 均存在 | 图片传入与模型处理待验   |
| `nativeApproval` | 协议包含两类审批，合成消息验证请求 ID 关联                   | 原生审批往返待验         |

## 对接结论

建议沿 ADR-0005 采用 App Server 的 stdio 路线推进后续验证。`exec --json` 与 `exec resume` 适合脚本执行和按 ID 接续。员工接口还需要控制正在运行的轮次以及回应双向审批，这些动作在 App Server 中有明确的协议入口。真实会话语义以原生验证结果为准。

当前未观察到需要立即修改员工接口的证据。后续适配器需要保存原生 `threadId`，在活跃轮次内维护 `turnId`，并按协议请求 ID 回应审批。`guide` 应核对预期轮次。遇到轮次已结束时，按员工接口返回未接受。审批布尔值只表达当前请求的允许或拒绝。

Q-004 建议维持现行的 A 设计，即接续为新会话并将摘要写入长期记忆。原生 `thread/compact/start` 可纳入后续正式对照，需先验证压缩前后的上下文、质量和恢复行为，再决定是否采用 B 或 C。

官方参考包括 [Codex App Server](https://learn.chatgpt.com/docs/app-server)、[Codex 非交互运行](https://developers.openai.com/codex/noninteractive)及 [Windows 沙箱](https://developers.openai.com/codex/windows)。

## T-015 真实会话

2026-11-21，Windows 11 x64（10.0.26100），原生 Codex CLI 0.167.0。候选路线为 App Server stdio 与 `exec --json`。组长运行原生 `login status`，观察到 ChatGPT 登录并正常关闭 Windows Job，本步骤使用 0 模型轮。随后组长按批准的预算向 exec 发出一次短消息（原生轮次预算记 1），收到控制器未接受的 item，立即停止，无可信终态、文本或工具执行结论。驱动没有重发。官方提供商底层可能重连，实际网络请求数未知。

### 真实动作与共享额度

下表记录组长在本机观察到的宿主动作。同一行的前、后读数来自同一个官方七天订阅窗口（10080 分钟）。账户窗口由并发会话共享，三行均无法据此算出单次调用的实际消耗。底层请求和重连次数未知。[认证及首轮留档](../../../docs/log/2026-11-21-04-real-session-preflight.md) · [引导实测留档](../../../docs/log/2026-11-21-07-native-stream.md) · [图片实测留档](../../../docs/log/2026-11-21-08-native-image.md)

| 阶段         | 计入动作 | 窗口已用百分比（前 → 后） | 真实结果                                                                                                                                                                            |
| ------------ | -------: | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 首批 exec    |        1 | 70% → 71%                 | 原生返回未接受的 item，宿主停止。未取得可信终态。                                                                                                                                   |
| 第二批 steer |        2 | 77% → 77%                 | 向同一线程提交 turn/start 和 turn/steer。响应流随后断开，未收到模型答复。                                                                                                           |
| 第二批 image |        1 | 78% → 78%                 | 本段账本预留 2，实际只计 turn/start。观察到 thread/started、turn/started、userMessage，随后收到 responseStreamDisconnected、willRetry=true、HTTP 类别 unknown。没有模型输出或终态。 |

图片场景未能充分证明允许续流的全部条件。控制器放行的可见重连为 0，现有记录不足以确定是哪个条件没有满足。按老板要求，本次真实验证在再次断流后结束。Codex 累计 4 个原生动作，第二批使用 3/13。第二批八个场景中，仅引导、图片进入真实模型阶段；中断、跨进程恢复、并行、权限审批、本机 MCP 和空闲／工作资源采样均未发起。

组长在引导和图片两个场景各自结束后核对，系统临时根目录中本卡专用名称匹配数均为 0，带本卡 MCP 配置哨兵的 Codex 原生服务进程匹配数也均为 0。合成正控已验证 Windows Job 能回收后代。真实后代未逐一按 PID 跟踪，首批 exec 未回溯核对。恢复场景未启动，本次没有创建用于恢复的持久会话。

本次授权的真实调用已经结束。以下 PowerShell 命令留作复核。默认或 `--plan` 打印两条路线、本次 native argv、12 项验收和六项能力记录。版本和协议字段的本机预检沿用 `offline-check.mjs`。

```powershell
$p = 'packages/adapters/codex/spike/session-check.mjs'
node $p --plan
node $p --offline protocol
node $p --offline mcp
node $p --offline job
```

组长在老板审阅对应命令后再执行账号与原生阶段。`$exe` 为审阅过的 0.167.0 原生程序绝对路径。`--policy-reviewed` 仅涉及本次仍会生效的托管配置，包括 hooks、端点及凭据选择。transport 使用空白临时 `CODEX_HOME`，只发送握手和不存在的 ID；无账号、无模型输入。auth 只检查官方 CLI 是否确认为 ChatGPT 登录。`--included-only` 由组长在核实订阅额度且额外付费途径已关闭后传入，`$before` 为该额度窗口已用百分比，`$spent` 为本卡该 harness 已花的原生轮，包括可能发给模型的失败、可见重试和追加输入。缺任一条件即停止。结束后从同一额度窗口记录后值、单位、时间与是否重置。取整后读数相同不代表零消耗。

```powershell
node $p --live transport --exe $exe --policy-reviewed
node $p --live auth --exe $exe --policy-reviewed
node $p --live smoke --exe $exe --policy-reviewed --included-only --before-used-percent $before --used-turns $spent
```

smoke 用 `exec --json` 向本地 CLI 发一条固定消息，仅接受一条原生轮及符合前言的固定文本标记。使用临时项目、只读沙箱、禁审批升级、忽略用户配置和规则、临时会话，关闭 shell、Code Mode、多代理、插件、hooks、联网搜索等功能。模型指定 `gpt-6.2-sol`。驱动遇到工具、重试、失败或未知事件即停止，报告只含白名单计数和退出状态。该 CLI 没有由通用开关禁用全部内置工具的契约。只读沙箱、已禁用的工具入口、实际有无工具事件分别记录。App Server 在该版本缺少 exec 的 `--ignore-user-config`，独立的零轮传输命令使用空白临时原生配置。下述第二批受控场景通过独立配置清单核对后使用原生登录。[驱动](spike/session-check.mjs) · [App Server](https://developers.openai.com/codex/app-server) · [非交互运行](https://developers.openai.com/codex/noninteractive) · [当前测试版本 shell 注册](https://github.com/openai/codex/blob/rust-v0.167.0/codex-rs/core/src/tools/spec_plan.rs#L1177-L1206)

程序开始 smoke 前独占创建共享 Git 管理目录内的私有预留标记。一个 checkout 及其余 linked worktree 共享该预留。只写数字 1，不写账号或会话数据。任何已启动的失败都继续计入，驱动不会自动重发。每个原生步骤均在 Windows kill-on-close Job 内，新的临时目录在退出后按本次创建路径回收。[预算和进程管理](spike/session-common.mjs) · [Windows Job](spike/job.ps1)

| 项目          | 当前结论和观察                                                                                                                 | 对应命令或后续取证                                    |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------- |
| 1 路线        | 未满足完整对照。已确认 ChatGPT 登录，exec 和 App Server 均发起了真实请求，均未取得可信模型终稿。                               | 首批 exec、第二批 steer 与 image，见上表。            |
| 2 启动与前言  | 未满足前言验证。原生线程的模型、provider、只读沙箱、审批及 cwd 回包核对通过；无模型答复可验证前言效果。                        | steer 和 image 的 thread/start、turn/start。          |
| 3 流式事件    | 未满足。图片观察到线程、轮及用户输入事件，两次 App Server 真实场景随后断流。没有可信的模型文本增量、终稿或工具开始／结束事件。 | 实际事件见上表；合成映射见 --offline protocol。       |
| 4 恢复        | 未满足。跨进程暗号场景没有发起。无效 ID 的独立传输探针和合成错误分类不能证明真实会话恢复。                                     | --live transport 与 --case resume 的代码。            |
| 5 中断        | 未满足。真实中断场景未发起，原轮终态、中断前文件和后续发言均未核实。                                                           | --case interrupt。                                    |
| 6 引导        | 未满足。已向同一原生线程提交启动和引导两个动作。断流前没有终稿，可否改变这一轮的答复仍未知。                                   | --case steer，见上表。                                |
| 7 并行        | 未满足。真实并行场景未发起。独立 cwd、文件读取和事件对应目前只有合成证据。                                                     | --offline scenarios 与 --case parallel。              |
| 8 权限        | 未满足。真实审批场景未发起，原生请求、程序代答和 Q-014 A 的效果仍未知。                                                        | --case approval；合成样例仅授空权限。                 |
| 9 成员工具    | 未满足。合成配置与固定 MCP 的独立往返通过；真实模型使用该工具的场景未发起。                                                    | --offline mcp 与 --case mcp。                         |
| 10 计费与认证 | 已满足依据记录。原生认证为 ChatGPT，普通订阅可用。三次窗口前后数字均已登记。单轮实际扣量无法确认。                             | 原生配额及宿主普通用量检查；见上表。                  |
| 11 资源       | 未满足资源测量。真实资源场景未发起。引导和图片结束后本卡临时目录和带哨兵服务的匹配数均为 0；完整后代与首批退出未经逐一核对。   | --case resources 未启动；--offline job 验证后代回收。 |
| 12 压缩       | 已满足观察记录。Codex 实际计入 4 个原生动作，期间未观察到自然压缩，Q-004 留待以后。                                            | 三个真实阶段被动观察；本次已停止。                    |

### 第二批 App Server 验证命令

组长已执行 `steer`。宿主向原生会话提交两个动作，随后报告响应流断开及准备重连。控制器在未知 HTTP 类别、无模型输出时停止，整批暂停。此时无法判断新指令能否改变同一轮的答复。

`--offline scenarios` 在 Node 实现的假 App Server 上实际收发 stdio 消息。另用同版本官方二进制的 `native-roster` 样例，在没有账号的临时配置里放置一个只写启动标记的 MCP。两次读取有效配置时分别看到该服务启用、禁用，均未触发标记；直接运行同一程序的阳性对照触发标记。只在本机回环的独立 Responses 模拟中，关闭 view_image、goals 和 experimental_request_user_input 后，技术员观察到发给模拟服务的工具清单为空。该模拟也观察到原生轮开始前可能出现模型元数据诊断。驱动仅接受已核实的固定版本、固定模型、固定原文和位置，其他未知项输出枚举类别并中止。首次真实 exec 究竟遇到哪种 item 仍未知。[受控场景](spike/scenarios.mjs) · [回环前置检查](spike/roster-fixture.mjs) · [执行事件定义](https://github.com/openai/codex/blob/rust-v0.167.0/codex-rs/exec/src/exec_events.rs)

```powershell
node $p --offline scenarios
node $p --offline native-roster --exe $exe
```

下面各段用同一命令形态。将 `NAME` 替换成表内一个名称，每次执行一段。组长在每段执行前、结束后核对同一 10080 分钟窗口，串行更新 `$before` 和 `$spent`。原生程序开始前的配额快照必须显示零余额、无可用付费点数、未耗尽的原有额度。原生接口未返回普通额度许可时，组长须额外通过官方宿主确认前后均为可用，再以 `--included-only` 传入前置确认。不能据百分比推断许可。各段独占预留；首次 exec 不重跑。13 个原生动作加首批预留共 14 个。每段还为意外失败留出一轮余量，单个 harness 总上限为 30；记录每次 MCP 调用、原生拒绝及可见错误。官方内置 openai provider 不接受覆盖请求或流重试次数，驱动不自动重试。原生动作数和底层网络次数分别报告。[固定版 provider 合并规则](https://github.com/openai/codex/blob/rust-v0.167.0/codex-rs/model-provider-info/src/lib.rs#L739-L769) · [官方用量字段](https://github.com/openai/codex/blob/rust-v0.167.0/codex-rs/app-server-protocol/src/protocol/v2/account.rs#L323-L350)

```powershell
node $p --live scenarios --case NAME --exe $exe --policy-reviewed --included-only --before-used-percent $before --used-turns $spent
```

组长在最终图片场景执行了以下单独批准的命令。它预留 2 个动作，只提交一次原生 `turn/start`。如果原生服务通知将重连，控制器会先把这次可见重连追加到本地持久账本，再继续处理原来的流。宿主无法控制原生客户端开始网络重连的时机，底层实际请求数仍未知。需同时核对原线程和轮次、启动回执、此前无模型文本、推理或工具活动。只接受精确的 `responseStreamDisconnected`、`willRetry=true`，HTTP 状态须缺省或为 500、502、503、504。遇到再次断流、401、403、429、未知事件后无法确认是否已有输出、或计量条件变化，停止。最终仍须由同一轮返回唯一且能识别随机构图的答案。第二批合计最多 13 个新增动作，含这次可能发生的重连。每个第二批场景都会在启动前用当前累计加上该段上限，与两批合计 14 个动作核对。剩余动作不足以覆盖整个场景时停止，组长据实缩减后续场景。离线合成回归覆盖了满足全部条件时的续流。真实图片场景未能证实全部条件，控制器停止。

```powershell
node $p --live scenarios --case image --exe $exe --policy-reviewed --included-only --before-used-percent $before --used-turns $spent --allow-one-stream-reconnect
```

| NAME      | 原生动作上限 | 如何判断                                                                                                                                                                                                 |
| --------- | -----------: | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| steer     |            2 | 在 turn/started 后发送 steer。原 turnId 完成且唯一终稿变为新标记。                                                                                                                                       |
| interrupt |            3 | 活动轮发 interrupt，观察 interrupted，再在同线程发新轮。当前严格只读，无已写文件样本。                                                                                                                   |
| resume    |            2 | 用随机暗号启动唯一持久化测试线程，关闭服务器再重启、按原 ID 恢复。给出暗号后或中途失败均尝试仅归档本次已确认的线程。必要时用同样受限的连接再试一次归档。无法确认归档时明确记录可能残留一个原生测试会话。 |
| parallel  |            2 | 两个临时 cwd 各放不同的随机标记。两个模型轮仅可调用无参数的本地固定工具，读取自己 cwd 的 fixture.txt。核对两个独立答复、工具调用、文件状态以及原生轮的时间区间是否重叠。                                 |
| mcp       |            1 | 仅在本次进程启用固定返回文本的本地 stdio MCP。按 threadId、turnId、itemId 对齐真实开始、结束与结果。                                                                                                     |
| approval  |            1 | 只启用 request_permissions，要求对测试根下兄弟目录指定文件申请写权限。宿主一律答空权限，核对申请范围、拒绝与文件仍不存在。禁止通用 shell 与实际写操作。若测试版本未产生请求，只记录未证实。              |
| image     |            1 | 在内存随机排列四种色条，编码为 PNG 并随文字输入，期望唯一终稿按顺序答出四个字母。                                                                                                                        |
| resources |            1 | 同一原生进程树在会话空闲和固定 MCP 短延迟工作中各采样工作集。按实测说明采样时是否仍在工作，Windows Job 关闭后复核已观察 PID 的残留数。                                                                   |

每段开始前，驱动对老板默认 Codex home 执行 `initialize`、`initialized`、`config/read`，不创建线程。0.167.0 只支持 `cwd` 和 `includeLayers`，没有服务端按键选择。完整原生答复经本地进程内存，实际使用测试所需配置名称、启用状态和约束；不打印配置内容，不读取凭据文件，不把配置对象装入模型输入。确认后重启，逐一禁用先前服务，再检查有效配置及原生登录。固定 MCP 专段仅放行新登记的测试进程、固定参数和工具。发生意外权限、未知工具、计费或边界异常，整批暂停。单个应答未命中标记、引导错过活动轮等作为该项未证实，可在额度仍许可时继续其他已批场景。自然压缩只记录被动观察。[协议控制器](spike/scenario-rpc.mjs) · [固定版本配置读取参数](https://github.com/openai/codex/blob/rust-v0.167.0/codex-rs/app-server-protocol/src/protocol/v2/config.rs#L359-L378)

每个 App Server 子进程单独设置 `CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED=1`，并传入 `analytics.enabled=false`，以及 exporter、metrics_exporter、trace_exporter 均为 none 的 OTEL 配置。固定版本的 `config/read` 可复核 14 项被禁用的特性。原生接口未投影 `tools.experimental_request_user_input.enabled`，该项由传入参数和上述独立本机 Responses 模拟取证。真实回包须同时符合模型、provider、审批模式、只读沙箱、临时线程标志和两个 cwd。失败或后置额度不可读时，保留原阶段原因、开始读数、缺失的后置读数及已提交动作；进程强制结束时可用本地独占预留复核保守计数。

### 真实能力与 T-007 开工结论

| AdapterCapabilities | 真实支持状态 | 尚缺证据                                     |
| ------------------- | ------------ | -------------------------------------------- |
| `resume`            | 待验         | 成功恢复并记得先前的暗号                     |
| `guide`             | 待验         | 追加输入在本轮产生可辨识的效果               |
| `interrupt`         | 待验         | 原轮中断、文件保留情况、后续可发言           |
| `parallel`          | 待验         | 原生多会话并发及文件隔离                     |
| `images`            | 待验         | 图片轮再次断流，无模型输出或终稿可核对       |
| `nativeApproval`    | 待验         | 原生审批、请求关联、程序拒绝及目标文件无变动 |

**T-007 当前环境不开工。** App Server 能创建原生线程，活动轮的引导能提交，响应流尚未稳定到足以验证完整回复。保留 App Server 为候选，待现有 ChatGPT 登录正常且流稳定后再决定正式接入路线。六项能力均未获得可判定支持与否的真实证据，现阶段没有实测依据要求修改接口。
