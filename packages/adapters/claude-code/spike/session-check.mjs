import { randomUUID } from "node:crypto";
import { join } from "node:path";

import { checkMcp } from "../../codex/spike/fixed-mcp.mjs";
import {
  checkedExe,
  cleanEnv,
  command,
  liveArgs,
  plan,
  requireThat,
  reserve,
  sessionMain,
  withScratch,
} from "../../codex/spike/session-common.mjs";
import { verifySyntheticStreams } from "./synthetic-events.mjs";

const controls = [
  "--restricted",
  "--safe-mode",
  "--setting-sources",
  "",
  "--settings",
  JSON.stringify({ disableAllHooks: true }),
  "--tools",
  "",
  "--disallowedTools",
  "mcp__*",
  "--strict-mcp-config",
  "--permission-mode",
  "dontAsk",
  "--max-turns",
  "1",
];
const output = ["--output-format", "stream-json", "--verbose", "--include-partial-messages"];
const smoke = [
  "-p",
  "按前言回答。",
  "--append-system-prompt",
  "仅回答 PAIHUO_OK。",
  ...controls,
  ...output,
  "--no-session-persistence",
];
const stageNames = [
  "--plan",
  "--offline protocol",
  "--offline mcp",
  "--live transport --exe PATH --policy-reviewed",
  "--live auth --exe PATH --policy-reviewed",
  "--live smoke --exe PATH --policy-reviewed --included-only --before-used-percent N --used-turns N",
];

export function summarizeClaude(lines) {
  const frames = lines
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line));
  const init = frames.find((f) => f.type === "system" && f.subtype === "init");
  const result = frames.filter((f) => f.type === "result");
  const deltas = frames.filter(
    (f) => f.type === "stream_event" && f.event?.delta?.type === "text_delta",
  );
  requireThat(
    init &&
      Array.isArray(init.tools) &&
      init.tools.length === 0 &&
      Array.isArray(init.mcp_servers) &&
      init.mcp_servers.length === 0,
    "原生工具或 MCP 集合与空白名单不符，停止。",
  );
  requireThat(
    !frames.some(
      (f) =>
        f.subtype === "api_retry" ||
        f.subtype?.startsWith("hook_") ||
        f.event?.content_block?.type === "tool_use" ||
        f.message?.content?.some?.((b) => b.type === "tool_use"),
    ),
    "出现重试、hook 或工具事件，停止并核对额度。",
  );
  requireThat(
    result.length === 1 &&
      result[0].subtype === "success" &&
      result[0].is_error === false &&
      result[0].num_turns === 1,
    "未取得单轮原生成功终态，请人工复核本次额度。",
  );
  requireThat(result[0].result?.trim() === "PAIHUO_OK", "固定前言标记不匹配。");
  return {
    preambleMatched: true,
    nativeTurns: 1,
    textDeltaCount: deltas.length,
    streamMatched:
      deltas
        .map((f) => f.event.delta.text)
        .join("")
        .trim() === "PAIHUO_OK",
    toolCalls: 0,
    inputTokens: result[0].usage?.input_tokens,
    outputTokens: result[0].usage?.output_tokens,
  };
}

function subscription(exe, cwd, env) {
  const response = command(
    exe,
    [
      "--restricted",
      "--safe-mode",
      "--settings",
      JSON.stringify({ disableAllHooks: true }),
      "auth",
      "status",
    ],
    cwd,
    env,
  );
  requireThat(response.status === 0, "没有可用的原生已有登录，停止。");
  const state = JSON.parse(response.stdout);
  requireThat(
    state.loggedIn === true &&
      state.authMethod === "claude.ai" &&
      state.apiProvider === "firstParty",
    "原生登录类别或 provider 无法确认是 claude.ai 订阅，停止。",
  );
}

async function main(args) {
  if (args.length === 0 || (args.length === 1 && args[0] === "--plan")) {
    return {
      ...plan("Claude Code", ["CLI 流式", "Agent SDK（项目未安装）"], stageNames),
      smokeArgv: smoke,
    };
  }
  if (args.length === 2 && args[0] === "--offline") {
    if (args[1] === "mcp") return checkMcp();
    if (args[1] === "protocol") {
      await verifySyntheticStreams();
      return { mode: "offline-protocol", synthetic: true, nativeHarness: false };
    }
  }
  const [mode, stage, ...rest] = args;
  requireThat(
    mode === "--live" && ["transport", "auth", "smoke"].includes(stage),
    "未知命令，请查看 --plan。",
  );
  const values = liveArgs(rest, stage === "smoke");
  const exe = checkedExe(values.exe, "claude.exe");
  return withScratch((root, project) => {
    const env = {
      ...cleanEnv(root, stage !== "transport"),
      CLAUDE_CODE_MAX_RETRIES: "0",
      CLAUDE_CODE_RETRY_WATCHDOG: "0",
      CLAUDE_CODE_NONSTREAMING_TIMEOUT_RETRIES: "0",
      CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      DISABLE_AUTOUPDATER: "1",
      DISABLE_TELEMETRY: "1",
      ENABLE_CLAUDEAI_MCP_SERVERS: "false",
    };
    if (stage === "transport") env.CLAUDE_CONFIG_DIR = join(root, "claude");
    const version = command(exe, ["--version"], project, env);
    requireThat(
      version.status === 0 && version.stdout.trim() === "2.1.316 (Claude Code)",
      "原生版本与审阅的 2.1.316 不符。",
    );
    if (stage === "transport") {
      const zero = command(
        exe,
        ["-p", ...controls, ...output, "--input-format", "stream-json", "--resume", randomUUID()],
        project,
        env,
        "",
      );
      const combined = zero.stdout + zero.stderr;
      requireThat(
        zero.status !== 0 &&
          /(?:no conversation found|session not found|no session found|could not find .*session)/i.test(
            combined,
          ),
        "未取得明确的无效恢复分类，可能先要求认证或输入。",
      );
      return {
        stage,
        version: "2.1.316",
        nativeTurns: 0,
        invalidResume: "session-not-found",
        mapping: "native_session_lost",
      };
    }
    subscription(exe, project, env);
    if (stage === "auth")
      return {
        stage,
        version: "2.1.316",
        nativeTurns: 0,
        auth: "claude.ai",
        billing: "待核对用量页",
      };
    reserve("claude");
    const response = command(exe, smoke, project, env, undefined, 90000);
    requireThat(response.status === 0, "首轮已预留，CLI 返回失败，停止且不重试。");
    return {
      stage,
      version: "2.1.316",
      beforeUsedPercent: Number(values["before-used-percent"]),
      afterUsedPercent: null,
      ...summarizeClaude(response.stdout),
    };
  });
}

sessionMain(main, import.meta.url);
