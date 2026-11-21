import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { checkMcp } from "./fixed-mcp.mjs";
import { offlineRoster } from "./roster-fixture.mjs";
import { offlineCases } from "./scenario-fixture.mjs";
import {
  allowances,
  appServerEnv,
  disabledFeatures,
  nativeCase,
  telemetrySettings,
} from "./scenarios.mjs";
import {
  checkedExe,
  cleanEnv,
  command,
  liveArgs,
  ProbeStop,
  plan,
  requireThat,
  reserve,
  sessionMain,
  tokenCount,
  withScratch,
} from "./session-common.mjs";

const flags = disabledFeatures.flatMap((name) => ["--disable", name]);
const settings = [
  ...telemetrySettings.flatMap((setting) => ["-c", setting]),
  "-c",
  'web_search="disabled"',
  "-c",
  'forced_login_method="chatgpt"',
  "-c",
  "project_doc_max_bytes=0",
  "-c",
  'model_provider="openai"',
  "-c",
  "tools.experimental_request_user_input.enabled=false",
];
const execArgs = [
  ...flags,
  ...settings,
  "--ask-for-approval",
  "never",
  "exec",
  "--ignore-user-config",
  "--ignore-rules",
  "--ephemeral",
  "--skip-git-repo-check",
  "--sandbox",
  "read-only",
  "--json",
  "--model",
  "gpt-6.2-sol",
  "-c",
  'developer_instructions="Reply only with PAIHUO_OK. Do not use tools."',
  "Follow the developer instructions.",
];
const transportArgs = [
  ...flags,
  ...settings,
  "--ask-for-approval",
  "never",
  "--sandbox",
  "read-only",
  "app-server",
  "--listen",
  "stdio://",
];
const stages = [
  "--plan",
  "--offline protocol",
  "--offline mcp",
  "--offline job",
  "--offline scenarios",
  "--offline native-roster --exe PATH",
  "--live scenarios --case NAME --exe PATH --policy-reviewed --included-only --before-used-percent N --used-turns N",
  "--live transport --exe PATH --policy-reviewed",
  "--live auth --exe PATH --policy-reviewed",
  "--live smoke --exe PATH --policy-reviewed --included-only --before-used-percent N --used-turns N",
];

export function protocolState(child) {
  let state = "handshake";
  const send = (msg) => child.stdin.write(`${JSON.stringify(msg)}\n`);
  send({
    id: 1,
    method: "initialize",
    params: { clientInfo: { name: "paihuo_probe", version: "0.1.0" } },
  });
  return (message) => {
    requireThat(!("method" in message && "id" in message), "服务端请求未列入允许集合，停止。");
    if (message.id === undefined) return;
    if (message.id === 1 && state === "handshake") {
      requireThat(typeof message.result?.userAgent === "string", "握手没有返回原生 userAgent。");
      send({ method: "initialized" });
      send({ id: 2, method: "thread/resume", params: { threadId: randomUUID() } });
      state = "resume";
      return;
    }
    requireThat(
      message.id === 2 &&
        state === "resume" &&
        Number.isInteger(message.error?.code) &&
        /(?:no rollout found for (?:thread|session)|(?:thread|session|rollout)[^\r\n]{0,90}(?:not found|does not exist)|could not find (?:thread|session|rollout))/i.test(
          message.error?.message ?? "",
        ),
      "无效 ID 未返回明确的不存在错误，不能映射为 native_session_lost。",
    );
    state = "done";
    child.stdin.end();
    return {
      handshake: true,
      invalidResume: "session-not-found",
      nativeCode: message.error.code,
      nativeTurns: 0,
    };
  };
}

export function execState() {
  let threads = 0;
  let turns = 0;
  let completed = false;
  let matched = false;
  let finals = 0;
  let metadataWarning = false;
  const events = [];
  return (frame) => {
    const standard = [
      "thread.started",
      "turn.started",
      "turn.completed",
      "item.started",
      "item.updated",
      "item.completed",
      "error",
      "turn.failed",
    ];
    const items = [
      "agent_message",
      "reasoning",
      "error",
      "command_execution",
      "file_change",
      "mcp_tool_call",
      "web_search",
      "todo_list",
    ];
    const category = standard.includes(frame.type) ? frame.type : "unknown-event";
    const item = frame.item
      ? items.includes(frame.item.type)
        ? frame.item.type
        : "unknown-item"
      : null;
    if (events.length < 32) events.push(item ? `${category}/${item}` : category);
    const diagnostic = `。事件顺序 ${events.join(" → ")}，已开始轮数 ${turns}`;
    requireThat(!completed, "原生终态后出现额外事件。");
    if (frame.type === "thread.started") threads++;
    else if (frame.type === "turn.started") turns++;
    else if (["item.started", "item.updated", "item.completed"].includes(frame.type)) {
      if (
        turns === 0 &&
        threads === 1 &&
        !metadataWarning &&
        frame.type === "item.completed" &&
        frame.item?.type === "error" &&
        frame.item.message ===
          "Model metadata for `gpt-6.2-sol` not found. Defaulting to fallback metadata; this can degrade performance and cause issues."
      ) {
        metadataWarning = true;
        return;
      }
      requireThat(
        ["agent_message", "reasoning"].includes(frame.item?.type),
        `出现工具或预期外项目，停止并核对额度${diagnostic}`,
      );
      if (frame.type === "item.completed" && frame.item.type === "agent_message") {
        requireThat(++finals === 1, `存在多个最终文本，停止${diagnostic}`);
        matched = frame.item.text?.trim() === "PAIHUO_OK";
      }
    } else if (frame.type === "turn.completed") {
      requireThat(
        threads === 1 && turns === 1 && matched,
        "未观察到准确的前言标记及单轮成功终态。",
      );
      completed = true;
      return {
        preambleMatched: true,
        nativeTurns: 1,
        toolCalls: 0,
        events,
        inputTokens: tokenCount(frame.usage?.input_tokens),
        outputTokens: tokenCount(frame.usage?.output_tokens),
      };
    } else {
      throw new ProbeStop(`收到重试、失败或未知事件，停止且不重发${diagnostic}`);
    }
    requireThat(threads <= 1 && turns <= 1, "发现第二轮或第二个会话，已停止。");
  };
}

// 每一行先判断是否应该停止。只向上层返回可公开的汇总，原始输出不离开驱动进程。
async function stream(exe, argv, project, env, mode) {
  const child = spawn(exe, argv, {
    cwd: project,
    env,
    shell: false,
    windowsHide: true,
    stdio: ["pipe", "pipe", "ignore"],
  });
  let failure;
  const fail = (message) => {
    failure ??= new ProbeStop(message);
    child.kill();
  };
  const timer = setTimeout(
    () => fail("原生会话超时，停止并核对本次预留。"),
    mode === "transport" ? 15000 : 90000,
  );
  const exit = new Promise((resolve) => {
    child.on("error", () => fail("无法启动指定的原生进程。"));
    child.on("close", resolve);
  });
  child.stdin.on("error", () => fail("原生输入管道提前关闭。"));
  let bytes = 0;
  child.stdout.on("data", (chunk) => {
    bytes += chunk.length;
    if (bytes > 2 * 1024 * 1024) fail("输出超限，停止。");
  });
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const next = mode === "transport" ? protocolState(child) : execState();
  if (mode !== "transport") child.stdin.end();
  let summary;
  try {
    for await (const line of lines) {
      if (failure) throw failure;
      summary = next(JSON.parse(line)) ?? summary;
    }
    const code = await exit;
    if (failure) throw failure;
    requireThat(code === 0 && summary, "进程提前退出或缺少可信终态。");
    return summary;
  } finally {
    clearTimeout(timer);
    lines.close();
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exit;
  }
}

function subscription(exe, cwd, env) {
  const result = command(exe, ["login", "status"], cwd, env);
  requireThat(
    result.status === 0 &&
      /(?:^|\r?\n)Logged in using ChatGPT(?:\s|$)/i.test(`${result.stdout}\n${result.stderr}`),
    "未验证为 ChatGPT 原生登录，停止。",
  );
}

async function main(args) {
  if (
    args.length === 4 &&
    args[0] === "--offline" &&
    args[1] === "native-roster" &&
    args[2] === "--exe"
  )
    return offlineRoster(checkedExe(args[3], "codex.exe"), transportArgs.slice(0, -3));
  if (args.length === 0 || (args.length === 1 && args[0] === "--plan")) {
    return {
      ...plan("Codex", ["App Server stdio", "exec --json"], stages),
      transportArgv: transportArgs,
      smokeArgv: execArgs,
      scenarioNativeActionLimits: allowances,
    };
  }
  if (args.length === 2 && args[0] === "--offline") {
    if (args[1] === "scenarios") return offlineCases();
    if (args[1] === "mcp") return checkMcp();
    if (args[1] === "protocol") {
      return withScratch((root, project) => {
        const result = command(
          process.execPath,
          [fileURLToPath(new URL("./offline-check.mjs", import.meta.url)), "--synthetic-only"],
          project,
          cleanEnv(root),
        );
        requireThat(
          result.status === 0 && JSON.parse(result.stdout).mode === "synthetic-only",
          "合成协议检查失败。",
        );
        return { mode: "offline-protocol", synthetic: true, nativeHarness: false };
      });
    }
  }
  const [mode, stage, ...rest] = args;
  requireThat(
    mode === "--live" && ["transport", "auth", "smoke", "scenarios"].includes(stage),
    "未知命令，请查看 --plan。",
  );
  let scenario;
  if (stage === "scenarios") {
    requireThat(
      rest[0] === "--case" && Object.hasOwn(allowances, rest[1]),
      "请指定已列出的 --case。",
    );
    [, scenario] = rest.splice(0, 2);
  }
  const values = liveArgs(rest, stage === "smoke" || stage === "scenarios");
  const exe = checkedExe(values.exe, "codex.exe");
  return withScratch(async (root, project) => {
    const env = cleanEnv(root, stage !== "transport");
    if (stage === "transport") {
      env.CODEX_HOME = join(root, "codex");
      mkdirSync(env.CODEX_HOME);
    }
    const version = command(exe, ["--version"], project, env);
    requireThat(
      version.status === 0 && version.stdout.trim() === "codex-cli 0.167.0",
      "原生版本与审阅的 0.167.0 不符。",
    );
    if (stage === "transport")
      return {
        stage,
        version: "0.167.0",
        ...(await stream(exe, transportArgs, project, appServerEnv(env), stage)),
      };
    subscription(exe, project, env);
    if (scenario)
      return nativeCase(
        scenario,
        exe,
        transportArgs.slice(0, -3),
        env,
        project,
        30 - Number(values["used-turns"]),
        true,
      );
    if (stage === "auth")
      return {
        stage,
        version: "0.167.0",
        nativeTurns: 0,
        auth: "ChatGPT",
        billing: "待核对用量页",
      };
    requireThat(Number(values["used-turns"]) <= 28, "需为本轮和首次可见的异常重试各预留一次。");
    reserve("codex");
    return {
      stage,
      version: "0.167.0",
      beforeUsedPercent: Number(values["before-used-percent"]),
      afterUsedPercent: null,
      ...(await stream(exe, execArgs, project, env, stage)),
    };
  });
}

sessionMain(main, import.meta.url);
