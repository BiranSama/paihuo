import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";
import { openRpc } from "./scenario-rpc.mjs";
import { allowances, runCase } from "./scenarios.mjs";
import { cleanEnv, requireThat, withScratch } from "./session-common.mjs";

export async function offlineCases() {
  const results = {};
  for (const name of Object.keys(allowances)) {
    results[name] = await withScratch(async (root, project) => {
      let used = 0;
      const connect = async () => {
        const c = openRpc(
          process.execPath,
          [fileURLToPath(import.meta.url), "--serve", root],
          project,
          cleanEnv(root),
          ["mcp", "parallel", "resources"].includes(name),
          name === "approval" ? join(root, "denied/attempt.txt") : null,
        );
        await c.request("initialize");
        c.initialized();
        return c;
      };
      const report = await runCase(name, {
        connect,
        project,
        sample: async () => ({ synthetic: true }),
        charge() {
          used++;
        },
      });
      requireThat(used === allowances[name], "合成动作数与预算不符。");
      requireThat(!report.outcome, "合成场景判定未通过。");
      return { ...report, syntheticNativeActions: used };
    });
  }
  return { mode: "offline-scenarios", nativeHarness: false, modelRequests: 0, results };
}

if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv[2] === "--serve") {
  const root = process.argv[3],
    threads = new Map();
  const paired = [];
  let approval;
  const send = (frame) => process.stdout.write(`${JSON.stringify(frame)}\n`);
  const event = (method, params) => send({ method, params });
  const finish = (t, u, text, status = "completed") => {
    if (text) {
      event("item/agentMessage/delta", { threadId: t, turnId: u, delta: text });
      event("item/completed", {
        threadId: t,
        turnId: u,
        item: { id: "msg", type: "agentMessage", text },
      });
    }
    event("turn/completed", { threadId: t, turn: { id: u, status } });
  };
  for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
    const { id, method, params: p, result } = JSON.parse(line);
    const reply = (result) => send({ id, result });
    if (!method && id === "ask") {
      if (result?.scope !== "turn" || Object.keys(result?.permissions ?? { absent: true }).length)
        throw Error();
      finish(approval.t, approval.u, "DENIED");
      continue;
    }
    if (method === "initialize") reply({ userAgent: "synthetic" });
    else if (method === "initialized") continue;
    else if (method === "thread/start") {
      const t = randomUUID();
      threads.set(t, { cwd: p.cwd });
      reply({
        thread: { id: t, cwd: p.cwd, ephemeral: p.ephemeral },
        cwd: p.cwd,
        model: p.model,
        modelProvider: "openai",
        approvalPolicy: p.approvalPolicy,
        sandbox: { type: "readOnly", networkAccess: false },
      });
    } else if (method === "thread/resume") {
      const prev = JSON.parse(readFileSync(join(root, "fixture-state.json"), "utf8"));
      if (prev.id !== p.threadId) throw Error();
      threads.set(prev.id, prev);
      reply({
        thread: { id: prev.id, cwd: prev.cwd, ephemeral: false },
        cwd: p.cwd,
        model: p.model,
        modelProvider: "openai",
        approvalPolicy: p.approvalPolicy,
        sandbox: { type: "readOnly", networkAccess: false },
      });
    } else if (method === "turn/start") {
      const t = p.threadId,
        u = randomUUID(),
        text = p.input[0].text;
      reply({ turn: { id: u } });
      event("turn/started", { threadId: t, turn: { id: u } });
      if (text.startsWith("Remember ")) {
        const saved = {
          id: t,
          cwd: threads.get(t).cwd,
          marker: text.split(" ")[1].replace(".", ""),
        };
        writeFileSync(join(root, "fixture-state.json"), JSON.stringify(saved));
        finish(t, u, "SAVED");
      } else if (text.startsWith("Return only the marker")) finish(t, u, threads.get(t).marker);
      else if (text.startsWith("Call the fixed MCP tool")) {
        const item = {
          id: "tool",
          type: "mcpToolCall",
          server: "paihuo_t015_fixed",
          tool: "fixed",
          arguments: {},
          status: "inProgress",
        };
        event("item/started", { threadId: t, turnId: u, item });
        const marker = readFileSync(join(threads.get(t).cwd, "fixture.txt"), "utf8");
        event("item/completed", { threadId: t, turnId: u, item: { ...item, status: "completed" } });
        paired.push([t, u, marker]);
        if (paired.length === 2) for (const args of paired) finish(...args);
      } else if (text.startsWith("Read the four color stripes")) {
        const png = Buffer.from(p.input[1].url.split(",")[1], "base64");
        const values = inflateSync(png.subarray(41, 41 + png.readUInt32BE(33)));
        const names = { "255,0,0": "R", "0,200,0": "G", "0,0,255": "B", "255,255,0": "Y" };
        const letters = [0, 32, 64, 96]
          .map((x) => names[Array.from(values.subarray(1 + 3 * x, 4 + 3 * x)).join(",")])
          .join("");
        finish(t, u, letters);
      } else if (text.startsWith("Use request_permissions")) {
        approval = { t, u };
        send({
          id: "ask",
          method: "item/permissions/requestApproval",
          params: {
            threadId: t,
            turnId: u,
            permissions: { fileSystem: { write: [join(root, "denied/attempt.txt")] } },
          },
        });
      } else if (text.startsWith("Reply only ")) finish(t, u, text.slice(11, -1));
      else if (text.startsWith("Call the MCP")) {
        const item = {
          id: "tool",
          type: "mcpToolCall",
          server: "paihuo_t015_fixed",
          tool: "fixed",
          status: "inProgress",
        };
        event("item/started", { threadId: t, turnId: u, item });
        event("item/completed", { threadId: t, turnId: u, item: { ...item, status: "completed" } });
        finish(t, u, "PAIHUO_MCP_OK");
      }
    } else if (method === "turn/steer") {
      reply({ turnId: p.expectedTurnId });
      finish(p.threadId, p.expectedTurnId, "STEERED");
    } else if (method === "turn/interrupt") {
      reply({});
      finish(p.threadId, p.turnId, null, "interrupted");
    } else if (method === "thread/archive") reply({});
    else send({ id, error: { code: -32601, message: "Unsupported fixture method" } });
  }
}
