# glm-night-shift
GLM 夜班：把编码任务排进队列，错峰自动派给 Claude Code + GLM 执行、自动开 PR，并带网页看板和额度统计（由 Grok Bot 团队协作开发）

## 开发

- Node.js 22.13+（`node:sqlite` 从 22.13 起无需开关；Node 22 加载它会向 stderr 打一条 SQLite 的 ExperimentalWarning，Node 24 不会）；零依赖，跑测试：`npm test`（即 `node --test`）。
- 数据目录：环境变量 `NIGHT_SHIFT_HOME`，默认 `~/.glm-night-shift`。
- 测试一律通过 `test/helpers.js` 的 `fakeEnv()` 构造子进程环境，用仓库里的假替身 `test/fixtures/fake-claude.mjs`、`test/fixtures/fake-gh.mjs`，**绝不调用真实的 `claude` / `gh`，也不联网**。
  - 假 claude：`FAKE_CLAUDE_SCENARIO`（success/fail/hang/slow/noop）、`FAKE_CLAUDE_ARGS_LOG`、`FAKE_CLAUDE_DELAY_MS`。
  - 假 gh：`FAKE_GH_LOG`、`FAKE_GH_PR_NUMBER`、`FAKE_GH_FAIL`、`FAKE_GH_REPO`、`FAKE_GH_DEFAULT_BRANCH`。
- 注意：`node --test` 会把 `test/` 下所有 `.js`/`.mjs` 当测试文件执行（包括 `test/fixtures/*.mjs` 和 `test/helpers.js`），这些文件被无参数运行时必须零副作用。
