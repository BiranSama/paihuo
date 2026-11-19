import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const version = "24.22.3";
const zip = `node-v${version}-win-x64`;
const archiveHash = "e612af99f626ab415ea225af6bce5c971feb448cb5cae250bb1c3fa50c5f7d9f";
const executableHash = "86fc4785327db5f5c7558dc6156c543b433c313e813a222e088086222ab4afa6";
const directory = fileURLToPath(new URL("../src-tauri/build/", import.meta.url));
const archive = join(directory, `${zip}.zip`);
const runtime = join(directory, "runtime");
const unpacked = join(directory, zip);

async function sha256(file) {
  try {
    return createHash("sha256")
      .update(await readFile(file))
      .digest("hex");
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
}

if (process.platform !== "win32" || process.arch !== "x64") {
  throw new Error("当前桌面构建需要 Windows x64 和 x64 Node.js。");
}

await mkdir(runtime, { recursive: true });
if ((await sha256(archive)) !== archiveHash) {
  const response = await fetch(`https://nodejs.org/download/release/v${version}/${zip}.zip`, {
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) throw new Error(`Node.js 运行时下载失败（HTTP ${response.status}）。`);

  const binary = Buffer.from(await response.arrayBuffer());
  if (createHash("sha256").update(binary).digest("hex") !== archiveHash) {
    throw new Error("Node.js 运行时压缩包校验失败。");
  }

  const temporaryArchive = `${archive}.${process.pid}.tmp`;
  await writeFile(temporaryArchive, binary);
  await rename(temporaryArchive, archive);
}

// 只解压固定路径，在构建目录中保留官方许可与可执行文件。
execFileSync("tar.exe", ["-xf", archive, "-C", directory, `${zip}/node.exe`, `${zip}/LICENSE`]);
const executable = join(unpacked, "node.exe");
if ((await sha256(executable)) !== executableHash) {
  throw new Error("Node.js 可执行文件校验失败。");
}
const installedExecutable = join(runtime, "node.exe");
if ((await sha256(installedExecutable)) !== executableHash) {
  await copyFile(executable, installedExecutable);
}
await copyFile(join(unpacked, "LICENSE"), join(runtime, "LICENSE-Node.js.txt"));
await copyFile(
  new URL("../../../packages/core/dist/core.cjs", import.meta.url),
  join(runtime, "core.cjs"),
);
await copyFile(
  new URL("../../../packages/core/node_modules/ws/LICENSE", import.meta.url),
  join(runtime, "LICENSE-ws.txt"),
);
await rm(executable);
await rm(join(unpacked, "LICENSE"));
