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
