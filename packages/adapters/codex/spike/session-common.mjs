import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { release, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const topics = [
  ["route", "主路线与比较路线", "同一短消息、原生事件与结果"],
  ["start", "启动与前言", "新建目录、固定前言、准确标记"],
  ["stream", "流式事件", "增量、最终消息、工具开始及结束分别记录"],
  ["resume", "恢复", "跨进程匹配暗号，区分不存在、认证失败和传输失败"],
  ["interrupt", "中断", "确认原轮结束、后续可用性和已写文件"],
  ["guide", "引导", "区分同轮生效、排队及拒绝"],
  ["parallel", "并行", "两条原生会话、不同目录、文件和事件无交叉"],
  ["approval", "权限", "隔离兄弟临时目录内请求、拒绝回执、目标文件仍不存在"],
  ["mcp", "成员工具", "独立本地固定工具调用和实际会话调用分记"],
  ["billing", "计费与认证", "登录类别、额度窗口与测试前后数字、是否可能额外收费"],
  ["resources", "资源", "同一会话空闲/工作时的全树工作集与退出后残留"],
  ["compact", "压缩", "上限内被动观察压缩事件，有则检查前后暗号"],
];

export class ProbeStop extends Error {}
export class CaseObservation extends ProbeStop {}
export function requireThat(condition, message) {
  if (!condition) throw new ProbeStop(message);
}

export function tokenCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

export function plan(harness, routes, stages) {
  return {
    mode: "plan",
    harness,
    os: process.platform,
    osVersion: release(),
    routes,
    stages,
    limitPerHarness: 30,
    billing: { before: null, after: null, bucket: "无法确认" },
    results: topics.map(([id, name, evidence]) => ({
      id,
      name,
      evidence,
      live: "待验",
      observation: null,
    })),
    capabilities: Object.fromEntries(
      ["resume", "guide", "interrupt", "parallel", "images", "nativeApproval"].map((key) => [
        key,
        "待验",
      ]),
    ),
  };
}

// 使用固定白名单；未列出的 provider、代理、更新及脚本环境变量不进入子进程。
export function cleanEnv(root, account = false) {
  const env = {
    SystemRoot: process.env.SystemRoot,
    WINDIR: process.env.SystemRoot,
    TEMP: root,
    TMP: root,
    USERPROFILE: root,
    HOME: root,
    APPDATA: root,
    LOCALAPPDATA: root,
    NO_COLOR: "1",
  };
  if (account) {
    for (const key of ["USERPROFILE", "APPDATA", "LOCALAPPDATA"]) {
      if (process.env[key]) env[key] = process.env[key];
    }
    env.HOME = env.USERPROFILE;
  }
  return env;
}

export async function withScratch(operation) {
  const parent = realpathSync(tmpdir());
  const root = mkdtempSync(join(parent, "paihuo-t015-"));
  try {
    const project = join(root, "project");
    mkdirSync(project);
    return await operation(root, project);
  } finally {
    requireThat(
      !lstatSync(root).isSymbolicLink() && realpathSync(root) === root && dirname(root) === parent,
      "临时目录被替换，停止清理。",
    );
    rmSync(root, { recursive: true, maxRetries: 3, retryDelay: 120 });
  }
}

export function checkedExe(value, name) {
  requireThat(process.platform === "win32", "真实驱动仅限 Windows。");
  requireThat(
    typeof value === "string" &&
      isAbsolute(value) &&
      basename(value).toLowerCase() === name &&
      statSync(value, { throwIfNoEntry: false })?.isFile(),
    "请指定已核实来源的原生 exe 绝对路径。",
  );
  return value;
}

export function command(exe, args, cwd, env, input, timeout = 15000) {
  const result = spawnSync(exe, args, {
    cwd,
    env,
    input,
    encoding: "utf8",
    shell: false,
    windowsHide: true,
    timeout,
    killSignal: "SIGKILL",
    maxBuffer: 2 * 1024 * 1024,
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
  });
  requireThat(
    !result.error && result.signal === null,
    "子进程异常结束、超时或输出超限，停止；检查本次进程树。",
  );
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

export function liveArgs(raw, smoke = false) {
  const options = { exe: { type: "string" }, "policy-reviewed": { type: "boolean" } };
  if (smoke)
    Object.assign(options, {
      "before-used-percent": { type: "string" },
      "used-turns": { type: "string" },
      "included-only": { type: "boolean" },
    });
  let values;
  try {
    values = parseArgs({ args: raw, options }).values;
  } catch {
    throw new ProbeStop("参数无效，请查看 --plan。");
  }
  requireThat(
    values["policy-reviewed"] === true,
    "需确认本次仍生效的托管策略未启用 hooks、凭据或端点覆写、插件或自定义 MCP。",
  );
  if (smoke) {
    requireThat(
      values["included-only"] === true,
      "需要确认订阅内额度且自动付费、额外额度均已关闭。",
    );
    const before = values["before-used-percent"];
    const spent = values["used-turns"];
    requireThat(
      /^(?:0|[1-9]\d?)(?:\.\d+)?$/.test(before ?? "") && Number(before) < 100,
      "缺少可用的额度窗口前值（已用百分比必须小于100）。",
    );
    requireThat(
      /^(?:0|[1-9]\d?)$/.test(spent ?? "") && Number(spent) < 30,
      "缺少已核实的累计轮数，或已到30轮上限。",
    );
  }
  return values;
}

// 只写入本仓库未跟踪的 Git 元数据。默认 checkout 和所有 linked worktree 共用同一独占预留。
function reservationPath(harness) {
  const repo = fileURLToPath(new URL("../../../../", import.meta.url));
  let admin = join(repo, ".git");
  if (lstatSync(admin).isFile()) {
    const entry = /^gitdir: (.+)$/.exec(readFileSync(admin, "utf8").trim());
    requireThat(entry, "无法定位本地 Git 管理目录。");
    admin = resolve(repo, entry[1]);
  }
  const common = join(admin, "commondir");
  if (existsSync(common)) admin = resolve(admin, readFileSync(common, "utf8").trim());
  return join(admin, `T-015-${harness}-smoke.reserved`);
}
export function reserve(harness, details) {
  const marker = reservationPath(harness);
  try {
    writeFileSync(marker, details ? `${JSON.stringify(details)}\n` : "1\n", { flag: "wx" });
  } catch {
    throw new ProbeStop("本卡单次 smoke 已预留或账本不可写；停止，由组长核对用量。");
  }
  return marker;
}
function supervisionFailure(args) {
  if (
    args[0] === "--live" &&
    args[1] === "scenarios" &&
    args[2] === "--case" &&
    ["steer", "interrupt", "resume", "parallel", "mcp", "resources", "approval", "image"].includes(
      args[3],
    )
  ) {
    const marker = reservationPath(`codex-${args[3]}`);
    if (existsSync(marker)) {
      const [header, ...attempts] = readFileSync(marker, "utf8").trim().split("\n");
      const { reserved, before } = JSON.parse(header);
      if (
        Number.isInteger(reserved) &&
        Number.isFinite(before) &&
        attempts.every((v) => v === "1")
      ) {
        return `监督中断，已停止。保留账本：预留 ${reserved}，提交动作 ${attempts.length}，before=${before}，after=null。`;
      }
    }
  }
  return "进程监督或原生探针失败，已关闭 Job；请核对本次预留。";
}

export function finish(run) {
  run()
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error) => {
      const message =
        error instanceof ProbeStop ? error.message : "输入、传输或响应格式异常，停止。";
      console.error(
        process.argv[2] === "--job-input" ? JSON.stringify({ probeStop: message }) : message,
      );
      process.exitCode = 2;
    });
}

export function sessionMain(main, entry) {
  if (process.argv[1] !== fileURLToPath(entry)) return;
  finish(async () => {
    const args = process.argv.slice(2);
    if (args.length === 1 && args[0] === "--job-input") {
      const packet = readFileSync(0, "utf8");
      const submitted = JSON.parse(Buffer.from(packet, "base64").toString("utf8"));
      if (submitted.length === 1 && submitted[0] === "job-cleanup-self-test") {
        // 合成后代本应再运行 15 秒。由 Job 回收，再由外层核查这个 PID 已消失。
        const fixture = spawn(process.execPath, ["-e", "setTimeout(() => {}, 15000)"], {
          env: cleanEnv(tmpdir()),
          stdio: "ignore",
          windowsHide: true,
        });
        fixture.unref();
        return { fixturePid: fixture.pid };
      }
      return main(submitted);
    }
    const jobTest = args.length === 2 && args[0] === "--offline" && args[1] === "job";
    const nativeFixture = args[0] === "--offline" && args[1] === "native-roster";
    if (args[0] !== "--live" && !jobTest && !nativeFixture) return main(args);
    requireThat(process.platform === "win32", "原生进程监督需要 Windows Job Object。");
    return withScratch((root, project) => {
      const env = cleanEnv(root, true);
      const shell = join(env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
      const supervisor = fileURLToPath(new URL("./job.ps1", import.meta.url));
      const packet = Buffer.from(
        JSON.stringify(jobTest ? ["job-cleanup-self-test"] : args),
      ).toString("base64");
      let result;
      try {
        result = command(
          shell,
          [
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-File",
            supervisor,
            process.execPath,
            fileURLToPath(entry),
          ],
          project,
          env,
          packet,
          120000,
        );
      } catch {
        throw new ProbeStop(supervisionFailure(args));
      }
      if (result.status !== 0) {
        // 仅转述我们的已知安全错误；PowerShell/本机可能附带路径或账户上下文。
        let reason;
        try {
          reason = JSON.parse(result.stderr).probeStop;
        } catch {}
        throw new ProbeStop(typeof reason === "string" ? reason : supervisionFailure(args));
      }
      const summary = JSON.parse(result.stdout);
      if (summary.resources) {
        const { idle, busy } = summary.resources;
        const pids = new Set([...idle.pids, ...busy.pids]);
        delete idle.pids;
        delete busy.pids;
        let survivors = 0;
        for (const pid of pids) {
          try {
            process.kill(pid, 0);
            survivors++;
          } catch (error) {
            if (error.code !== "ESRCH") throw error;
          }
        }
        summary.resources.observedPidsAfterExit = survivors;
        requireThat(survivors === 0, "全批暂停：本次采样的进程在 Job 关闭后仍存在。");
      }
      if (jobTest) {
        requireThat(
          Number.isSafeInteger(summary.fixturePid) && summary.fixturePid > 0,
          "合成后代未启动。",
        );
        try {
          process.kill(summary.fixturePid, 0);
        } catch (error) {
          if (error.code === "ESRCH")
            return { mode: "offline-job", windowsJobClosed: true, descendantReleased: true };
          throw error;
        }
        throw new ProbeStop("Windows Job 关闭后仍有合成后代存活。");
      }
      return { ...summary, windowsJobClosed: true };
    });
  });
}
