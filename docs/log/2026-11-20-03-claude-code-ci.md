# 固定包内 Markdown 的 Windows 检出行尾

- 日期：2026-11-20
- 谁：组长 / Codex
- 关联：T-003、[Windows CI](https://github.com/BiranSama/paihuo/actions/runs/44607652843)

Windows 全新检出把包内说明转成 CRLF，Biome 校验失败。本地初写文件使用 LF，先前检查未暴露差异。对 Biome 管辖的 `packages/**/*.md` 显式使用 LF，随后用相同工作流重验。
