# T-003 Claude Code 离线验证

2026-11-20 在 Windows 11 企业版 LTSC（10.0.26100）上验证，Node.js v24.18.0，Claude Code 2.1.316。D-018 将本轮限定为离线验证。样例用本机 CLI 帮助确认可调用的选项，并用合成事件验证解析。本轮证据支持后续实测准备，接入路线及真实会话能力仍待确认。

## 运行样例

在 Windows 项目根目录运行。默认模式需要 Node.js 和 PATH 上已安装的原生 `claude.exe`。

```powershell
node packages/adapters/claude-code/spike/offline.mjs
```

[offline.mjs](spike/offline.mjs) 先运行合成检查，然后只执行 `claude --version`、`claude --help` 和 `claude mcp --help`。每次执行使用样例目录内新建的临时工作目录和配置目录，只传入白名单环境变量，禁用遥测、更新和 Claude.ai MCP 连接器。子进程不接收标准输入。每个命令最多运行 10 秒，输出限 1 MiB，超时终止该子进程；样例在退出时删除自身建立的临时目录。控制台仅输出版本、选项计数和状态。退出码 0 表示离线检查通过，1 表示检查失败，2 表示找不到原生 CLI。环境变量和命令行为见官方说明。[环境变量](https://code.claude.com/docs/en/env-vars) · [无界面 CLI](https://code.claude.com/docs/en/headless)

[synthetic-events.mjs](spike/synthetic-events.mjs) 在内存构造两条 JSON 行流。断言覆盖被拆成两块的 UTF-8 字符、CRLF、没有尾换行的结果事件、工具调用与结果配对、压缩事件识别、会话 ID 隔离和错误输入。事件形状取自协议公开定义，数据由测试生成。[TypeScript SDK 事件](https://code.claude.com/docs/en/agent-sdk/typescript) · [流式响应](https://code.claude.com/docs/en/agent-sdk/streaming-output)

Windows CI 可以只运行合成检查。此模式仅需 Node.js，在 CLI 查找、临时目录创建和子进程启动前返回。退出码 0 表示合成断言通过，1 表示失败或参数无效。

```powershell
node packages/adapters/claude-code/spike/offline.mjs --synthetic-only
```

## 任务卡场景

表中「本机」指版本、帮助和进程退出的观察。「合成」指对人为构造的事件运行了断言。「协议」指官方文档提供的机制。运行样例即可复现表中的本机和合成检查。

| 项目          | 离线结果     | 可重复命令或样例                                                 | 已观察到的现象                                                                                                                                                                               | 实测边界                                                             |
| ------------- | ------------ | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| 1 启动        | 本机         | `offline.mjs` 的版本和主帮助检查                                 | Node 能启动原生 CLI。版本及帮助命令均以 0 退出；帮助列出 `--print` 和 `--append-system-prompt`。                                                                                             | 创建新会话、工作目录与前言是否生效，以及 SDK 和 CLI 的行为差异待验。 |
| 2 流式输出    | 本机、合成   | `offline.mjs`；`synthetic-events.mjs` 的双流样例                 | 帮助列出 `stream-json` 所需开关。合成流按预期读取文本增量、工具调用、工具结果及结束事件。                                                                                                    | 原生事件的顺序、工具开始结束边界及失败行为待验。                     |
| 3 会话 ID     | 本机、合成   | `offline.mjs`；双流的 `session_id` 断言                          | 帮助列出 `--session-id`。合成事件中，相同 ID 通过，错配 ID 被拒绝。                                                                                                                          | 新会话取得实际 ID 并跨进程保存待验。                                 |
| 4 恢复        | 本机、协议   | `offline.mjs` 检查 `--resume` 与 `--no-session-persistence`      | 帮助描述了按 ID 恢复以及禁用持久化后无法恢复。                                                                                                                                               | 用合成记忆标记验证实际重启恢复、旧进程退出和无效 ID 的错误映射。     |
| 5 并行        | 合成         | `synthetic-events.mjs` 并行读取两条消息流                        | 两条合成流各自保留 ID 和文本，交叉输入被拒绝。                                                                                                                                               | 两条真实会话能否在不同目录并行并保持工具调用、文件和事件隔离待验。   |
| 6 中断        | 协议         | SDK `interrupt()` 与中断回执定义                                 | 官方文档定义流式会话中断和队列回执。                                                                                                                                                         | 原生中断事件、进程能否继续、队列处理及恢复待验。                     |
| 7 引导        | 本机、协议   | `offline.mjs` 检查 `--input-format`；流式输入文档                | 帮助列出 `stream-json` 输入，SDK 文档描述后续消息进队列。                                                                                                                                    | 必须实测第二条消息影响当前轮还是在下一轮执行，才能声明 `guide`。     |
| 8 权限        | 本机、协议   | `offline.mjs` 检查 `--permission-mode` 与 `--permission-prompts` | 本机 2.1.316 的帮助将 `--permission-prompts` 设为 `--print` 模式下的应答方，默认 `host`，交给 SDK 宿主或配置的权限应答工具。`none` 会拒绝需要提示的请求，其余仍由 `--permission-mode` 判定。 | 实际权限请求、允许与拒绝结果、约束模式下是否收到回调待验。           |
| 9 长对话      | 本机、合成   | `offline.mjs` 检查 `--autocompact`；合成 `compact_boundary`      | 本机帮助列出配置压缩的开关。合成流能识别压缩事件。                                                                                                                                           | 有效触发阈值、手动与自动策略以及压缩后记忆保真待验。                 |
| 10 成员工具   | 本机、协议   | `offline.mjs` 的 `mcp --help` 和两项 MCP 配置开关检查            | CLI MCP 帮助以 0 退出，主帮助列出单次配置及限制配置来源的选项。                                                                                                                              | 本机 MCP 的连接、发现、调用和断开清理待验。                          |
| 11 登录和计费 | 协议         | 官方认证条款                                                     | 本轮无认证或用量数据。                                                                                                                                                                       | 本人订阅在 CLI 的实际可用性、SDK 授权路径及费用需按批准范围复核。    |
| 12 资源       | 本机命令退出 | `offline.mjs` 的三条帮助及版本命令                               | 三个短命令均正常退出。运行后样例临时目录残留数为 0。                                                                                                                                         | 真实会话在空闲、工作及休眠后的内存与完整进程树清理待验。             |

协议参考包括 [会话恢复](https://code.claude.com/docs/en/agent-sdk/sessions)、[流式输入与中断](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode)、[权限](https://code.claude.com/docs/en/agent-sdk/permissions)、[MCP](https://code.claude.com/docs/en/agent-sdk/mcp) 和 [认证条款](https://code.claude.com/docs/en/legal-and-compliance)。

## AdapterCapabilities

| 项目             | 离线结果   | 可重复命令或样例                     | 已观察到的现象                                       | 实测边界                                         |
| ---------------- | ---------- | ------------------------------------ | ---------------------------------------------------- | ------------------------------------------------ |
| `resume`         | 本机、协议 | `offline.mjs`；会话恢复文档          | CLI 帮助列出按会话 ID 恢复。                         | 实际恢复和记忆保留待验。                         |
| `guide`          | 本机、协议 | `offline.mjs`；流式输入文档          | 提供流式输入，未观察到本轮引导行为。                 | 以第二条消息进入哪个轮次为判定依据。             |
| `interrupt`      | 协议       | SDK `interrupt()` 和回执定义         | 官方文档描述中断当前轮和待处理消息；本轮无运行观测。 | Windows 下的中断、进程、排队消息及后续会话待验。 |
| `parallel`       | 合成       | 两条合成流                           | 验证了解析层的 ID 区分。                             | 多个原生进程或会话并行待验。                     |
| `images`         | 协议       | SDK 流式图片示例                     | 官方文档描述流式输入的图片数据字段；本轮无运行观测。 | 文件转图片消息和模型接收结果待验。               |
| `nativeApproval` | 本机、协议 | `offline.mjs`；SDK `canUseTool` 文档 | CLI 帮助列出权限相关选项，SDK 文档描述何时调用回调。 | 原生请求及回复、ID 对应、取消清理待验。          |

六项能力的真实支持状态均待验；这份报告不填入适配器的布尔能力声明。

## 接入路线、接口影响和 Q-004

下一轮在 Windows 上可先用已安装的官方 CLI 测通启动、事件和恢复，再比较流式 SDK 的中断回执、权限回调和图片输入。CLI 帮助和 SDK 文档目前都支持候选路线，最终取舍留待真实验证。Anthropic 对 Agent SDK 产品集成给出独立的认证要求，使用现有 CLI 登录的结论应按调用形态分别核对。[认证条款](https://code.claude.com/docs/en/legal-and-compliance)

- `guide` 需要当前轮可观察的效果。只看到消息进队列时，应按现有接口返回 `accepted: false`。
- 要验证中断回执与 `turn_done` 如何对应，并确认中断前排队的消息是否继续。权限路径还需验证请求 ID 与 `approve` 回答的关联。接口目前无需据离线证据修改。[SDK 中断回执](https://code.claude.com/docs/en/agent-sdk/typescript#sdkcontrolinterruptresponse) · [审批和用户输入](https://code.claude.com/docs/en/agent-sdk/user-input)
- Q-004 保留待决定。先验证按 ID 恢复及压缩前后的合成记忆标记，再判断是否应优先原生压缩，以及何时启动新会话并用派活的记忆续接。

## 本次命令结果

- `node packages/adapters/claude-code/spike/offline.mjs` 退出 0，三个 CLI 命令分别退出 0，13 项帮助开关均存在，合成断言通过。运行结束无残留临时目录。
- 在仅测试进程内清空 PATH，用 Node 的绝对路径运行同一入口。合成检查通过，样例报告 CLI 不可用并退出 2。
- 清空测试进程的 PATH 后运行 `--synthetic-only`，合成检查通过并退出 0。
- 三个脚本均通过 `node --check` 和项目已有 Biome 的 `ci` 检查。
- 在基线 `0a6cb2c` 的 Windows 隔离工作树执行 `pnpm test --reporter=verbose`，Vitest 自动发现 `offline.test.mjs`，3 个测试文件共 10 个用例通过。新增用例清空子进程的 PATH，检查 `--synthetic-only` 正常退出、无标准错误，并输出合成覆盖汇总。

交付文件为本文和 `spike/offline.mjs`、`spike/synthetic-events.mjs`、`spike/offline.test.mjs`。运行现场数据仅保留汇总状态。

## T-015 真实会话

2026-11-21，Windows 11 x64（10.0.26100），原生 Claude Code 2.1.316。候选入口为原生 CLI 流式打印与 Agent SDK。组长执行本机认证检查时，原生 CLI 退出 1，返回未登录。未发送模型消息，模型轮数为 0。工作区没有安装 Agent SDK。项目当前无法核对这台机器经过程序化调用后的真实额度、流式增量或会话行为。

从项目根目录在 PowerShell 运行。`--plan` 以及省略参数时均只打印计划，包含 12 项取证结构、六个能力字段和真实 smoke 的完整 argv。`--offline mcp` 启动本地固定 MCP 小程序，`--offline job` 验证 Windows Job 会清理一个仍在运行的测试后代。版本与帮助检查沿用 T-003 的 `offline.mjs`。

```powershell
$p = 'packages/adapters/claude-code/spike/session-check.mjs'
node $p --plan
node $p --offline protocol
node $p --offline mcp
node $p --offline job
```

组长仅在老板审阅对应命令后执行下一段。`$exe` 为审阅过的本机原生程序绝对路径。`--policy-reviewed` 表示已经确认本次仍会生效的托管设置没有自定义 hooks、凭据或服务端点覆写。两个账号阶段只使用官方 CLI 的默认登录位置。原始认证输出仅在驱动进程内部解析。`$before` 为已记录的同一额度窗口已用百分比，`$spent` 为本卡该 harness 已使用的原生轮次，包括已发起而失败的尝试、可见重试及追加输入。仅在订阅剩余额度足、额外付费途径已关闭时使用 `--included-only`。缺数据、额度耗尽或未登录时停止。结束后再从同一窗口记录后值、单位、时间与是否发生重置，不把取整后读数未变解释成零消耗。

```powershell
node $p --live transport --exe $exe --policy-reviewed
node $p --live auth --exe $exe --policy-reviewed
node $p --live smoke --exe $exe --policy-reviewed --included-only --before-used-percent $before --used-turns $spent
```

transport 在新建的临时项目和空白配置中，只尝试随机不存在的恢复 ID。smoke 在新的临时目录，用固定中文前言和一个短输入请求固定标记，组合使用 `--safe-mode`、`--restricted`、空内置工具清单、禁 MCP、拒绝权限、单原生轮、禁重试和禁会话持久化。每次只允许一侧一个 smoke，从共享 Git 管理目录以独占创建的方式预留一轮，失败也保留预留。清除预留需要组长先核对累计用量。所有本机子进程在 Windows Job 内运行。驱动仅输出筛选后的结论，不写原始响应、会话 ID 或账户信息。[驱动](spike/session-check.mjs) · [官方 CLI 参数](https://code.claude.com/docs/en/cli-reference) · [重试与环境变量](https://code.claude.com/docs/en/env-vars)

| 项目 | 当前结论和观察 | 对应命令或后续取证 |
| --- | --- | --- |
| 1 路线 | CLI 版本可核对，订阅登录当前不可用；项目 SDK 未安装。两条路线的原生行为尚不能比较。 | `--live auth`，随后在具备条件时对照 CLI 与 SDK |
| 2 启动与前言 | 未发消息，实际工作目录和前言待验。 | `--live smoke` 核对固定标记 |
| 3 流式事件 | 合成增量及工具配对通过；真实增量、最终消息和工具事件待验。 | `--offline protocol`；smoke 只测文本增量 |
| 4 恢复 | 已实现无效恢复的单独入口；错误必须明确指向不存在会话才可映射。跨进程恢复暗号待验。 | `--live transport`；成功恢复需另一个可持久化的短会话 |
| 5 中断 | 真实中断、进程状态、中断前文件及后续发言待验。 | 后续在单独临时目录发 `interrupt()` 并核对结果 |
| 6 引导 | 实际活动轮效果与排队次序待验。 | 记录第二条流式输入所影响的原生轮 |
| 7 并行 | 合成流可分离；两条真实会话的事件和文件隔离待验。 | `--offline protocol`；原生检查分别使用两个临时目录 |
| 8 权限 | smoke 配置为禁工具；尚未观察到真实审批，也不能判定 Q-014 A。 | 后续只向同一测试根下的兄弟临时目录请求写入，拒绝后核对文件不存在 |
| 9 成员工具 | 固定 MCP 的 stdio 握手、单工具发现、合法调用与拒绝多余参数均通过。Claude 原生调用待验。 | `--offline mcp`；[本地 MCP](../codex/spike/fixed-mcp.mjs) |
| 10 计费与认证 | 组长观察到本机原生已有登录不可用。测试前值与后值均未取得，实际额度归属无法确认。 | `--live auth` 返回未登录；比较同窗口测试前后数字 |
| 11 资源 | Windows Job 的离线后代回收已验。原生持续会话的空闲/工作内存和退出回收待验。 | `--offline job`；未来按工作集分别采样本次原生进程树 |
| 12 压缩 | 0 模型轮，未观察到压缩，Q-004 保留。 | 将来在原生轮数上限内被动观察 `compact_boundary` |

原生订阅登录、程序化使用的额度归属、将 Claude 登录用于第三方产品是三个不同问题。裸模式会跳过订阅 OAuth，因此这里使用受限模式和安全模式。产品集成阶段仍须按调用主体核对官方认证条件。[程序化运行](https://code.claude.com/docs/en/headless) · [认证与条款](https://code.claude.com/docs/en/legal-and-compliance)

| AdapterCapabilities | 真实支持状态 | 缺失的原生证据 |
| --- | --- | --- |
| `resume` | 待验 | 按 ID 跨进程继续并记得暗号 |
| `guide` | 待验 | 同轮收到并执行追加输入 |
| `interrupt` | 待验 | 可归因的中断终态及下一轮 |
| `parallel` | 待验 | 双会话并发及文件隔离 |
| `images` | 待验 | 收到合成图片并答出图内标记 |
| `nativeApproval` | 待验 | 宿主收到并拒绝匹配的原生请求 |

T-006 仍等关卡。恢复有效登录后可先执行已审阅的 CLI 单轮，再比较 SDK。SDK 安装和使用其他付费认证渠道分别需要授权。
