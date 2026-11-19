# T-006 / T-007 员工适配器接入契约测试

适配器实现从 `@paihuo/shared/staff` 导入的 `StaffAdapter`。调度层或测试可从 `@paihuo/shared/testing` 导入 `FakeStaffAdapter`、`runStaffContract`。测试包不依赖 Vitest，也不会自行启动客户端。工作区的 `pnpm test` 会发现这里的离线用例。

## 给真实适配器接同一套断言

在适配器包的 Vitest 测试里调用下面的函数。传入自己的适配器工厂，每次调用都返回一个新实例。CI 工厂应将真实适配器连到模拟 CLI 或协议传输层，以便验证适配器本身的事件映射和能力声明。

```ts
import type { StaffAdapter } from "@paihuo/shared/staff";
import { runStaffContract, type StaffContractCase } from "@paihuo/shared/testing";

export function checkAdapter(
  create: (scenario: StaffContractCase) => StaffAdapter | Promise<StaffAdapter>,
  cwd: { a: string; b: string },
  pngPath: string,
  approvalSummary: string,
) {
  return runStaffContract(create, {
    startInput: (slot) => ({
      memberId: "contract-member",
      cwd: cwd[slot],
      preamble: "",
      runtimeConfig: {},
    }),
    imagePath: pngPath,
    recallInput: { text: "原样输出上一轮给你的 PH- 开头标记。" },
    approvalInput: { text: "调用一次测试工具读取本目录的 contract.txt。" },
    acceptApproval: (request) => request.summary === approvalSummary,
  });
}
```

让 Vitest 的测试函数返回或 `await` 上面的 Promise。两个工作目录应独立且仅含测试数据，`pngPath` 指向有效的小图片。只在审批场景配置会触发指定测试工具的原生审批规则，核对实际摘要再传入 `approvalSummary`。其余场景使用普通文本。工厂收到的场景名可用来选择协议回放。

- `turn` 会读完整条流，检查最后一条是唯一的 `turn_done`。默认测试输入要求回复一个随机标记。
- `resume` 在休眠后继续使用原引用。T-006 和 T-007 的恢复验收须提供上例的 `recallInput` 或等效的回忆夹具，要求模型从原会话找回休眠前的随机标记。省略它时只检查恢复后能继续收发。
- `guide`、`interrupt`、`parallel` 都需要一轮仍在运行。离线回放先发一段回复，再留出受控窗口。需要调整提示时传 `turnInput(marker, ongoing)`，普通轮次返回所给标记，长轮次先给标记并继续生成。接受引导后，同轮还应回复新标记。并行场景同时检查两条流各自的标记。
- `images` 和 `nativeApproval` 根据声明验证图片投递或审批请求。声明不支持的引导返回 `{ accepted: false }`，其他不支持的操作抛出 `StaffAdapterError`，错误码为 `unsupported_capability`。七项全部通过后返回逐项结果，失败会抛出带场景名的错误。

## 在哪里运行

从仓库根目录运行 `pnpm exec vitest run packages/shared/src/testing/staff.test.ts`。它用内存假适配器覆盖能力切换、错误注入、休眠记录丢失、并行、中断和故意重复的结束事件。脚本通过 `script(input, context)` 返回完整事件序列，`context.previousInputs` 是该原生会话之前的输入。可用 `delayMs` 配置事件间隔，用 `failure` 对指定方法注入错误。

T-006、T-007 另设显式启用的本机测试入口。在安装且已登录 Claude Code 或 Codex 的 Windows 机器上，将同一工厂换接真实客户端，运行流式输出、原生会话恢复及其余已声明能力，记录客户端版本和逐项结果。为该测试设置适合真实响应的超时，并在测试结束时关闭传输层和子进程。默认 CI 使用协议回放，不读取本机登录状态。
