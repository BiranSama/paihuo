import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { openRpc } from "./scenario-rpc.mjs";
import { appServerEnv, scenarioBaseArgs, verifyPolicy, verifyRoster } from "./scenarios.mjs";
import { cleanEnv, command, requireThat, withScratch } from "./session-common.mjs";

export async function offlineRoster(exe, argv) {
  return withScratch(async (root, project) => {
    const home = join(root, "codex"),
      marker = join(root, "mcp-started");
    mkdirSync(home);
    const script = fileURLToPath(import.meta.url);
    const config = `[mcp_servers.sentinel]\ncommand = ${JSON.stringify(process.execPath)}\nargs = ${JSON.stringify([script, "--mark", marker])}\n`;
    writeFileSync(join(home, "config.toml"), config);
    const env = appServerEnv({
      ...cleanEnv(root),
      CODEX_HOME: home,
      HTTP_PROXY: "http://127.0.0.1:9",
      HTTPS_PROXY: "http://127.0.0.1:9",
      ALL_PROXY: "http://127.0.0.1:9",
      NO_PROXY: "127.0.0.1,localhost",
    });
    requireThat(
      command(exe, ["--version"], project, env).stdout.trim() === "codex-cli 0.167.0",
      "原生版本不符。",
    );
    const rosters = [];
    const base = scenarioBaseArgs(argv);
    const rejected = openRpc(
      exe,
      [...base, "-c", 'history.persistence="save-none"', "app-server", "--listen", "stdio://"],
      project,
      env,
    );
    let rejectedHistory = false;
    try {
      await rejected.request("initialize", {
        clientInfo: { name: "paihuo_probe", version: "0.1.0" },
      });
    } catch (error) {
      rejectedHistory = error?.message.includes("startup=history-enum, exit=1。") === true;
    } finally {
      await rejected.close();
    }
    requireThat(rejectedHistory, "旧 history.persistence 负控未按预期拒绝。");
    const fixedArgs = [script, "--mark", marker];
    const fixedSpec = {
      command: process.execPath,
      args: fixedArgs,
      enabled: true,
      required: true,
      enabled_tools: ["fixed"],
    };
    const fixedOverrides = Object.entries(fixedSpec).flatMap(([key, value]) => [
      "-c",
      `mcp_servers.paihuo_t015_fixed.${key}=${JSON.stringify(value)}`,
    ]);
    for (const overrides of [[], ["-c", "mcp_servers.sentinel.enabled=false", ...fixedOverrides]]) {
      const c = openRpc(
        exe,
        [...base, ...overrides, "app-server", "--listen", "stdio://"],
        project,
        env,
      );
      try {
        await c.request("initialize", { clientInfo: { name: "paihuo_probe", version: "0.1.0" } });
        c.initialized();
        const result = await c.request("config/read", { includeLayers: false, cwd: project });
        const cfg = result.config;
        verifyPolicy(cfg, base);
        const item = result.config?.mcp_servers?.sentinel;
        requireThat(
          item && (item.enabled !== false) === (overrides.length === 0),
          "有效配置未反映合成服务的启用状态。",
        );
        rosters.push(item.enabled !== false);
        if (overrides.length)
          verifyRoster(["sentinel", "paihuo_t015_roster"], cfg.mcp_servers, fixedArgs);
        await pause(1000);
      } finally {
        await c.close();
      }
      requireThat(!existsSync(marker), "握手或 config/read 启动了合成 MCP，停止有账号场景。");
    }
    requireThat(
      command(process.execPath, [script, "--mark", marker], project, env).status === 0 &&
        existsSync(marker),
      "标记阳性对照失败。",
    );
    return {
      mode: "offline-native-roster",
      version: "0.167.0",
      enabledThenDisabled: rosters,
      processes: 3,
      rejectedInvalidHistoryEnum: true,
      markerBeforeThread: false,
      positiveControl: true,
      restrictedFixedDefinitionVerified: true,
      modelRequests: 0,
    };
  });
}
if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv[2] === "--mark")
  writeFileSync(process.argv[3], "started");
