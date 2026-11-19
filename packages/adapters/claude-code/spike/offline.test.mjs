import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

test("未安装 Claude Code 时仍能运行合成验证", () => {
  const entry = fileURLToPath(new URL("./offline.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [entry, "--synthetic-only"], {
    env: { PATH: "", SystemRoot: process.env.SystemRoot ?? "" },
    encoding: "utf8",
    timeout: 5_000,
    killSignal: "SIGKILL",
    windowsHide: true,
  });

  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.stdout).toContain(
    "Synthetic streams: passed (UTF-8, tool pairing, session isolation, invalid input)",
  );
  expect(result.stdout).toContain("Mode: synthetic-only");
});
