import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { colorFixture } from "./scenario-media.mjs";
import { quotaSnapshot, sampleTree } from "./scenario-observations.mjs";
import { openRpc } from "./scenario-rpc.mjs";
import { CaseObservation, ProbeStop, requireThat, reserve } from "./session-common.mjs";

export const allowances = {
  steer: 2,
  interrupt: 3,
  resume: 2,
  parallel: 2,
  mcp: 1,
  approval: 1,
  image: 1,
  resources: 1,
};
const model = "gpt-6.2-sol";
export function secondBatchReservation(name, spent, allowReconnect = false) {
  requireThat(
    Object.hasOwn(allowances, name) &&
      (!allowReconnect || name === "image") &&
      Number.isInteger(spent) &&
      spent >= 0,
    "本批场景或累计动作无效。",
  );
  const reserved = allowances[name] + Number(allowReconnect);
  requireThat(spent + reserved <= 14, "首批1次加第二批最多13个动作，剩余预算不足以覆盖本场景。");
  return reserved;
}
export const disabledFeatures = [
  "shell_tool",
  "code_mode",
  "code_mode_host",
  "multi_agent",
  "multi_agent_v2",
  "apps",
  "plugins",
  "plugin_hooks",
  "hooks",
  "image_generation",
  "apply_patch_freeform",
  "in_app_browser",
  "goals",
  "view_image",
];
export const appServerEnv = (env) => ({
  ...env,
  CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED: "1",
});
export const telemetrySettings = [
  "analytics.enabled=false",
  'otel.exporter="none"',
  'otel.metrics_exporter="none"',
  'otel.trace_exporter="none"',
];
export function verifyPolicy(cfg, argv) {
  requireThat(
    cfg?.model_provider === "openai" &&
      cfg.sandbox_mode === "read-only" &&
      cfg.web_search === "disabled" &&
      disabledFeatures.every(
        (k) => cfg.features?.[k] === false || cfg.features?.[k]?.enabled === false,
      ) &&
      argv.some(
        (value, i) =>
          value === "-c" && argv[i + 1] === "tools.experimental_request_user_input.enabled=false",
      ) &&
      (!cfg.tools?.experimental_request_user_input ||
        cfg.tools.experimental_request_user_input.enabled === false) &&
      telemetrySettings.every((setting) =>
        argv.some((v, i) => v === "-c" && argv[i + 1] === setting),
      ) &&
      (cfg.analytics === undefined || cfg.analytics?.enabled === false) &&
      (cfg.otel === undefined ||
        ["exporter", "metrics_exporter", "trace_exporter"].every((k) => cfg.otel[k] === "none")) &&
      !cfg.model_instructions_file,
    "全批暂停：实际 provider、权限、核心工具或提示来源未能核实。",
  );
}
export function verifyRoster(names, effective, toolArgs) {
  requireThat(
    Object.keys(effective).length === names.length + Number(Boolean(toolArgs)) &&
      Object.entries(effective).every(([n, item]) =>
        n === serverName && toolArgs
          ? item.enabled === true &&
            item.required === true &&
            Object.keys(item).every((k) =>
              [
                "enabled",
                "required",
                "command",
                "args",
                "enabled_tools",
                "environment_id",
                "tool_timeout_sec",
              ].includes(k),
            ) &&
            (!Object.hasOwn(item, "environment_id") || item.environment_id === "local") &&
            (!Object.hasOwn(item, "tool_timeout_sec") || item.tool_timeout_sec === null) &&
            item.command === process.execPath &&
            JSON.stringify(item.args) === JSON.stringify(toolArgs) &&
            JSON.stringify(item.enabled_tools) === JSON.stringify(["fixed"])
          : names.includes(n) && item.enabled === false,
      ),
    "复核失败，有未禁用或变化的 MCP 服务。",
  );
}
const serverName = "paihuo_t015_fixed";
const testTool = fileURLToPath(new URL("./fixed-mcp.mjs", import.meta.url));
const textInput = (text) => [{ type: "text", text, text_elements: [] }];
const matchTurn = (threadId, turnId) => (p) => p.threadId === threadId && p.turn?.id === turnId;
const owns = (r, t, u) => r.threadId === t && r.turnId === u;
const bounded = (t) => typeof t === "string" && t.length > 0 && t.length < 160;
const outcome = (condition, message) => {
  if (!condition) throw new CaseObservation(message);
};
export function verifyThread(result, cwd, approvalPolicy, ephemeral) {
  requireThat(
    bounded(result?.thread?.id) &&
      typeof result.thread.cwd === "string" &&
      typeof result.cwd === "string" &&
      resolve(result.cwd).toLowerCase() === resolve(cwd).toLowerCase() &&
      resolve(result.thread.cwd).toLowerCase() === resolve(cwd).toLowerCase() &&
      result.thread.ephemeral === ephemeral &&
      result.model === model &&
      result.modelProvider === "openai" &&
      result.approvalPolicy === approvalPolicy &&
      result.sandbox?.type === "readOnly" &&
      result.sandbox.networkAccess !== true,
    "原生线程的模型、provider、审批、只读沙箱或 cwd 不符，发轮前停止。",
  );
  return result.thread.id;
}
export function closeLedger(used, reserved, before, after, failure, afterError) {
  const summary = `预留 ${reserved}，已提交动作 ${used}，before=${before.usedPercent}，after=${after?.usedPercent ?? "null"}。`;
  if (failure || afterError || before.resetsAt !== after?.resetsAt) {
    throw new ProbeStop(
      "全批暂停。" +
        summary +
        (failure
          ? `原始阶段：${failure instanceof ProbeStop ? failure.message : "进程或采样异常。"}`
          : "") +
        (afterError
          ? `后置额度：${afterError instanceof ProbeStop ? afterError.message : "无法取得。"}`
          : before.resetsAt !== after?.resetsAt
            ? "前后窗口不同。"
            : ""),
    );
  }
}

function roster(data) {
  const config = data.config;
  const servers = config?.mcp_servers;
  // 受控禁用的哨兵必须出现在实际配置中，才能区分“没有服务器”和“协议隐藏了该字段”。
  requireThat(
    servers?.paihuo_t015_roster?.enabled === false,
    "无法从本版本有效配置核实 MCP 清单。",
  );
  const names = Object.keys(servers);
  requireThat(
    names.length <= 128 && names.every((n) => /^[A-Za-z0-9_-]{1,80}$/.test(n)),
    "MCP 名称不符合此探针可覆盖的范围。",
  );
  requireThat(
    !config.openai_base_url ||
      /^https:\/\/chatgpt\.com\/backend-api\/codex\/?$/.test(config.openai_base_url),
    "检测到非标准模型端点，停止。",
  );
  requireThat(
    !config.chatgpt_base_url ||
      /^https:\/\/chatgpt\.com\/backend-api\/?$/.test(config.chatgpt_base_url),
    "检测到非标准账户端点，停止。",
  );
  requireThat(!config.model_providers?.openai?.model_catalog_url, "检测到自定义模型目录，停止。");
  return servers;
}

async function init(client) {
  const result = await client.request("initialize", {
    clientInfo: { name: "paihuo_probe", version: "0.1.0" },
  });
  requireThat(typeof result.userAgent === "string", "初始化回复缺失。");
  client.initialized();
}

export async function runCase(name, { connect, project, charge, sample }) {
  let rpc;
  const clients = [];
  const startClient = async () => {
    rpc = await connect();
    clients.push(rpc);
    return rpc;
  };
  const startThread = async (cwd, ephemeral = true) => {
    const result = await rpc.request("thread/start", {
      model,
      cwd,
      ephemeral,
      approvalPolicy: name === "approval" ? "on-request" : "never",
      sandbox: "read-only",
      ...(name === "parallel" ? { config: { [`mcp_servers.${serverName}.cwd`]: cwd } } : {}),
      developerInstructions:
        "Follow the short protocol-test request exactly. Do not use tools unless the user asks for the fixed test tool.",
    });
    return verifyThread(result, cwd, name === "approval" ? "on-request" : "never", ephemeral);
  };
  const startTurn = async (threadId, text, other = []) => {
    charge();
    const res = await rpc.request("turn/start", {
      threadId,
      input: [...textInput(text), ...other],
    });
    requireThat(bounded(res.turn?.id), "缺少原生轮 ID。");
    return res.turn.id;
  };
  const done = async (t, u) => rpc.wait("turn/completed", matchTurn(t, u));
  const expectText = async (t, u, expected) => {
    const finished = await done(t, u);
    outcome(finished.turn.status === "completed", "原生模型轮未完成。");
    const finals = rpc.finals(t, u);
    outcome(
      finals.length === 1 && finals[0]?.trim() === expected,
      "最终文本条数或独立标记不匹配。",
    );
    const deltas = rpc.deltas(t, u);
    return { deltas: deltas.length, deltaMatchesFinal: deltas.join("").trim() === expected };
  };
  let report, summary, failure, archiveThread;
  try {
    await startClient();
    const t = await startThread(project, name !== "resume");
    if (name === "resume") {
      archiveThread = t;
      const marker = `T${randomUUID().slice(0, 8)}`;
      const first = await startTurn(t, `Remember ${marker}. Reply only SAVED.`);
      await expectText(t, first, "SAVED");
      await rpc.close();
      await startClient();
      const res = await rpc.request("thread/resume", {
        threadId: t,
        cwd: project,
        model,
        approvalPolicy: "never",
        sandbox: "read-only",
      });
      requireThat(verifyThread(res, project, "never", false) === t, "恢复后原生 ID 改变。");
      const second = await startTurn(t, "Return only the marker from my previous message.");
      report = { ...(await expectText(t, second, marker)), crossProcessRecall: true };
    } else if (name === "steer") {
      const u = await startTurn(
        t,
        "Think about the numbers one through fifty. Reply only ORIGINAL.",
      );
      await rpc.wait("turn/started", matchTurn(t, u));
      charge();
      const response = await rpc.request("turn/steer", {
        threadId: t,
        expectedTurnId: u,
        input: textInput("Replace the answer. Reply only STEERED."),
      });
      outcome(response.turnId === u, "引导未返回原轮 ID。");
      report = { ...(await expectText(t, u, "STEERED")), sameTurnGuide: true };
    } else if (name === "interrupt") {
      const u = await startTurn(
        t,
        "Think carefully about fifty primes, then describe them in detail.",
      );
      await rpc.wait("turn/started", matchTurn(t, u));
      charge();
      await rpc.request("turn/interrupt", { threadId: t, turnId: u });
      const finished = await done(t, u);
      outcome(finished.turn.status === "interrupted", "中断前原轮已结束或未返回 interrupted。");
      const after = await startTurn(t, "Reply only CONTINUED.");
      report = {
        ...(await expectText(t, after, "CONTINUED")),
        interrupted: true,
        continued: true,
        fileBeforeInterrupt: "本轮禁写，未测已提交文件保留",
      };
    } else if (name === "parallel") {
      const b = join(project, "../second");
      mkdirSync(b);
      const ut = await startThread(b);
      requireThat(ut !== t, "两会话 ID 相同。");
      const left = `L${randomUUID().slice(0, 8)}`,
        right = `R${randomUUID().slice(0, 8)}`;
      writeFileSync(join(project, "fixture.txt"), left);
      writeFileSync(join(b, "fixture.txt"), right);
      const request =
        "Call the fixed MCP tool once. Reply only with the exact file marker it returns.";
      const [aTurn, bTurn] = await Promise.all([startTurn(t, request), startTurn(ut, request)]);
      await Promise.all([expectText(t, aTurn, left), expectText(ut, bTurn, right)]);
      requireThat(
        readFileSync(join(project, "fixture.txt"), "utf8") === left &&
          readFileSync(join(b, "fixture.txt"), "utf8") === right,
        "隔离目录哨兵发生变化。",
      );
      requireThat(rpc.observed().toolCalls === 2, "没有看到两个独立原生工具调用。");
      report = {
        eventIsolation: true,
        nativeTurnsOverlap: rpc.overlap(`${t}/${aTurn}`, `${ut}/${bTurn}`),
        distinctCwd: true,
        perThreadFileRead: true,
        hostSentinelsUnchanged: true,
        agentFileWrites: "未测",
      };
    } else if (name === "image") {
      const image = colorFixture();
      const u = await startTurn(
        t,
        "Read the four color stripes left to right. Return four letters only: R red, G green, B blue, Y yellow.",
        [{ type: "image", url: image.url }],
      );
      report = { ...(await expectText(t, u, image.order)), randomColorOrderMatched: true };
    } else if (name === "approval") {
      const sibling = join(project, "../denied");
      mkdirSync(sibling);
      const target = join(sibling, "attempt.txt");
      const u = await startTurn(
        t,
        `Use request_permissions once to request write permission to this one file: ${target}. Do not write it. If the request is denied reply only DENIED.`,
      );
      report = {
        ...(await expectText(t, u, "DENIED")),
        matchedApprovalDeclined: rpc.observed().denied === 1,
        targetAbsent: !existsSync(target),
      };
      requireThat(report.targetAbsent, "权限测试目标文件出现，暂停全部场景。");
      outcome(report.matchedApprovalDeclined, "未观察到原生权限请求及拒绝回执。");
    } else {
      const idle = name === "resources" ? await sample(rpc.pid) : null;
      const u = await startTurn(
        t,
        "Call the MCP tool named fixed on the paihuo_t015_fixed server once with {}. Return exactly its text.",
      );
      const started = await rpc.wait(
        "item/started",
        (p) => owns(p, t, u) && p.item.type === "mcpToolCall",
        matchTurn(t, u),
      );
      const busy = name === "resources" ? await sample(rpc.pid) : null;
      const activeDuringSample = rpc.finals(t, u).length === 0;
      const finished = await rpc.wait(
        "item/completed",
        (p) => owns(p, t, u) && p.item.type === "mcpToolCall" && p.item.id === started.item.id,
        matchTurn(t, u),
      );
      requireThat(
        finished.item.server === serverName &&
          finished.item.tool === "fixed" &&
          finished.item.status === "completed",
        "原生工具未按预期完成。",
      );
      report = { ...(await expectText(t, u, "PAIHUO_MCP_OK")), nativeMcpStartEnd: true };
      if (name === "resources") report.resources = { idle, busy, activeDuringSample };
    }
    summary = {
      ...report,
      observedCompactions: clients.reduce((n, c) => n + c.observed().compactions, 0),
      eventOrder: clients.flatMap((c) => c.trace).slice(0, 96),
    };
  } catch (error) {
    if (error instanceof CaseObservation)
      summary = {
        outcome: "未证实",
        reason: error.message,
        eventOrder: clients.flatMap((c) => c.trace).slice(0, 96),
      };
    else failure = error;
  } finally {
    if (archiveThread) {
      let archived = false;
      try {
        await rpc.request("thread/archive", { threadId: archiveThread });
        archived = true;
      } catch {
        try {
          const cleanup = await startClient();
          await cleanup.request("thread/archive", { threadId: archiveThread });
          archived = true;
        } catch {
          /* 只尝试已确认归属的同一线程。 */
        }
      }
      if (summary) summary.nativeTestThreadArchived = archived;
      if (!archived || failure)
        failure = new ProbeStop(
          (failure instanceof ProbeStop ? failure.message : failure ? "原生阶段出现异常。" : "") +
            (archived
              ? "本次持久测试线程已归档。"
              : "本次一个本机测试会话可能仍留存，归档未能确认。"),
        );
    }
    for (const client of clients) await client.close();
  }
  if (failure) throw failure;
  for (const client of clients) client.checkReconnectTermination?.();
  summary.toolCalls = clients.reduce((n, c) => n + c.observed().toolCalls, 0);
  summary.countedStreamReconnects = clients.reduce(
    (n, c) => n + (c.observed().countedStreamReconnects ?? 0),
    0,
  );
  summary.latestCumulativeTokenTotalsByConnection = clients.map(
    (c) => c.observed().latestCumulativeTokenTotals,
  );
  return summary;
}

const opt = (key, value) => ["-c", `${key}=${JSON.stringify(value)}`];
export function scenarioBaseArgs(flags) {
  return [
    ...flags,
    ...opt("approval_policy", "never"),
    ...opt("sandbox_mode", "read-only"),
    ...opt("mcp_servers.paihuo_t015_roster.command", process.execPath),
    ...opt("mcp_servers.paihuo_t015_roster.enabled", false),
    ...opt("memories.use_memories", false),
    ...opt("memories.generate_memories", false),
    ...opt("history.persistence", "none"),
    ...opt("notify", []),
    ...opt("include_skill_instructions", false),
    ...opt("features.skip_host_skill_discovery", true),
  ];
}

export async function nativeCase(
  name,
  exe,
  flags,
  env,
  project,
  remaining,
  record,
  allowReconnect = false,
) {
  requireThat(
    !allowReconnect || (name === "image" && record),
    "可选重连仅用于启用持久账本的图片场景。",
  );
  const limit = secondBatchReservation(name, 30 - remaining, allowReconnect);
  requireThat(
    Object.hasOwn(allowances, name) && remaining >= allowances[name] + 1,
    "轮数不足，需保留本段完整上限和一个异常尝试。",
  );
  const base = scenarioBaseArgs(flags);
  const open = (argv, tool = false, reconnectCharge = null) =>
    openRpc(
      exe,
      [...argv, "app-server", "--listen", "stdio://"],
      project,
      appServerEnv(env),
      tool,
      name === "approval" ? join(project, "../denied/attempt.txt") : null,
      reconnectCharge,
    );
  const probe = open(base);
  let names, before;
  try {
    await init(probe);
    const read = await probe.request("config/read", { includeLayers: false, cwd: project });
    verifyPolicy(read.config, base);
    const effective = roster(read);
    names = Object.keys(effective);
    requireThat(!names.includes(serverName), "专用测试服务名已被本机配置占用。");
    before = quotaSnapshot(
      await probe.request("account/rateLimits/read", { excludeResetCreditDetails: true }),
    );
  } finally {
    await probe.close();
  }
  const restricted = [...base, ...names.flatMap((n) => opt(`mcp_servers.${n}.enabled`, false))];
  if (name === "approval")
    restricted.push("--enable", "request_permissions", "--enable", "request_permissions_tool");
  const withTool = ["mcp", "parallel", "resources"].includes(name);
  const toolArgs =
    name === "parallel"
      ? [testTool, "--serve-marker", dirname(project)]
      : [testTool, name === "resources" ? "--serve-delay" : "--serve"];
  if (withTool)
    restricted.push(
      ...opt(`mcp_servers.${serverName}.command`, process.execPath),
      ...opt(`mcp_servers.${serverName}.args`, toolArgs),
      ...opt(`mcp_servers.${serverName}.enabled_tools`, ["fixed"]),
      ...opt(`mcp_servers.${serverName}.enabled`, true),
      ...opt(`mcp_servers.${serverName}.required`, true),
    );
  const connect = async () => {
    const c = open(restricted, withTool, allowReconnect ? charge : null);
    try {
      await init(c);
      const read = await c.request("config/read", { includeLayers: false, cwd: project });
      const effective = roster(read);
      const cfg = read.config;
      verifyPolicy(cfg, restricted);
      verifyRoster(names, effective, withTool ? toolArgs : null);
      requireThat(
        (await c.request("account/read", { refreshToken: false })).account?.type === "chatgpt",
        "未取得 ChatGPT 原生登录。",
      );
      return c;
    } catch (error) {
      await c.close();
      throw error;
    }
  };
  let used = 0;
  const marker = record
    ? reserve(`codex-${name}`, { reserved: limit, before: before.usedPercent })
    : null;
  let result, failure;
  function charge() {
    requireThat(used < limit, "超过本段原生动作上限。");
    if (marker) appendFileSync(marker, "1\n");
    used++;
  }
  try {
    result = await runCase(name, {
      connect,
      project,
      sample: (pid) => sampleTree(pid, env, project),
      charge,
    });
  } catch (e) {
    failure = e;
  }
  let check, after, afterError;
  try {
    check = open(base);
    await init(check);
    after = quotaSnapshot(
      await check.request("account/rateLimits/read", { excludeResetCreditDetails: true }),
    );
  } catch (error) {
    afterError = error;
  } finally {
    if (check) await check.close();
  }
  closeLedger(used, limit, before, after, failure, afterError);
  const usage = {
    beforeUsedPercent: before.usedPercent,
    afterUsedPercent: after.usedPercent,
    windowMinutes: before.windowMinutes,
    requiresHostOrdinaryUsageCheck:
      before.requiresHostOrdinaryUsageCheck || after.requiresHostOrdinaryUsageCheck,
  };
  return { stage: "scenarios", case: name, nativeActions: used, usage, ...result };
}
