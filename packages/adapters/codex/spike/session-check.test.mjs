import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { summarizeClaude } from "../../claude-code/spike/session-check.mjs";
import { offlineCases } from "./scenario-fixture.mjs";
import { quotaSnapshot } from "./scenario-observations.mjs";
import { errorNotification, imageReconnectGate, openRpc } from "./scenario-rpc.mjs";
import {
  appServerEnv,
  closeLedger,
  disabledFeatures,
  runCase,
  telemetrySettings,
  verifyPolicy,
  verifyRoster,
} from "./scenarios.mjs";
import { execState, protocolState } from "./session-check.mjs";
import { cleanEnv, liveArgs, ProbeStop, withScratch } from "./session-common.mjs";

it("图片可选同轮重连只对精确的无输出瞬时断流生效，先记预算", () => {
  const notice = (status) => ({
    threadId: "t",
    turnId: "u",
    willRetry: true,
    error: { codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: status } } },
  });
  const started = { threadId: "t", turn: { id: "u" } };
  const active = (charge = () => {}) => {
    const gate = imageReconnectGate(charge);
    gate.submitted("t");
    gate.observe("turn/started", started);
    gate.acknowledged({ id: "u" });
    return gate;
  };
  for (const status of [null, undefined, 500, 502, 503, 504]) {
    let charged = 0;
    const gate = active(() => charged++);
    expect(gate.observe("error", notice(status))).toBe(true);
    expect(charged).toBe(1);
    expect(gate.observe("error", notice(status))).toBe(false);
    expect(charged).toBe(1);
  }
  const bad = [
    ...[400, 401, 403, 429, 501, 505, "503"].map(notice),
    { ...notice(null), threadId: "x" },
    { ...notice(null), turnId: "x" },
    { ...notice(null), willRetry: false },
    { ...notice(null), willRetry: null },
  ];
  for (const info of [
    "unauthorized",
    { responseStreamConnectionFailed: {} },
    { responseStreamDisconnected: null },
    { responseStreamDisconnected: {}, other: {} },
    { responseStreamDisconnected: { httpStatusCode: null, unreviewed: true } },
  ])
    bad.push({ ...notice(null), error: { codexErrorInfo: info } });
  for (const p of bad) {
    const gate = active();
    expect(gate.observe("error", p)).toBe(false);
    expect(gate.count()).toBe(0);
  }
  for (const [method, p] of [
    ["item/agentMessage/delta", { delta: "x" }],
    ["item/reasoning/summaryTextDelta", { delta: "x" }],
    ["item/started", { item: { type: "reasoning" } }],
    ["item/completed", { item: { type: "agentMessage" } }],
    ["item/started", { item: { type: "mcpToolCall" } }],
    ["turn/completed", started],
    [
      "thread/tokenUsage/updated",
      { tokenUsage: { total: { outputTokens: 2, reasoningOutputTokens: 0 } } },
    ],
    ["future/unknown", {}],
  ]) {
    const gate = active();
    gate.observe(method, p);
    expect(gate.observe("error", notice(null))).toBe(false);
  }
  const unknown = imageReconnectGate(() => {});
  unknown.submitted("t");
  unknown.acknowledged({ id: "u" });
  expect(unknown.observe("error", notice(null))).toBe(false);
  expect(() =>
    active(() => {
      throw new Error("synthetic ledger failure");
    }).observe("error", notice(null)),
  ).toThrow("synthetic ledger failure");
  const args = [
    "--policy-reviewed",
    "--before-used-percent",
    "77",
    "--used-turns",
    "3",
    "--included-only",
    "--allow-one-stream-reconnect",
  ];
  expect(() => liveArgs(args, true)).toThrow();
  expect(liveArgs(args, true, true)["allow-one-stream-reconnect"]).toBe(true);
});

it("跨进程合成图片断流默认停止，可选模式一次宿主提交后核对唯一终稿", async () => {
  for (const [enabled, fixture] of [
    [false, "disconnect-image"],
    [true, "disconnect-image"],
    [true, "repeat-after-final"],
  ])
    await withScratch(async (root, project) => {
      let host = 0,
        reconnects = 0;
      const connect = async () => {
        const c = openRpc(
          process.execPath,
          [
            fileURLToPath(new URL("./scenario-fixture.mjs", import.meta.url)),
            "--serve",
            root,
            fixture,
          ],
          project,
          cleanEnv(root),
          false,
          null,
          enabled ? () => reconnects++ : null,
        );
        await c.request("initialize");
        c.initialized();
        return c;
      };
      const result = runCase("image", { connect, project, charge: () => host++ });
      if (enabled && fixture === "disconnect-image")
        expect(await result).toMatchObject({
          randomColorOrderMatched: true,
          countedStreamReconnects: 1,
          deltaMatchesFinal: true,
        });
      else await expect(result).rejects.toThrow(/responseStreamDisconnected/);
      expect(host).toBe(1);
      expect(reconnects).toBe(Number(enabled));
    });
});

it("握手前退出只暴露固定错误类别和退出码", async () => {
  await withScratch(async (root, cwd) => {
    const c = openRpc(
      process.execPath,
      [
        "-e",
        "process.stderr.write('synthetic-private-location unknown variant for hist');setTimeout(()=>{process.stderr.write('ory.persistence');process.exitCode=9},10)",
      ],
      cwd,
      cleanEnv(root),
    );
    try {
      const reason = await c.request("initialize").then(
        () => "",
        (error) => error.message,
      );
      expect(reason).toContain("startup=history-enum, exit=9");
      expect(reason).not.toContain("synthetic-private-location");
    } finally {
      await c.close();
    }
  });
});

it("运行期错误只保留协议枚举、选定 HTTP 类别与重试标志", () => {
  const info = (code, retry) =>
    errorNotification({
      error: {
        codexErrorInfo: code,
        message: "synthetic-private-location",
        additionalDetails: "synthetic-private-token",
      },
      willRetry: retry,
    });
  expect(info("unauthorized", false)).toBe(
    "codexErrorInfo=unauthorized, http=unknown, willRetry=false",
  );
  for (const [native, expected] of [
    [401, "401"],
    [403, "403"],
    [429, "429"],
    [503, "5xx"],
    [418, "unknown"],
  ]) {
    expect(info({ responseStreamDisconnected: { httpStatusCode: native } }, true)).toBe(
      `codexErrorInfo=responseStreamDisconnected, http=${expected}, willRetry=true`,
    );
  }
  for (const code of [
    "synthetic-private-location",
    { "synthetic-private-token": {} },
    { responseStreamDisconnected: {}, private: {} },
    null,
  ]) {
    expect(info(code, "synthetic-private-token")).toBe(
      "codexErrorInfo=unknown, http=unknown, willRetry=unknown",
    );
  }
});

it("记暗号失败后仅归档本次线程，必要时重连且不发新轮", async () => {
  const cwd = process.cwd();
  for (const archiveWorks of [false, true]) {
    const requests = [];
    let connections = 0,
      charged = 0;
    const connect = async () => {
      const n = ++connections;
      return {
        trace: [],
        close: async () => {},
        observed: () => ({ toolCalls: 0, latestCumulativeTokenTotals: [] }),
        request: async (method, params) => {
          requests.push([method, params?.threadId]);
          if (method === "thread/start")
            return {
              thread: { id: "owned-fixture", cwd, ephemeral: false },
              cwd,
              model: "gpt-6.2-sol",
              modelProvider: "openai",
              approvalPolicy: "never",
              sandbox: { type: "readOnly" },
            };
          if (method === "thread/archive" && n === 2 && archiveWorks) return {};
          throw new ProbeStop("合成阶段失败。");
        },
      };
    };
    await expect(
      runCase("resume", { project: cwd, connect, charge: () => charged++ }),
    ).rejects.toThrow(archiveWorks ? /持久测试线程已归档/ : /本机测试会话可能仍留存/);
    expect(requests).toEqual([
      ["thread/start", undefined],
      ["turn/start", "owned-fixture"],
      ["thread/archive", "owned-fixture"],
      ["thread/archive", "owned-fixture"],
    ]);
    expect(charged).toBe(1);
  }
});

it("未核实的原生线程配置阻止提交第一轮", async () => {
  const cwd = process.cwd();
  const thread = { id: "synthetic", cwd, ephemeral: true };
  const correct = {
    cwd,
    thread,
    model: "gpt-6.2-sol",
    modelProvider: "openai",
    approvalPolicy: "never",
    sandbox: { type: "readOnly", networkAccess: false },
  };
  for (const overrides of [
    { cwd: "other" },
    { thread: { ...thread, cwd: "other" } },
    { thread: { ...thread, ephemeral: false } },
    { model: "other" },
    { modelProvider: "other" },
    { approvalPolicy: "on-request" },
    { sandbox: { type: "workspaceWrite" } },
    { sandbox: { type: "readOnly", networkAccess: true } },
  ]) {
    const methods = [];
    let used = 0;
    const client = {
      request: async (method) => {
        methods.push(method);
        return { ...correct, ...overrides };
      },
      close: async () => {},
    };
    await expect(
      runCase("steer", { project: cwd, connect: async () => client, charge: () => used++ }),
    ).rejects.toThrow(/发轮前停止/);
    expect(methods).toEqual(["thread/start"]);
    expect(used).toBe(0);
  }
});

it("后置额度不可读、窗口改变保留开始读数、动作与原始失败", () => {
  const before = { usedPercent: 71, resetsAt: 10 };
  expect(() =>
    closeLedger(1, 2, before, null, new ProbeStop("原生协议失败。"), new Error()),
  ).toThrow(/预留 2，已提交动作 1，before=71，after=null。原始阶段：原生协议失败。后置额度/);
  expect(() => closeLedger(2, 2, before, { usedPercent: 30, resetsAt: 11 }, null, null)).toThrow(
    /已提交动作 2，before=71，after=30.*窗口不同/,
  );
  expect(() => closeLedger(1, 2, before, before, null, null)).not.toThrow();
});

it("有效 MCP 清单逐项匹配且远程控制仅限子进程禁用", () => {
  const base = { sentinel: { enabled: false } };
  const fixed = {
    command: process.execPath,
    args: ["fixed"],
    enabled: true,
    required: true,
    enabled_tools: ["fixed"],
  };
  const check = (extra) =>
    verifyRoster(["sentinel"], { ...base, paihuo_t015_fixed: { ...fixed, ...extra } }, ["fixed"]);
  expect(() => check({})).not.toThrow();
  for (const extra of [
    { required: false },
    { environment_id: "remote" },
    { tool_timeout_sec: 900 },
    { args: ["other"] },
    { enabled_tools: ["fixed", "extra"] },
    { env: { unwanted: "fixture" } },
  ])
    expect(() => check(extra)).toThrow();
  for (const roster of [
    { ...base, extra: { enabled: false } },
    { other: { enabled: false } },
    { sentinel: { enabled: true } },
  ])
    expect(() => verifyRoster(["sentinel"], roster, null)).toThrow();
  const env = {};
  expect(appServerEnv(env).CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED).toBe("1");
  expect(env).toEqual({});
  const argv = [
    "-c",
    "tools.experimental_request_user_input.enabled=false",
    ...telemetrySettings.flatMap((setting) => ["-c", setting]),
  ];
  const cfg = {
    model_provider: "openai",
    web_search: "disabled",
    sandbox_mode: "read-only",
    features: Object.fromEntries(disabledFeatures.map((k) => [k, false])),
  };
  expect(() => verifyPolicy(cfg, argv)).not.toThrow();
  for (const k of disabledFeatures)
    expect(() =>
      verifyPolicy({ ...cfg, features: { ...cfg.features, [k]: true } }, argv),
    ).toThrow();
  expect(() => verifyPolicy(cfg, [])).toThrow();
  expect(() =>
    verifyPolicy({ ...cfg, tools: { experimental_request_user_input: { enabled: true } } }, argv),
  ).toThrow();
  expect(() => verifyPolicy({ ...cfg, analytics: { enabled: true } }, argv)).toThrow();
  expect(() => verifyPolicy({ ...cfg, otel: { exporter: "unexpected" } }, argv)).toThrow();
});

for (const dir of ["codex", "claude-code"]) {
  const entry = fileURLToPath(new URL(`../../${dir}/spike/session-check.mjs`, import.meta.url));
  it(`${dir} 默认只输出完整计划`, () => {
    const response = spawnSync(process.execPath, [entry], {
      encoding: "utf8",
      env: { SystemRoot: process.env.SystemRoot, PATH: "" },
    });
    expect(response.status).toBe(0);
    const report = JSON.parse(response.stdout);
    expect(report.mode).toBe("plan");
    expect(new Set(report.results.map((row) => row.id)).size).toBe(12);
    expect(Object.values(report.capabilities)).toEqual(Array(6).fill("待验"));
    expect(report.billing.before).toBeNull();
    expect(report.stages.join(" ")).toContain("--included-only");
    expect(report.smokeArgv).toContain(dir === "codex" ? "shell_tool" : "--safe-mode");
  });
}

it("额度与策略未知时拒绝模型阶段，子环境排除未列出的键", () => {
  const args = [
    "--policy-reviewed",
    "--included-only",
    "--before-used-percent",
    "25",
    "--used-turns",
    "0",
  ];
  expect(liveArgs(args, true)["used-turns"]).toBe("0");
  for (const bad of [
    args.slice(1),
    args.filter((a) => a !== "--included-only"),
    [...args.slice(0, -1), "30"],
    ["--policy-reviewed", "--included-only", "--before-used-percent", "100", "--used-turns", "0"],
  ]) {
    expect(() => liveArgs(bad, true)).toThrow();
  }
  expect(Object.keys(cleanEnv("fixture", true)).sort()).toEqual(
    [
      "APPDATA",
      "HOME",
      "LOCALAPPDATA",
      "NO_COLOR",
      "SystemRoot",
      "TEMP",
      "TMP",
      "USERPROFILE",
      "WINDIR",
    ].sort(),
  );
});

it("Claude 合成成功要求一轮、前言、空工具，额外重试使其失败", () => {
  const rows = [
    { type: "system", subtype: "init", tools: [], mcp_servers: [] },
    { type: "stream_event", event: { delta: { type: "text_delta", text: "PAIHUO_OK" } } },
    { type: "result", subtype: "success", is_error: false, result: "PAIHUO_OK", num_turns: 1 },
  ];
  const lines = (items) => items.map((item) => JSON.stringify(item)).join("\n");
  expect(summarizeClaude(lines(rows))).toMatchObject({
    nativeTurns: 1,
    streamMatched: true,
    toolCalls: 0,
  });
  expect(() =>
    summarizeClaude(lines([...rows, { type: "system", subtype: "api_retry" }])),
  ).toThrow();
  expect(() =>
    summarizeClaude(lines([{ ...rows[0], tools: ["Bash"] }, ...rows.slice(1)])),
  ).toThrow();
  expect(() => summarizeClaude(lines(rows.slice(0, 2)))).toThrow();
  expect(() =>
    summarizeClaude(lines([...rows, { type: "system", subtype: "model_refusal_fallback" }])),
  ).toThrow();
  expect(() =>
    summarizeClaude(lines([...rows.slice(0, 2), { ...rows[2], modelUsage: { one: {}, two: {} } }])),
  ).toThrow();
});

it("exec 拒绝重试、工具、第二轮和缺少前言的终态", () => {
  const next = execState();
  next({ type: "thread.started" });
  next({ type: "turn.started" });
  expect(() => next({ type: "turn.completed" })).toThrow();
  next({ type: "item.completed", item: { type: "agent_message", text: "PAIHUO_OK" } });
  expect(next({ type: "turn.completed" })).toMatchObject({ preambleMatched: true, toolCalls: 0 });
  expect(() => next({ type: "turn.started" })).toThrow();
  expect(() => execState()({ type: "error" })).toThrow();
  const extra = execState();
  extra({ type: "thread.started" });
  extra({ type: "turn.started" });
  extra({ type: "item.completed", item: { type: "agent_message", text: "unrelated" } });
  expect(() =>
    extra({ type: "item.completed", item: { type: "agent_message", text: "PAIHUO_OK" } }),
  ).toThrow();
  const diag = execState();
  diag({ type: "thread.started" });
  diag({
    type: "item.completed",
    item: {
      type: "error",
      message:
        "Model metadata for `gpt-6.2-sol` not found. Defaulting to fallback metadata; this can degrade performance and cause issues.",
    },
  });
  expect(() =>
    diag({ type: "item.completed", item: { type: "error", message: "private content" } }),
  ).toThrow(/item.completed\/error/);
  expect(() =>
    execState()({ type: "item.started", item: { type: "command_execution" } }),
  ).toThrow();
});

it("八段控制脚本经过跨进程合成 stdio，额度数据缺失或付费时拒绝", async () => {
  const sample = {
    ordinaryUsageAllowed: true,
    rateLimits: {
      limitId: "codex",
      credits: { hasCredits: false, unlimited: false, balance: "0" },
      secondary: { windowDurationMins: 10080, usedPercent: 71, resetsAt: 2000000000 },
    },
  };
  expect(quotaSnapshot(sample).usedPercent).toBe(71);
  expect(() => quotaSnapshot({ ...sample, ordinaryUsageAllowed: false })).toThrow();
  expect(() =>
    quotaSnapshot({
      ...sample,
      rateLimits: { ...sample.rateLimits, credits: { hasCredits: true } },
    }),
  ).toThrow();
  expect(
    quotaSnapshot({ ...sample, ordinaryUsageAllowed: null }).requiresHostOrdinaryUsageCheck,
  ).toBe(true);
  const { results, modelRequests } = await offlineCases();
  expect(modelRequests).toBe(0);
  expect(Object.keys(results)).toHaveLength(8);
  expect(results.parallel.nativeTurnsOverlap).toBe(true);
  expect(results.parallel.perThreadFileRead).toBe(true);
  expect(results.approval.matchedApprovalDeclined).toBe(true);
  expect(results.image.randomColorOrderMatched).toBe(true);
  expect(Object.values(results).reduce((n, r) => n + r.syntheticNativeActions, 0)).toBe(13);
});

it("App Server 探针只发送握手和无效恢复，拒绝非预期请求并保留错误类别", () => {
  const sent = [];
  const next = protocolState({
    stdin: { write: (line) => sent.push(JSON.parse(line)), end: () => {} },
  });
  next({ id: 1, result: { userAgent: "fixture" } });
  expect(sent.map((f) => f.method)).toEqual(["initialize", "initialized", "thread/resume"]);
  expect(() => next({ id: 99, method: "thread/shellCommand" })).toThrow();
  expect(() => next({ id: 2, error: { code: -1, message: "model provider not found" } })).toThrow();
  expect(
    next({ id: 2, error: { code: -1, message: "no rollout found for thread id" } }),
  ).toMatchObject({ nativeTurns: 0, invalidResume: "session-not-found" });
});
