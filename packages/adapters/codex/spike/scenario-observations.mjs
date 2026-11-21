import { execFile } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { requireThat } from "./session-common.mjs";

export function quotaSnapshot(data) {
  const r = data.rateLimitsByLimitId?.codex ?? data.rateLimits;
  const w = [r?.primary, r?.secondary].find((v) => v?.windowDurationMins === 10080);
  const c = r?.credits;
  requireThat(
    data.ordinaryUsageAllowed !== false &&
      (r?.limitId === "codex" || data.rateLimitsByLimitId?.codex === r) &&
      Number.isFinite(w?.usedPercent) &&
      w.usedPercent >= 0 &&
      w.usedPercent < 100 &&
      Number.isSafeInteger(w.resetsAt) &&
      c?.hasCredits === false &&
      c.unlimited === false &&
      c.balance !== null &&
      c.balance !== undefined &&
      /^(?:0|0\.0+)$/.test(String(c.balance)),
    "全批暂停：订阅窗口、普通额度或零付费点数未获确认。",
  );
  return {
    usedPercent: w.usedPercent,
    windowMinutes: w.windowDurationMins,
    resetsAt: w.resetsAt,
    requiresHostOrdinaryUsageCheck: data.ordinaryUsageAllowed !== true,
  };
}

export async function sampleTree(pid, env, cwd) {
  requireThat(Number.isSafeInteger(pid) && pid > 0, "采样根 PID 无效。");
  const shell = join(env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const sampler = fileURLToPath(new URL("./sample.ps1", import.meta.url));
  const r = await promisify(execFile)(
    shell,
    ["-NoProfile", "-NoLogo", "-NonInteractive", "-File", sampler],
    {
      env: { ...env, PAIHUO_SAMPLE_ROOT: String(pid) },
      cwd,
      windowsHide: true,
      timeout: 9000,
      maxBuffer: 4096,
      encoding: "utf8",
    },
  );
  const { pids, bytes } = JSON.parse(r.stdout);
  requireThat(
    Array.isArray(pids) &&
      pids.length > 0 &&
      pids.every((n) => Number.isSafeInteger(n) && n > 0) &&
      bytes > 0,
    "未找到本次原生进程树。",
  );
  return { processes: pids.length, workingSetMiB: Math.round((bytes / 1048576) * 100) / 100, pids };
}
