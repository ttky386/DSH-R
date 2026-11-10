# 出处与许可

- 上游：vercel-labs/agent-browser（`skills/electron/SKILL.md`），Copyright 2025 Vercel Inc.，Apache-2.0。
- 本副本取自 zai-org/ZCode 的 `.agents/skills/electron`（commit `3c5b227649371507ddc4eb46ac5133afe6db1cab`，Apache-2.0）；ZCode 侧对内容做过本地集成、格式与适配调整。
- DSH-X 原样收录，未再修改；许可全文见同目录 `LICENSE-APACHE-2.0.txt`。
- 依赖 `agent-browser` CLI，并用 Chrome DevTools Protocol 连接 Electron 应用；启动时需带 `--remote-debugging-port`。
