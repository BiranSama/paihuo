import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as pause } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { cleanEnv, command, requireThat, withScratch } from "./session-common.mjs";

const versions = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
function responder(getText) {
  let state = "new";
  return (m) => {
    if (m.jsonrpc !== "2.0") throw Error("invalid JSON-RPC");
    if (
      m.method === "notifications/initialized" &&
      m.id === undefined &&
      state === "initializing"
    ) {
      state = "ready";
      return;
    }
    if (m.id === undefined) return;
    const ok = (result) => ({ jsonrpc: "2.0", id: m.id, result });
    const fail = (code) => ({
      jsonrpc: "2.0",
      id: m.id,
      error: { code, message: "Unsupported request" },
    });
    if (m.method === "initialize" && state === "new") {
      state = "initializing";
      return ok({
        protocolVersion: versions.includes(m.params?.protocolVersion)
          ? m.params.protocolVersion
          : versions[0],
        capabilities: { tools: {} },
        serverInfo: { name: "paihuo-probe", version: "1.0.0" },
      });
    }
    if (state !== "ready") return fail(-32600);
    if (m.method === "ping") return ok({});
    if (m.method === "tools/list")
      return ok({
        tools: [
          {
            name: "fixed",
            description: "返回固定标记",
            inputSchema: { type: "object", properties: {}, additionalProperties: false },
          },
        ],
      });
    if (
      m.method === "tools/call" &&
      m.params?.name === "fixed" &&
      Object.keys(m.params.arguments ?? {}).length === 0
    ) {
      return ok({ content: [{ type: "text", text: getText() }] });
    }
    return fail(m.method === "tools/call" ? -32602 : -32601);
  };
}

export async function checkMcp() {
  return withScratch((root, project) => {
    const frames = [
      {
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: versions[0],
          capabilities: {},
          clientInfo: { name: "local-probe", version: "1" },
        },
      },
      { method: "notifications/initialized" },
      { id: 2, method: "tools/list" },
      { id: 3, method: "tools/call", params: { name: "fixed", arguments: {} } },
      { id: 4, method: "tools/call", params: { name: "fixed", arguments: { unexpected: true } } },
    ];
    const input = `${frames.map((f) => JSON.stringify({ jsonrpc: "2.0", ...f })).join("\n")}\n`;
    const result = command(
      process.execPath,
      [fileURLToPath(import.meta.url), "--serve"],
      project,
      cleanEnv(root),
      input,
    );
    const rows = result.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    requireThat(
      result.status === 0 &&
        rows.length === 4 &&
        rows[0].result.protocolVersion === versions[0] &&
        rows[1].result.tools.length === 1 &&
        rows[1].result.tools[0].name === "fixed" &&
        rows[2].result.content[0].text === "PAIHUO_MCP_OK" &&
        rows[3].error.code === -32602,
      "固定 MCP 的本地 stdio 自检失败。",
    );
    return {
      mode: "offline-mcp",
      protocolVersion: versions[0],
      tools: 1,
      calls: 1,
      rejectedInvalidArgs: true,
      nativeHarness: false,
    };
  });
}

if (
  process.argv[1] === fileURLToPath(import.meta.url) &&
  ["--serve", "--serve-marker", "--serve-delay"].includes(process.argv[2])
) {
  const reply = responder(() => {
    if (process.argv[2] !== "--serve-marker") return "PAIHUO_MCP_OK";
    const cwd = realpathSync(process.cwd());
    const file = join(cwd, "fixture.txt");
    requireThat(
      dirname(cwd) === realpathSync(process.argv[3]) &&
        ["project", "second"].includes(basename(cwd)) &&
        !lstatSync(file).isSymbolicLink() &&
        realpathSync(file) === file &&
        lstatSync(file).size === 9,
      "标记不在本次两个临时项目内。",
    );
    const marker = readFileSync(file, "utf8");
    requireThat(/^[LR][0-9a-f]{8}$/.test(marker), "标记格式无效。");
    return marker;
  });
  for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
    const message = JSON.parse(line);
    if (process.argv[2] === "--serve-delay" && message.method === "tools/call") await pause(11000);
    const answer = reply(message);
    if (answer) process.stdout.write(`${JSON.stringify(answer)}\n`);
  }
}
