import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, statSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { verifySyntheticStreams } from "./synthetic-events.mjs";

function findClaude() {
  const name = process.platform === "win32" ? "claude.exe" : "claude";
  for (const entry of (process.env.PATH ?? "").split(delimiter)) {
    const directory = entry.replace(/^"(.*)"$/, "$1");
    if (!isAbsolute(directory)) continue;
    const candidate = join(directory, name);
    if (statSync(candidate, { throwIfNoEntry: false })?.isFile()) return candidate;
  }
}

function probeClaude(executable, directory) {
  // 这些参数只读取命令帮助或版本。不给子进程提供外部配置和认证环境变量。
  const options = {
    cwd: directory,
    env: {
      SystemRoot: process.env.SystemRoot ?? "",
      USERPROFILE: directory,
      HOME: directory,
      APPDATA: directory,
      LOCALAPPDATA: directory,
      TEMP: directory,
      TMP: directory,
      CLAUDE_CONFIG_DIR: join(directory, "config"),
      DISABLE_TELEMETRY: "1",
      DISABLE_UPDATES: "1",
      ENABLE_CLAUDEAI_MCP_SERVERS: "false",
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    timeout: 10_000,
    killSignal: "SIGKILL",
    maxBuffer: 1024 * 1024,
    encoding: "utf8",
  };
  const probes = [
    { name: "version", args: ["--version"] },
    { name: "help", args: ["--help"] },
    { name: "mcp-help", args: ["mcp", "--help"] },
  ];
  const outputs = new Map();
  for (const { name, args } of probes) {
    const result = spawnSync(executable, args, options);
    if (result.error || result.status !== 0) {
      // 原始输出可能随本机配置变化，仅汇报受控的状态字段。
      const status = result.error?.code ?? result.status ?? result.signal ?? "unknown";
      console.error(`CLI ${name}: failed (${status})`);
      return false;
    }
    console.log(`CLI ${name}: exit 0`);
    outputs.set(name, result.stdout);
  }

  const version = /^([0-9]+\.[0-9]+\.[0-9]+) \(Claude Code\)$/.exec(
    outputs.get("version").trim(),
  )?.[1];
  if (!version) {
    console.error("CLI version: unexpected format");
    return false;
  }
  console.log(`Claude Code: ${version}`);

  const flags = [
    "--print",
    "--append-system-prompt",
    "--input-format",
    "--output-format",
    "--include-partial-messages",
    "--session-id",
    "--resume",
    "--no-session-persistence",
    "--permission-mode",
    "--permission-prompts",
    "--autocompact",
    "--mcp-config",
    "--strict-mcp-config",
  ];
  const help = outputs.get("help");
  if (!help.includes("Usage: claude") || !outputs.get("mcp-help").includes("Usage: claude mcp")) {
    console.error("CLI help: unexpected format");
    return false;
  }
  const helpFlags = new Set(help.match(/--[a-z][a-z-]*/g));
  const missing = flags.filter((flag) => !helpFlags.has(flag));
  console.log(`Advertised flags: ${flags.length - missing.length}/${flags.length}`);
  if (missing.length) console.error(`Missing flags: ${missing.join(", ")}`);
  return missing.length === 0;
}

async function main(args) {
  const syntheticOnly = args.length === 1 && args[0] === "--synthetic-only";
  if (args.length > 0 && !syntheticOnly) {
    console.error("Usage: node packages/adapters/claude-code/spike/offline.mjs [--synthetic-only]");
    return 1;
  }

  await verifySyntheticStreams();
  console.log("Synthetic streams: passed (UTF-8, tool pairing, session isolation, invalid input)");
  if (syntheticOnly) {
    console.log("Mode: synthetic-only");
    return 0;
  }

  const executable = findClaude();
  if (!executable) {
    console.error("Claude Code CLI unavailable: native binary missing from PATH");
    return 2;
  }

  const spikeDirectory = realpathSync(fileURLToPath(new URL(".", import.meta.url)));
  const directory = mkdtempSync(join(spikeDirectory, ".offline-"));
  let passed;
  let cleaned = false;
  try {
    passed = probeClaude(executable, directory);
  } finally {
    if (dirname(realpathSync(directory)) === spikeDirectory) {
      rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      cleaned = true;
    } else {
      console.error("Cleanup skipped: temporary directory escaped the sample folder");
    }
  }
  return passed && cleaned ? 0 : 1;
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  if (error?.code === "ERR_ASSERTION") {
    console.error(`Synthetic streams: failed (${error.message.split("\n")[0]})`);
  } else {
    console.error(`Offline sample: failed (${error?.code ?? error?.name ?? "unknown"})`);
  }
  process.exitCode = 1;
}
