import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { CaseObservation, ProbeStop, requireThat } from "./session-common.mjs";

const methods = new Set([
  "initialize",
  "config/read",
  "account/read",
  "account/rateLimits/read",
  "thread/start",
  "thread/resume",
  "turn/start",
  "turn/steer",
  "turn/interrupt",
  "thread/archive",
]);
const kinds = new Set([
  "userMessage",
  "agentMessage",
  "reasoning",
  "plan",
  "commandExecution",
  "fileChange",
  "mcpToolCall",
  "dynamicToolCall",
  "webSearch",
  "imageView",
  "contextCompaction",
  "enteredReviewMode",
  "exitedReviewMode",
]);
const safeMethod = new Set([
  "thread/started",
  "turn/started",
  "turn/completed",
  "item/started",
  "item/completed",
  "item/agentMessage/delta",
  "turn/diff/updated",
  "thread/tokenUsage/updated",
  "mcpServer/startupStatus/updated",
  "error",
]);
// 固定版 ErrorNotification 的公开枚举。其余字段可以包含原文、地址或账号信息。
const publicErrors = new Set([
  "contextWindowExceeded",
  "sessionBudgetExceeded",
  "usageLimitExceeded",
  "rateLimitExceeded",
  "flexUnavailable",
  "serverOverloaded",
  "modelNotFound",
  "policyCapacityUnavailable",
  "cyberPolicy",
  "misalignmentPolicyViolation",
  "tooManyDenials",
  "internalServerError",
  "unauthorized",
  "badRequest",
  "threadRollbackFailed",
  "sandboxError",
  "other",
]);
const variantErrors = new Set([
  "httpConnectionFailed",
  "responseStreamConnectionFailed",
  "responseStreamDisconnected",
  "responseTooManyFailedAttempts",
  "activeTurnNotSteerable",
]);
export function errorNotification(params) {
  const info = params?.error?.codexErrorInfo;
  let category = typeof info === "string" && publicErrors.has(info) ? info : "unknown";
  let http = "unknown";
  if (info && typeof info === "object" && Object.keys(info).length === 1) {
    const [key] = Object.keys(info);
    if (variantErrors.has(key)) {
      category = key;
      const status = info[key]?.httpStatusCode;
      if ([401, 403, 429].includes(status)) http = String(status);
      else if (Number.isInteger(status) && status >= 500 && status < 600) http = "5xx";
    }
  }
  return `codexErrorInfo=${category}, http=${http}, willRetry=${typeof params?.willRetry === "boolean" ? String(params.willRetry) : "unknown"}`;
}
function startupCategory(bytes) {
  if (!bytes.length) return "empty-stderr";
  const text = bytes.toString("utf8");
  if (/unknown variant/i.test(text) && /\bhistory\.persistence\b/i.test(text))
    return "history-enum";
  if (/unknown variant/i.test(text)) return "config-enum";
  if (/(?:unexpected argument|unrecognized (?:subcommand|option))/i.test(text)) return "argument";
  if (/(?:TOML parse error|invalid type|failed to parse config)/i.test(text))
    return "config-syntax";
  return "other-stderr";
}
// 只对一个已由请求、回复、启动通知三方确认的图片轮放行一次原生重连。
// 即使还没收到 turn/start 回复，提前出现的任何可能输出也会封闭这道门。
export function imageReconnectGate(charge) {
  let threadId,
    turnId,
    startedId,
    closed = false,
    used = 0;
  return {
    submitted(id) {
      if (threadId) closed = true;
      threadId = id;
    },
    acknowledged(turn) {
      turnId = turn?.id;
      if ((turn?.items ?? []).some((item) => item.type !== "userMessage")) closed = true;
    },
    observe(method, p) {
      if (!threadId || closed) return false;
      if (method === "error") {
        const info = p?.error?.codexErrorInfo;
        const detail = info?.responseStreamDisconnected;
        if (
          used ||
          !turnId ||
          turnId !== startedId ||
          p.threadId !== threadId ||
          p.turnId !== turnId ||
          p.willRetry !== true ||
          !info ||
          Object.keys(info).length !== 1 ||
          !detail ||
          typeof detail !== "object" ||
          Array.isArray(detail) ||
          Object.keys(detail).some((k) => k !== "httpStatusCode") ||
          (detail.httpStatusCode != null && ![500, 502, 503, 504].includes(detail.httpStatusCode))
        )
          return false;
        charge();
        used++;
        return true;
      }
      if (method === "turn/started") {
        if (
          startedId ||
          p?.threadId !== threadId ||
          typeof p?.turn?.id !== "string" ||
          (p.turn.items ?? []).some((item) => item.type !== "userMessage")
        )
          closed = true;
        else startedId = p.turn.id;
      } else if (method === "item/started" || method === "item/completed") {
        if (p?.item?.type !== "userMessage") closed = true;
      } else if (method === "thread/tokenUsage/updated") {
        const usage = p?.tokenUsage?.total;
        if (usage?.outputTokens !== 0 || usage.reasoningOutputTokens !== 0) closed = true;
      } else if (!["thread/status/changed", "mcpServer/startupStatus/updated"].includes(method)) {
        closed = true;
      }
      return false;
    },
    count: () => used,
  };
}
export function openRpc(
  exe,
  args,
  cwd,
  env,
  allowFixedTool = false,
  approvalTarget = null,
  reconnectCharge = null,
) {
  const reconnect = reconnectCharge ? imageReconnectGate(reconnectCharge) : null;
  const child = spawn(exe, args, {
    cwd,
    env,
    shell: false,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const pending = new Map();
  const events = [];
  const waiters = new Set();
  let next = 0,
    lastFailure,
    bytes = 0,
    closed = false;
  const trace = [];
  const intervals = new Map();
  let sequence = 0,
    actions = 0,
    denied = 0,
    compactions = 0;
  const toolsByTurn = new Set();
  const latestTokenTotals = new Map();
  let initialized = false;
  let exitStatus;
  let startupBytes = Buffer.alloc(0);
  child.stderr.on("data", (chunk) => {
    if (!initialized && startupBytes.length < 8192)
      startupBytes = Buffer.concat([startupBytes, chunk.subarray(0, 8192 - startupBytes.length)]);
  });
  const stop = (reason) => {
    lastFailure ??= new ProbeStop(
      `${reason instanceof ProbeStop ? reason.message : "原生协议进程结束或消息格式异常。"} 已提交原生动作 ${actions}。事件顺序 ${trace.join(" → ")}`,
    );
    for (const task of pending.values()) task.reject(lastFailure);
    pending.clear();
    for (const notify of [...waiters]) notify();
    child.kill();
  };
  const exited = new Promise((resolve) =>
    child.on("close", (code) => {
      closed = true;
      exitStatus = code;
      if (pending.size || waiters.size) {
        const diagnostic = initialized
          ? ""
          : ` startup=${startupCategory(startupBytes)}, exit=${Number.isInteger(code) ? code : "unknown"}。`;
        stop(new ProbeStop(`原生进程先于请求/通知退出。${diagnostic}`));
      }
      startupBytes = Buffer.alloc(0);
      resolve(code);
    }),
  );
  child.on("error", stop);
  child.stdin.on("error", (error) => {
    if (!initialized && ["EPIPE", "EOF", "ERR_STREAM_DESTROYED"].includes(error.code)) return;
    stop(error);
  });
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  child.stdout.on("data", (chunk) => {
    bytes += chunk.length;
    if (bytes > 8 * 1024 * 1024) stop(new ProbeStop("原生协议输出超限。"));
  });
  const send = (frame) => {
    requireThat(!lastFailure && !closed, "进程已结束。");
    child.stdin.write(`${JSON.stringify(frame)}\n`);
  };
  lines.on("line", (line) => {
    if (lastFailure) return;
    try {
      const frame = JSON.parse(line);
      if (frame.method && frame.id !== undefined) {
        if (frame.method === "item/permissions/requestApproval") {
          send({ id: frame.id, result: { permissions: {}, scope: "turn" } });
          const perm = frame.params?.permissions,
            fs = perm?.fileSystem;
          const targets = [
            ...(fs?.write ?? []),
            ...(fs?.entries ?? []).map((e) =>
              e.access === "write" && e.path.type === "path" ? e.path.path : null,
            ),
          ];
          requireThat(
            approvalTarget &&
              denied === 0 &&
              !perm?.network &&
              !fs?.read?.length &&
              targets.length > 0 &&
              targets.every((p) => typeof p === "string" && resolve(p) === resolve(approvalTarget)),
            "拒绝非预期原生权限请求，暂停全部场景。",
          );
          denied++;
          trace.push("item/permissions/requestApproval:declined");
          return;
        }
        if (
          frame.method === "item/commandExecution/requestApproval" ||
          frame.method === "item/fileChange/requestApproval"
        )
          send({ id: frame.id, result: { decision: "decline" } });
        stop(new ProbeStop("出现审批或未允许的服务端请求，本次停止。"));
        return;
      }
      if (frame.id !== undefined) {
        const task = pending.get(frame.id);
        requireThat(task, "响应 ID 未匹配。");
        pending.delete(frame.id);
        if (task.method === "turn/start" && !frame.error)
          reconnect?.acknowledged(frame.result?.turn);
        if (task.method === "initialize" && typeof frame.result?.userAgent === "string") {
          initialized = true;
          startupBytes = Buffer.alloc(0);
        }
        if (
          frame.error &&
          ["turn/steer", "turn/interrupt", "thread/resume"].includes(task.method) &&
          /(?:no active turn|turn.*(?:no longer|not active|already completed)|no rollout found for thread)/i.test(
            frame.error.message ?? "",
          )
        ) {
          task.reject(new CaseObservation(`原生 ${task.method} 返回无活跃轮或无持久化会话。`));
        } else if (frame.error) task.reject(new ProbeStop(`RPC ${task.method} 返回错误。`));
        else task.resolve(frame.result);
        return;
      }
      const kind = safeMethod.has(frame.method) ? frame.method : "other-notification";
      if (frame.method === "thread/tokenUsage/updated") {
        const p = frame.params,
          total = p?.tokenUsage?.total?.totalTokens;
        if (typeof p?.threadId === "string" && Number.isSafeInteger(total) && total >= 0)
          latestTokenTotals.set(p.threadId, total);
      }
      sequence++;
      if (["turn/started", "turn/completed"].includes(frame.method)) {
        const key = `${frame.params.threadId}/${frame.params.turn.id}`;
        const span = intervals.get(key) ?? {};
        span[frame.method === "turn/started" ? "start" : "end"] = sequence;
        intervals.set(key, span);
      }
      if (trace.length < 96)
        trace.push(
          kind +
            (frame.params?.item?.type
              ? `/${kinds.has(frame.params.item.type) ? frame.params.item.type : "unknown-item"}`
              : ""),
        );
      if (reconnect?.observe(frame.method, frame.params)) {
        actions++;
        trace.push("error/streamReconnectCounted");
        return;
      }
      if (frame.method === "error") {
        stop(
          new ProbeStop(`出现原生错误或重连通知，本次停止。${errorNotification(frame.params)}。`),
        );
        return;
      }
      if (["item/started", "item/completed"].includes(frame.method)) {
        const item = frame.params.item;
        requireThat(
          [
            "userMessage",
            "agentMessage",
            "reasoning",
            "plan",
            "mcpToolCall",
            "contextCompaction",
          ].includes(item.type),
          "原生轮出现不允许的工具或未知 item。",
        );
        if (item.type === "mcpToolCall") {
          requireThat(
            allowFixedTool &&
              item.server === "paihuo_t015_fixed" &&
              item.tool === "fixed" &&
              Object.keys(item.arguments ?? {}).length === 0,
            "出现白名单外的 MCP 调用。",
          );
          if (frame.method === "item/started") {
            const key = `${frame.params.threadId}/${frame.params.turnId}`;
            requireThat(!toolsByTurn.has(key), "同一轮发生重复 MCP 调用，停止。");
            toolsByTurn.add(key);
          }
        }
        if (item.type === "contextCompaction" && frame.method === "item/completed") compactions++;
      }
      if (safeMethod.has(frame.method)) events.push(frame);
      requireThat(events.length <= 12000, "通知数超限。");
      for (const notify of [...waiters]) notify();
    } catch (error) {
      stop(error);
    }
  });
  const timer = setTimeout(() => stop(new ProbeStop("App Server 阶段超时，停止。")), 85000);
  return {
    trace,
    pid: child.pid,
    checkReconnectTermination() {
      if (!reconnect) return;
      if (lastFailure) throw lastFailure;
      requireThat(
        closed && exitStatus === 0,
        `图片场景收尾未通过：原生进程关闭 exit=${Number.isInteger(exitStatus) ? exitStatus : "unknown"}，清理异常，场景能力未确认。`,
      );
    },
    observed() {
      return {
        denied,
        compactions,
        toolCalls: toolsByTurn.size,
        latestCumulativeTokenTotals: [...latestTokenTotals.values()],
        countedStreamReconnects: reconnect?.count() ?? 0,
      };
    },
    request(method, params = {}) {
      requireThat(methods.has(method), "RPC 不在允许集合。");
      if (["turn/start", "turn/steer", "turn/interrupt"].includes(method)) actions++;
      if (lastFailure) throw lastFailure;
      if (method === "turn/start") reconnect?.submitted(params.threadId);
      const id = ++next;
      return new Promise((resolve, reject) => {
        pending.set(id, { method, resolve, reject });
        send({ id, method, params });
      });
    },
    initialized() {
      send({ method: "initialized" });
    },
    wait(method, test, ended) {
      return new Promise((resolve, reject) => {
        const check = () => {
          const index = events.findIndex((frame) => frame.method === method && test(frame.params));
          if (lastFailure || closed) {
            waiters.delete(check);
            reject(lastFailure ?? new ProbeStop("未等到通知进程即退出。"));
            return;
          }
          if (index >= 0) {
            waiters.delete(check);
            resolve(events.splice(index, 1)[0].params);
          } else if (
            ended &&
            events.some((f) => f.method === "turn/completed" && ended(f.params))
          ) {
            waiters.delete(check);
            reject(new CaseObservation(`原生轮已结束，缺少预期的 ${method} 通知。`));
          }
        };
        waiters.add(check);
        check();
      });
    },
    deltas(threadId, turnId) {
      return events
        .filter(
          (m) =>
            m.method === "item/agentMessage/delta" &&
            m.params.threadId === threadId &&
            m.params.turnId === turnId,
        )
        .map((m) => m.params.delta);
    },
    finals(threadId, turnId) {
      return events
        .filter(
          (m) =>
            m.method === "item/completed" &&
            m.params.threadId === threadId &&
            m.params.turnId === turnId &&
            m.params.item.type === "agentMessage",
        )
        .map((m) => m.params.item.text);
    },
    overlap(a, b) {
      const x = intervals.get(a),
        y = intervals.get(b);
      return Boolean(x?.end && y?.end && x.start < y.end && y.start < x.end);
    },
    async close() {
      clearTimeout(timer);
      if (!closed) child.stdin.end();
      const hard = setTimeout(() => child.kill(), 1500);
      try {
        return await exited;
      } finally {
        clearTimeout(hard);
        lines.close();
      }
    },
  };
}
