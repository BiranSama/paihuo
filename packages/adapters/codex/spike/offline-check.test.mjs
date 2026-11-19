import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

test("合成模式在没有 Codex CLI 和账号时返回预期的覆盖汇总", () => {
  const sample = fileURLToPath(new URL("./offline-check.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [sample, "--synthetic-only"], {
    encoding: "utf8",
    env: { SystemRoot: process.env.SystemRoot },
    timeout: 5_000,
    windowsHide: true,
  });

  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({
    mode: "synthetic-only",
    syntheticEvents: { frames: 6, routedTurns: 2, correlatedApprovals: 1 },
  });
});
