# CLAUDE.md（glm-night-shift）

给 Claude Code 的通用规则。每个任务的提示词只写「做什么」，这里的东西不用再重复。设计约定以 issue #1 为准，这里只列开发时每次都要守的。

## 技术约定
- 零依赖，ES 模块，Node >=22.13（机器默认 24）。只允许 import `node:` 内置模块和相对路径，`package.json` 不加 dependencies / devDependencies。
- 数据库用 `node:sqlite`：CLI 代码必须动态 `import()` 加载 `src/db.js` / `src/tasks.js`，不要静态 import（否则 Node 22 的 SQLite 警告会漏出来，见 `src/warnings.js`）。
- 迁移只能往 `MIGRATIONS` 末尾追加；测试断言 `user_version === MIGRATIONS.length`，不写字面数字。
- 时间存 UTC ISO 字符串，显示才转本地时区。

## 测试
- `npm test`，要在 Node 24 和 Node 22.13 各跑一遍：`PATH=/tmp/node-v22.13.0-linux-x64/bin:$PATH npm test`（Node 22.13 的路径按本机实际位置替换）。跑完 `git status` 必须干净。
- 每条验收标准对应一个测试，测试名以「验收:」开头，断言字面值。
- 测试里的 `claude`、`gh`、`systemctl` 一律用 `test/fixtures/` 里的假替身（`fake-claude.mjs`、`fake-gh.mjs`、`fake-systemctl.mjs`），环境用 `fakeEnv({...})`，临时目录用 `makeTempHome(t)`。不碰 `~/.glm-night-shift`，不联网（本机回环 HTTP 可以）。
- 绝不在测试里调用真实 claude / gh，不消耗 GLM 额度。需要隔离验证时用 `/workspace/glm-night-shift-work/sandbox-test.sh <目录> <命令>`，结果里 `trap_hits` 必须是 0。
- 新 CLI 测试放新文件，不往 `test/cli.test.js` 追加，减少并行冲突。
- 改了命令、配置键、文档里提到的行为，要同步 `README.md` 和 `docs/configuration.md`；`test/docs.test.js` 会检查（DEFAULT_CONFIG 每个键、help 里每个命令都要出现在文档里）。

## 禁止
- 不读也不打印 `~/.claude/settings.json`，不在日志、提交、PR 里出现任何 token / key；不改 `~/.claude` 全局配置。
- 不碰其他 worktree、其他团队的目录和脚本；不杀不是自己起的进程。
- 不 merge PR。只给 #1 或规格明确写了「开发可自己打 ready」的 issue 打 `ready`，其余不改标签。
- `gh issue view` 要加 `--json`（不加会因 Projects-classic 弃用报错）；`gh pr edit` 同理会失败，改标题/正文用 REST 或 MCP。

## 分支、提交、PR
- 分支从最新 `origin/main` 开：`feat/<n>-<简述>`、`fix/<n>-<简述>`、`docs/<简述>`。
- 提交信息用中文，`类型: 简述`（feat / fix / docs / test / refactor），PR 合并后会带 `(#PR号)`。
- 开 PR 时正文含 `Closes #<issue>`，附验收标准逐条对应的测试名；写明两个 Node 版本的测试数。
- 只 push 自己的分支，PR 交给验收，不自己合。

## 收尾自查
1. 先提交一次实现。
2. 再看一遍自己的 diff：边界、错误路径、有没有越出允许改动的文件范围、测试是不是真的在断言。有问题就修，再提交一次（自查 commit）。
3. 这是交互会话：失败、重试、验收退回都在本会话里继续，不要新开会话。
4. 最后输出文件清单、设计取舍、规格里含糊的地方；全部完成后按提示词要求单独输出一行完成标记。
