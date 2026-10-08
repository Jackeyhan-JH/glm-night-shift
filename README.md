# glm-night-shift
GLM 夜班：把编码任务排进队列，错峰自动派给 Claude Code + GLM 执行、自动开 PR，并带网页看板和额度统计（由 Grok Bot 团队协作开发）

## 开发

- Node.js 22.13+（`node:sqlite` 从 22.13 起无需开关；Node 22 加载它会向 stderr 打一条 SQLite 的 ExperimentalWarning，Node 24 不会）；零依赖，跑测试：`npm test`（即 `node --test`）。
- 数据目录：环境变量 `NIGHT_SHIFT_HOME`，默认 `~/.glm-night-shift`。
- 测试一律通过 `test/helpers.js` 的 `fakeEnv()` 构造子进程环境，用仓库里的假替身 `test/fixtures/fake-claude.mjs`、`test/fixtures/fake-gh.mjs`、`test/fixtures/fake-systemctl.mjs`，**绝不调用真实的 `claude` / `gh` / `systemctl`，也不联网**。
  - 假 claude：`FAKE_CLAUDE_SCENARIO`（success/fail/hang/slow/noop）、`FAKE_CLAUDE_ARGS_LOG`、`FAKE_CLAUDE_DELAY_MS`。
  - 假 gh：`FAKE_GH_LOG`、`FAKE_GH_PR_NUMBER`、`FAKE_GH_FAIL`、`FAKE_GH_REPO`、`FAKE_GH_DEFAULT_BRANCH`、`FAKE_GH_EXISTING_PR_URL`、`FAKE_GH_BODY_COPY`。
  - 假 systemctl：`FAKE_SYSTEMCTL_LOG`、`FAKE_SYSTEMCTL_FAIL=1`（测试把 `NIGHT_SHIFT_SYSTEMCTL_BIN` 指到包着它的 shim；沙箱 PATH 上的 `systemctl` 是退出 99 的陷阱，忘覆盖也不会碰到真实 systemd）。
- 注意：`node --test` 会把 `test/` 下所有 `.js`/`.mjs` 当测试文件执行（包括 `test/fixtures/*.mjs` 和 `test/helpers.js`），这些文件被无参数运行时必须零副作用。

## 任务依赖

- `add … --depends-on 1,2` 让新任务依赖给定 id 的任务（逗号分隔、容忍空格，空串 = 无依赖）；`deps <id>` 查看依赖与各自状态，`deps <id> --set 1,2` 修改（只限排队中的任务），`--set ""` 清空。
- 依赖的任务全部 `succeeded` 前不会被领取（调度器的正常领取和「立刻跑」`runNow` 都一样：`runNow` 无视高峰、额度和退避，但不无视依赖）；依赖 `failed` 或被取消时，直接、间接依赖它的排队任务在同一事务里级联标为 `failed`（`last_error` 如 `依赖 #3 失败`）。
- 因级联失败的任务要先 `retry` 最上游、再逐级重试；重试上游不会自动恢复下游。
