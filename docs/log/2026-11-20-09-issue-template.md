# 修正 GitHub 未列出缺陷模板的问题

- 日期：2026-11-20
- 谁：组长 / Codex
- 关联：[初始化 PR #1](https://github.com/BiranSama/paihuo/pull/1)

## 发现与改动

默认分支上三个文件齐全，实际网页已见老板和后续工作两个模板及预选标签。组长从 GitHub GraphQL 查询仓库的 `issueTemplates`，在 `18dca6a` 上收到两个结果，缺少 `bug.md`。原模板的名称“缺陷”仅两个字符。本次将名称改为“缺陷报告”，其正文、元信息中的用途及 `bug` 标签沿用原值。[修正前的服务端输出](https://github.com/BiranSama/paihuo/actions/runs/44610257803)

## 验收方法

修复合入默认分支后重跑同一只读查询。依次核对 `boss.md`、`bug.md`、`followup.md` 的名称、用途、正文和建议标签，并将 GitHub 返回的 PR 模板与默认分支的八栏正文比较。网页和服务端证据的来源分别记录在初始化 PR 内。
