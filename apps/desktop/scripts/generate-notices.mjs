import { execFileSync } from "node:child_process";
import { readdir, readFile, realpath, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const desktop = fileURLToPath(new URL("../", import.meta.url));
const tauri = join(desktop, "src-tauri");
const runtime = join(tauri, "build", "runtime");
const isLicense = /^(?:licen[cs]e|copying|copyright|notice)(?:[-_.].*)?$/i;

// 这些确切版本的 crates.io 源码包没有自带许可文本。
const fallbackLicenses = {
  "webview2-com@0.39.1": [
    "webview2-rs-MIT.txt",
    "https://github.com/wravery/webview2-rs/blob/edc2caf886175ccaebe86078c9cfe1ae2a187328/LICENSE",
  ],
  "webview2-com-sys@0.39.1": [
    "webview2-rs-MIT.txt",
    "https://github.com/wravery/webview2-rs/blob/edc2caf886175ccaebe86078c9cfe1ae2a187328/LICENSE",
  ],
  "webview2-com-macros@0.8.1": [
    "webview2-rs-MIT.txt",
    "https://github.com/wravery/webview2-rs/blob/dffa41a8a46d3f5565eefbff2de57d38d399f158/LICENSE",
  ],
  "selectors@0.38.0": ["MPL-2.0.txt", "https://www.mozilla.org/MPL/2.0/index.txt"],
  "alloc-stdlib@0.3.0": [
    "alloc-stdlib-BSD-3-Clause.txt",
    "https://github.com/dropbox/rust-alloc-no-stdlib/blob/0a81fd6928ea3b33c8cd484aa4575d50ffb98012/LICENSE",
  ],
};

async function readNotice({ name, version, license, licenseFile, directory, source }) {
  const label = `${name}@${version}`;
  const names = new Set(
    (await readdir(directory, { withFileTypes: true }))
      .filter((file) => file.isFile() && isLicense.test(file.name))
      .map((file) => file.name),
  );

  if (licenseFile) {
    const filename = relative(directory, resolve(directory, licenseFile));
    if (isAbsolute(filename) || filename.startsWith("..")) {
      throw new Error(`${label} 的许可证路径超出包目录`);
    }
    names.add(filename);
  }

  const text = [label, license ?? "See the accompanying license text.", `Source: ${source}`];
  if (names.size === 0) {
    const fallback = fallbackLicenses[label];
    if (!fallback) throw new Error(`找不到 ${label} 的许可证文本`);
    const [file, url] = fallback;
    text.push(
      `License text: ${url}`,
      await readFile(new URL(`./licenses/${file}`, import.meta.url), "utf8"),
    );
  }

  for (const filename of [...names].sort()) {
    text.push(`--- ${basename(filename)} ---`, await readFile(join(directory, filename), "utf8"));
  }
  return text.join("\n").trimEnd();
}

async function javascriptNotices() {
  const modules = join(desktop, "node_modules");
  const reactDom = await realpath(join(modules, "react-dom"));
  const requireReactDom = createRequire(join(reactDom, "package.json"));
  const directories = [
    join(modules, "react"),
    reactDom,
    dirname(requireReactDom.resolve("scheduler/package.json")),
    join(modules, "@tauri-apps", "api"),
    join(modules, "vite"), // 生产页面含 Vite 的 modulepreload polyfill。
  ];
  return Promise.all(
    directories.map(async (directory) => {
      const { name, version, license } = JSON.parse(
        await readFile(join(directory, "package.json"), "utf8"),
      );
      return readNotice({
        name,
        version,
        license,
        directory,
        source: `https://www.npmjs.com/package/${name}/v/${version}`,
      });
    }),
  );
}

async function rustNotices() {
  const metadata = JSON.parse(
    execFileSync(
      "cargo",
      [
        "metadata",
        "--locked",
        "--filter-platform",
        "x86_64-pc-windows-msvc",
        "--features",
        "custom-protocol",
        "--format-version",
        "1",
      ],
      { cwd: tauri, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
    ),
  );
  const { root, nodes } = metadata.resolve;
  const resolved = new Map(nodes.map((node) => [node.id, node]));
  const pending = [root];
  const visited = new Set();

  while (pending.length > 0) {
    const id = pending.pop();
    if (visited.has(id)) continue;
    visited.add(id);

    for (const dependency of resolved.get(id).deps) {
      if (dependency.dep_kinds.some(({ kind }) => kind === null)) {
        pending.push(dependency.pkg);
      }
    }
  }

  const production = metadata.packages
    .filter(({ id }) => id !== root && visited.has(id))
    .sort((a, b) => a.name.localeCompare(b.name, "en") || a.version.localeCompare(b.version, "en"));

  return Promise.all(
    production.map((pkg) => {
      if (pkg.source !== "registry+https://github.com/rust-lang/crates.io-index") {
        throw new Error(`请为 ${pkg.name}@${pkg.version} 指定实际公开源代码位置`);
      }
      return readNotice({
        name: pkg.name,
        version: pkg.version,
        license: pkg.license,
        licenseFile: pkg.license_file,
        directory: dirname(pkg.manifest_path),
        source: `https://static.crates.io/crates/${pkg.name}/${pkg.name}-${pkg.version}.crate`,
      });
    }),
  );
}

const [javascript, rust] = await Promise.all([javascriptNotices(), rustNotices()]);
const webview2 = await Promise.all(
  ["LICENSE", "NOTICE"].map(async (kind) => {
    const file = new URL(`./licenses/Microsoft-WebView2-${kind}.txt`, import.meta.url);
    return `--- ${kind}.txt ---\n${await readFile(file, "utf8")}`;
  }),
);
const notice = [
  "派活 · THIRD-PARTY NOTICES",
  "Node.js and ws license texts are installed in this directory as LICENSE-Node.js.txt and LICENSE-ws.txt.",
  `Embedded JavaScript dependencies (${javascript.length})`,
  ...javascript,
  `Windows x64 Rust production dependency graph (${rust.length})`,
  ...rust,
  "Microsoft.Web.WebView2@1.0.3800.47 · WebView2LoaderStatic.lib",
  "Source: https://www.nuget.org/packages/Microsoft.Web.WebView2/1.0.3800.47",
  ...webview2,
].join("\n\n============================================================\n\n");

await writeFile(join(runtime, "THIRD-PARTY-NOTICES.txt"), `${notice}\n`);
console.log(
  `第三方许可已生成（浏览器依赖 ${javascript.length} 项，Rust 依赖 ${rust.length} 项）。`,
);
