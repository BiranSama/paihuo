import { defineConfig } from "vite";

export default defineConfig({
  clearScreen: false,
  server: {
    host: "127.0.0.1",
    port: 1420,
    strictPort: true,
    watch: {
      // Rust 目录由 Tauri 监控，Vite 不打开编译期间仍被占用的 Windows 文件。
      ignored: ["**/src-tauri/**"],
    },
  },
});
