import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { summarizeClaude } from "../../claude-code/spike/session-check.mjs";
import { execState, protocolState } from "./session-check.mjs";
import { cleanEnv, liveArgs } from "./session-common.mjs";

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
  expect(() =>
    execState()({ type: "item.started", item: { type: "command_execution" } }),
  ).toThrow();
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
