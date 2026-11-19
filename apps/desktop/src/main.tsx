import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { type ConnectionState, watchCore } from "./core-connection";
import "./styles.css";

const statusMessages = {
  starting: ["正在启动", "正在等候本机内核启动。"],
  restarting: ["正在重连", "内核连接已断开，正在恢复。"],
  unavailable: ["暂未连接", "暂时无法连接内核，系统会自动重试。"],
  browser: ["桌面应用未连接", "请从 Windows 打开派活，以连接本机内核。"],
} as const;

const memoryFormat = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 1 });

function App() {
  const [connection, setConnection] = useState<ConnectionState>({ phase: "starting" });
  useEffect(() => watchCore(setConnection), []);

  const info = connection.phase === "connected" ? connection.info : undefined;
  const [status, detail] =
    connection.phase === "connected"
      ? ["已连接", connection.recovered ? "内核已重启，连接已恢复。" : "内核正在本机运行。"]
      : statusMessages[connection.phase];

  const harnesses = info?.harnesses.map((harness) =>
    harness === "claude-code" ? "Claude Code" : "Codex",
  );

  return (
    <div className="workspace">
      <header className="app-heading">
        <div className="brand" aria-hidden="true">
          <span />
          <span />
        </div>
        <h1>派活</h1>
      </header>

      <main>
        <section className="core-panel" aria-labelledby="core-title">
          <div className="link-panel" data-phase={connection.phase}>
            <div className="link-graphic" aria-hidden="true">
              <span className="window-node" />
              <span className="link-track" />
              <span className="core-node" />
            </div>
            <div className="link-labels" aria-hidden="true">
              <span>桌面</span>
              <span>内核</span>
            </div>
          </div>
          <div className="core-summary">
            <h2 id="core-title">本机内核</h2>
            <div className="status" role="status" aria-atomic="true">
              <strong data-phase={connection.phase}>{status}</strong>
              <span className="status-detail">{detail}</span>
            </div>
            <dl className="version">
              <dt>内核版本</dt>
              <dd>{info?.version ?? "—"}</dd>
            </dl>
          </div>
        </section>

        <dl className="metrics">
          <div>
            <dt>内核内存</dt>
            <dd className="memory-value">
              {info ? `${memoryFormat.format(info.memoryBytes / 1024 ** 2)} MiB` : "—"}
            </dd>
          </div>
          <div>
            <dt>检测到的工具</dt>
            <dd>{harnesses ? harnesses.join("、") || "未检测到" : "—"}</dd>
          </div>
          <div className="data-directory">
            <dt>数据目录</dt>
            <dd>{info?.dataDir ?? "—"}</dd>
          </div>
        </dl>
      </main>

      <footer>关闭窗口后内核继续运行。完全退出请使用系统托盘菜单。</footer>
    </div>
  );
}

const root = document.getElementById("root");
if (root) createRoot(root).render(<App />);
