import { accessSync, constants, statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { createInterface } from "node:readline";
import type { SystemInfo } from "@paihuo/shared";
import { version } from "../package.json";
import { startCore } from "./server";

function detectedHarnesses(): SystemInfo["harnesses"] {
  const paths = (process.env.PATH ?? "").split(delimiter).filter(isAbsolute);
  const extensions = process.platform === "win32" ? [".exe", ".cmd", ".bat", ".com"] : [""];
  const candidates = [
    ["claude-code", "claude"],
    ["codex", "codex"],
  ] as const;

  return candidates
    .filter(([, command]) =>
      paths.some((directory) =>
        extensions.some((extension) => {
          const executable = join(directory, command + extension);
          try {
            accessSync(executable, constants.X_OK);
            return statSync(executable).isFile();
          } catch {
            return false;
          }
        }),
      ),
    )
    .map(([harness]) => harness);
}

function readConfig(line: string) {
  const value: unknown = JSON.parse(line);
  if (
    typeof value !== "object" ||
    value === null ||
    !("token" in value) ||
    typeof value.token !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.token) ||
    !("dataDir" in value) ||
    typeof value.dataDir !== "string" ||
    !isAbsolute(value.dataDir) ||
    !("origin" in value) ||
    (value.origin !== "http://tauri.localhost" && value.origin !== "http://127.0.0.1:1420")
  ) {
    throw new Error("Invalid core startup configuration");
  }
  return { token: value.token, dataDir: value.dataDir, origin: value.origin };
}

async function main() {
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const ended = new Promise<void>((resolve) => {
    input.once("close", resolve);
    process.stdin.once("error", resolve);
  });
  const startupLine = new Promise<string>((resolve) => input.once("line", resolve));
  const line = await Promise.race([startupLine, ended]);
  if (line === undefined) return;

  const config = readConfig(line);
  const core = await startCore({
    token: config.token,
    origin: config.origin,
    systemInfo: () => ({
      version,
      dataDir: config.dataDir,
      harnesses: detectedHarnesses(),
      memoryBytes: process.memoryUsage.rss(),
    }),
  });

  // 标准输出只报告就绪端口。令牌仅经父进程的标准输入管道传入。
  process.stdout.write(`${JSON.stringify({ port: core.port })}\n`);
  await ended;
  await core.close();
}

main().catch(() => {
  process.stderr.write("Core startup or shutdown failed.\n");
  process.exit(1);
});
