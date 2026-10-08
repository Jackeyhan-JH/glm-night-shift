# glm-night-shift
GLM 夜班：把编码任务排进队列，错峰自动派给 Claude Code + GLM 执行、自动开 PR，并带网页看板和额度统计（由 Grok Bot 团队协作开发）

## 开发

- Node.js 22+，零依赖；跑测试：`npm test`（即 `node --test`）。
- 数据目录由 `NIGHT_SHIFT_HOME` 指定，默认 `~/.glm-night-shift`。
- 测试不碰真实的 `claude` / `gh`，也不联网：一律用 `test/fixtures/fake-claude.mjs`、`test/fixtures/fake-gh.mjs`（行为用 `FAKE_CLAUDE_*` / `FAKE_GH_*` 环境变量控制）。
