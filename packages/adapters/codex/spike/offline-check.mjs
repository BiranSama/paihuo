import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, delimiter, dirname, isAbsolute, join } from "node:path";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

class CheckError extends Error {}

function npmCodex(pathEntry) {
  const npmRoot = join(pathEntry, "node_modules", "@openai", "codex");
  const manifest = join(npmRoot, "package.json");
  if (!existsSync(join(pathEntry, "codex.cmd")) || !existsSync(manifest)) return;

  const architecture = process.arch === "x64" ? "x86_64" : "aarch64";
  const target = `${architecture}-pc-windows-msvc`;
  const require = createRequire(manifest);
  let vendor = join(npmRoot, "vendor");
  try {
    const platformManifest = require.resolve(`@openai/codex-win32-${process.arch}/package.json`);
    vendor = join(dirname(platformManifest), "vendor");
  } catch (error) {
    if (error.code !== "MODULE_NOT_FOUND") throw error;
  }
  return join(vendor, target, "bin", "codex.exe");
}

function findCodex() {
  const explicit = process.argv[2];
  if (explicit !== undefined) {
    if (
      process.argv.length !== 3 ||
      !isAbsolute(explicit) ||
      basename(explicit).toLowerCase() !== "codex.exe" ||
      !statSync(explicit, { throwIfNoEntry: false })?.isFile()
    ) {
      throw new CheckError("可选参数必须是已安装的原生 codex.exe 的绝对路径。");
    }
    return { executable: explicit, source: "显式指定" };
  }

  for (const entry of (process.env.Path ?? "").split(delimiter)) {
    const dir = entry.replace(/^"(.*)"$/, "$1");
    if (!isAbsolute(dir)) continue;

    const installedNpm = npmCodex(dir);
    if (installedNpm && statSync(installedNpm, { throwIfNoEntry: false })?.isFile()) {
      return { executable: installedNpm, source: "PATH 中 npm 启动器对应的原生程序" };
    }

    const native = join(dir, "codex.exe");
    if (statSync(native, { throwIfNoEntry: false })?.isFile()) {
      return { executable: native, source: "PATH 中的原生程序" };
    }
  }
  throw new CheckError("未找到已安装的 codex.exe。可用绝对路径显式指定。");
}

function runStaticCommand(executable, cwd, args) {
  // 仅传递启动所需的 Windows 环境与本次专用目录，隔离已有认证和配置。
  const result = spawnSync(executable, args, {
    cwd,
    env: {
      CODEX_HOME: cwd,
      SystemRoot: process.env.SystemRoot,
      TEMP: cwd,
      TMP: cwd,
      NO_COLOR: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    shell: false,
    windowsHide: true,
    timeout: 15_000,
    killSignal: "SIGKILL",
    maxBuffer: 1024 * 1024,
  });

  if (result.error?.code === "ETIMEDOUT") {
    throw new CheckError("CLI 命令超时（15 秒）。");
  }
  if (result.error || result.status !== 0) {
    const stage = args[0] === "app-server" ? args.slice(0, 2).join(" ") : args[0];
    const status = result.error?.code ?? result.status ?? "进程被终止";
    throw new CheckError(`CLI 命令失败（${stage}，${status}）。`);
  }
  return result.stdout;
}

function inspectSchema(schemaDir) {
  const read = (name) => JSON.parse(readFileSync(join(schemaDir, name), "utf8"));
  const methods = (name, expected) => {
    const options = read(name).oneOf;
    const defined = new Set(options.flatMap((entry) => entry.properties?.method?.enum ?? []));
    for (const method of expected) {
      if (!defined.has(method)) throw new CheckError(`本机协议缺少 ${method}。`);
    }
    return expected;
  };
  const parameters = (name, expected, section, version = "v2") => {
    const schema = read(`${version}/${name}.json`);
    const names = section === "required" ? schema.required : Object.keys(schema.properties ?? {});
    for (const field of expected) {
      if (!names?.includes(field)) throw new CheckError(`${name} 缺少字段 ${field}。`);
    }
    return expected;
  };

  const imageTypes = read("v2/TurnStartParams.json").definitions.UserInput.oneOf.flatMap(
    (variant) => variant.properties?.type?.enum ?? [],
  );
  const inputs = ["text", "image", "localImage"];
  for (const type of inputs) {
    if (!imageTypes.includes(type)) throw new CheckError(`本机协议缺少 ${type} 输入。`);
  }

  return {
    clientRequests: methods("ClientRequest.json", [
      "initialize",
      "thread/start",
      "thread/resume",
      "thread/compact/start",
      "turn/start",
      "turn/steer",
      "turn/interrupt",
      "mcpServerStatus/list",
    ]),
    clientNotifications: methods("ClientNotification.json", ["initialized"]),
    serverNotifications: methods("ServerNotification.json", [
      "thread/started",
      "turn/completed",
      "item/started",
      "item/completed",
      "item/agentMessage/delta",
      "thread/tokenUsage/updated",
    ]),
    serverRequests: methods("ServerRequest.json", [
      "item/commandExecution/requestApproval",
      "item/fileChange/requestApproval",
    ]),
    initializeRequired: parameters("InitializeParams", ["clientInfo"], "required", "v1"),
    startFields: parameters("ThreadStartParams", ["cwd", "baseInstructions"], "properties"),
    startResponseRequired: parameters("ThreadStartResponse", ["thread"], "required"),
    resumeRequired: parameters("ThreadResumeParams", ["threadId"], "required"),
    steerRequired: parameters(
      "TurnSteerParams",
      ["threadId", "expectedTurnId", "input"],
      "required",
    ),
    interruptRequired: parameters("TurnInterruptParams", ["threadId", "turnId"], "required"),
    inputs,
  };
}

async function checkSyntheticEvents() {
  // 故意交错两个会话的消息，并将 UTF-8 字节按任意位置切段。
  const frames = [
    {
      method: "item/agentMessage/delta",
      params: { threadId: "A", turnId: "TA", itemId: "a", delta: "甲" },
    },
    {
      method: "item/agentMessage/delta",
      params: { threadId: "B", turnId: "TB", itemId: "b", delta: "乙" },
    },
    {
      id: 42,
      method: "item/commandExecution/requestApproval",
      params: { threadId: "A", turnId: "TA", itemId: "tool", startedAtMs: 0 },
    },
    {
      method: "item/agentMessage/delta",
      params: { threadId: "A", turnId: "TA", itemId: "a", delta: "完成" },
    },
    {
      method: "turn/completed",
      params: { threadId: "B", turn: { id: "TB", status: "interrupted", items: [] } },
    },
    {
      method: "turn/completed",
      params: { threadId: "A", turn: { id: "TA", status: "completed", items: [] } },
    },
  ];
  const bytes = Buffer.from(`${frames.map((frame) => JSON.stringify(frame)).join("\r\n")}\r\n`);
  function* chunks() {
    for (let offset = 0; offset < bytes.length; offset += 7) {
      yield bytes.subarray(offset, offset + 7);
    }
  }

  const turns = new Map([
    ["A", { id: "TA", text: "", status: null }],
    ["B", { id: "TB", text: "", status: null }],
  ]);
  const replies = [];
  const lines = createInterface({ input: Readable.from(chunks()), crlfDelay: Infinity });
  for await (const line of lines) {
    const { id, method, params } = JSON.parse(line);
    const turn = turns.get(params.threadId);
    assert.equal(params.turnId ?? params.turn.id, turn.id);
    assert.equal(turn.status, null);

    if (method === "item/agentMessage/delta") turn.text += params.delta;
    if (method === "item/commandExecution/requestApproval") {
      replies.push({
        threadId: params.threadId,
        response: { id, result: { decision: "decline" } },
      });
    }
    if (method === "turn/completed") turn.status = params.turn.status;
  }

  assert.deepEqual(
    [...turns.values()],
    [
      { id: "TA", text: "甲完成", status: "completed" },
      { id: "TB", text: "乙", status: "interrupted" },
    ],
  );
  assert.deepEqual(replies, [
    { threadId: "A", response: { id: 42, result: { decision: "decline" } } },
  ]);
  return { frames: frames.length, routedTurns: turns.size, correlatedApprovals: replies.length };
}

async function main() {
  if (process.argv[2] === "--synthetic-only") {
    if (process.argv.length !== 3) throw new CheckError("--synthetic-only 不接受其他参数。");
    return { mode: "synthetic-only", syntheticEvents: await checkSyntheticEvents() };
  }

  if (process.platform !== "win32" || !["x64", "arm64"].includes(process.arch)) {
    throw new CheckError("此样例需要 Windows x64 或 ARM64 上的原生 Node.js。");
  }

  const { executable, source } = findCodex();
  const spikeDir = realpathSync(dirname(fileURLToPath(import.meta.url)));
  const scratch = mkdtempSync(join(spikeDir, ".t004-offline-"));
  try {
    const rawVersion = runStaticCommand(executable, scratch, ["--version"]).trim();
    if (!/^codex-cli \d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(rawVersion)) {
      throw new CheckError("CLI 版本输出与样例支持的格式不符。");
    }
    const appServerHelp = runStaticCommand(executable, scratch, ["app-server", "--help"]);
    const execHelp = runStaticCommand(executable, scratch, ["exec", "--help"]);
    const resumeHelp = runStaticCommand(executable, scratch, ["exec", "resume", "--help"]);
    assert.match(appServerHelp, /generate-json-schema/);
    assert.match(appServerHelp, /stdio:\/\//);
    assert.match(execHelp, /--json\b/);
    assert.match(resumeHelp, /\[SESSION_ID\]/);

    const schemaDir = join(scratch, "schema");
    runStaticCommand(executable, scratch, [
      "app-server",
      "generate-json-schema",
      "--out",
      schemaDir,
    ]);
    const schema = inspectSchema(schemaDir);
    const synthetic = await checkSyntheticEvents();
    return {
      os: `${process.platform} ${process.arch}`,
      cli: rawVersion,
      cliSource: source,
      localHelp: { appServerStdio: true, execJson: true, execResumeById: true },
      exportedSchema: schema,
      syntheticEvents: synthetic,
    };
  } finally {
    removeScratch(scratch, spikeDir);
  }
}

function removeScratch(scratch, spikeDir) {
  // 递归删除前核对真实路径和父目录，仅清理本次创建的临时目录。
  const resolved = realpathSync(scratch);
  if (resolved !== scratch || dirname(resolved) !== spikeDir) {
    throw new CheckError("临时目录路径发生变化，已停止清理。");
  }
  rmSync(resolved, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}

try {
  const result = await main();
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  const message =
    error instanceof CheckError ? error.message : "检查失败。请核对本机 CLI 及协议版本。";
  console.error(message);
  process.exitCode = 1;
}
