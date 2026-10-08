// issue #48（follow：按 PR 评审在原分支跟进）的验收测试：迁移升级、gitRef 校验、
// createWorktree 的 gitRef 路径、follow 命令、follow --all、假 gh 的 pr view，以及
// 「调度器跑完跟进任务后 PR 仍是原来那一个」的端到端。
// git 全部用本地 bare 仓库（照 test/git.test.js），gh / claude 一律指向 test/fixtures
// 里的假替身（fakeEnv），绝不联网、不碰真实 ~/.glm-night-shift。
// runCli 在 bin 之前 import：先装好 SQLite 警告过滤再（经 src/db.js）加载 node:sqlite。
import { runCli } from '../bin/night-shift.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDb, MIGRATIONS } from '../src/db.js';
import {
  ValidationError,
  claimTaskById,
  createTask,
  finishTask,
  getTask,
  listTasks,
} from '../src/tasks.js';
import { DEFAULT_CONFIG } from '../src/config.js';
import { branchName, createWorktree, ensureRepoCache, repoCacheDir } from '../src/git.js';
import { createScheduler } from '../src/scheduler.js';
import { fakeEnv, fixturePath, makeTempHome } from './helpers.js';

// 隔离 git 配置（见 test/git.test.js 的同类说明）：不读机器配置，提交身份显式给
process.env.GIT_CONFIG_NOSYSTEM = '1';
process.env.GIT_CONFIG_GLOBAL = path.join(os.tmpdir(), 'night-shift-follow-test-absent-global-config');
process.env.GIT_AUTHOR_NAME = '夜班测试';
process.env.GIT_AUTHOR_EMAIL = 'night-shift-test@example.com';
process.env.GIT_COMMITTER_NAME = '夜班测试';
process.env.GIT_COMMITTER_EMAIL = 'night-shift-test@example.com';

const FAKE_GH = fixturePath('fake-gh.mjs');
const FAKE_CLAUDE = fixturePath('fake-claude.mjs');

// ---------------------------------------------------------------- 辅助

/** 同步跑 git（参数数组，无 shell），失败即断言失败并附 stderr。 */
function git(args, cwd) {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.ok(res.status === 0, `git ${args.join(' ')} 失败（cwd=${cwd}）：${res.stderr}`);
  return res.stdout;
}

/**
 * 建一个本地 bare 仓库当远端（默认分支 main，含 README 提交）。
 * 返回 { dir, bare, seed, baseSha }；seed 是可继续推送的克隆。
 */
function makeBareRemote(t, { branch = 'main', repo = 'a/b' } = {}) {
  const dir = makeTempHome(t);
  const bare = path.join(dir, `${repo.replace('/', '__')}.git`);
  git(['init', '--bare', '-q', '-b', branch, bare]);
  const seed = path.join(dir, 'seed');
  git(['clone', '--quiet', bare, seed]);
  git(['symbolic-ref', 'HEAD', `refs/heads/${branch}`], seed);
  fs.writeFileSync(path.join(seed, 'README.md'), `# ${repo}\n`);
  git(['add', '-A'], seed);
  git(['commit', '--quiet', '-m', 'init'], seed);
  const baseSha = git(['rev-parse', 'HEAD'], seed).trim();
  git(['push', '--quiet', 'origin', `HEAD:refs/heads/${branch}`], seed);
  return { dir, bare, seed, baseSha };
}

/** remoteUrlTemplate 指向本地 bare 仓库目录的配置。 */
function configFor(bareDir) {
  return { remoteUrlTemplate: path.join(bareDir, '{owner}__{name}.git') };
}

/** 轮询等待 fn() 为真（默认 10 秒超时），到点仍未真则断言失败。 */
async function waitUntil(fn, { timeoutMs = 10_000, message = '条件在超时内未满足' } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await fn()) return;
    if (Date.now() >= deadline) assert.fail(message);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** 读 jsonl 文件（不存在返回空数组），每行一个 JSON。 */
function readJsonl(file) {
  try {
    return fs.readFileSync(file, 'utf8').trim().split('\n').filter((line) => line !== '')
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

/** 收集输出的可写 sink（runCli 的 stdout / stderr 参数）。 */
function sink() {
  const chunks = [];
  return {
    write(chunk) {
      chunks.push(String(chunk));
      return true;
    },
    text: () => chunks.join(''),
  };
}

/** 进程内跑一次 CLI；home 指向全新临时目录，env 走 fakeEnv（指向假 gh/claude）。 */
async function run(args, home, envOverrides = {}) {
  const stdout = sink();
  const stderr = sink();
  const code = await runCli(args, { stdout, stderr, env: fakeEnv({ NIGHT_SHIFT_HOME: home, ...envOverrides }) });
  return { code, stdout: stdout.text(), stderr: stderr.text() };
}

/** gh pr view 的标准 JSON 输出（fake gh 原样回吐）。 */
function prViewJson({ reviewDecision = 'CHANGES_REQUESTED', reviews = [], url = 'https://github.com/a/b/pull/9' } = {}) {
  return JSON.stringify({ reviewDecision, reviews, url, headRefName: 'night-shift/1-fix-login-bug' });
}

/**
 * 在库里造一个「已成功且开了 PR」的父任务：createTask → claimTaskById（queued →
 * running）→ finishTask(succeeded, prUrl, branch)。branch 缺省用 branchName(task)。
 */
function seedSucceeded(db, {
  repo = 'a/b', title = 'fix login bug', prUrl = 'https://github.com/a/b/pull/9',
  branch, withPrUrl = true, ...taskSpec
} = {}) {
  const created = createTask(db, { repo, prompt: '做点修改', title, ...taskSpec });
  claimTaskById(db, created.id);
  finishTask(db, created.id, {
    status: 'succeeded',
    ...(withPrUrl ? { prUrl } : {}),
    branch: branch ?? branchName(created),
  });
  return getTask(db, created.id);
}

// ---------------------------------------------------------------- 迁移

test('验收: 打开没有 git_ref 列的旧库，user_version 只加 1，旧任务还在、git_ref 为 null', (t) => {
  const file = path.join(makeTempHome(t), 'night-shift.db');
  // git_ref 不一定是最后一步（后合并的 issue 会顺延）。找出加上它的那一步，
  // 旧库只跑到它之前；版本号一律用步数算，不写死数字。
  const probe = new DatabaseSync(':memory:');
  let gitRefStep = -1;
  for (let i = 0; i < MIGRATIONS.length; i++) {
    const hadTasks = probe.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='tasks'").get();
    const before = hadTasks
      ? probe.prepare('PRAGMA table_info(tasks)').all().some((row) => row.name === 'git_ref')
      : false;
    MIGRATIONS[i](probe);
    const after = probe.prepare('PRAGMA table_info(tasks)').all().some((row) => row.name === 'git_ref');
    if (!before && after) gitRefStep = i;
  }
  probe.close();
  assert.ok(gitRefStep > 0, '应有一步迁移加上 git_ref 列');
  const old = new DatabaseSync(file);
  const previous = MIGRATIONS.slice(0, gitRefStep);
  for (const migration of previous) migration(old);
  old.exec(`PRAGMA user_version = ${previous.length}`);
  assert.equal(
    old.prepare('PRAGMA table_info(tasks)').all().some((row) => row.name === 'git_ref'),
    false,
    '升级前不应有 git_ref 列',
  );
  old.prepare(`
    INSERT INTO tasks (repo, title, prompt, max_attempts, created_at, updated_at)
    VALUES ('a/b', '旧标题', '旧提示词', 2, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
  `).run();
  old.close();

  const db = openDb(file);
  t.after(() => db.close());
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, previous.length + 1, '迁移后 = 迁移前 + 1');
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, MIGRATIONS.length);
  const row = db.prepare('SELECT title, git_ref FROM tasks WHERE id = 1').get();
  assert.equal(row.title, '旧标题', '旧任务还在');
  assert.equal(row.git_ref, null, '旧行 git_ref 为 null');
  assert.equal(getTask(db, 1).gitRef, null, '经任务对象读出 gitRef 也是 null');
});

// ---------------------------------------------------------------- gitRef 校验

test('验收: gitRef 校验：night-shift/1-fix 通过（含 trim）；main、空格、..、绝对路径、其他前缀拒绝', (t) => {
  const db = openDb(path.join(makeTempHome(t), 'night-shift.db'));
  t.after(() => db.close());
  const base = { repo: 'a/b', prompt: '做点修改' };
  assert.equal(createTask(db, base).gitRef, null, '不传 gitRef 时为 null');
  assert.equal(createTask(db, { ...base, gitRef: null }).gitRef, null, 'null 走普通路径');
  assert.equal(createTask(db, { ...base, gitRef: '  night-shift/1-fix  ' }).gitRef, 'night-shift/1-fix', '先 trim 再入库');
  assert.equal(createTask(db, { ...base, gitRef: 'night-shift/12-foo.bar' }).gitRef, 'night-shift/12-foo.bar');
  const bad = [
    'main', 'master', 'night-shift', 'night-shift/', // 不是 night-shift/<名字> 的形状
    'night-shift/1 fix', 'night-shift/1\tfix',       // 空格 / 制表符
    'night-shift/1..2', 'night-shift/../x',          // 子串 ..
    '/night-shift/1', '/abs/path',                   // 绝对路径
    'feature/x', 'bug/1',                            // 其他前缀
    'night-shift/1//2', 'night-shift/1/',            // 空路径段
    '', '   ',                                       // 空 / 纯空白
    42, {},                                          // 非字符串
  ];
  for (const value of bad) {
    assert.throws(
      () => createTask(db, { ...base, gitRef: value }),
      (err) => err instanceof ValidationError && err.field === 'gitRef',
      JSON.stringify(value),
    );
  }
});

test('验收: 不传 gitRef 的 createTask 与 gitRef null 的 createWorktree 与改前一致', async (t) => {
  const remote = makeBareRemote(t);
  const home = makeTempHome(t);
  await ensureRepoCache({ home, repo: 'a/b', config: configFor(remote.dir) });
  const task = { id: 12, title: 'Fix Login Bug!!', gitRef: null };
  const wt = await createWorktree({ home, repo: 'a/b', task, baseBranch: 'main' });
  // 与原有行为逐项一致：路径 / 分支名 / 基线分支 / 基线 sha（从 origin/main 检出）
  assert.equal(wt.path, path.join(home, 'worktrees', 'task-12'));
  assert.equal(wt.branch, 'night-shift/12-fix-login-bug');
  assert.equal(wt.branch, branchName(task));
  assert.equal(wt.baseBranch, 'main');
  assert.equal(wt.baseSha, remote.baseSha);
  assert.equal(git(['rev-parse', 'HEAD'], wt.path).trim(), remote.baseSha);
});

// ---------------------------------------------------------------- createWorktree 的 gitRef 路径

test('验收: gitRef 指向的分支有一个 main 上没有的提交，检出后提交还在、HEAD 不是 main、branch 是 gitRef', async (t) => {
  const remote = makeBareRemote(t);
  // seed 里给 night-shift/1-fix 加一个 main 上没有的提交
  fs.writeFileSync(path.join(remote.seed, 'follow.txt'), '跟进改动\n');
  git(['add', '-A'], remote.seed);
  git(['commit', '--quiet', '-m', 'follow change'], remote.seed);
  git(['push', '--quiet', 'origin', 'HEAD:refs/heads/night-shift/1-fix'], remote.seed);
  const tip = git(['rev-parse', 'HEAD'], remote.seed).trim();

  const home = makeTempHome(t);
  await ensureRepoCache({ home, repo: 'a/b', config: configFor(remote.dir) });
  const wt = await createWorktree({
    home,
    repo: 'a/b',
    task: { id: 5, title: '跟进', gitRef: 'night-shift/1-fix' },
    baseBranch: 'main',
  });
  assert.equal(wt.branch, 'night-shift/1-fix', '返回的 branch 是 gitRef 本身');
  assert.equal(wt.baseBranch, 'main', 'baseBranch 仍是调用方传入的默认分支');
  assert.equal(wt.baseSha, tip, 'baseSha 是检出后的 HEAD（该远程分支的尖端）');
  assert.equal(git(['rev-parse', 'HEAD'], wt.path).trim(), tip, 'HEAD 对齐远程分支尖端');
  assert.notEqual(git(['rev-parse', 'HEAD'], wt.path).trim(), remote.baseSha, 'HEAD 不是 main');
  assert.equal(git(['rev-parse', '--abbrev-ref', 'HEAD'], wt.path).trim(), 'night-shift/1-fix');
  assert.ok(fs.existsSync(path.join(wt.path, 'follow.txt')), '该分支上、main 上没有的提交内容还在');
});

test('验收: origin/<gitRef> 不存在时 createWorktree 抛错（信息含分支名原文），默认分支上没有新分支', async (t) => {
  const remote = makeBareRemote(t);
  const home = makeTempHome(t);
  await ensureRepoCache({ home, repo: 'a/b', config: configFor(remote.dir) });
  const cache = repoCacheDir(home, 'a/b');
  const refsBefore = git(['for-each-ref', '--format=%(refname)', 'refs/heads/'], cache).trim();
  await assert.rejects(
    () => createWorktree({
      home,
      repo: 'a/b',
      task: { id: 5, title: 'x', gitRef: 'night-shift/nope' },
      baseBranch: 'main',
    }),
    (err) => err instanceof Error && err.message.includes('night-shift/nope'),
  );
  assert.equal(
    git(['for-each-ref', '--format=%(refname)', 'refs/heads/'], cache).trim(),
    refsBefore,
    'worktree add 没被拿去建别的分支：本地分支一个没多',
  );
  assert.equal(fs.existsSync(path.join(home, 'worktrees', 'task-5')), false, '也没有留下 worktree 目录');
});

// ---------------------------------------------------------------- follow <id>

test('验收: 父任务成功且 PR 结论是 CHANGES_REQUESTED：follow 入队一条（gitRef=父分支、source 含最大评审 id、字段照抄），再跑一次不产生第二条', async (t) => {
  const home = makeTempHome(t);
  const db = openDb(path.join(home, 'night-shift.db'));
  const parent = seedSucceeded(db, {
    difficulty: 'hard', priority: 5, testCommand: 'npm test', allowPeak: true, maxAttempts: 3,
  });
  db.close();
  const reviews = [
    { id: 11, state: 'APPROVED', body: '先赞一个' },
    { id: 99, state: 'CHANGES_REQUESTED', body: '请把变量名改清楚' },
  ];
  const res = await run(['follow', String(parent.id)], home, {
    FAKE_GH_PR_VIEW_JSON: prViewJson({ reviews }),
  });
  assert.equal(res.code, 0, res.stderr);
  assert.equal(res.stderr, '');
  assert.equal(res.stdout, `已入队 #2，在分支 ${parent.branch} 上改\n`);

  const db2 = openDb(path.join(home, 'night-shift.db'));
  t.after(() => db2.close());
  const follow = getTask(db2, 2);
  assert.equal(follow.repo, 'a/b');
  assert.equal(follow.gitRef, parent.branch, 'gitRef 等于父任务的 branch');
  assert.equal(follow.source, 'pr-review:a/b#9:99', '评审 id 取 CHANGES_REQUESTED 里 id 最大（数值比较）的那条');
  assert.equal(follow.title, '跟进 #1：fix login bug');
  assert.ok(follow.prompt.includes('请把变量名改清楚'), follow.prompt);
  assert.ok(follow.prompt.includes(`只在当前分支 ${parent.branch} 上提交并推送，不要开新分支，不要开新的 PR。`), follow.prompt);
  assert.equal(follow.difficulty, 'hard');
  assert.equal(follow.priority, 5);
  assert.equal(follow.testCommand, 'npm test');
  assert.equal(follow.allowPeak, true);
  assert.equal(follow.maxAttempts, DEFAULT_CONFIG.maxAttempts, 'maxAttempts 用默认值，不照抄父任务');
  assert.deepEqual(follow.dependsOn, [], 'dependsOn 为空，不依赖父任务');
  assert.equal(follow.status, 'queued');

  const again = await run(['follow', String(parent.id)], home, {
    FAKE_GH_PR_VIEW_JSON: prViewJson({ reviews }),
  });
  assert.equal(again.code, 0, again.stderr);
  assert.ok(again.stdout.includes(`已经入队 #2（queued）`), again.stdout);
  assert.equal(listTasks(db2, { limit: 1000 }).length, 2, '再执行一次不产生第二条');
});

test('评审 id 取数值最大且用它的正文：id 30 而不是 20', async (t) => {
  const home = makeTempHome(t);
  const db = openDb(path.join(home, 'night-shift.db'));
  const parent = seedSucceeded(db);
  db.close();
  const reviews = [
    { id: 20, state: 'CHANGES_REQUESTED', body: '更早的要求' },
    { id: 30, state: 'CHANGES_REQUESTED', body: '最新的要求' },
  ];
  const res = await run(['follow', String(parent.id)], home, { FAKE_GH_PR_VIEW_JSON: prViewJson({ reviews }) });
  assert.equal(res.code, 0, res.stderr);
  const db2 = openDb(path.join(home, 'night-shift.db'));
  t.after(() => db2.close());
  const follow = getTask(db2, 2);
  assert.equal(follow.source, 'pr-review:a/b#9:30');
  assert.ok(follow.prompt.includes('最新的要求'));
  assert.equal(follow.prompt.includes('更早的要求'), false);
});

test('reviews 为空但结论已是 CHANGES_REQUESTED：source 用字面量 decision，说明只有那一句', async (t) => {
  const home = makeTempHome(t);
  const db = openDb(path.join(home, 'night-shift.db'));
  const parent = seedSucceeded(db);
  db.close();
  const res = await run(['follow', String(parent.id)], home, {
    FAKE_GH_PR_VIEW_JSON: prViewJson({ reviews: [] }),
  });
  assert.equal(res.code, 0, res.stderr);
  const db2 = openDb(path.join(home, 'night-shift.db'));
  t.after(() => db2.close());
  const follow = getTask(db2, 2);
  assert.equal(follow.source, 'pr-review:a/b#9:decision');
  assert.equal(follow.prompt, `只在当前分支 ${parent.branch} 上提交并推送，不要开新分支，不要开新的 PR。`);
});

test('评审正文按码点截到 8000，标题截到 80', async (t) => {
  const home = makeTempHome(t);
  const db = openDb(path.join(home, 'night-shift.db'));
  const parent = seedSucceeded(db, { title: '标'.repeat(100) });
  db.close();
  const body = '改'.repeat(9000);
  const res = await run(['follow', String(parent.id)], home, {
    FAKE_GH_PR_VIEW_JSON: prViewJson({ reviews: [{ id: 1, state: 'CHANGES_REQUESTED', body }] }),
  });
  assert.equal(res.code, 0, res.stderr);
  const db2 = openDb(path.join(home, 'night-shift.db'));
  t.after(() => db2.close());
  const follow = getTask(db2, 2);
  assert.equal([...follow.title].length, 80, '标题按 Unicode 码点截到 80');
  assert.ok(follow.title.startsWith('跟进 #1：'));
  // 说明 = 正文前 8000 个码点 + 换行 + 固定一句
  const tailLine = `只在当前分支 ${parent.branch} 上提交并推送，不要开新分支，不要开新的 PR。`;
  assert.equal([...follow.prompt].length, 8000 + 1 + [...tailLine].length);
});

test('验收: reviewDecision 不是 CHANGES_REQUESTED：退出 0、输出「没有待处理的修改请求」、任务数不变', async (t) => {
  const home = makeTempHome(t);
  const db = openDb(path.join(home, 'night-shift.db'));
  const parent = seedSucceeded(db);
  db.close();
  const cases = [
    prViewJson({ reviewDecision: 'APPROVED', reviews: [{ id: 9, state: 'APPROVED', body: '好' }] }),
    prViewJson({ reviewDecision: 'COMMENTED', reviews: [] }),
    JSON.stringify({ reviews: [], url: 'https://github.com/a/b/pull/9', headRefName: 'x' }), // 缺 reviewDecision
  ];
  for (const payload of cases) {
    const res = await run(['follow', String(parent.id)], home, { FAKE_GH_PR_VIEW_JSON: payload });
    assert.equal(res.code, 0, payload);
    assert.equal(res.stderr, '', payload);
    assert.ok(res.stdout.includes('没有待处理的修改请求'), payload);
  }
  const db2 = openDb(path.join(home, 'night-shift.db'));
  t.after(() => db2.close());
  assert.equal(listTasks(db2, { limit: 1000 }).length, 1, '一个跟进任务都没建');
});

test('follow <id> 的拒绝路径：任务不存在 / 状态不是 succeeded / 没有 prUrl / 分支不是 night-shift/ → 退出 1 不建任务', async (t) => {
  const home = makeTempHome(t);
  const db = openDb(path.join(home, 'night-shift.db'));
  t.after(() => db.close());
  const missing = await run(['follow', '99'], home, {});
  assert.equal(missing.code, 1);
  assert.ok(missing.stderr.includes('不存在'), missing.stderr);

  const queued = createTask(db, { repo: 'a/b', prompt: '还在排队' });
  const notSucceeded = await run(['follow', String(queued.id)], home, {});
  assert.equal(notSucceeded.code, 1);
  assert.ok(notSucceeded.stderr.includes('queued'), notSucceeded.stderr);

  const noPr = seedSucceeded(db, { withPrUrl: false, title: 'no pr' });
  const noPrRes = await run(['follow', String(noPr.id)], home, {});
  assert.equal(noPrRes.code, 1);
  assert.ok(noPrRes.stderr.includes('prUrl'), noPrRes.stderr);

  const weirdBranch = seedSucceeded(db, { title: 'weird branch', branch: 'feature/x' });
  const weirdRes = await run(['follow', String(weirdBranch.id)], home, {});
  assert.equal(weirdRes.code, 1);
  assert.ok(weirdRes.stderr.includes('feature/x'), weirdRes.stderr);
  assert.ok(weirdRes.stderr.includes('night-shift'), weirdRes.stderr);
  assert.equal(listTasks(db, { limit: 1000 }).length, 3, '拒绝路径一个任务都不建');
});

test('gh 失败 / 输出不是 JSON：退出 1 不建任务', async (t) => {
  const home = makeTempHome(t);
  const db = openDb(path.join(home, 'night-shift.db'));
  const parent = seedSucceeded(db);
  db.close();
  const failed = await run(['follow', String(parent.id)], home, { FAKE_GH_PR_VIEW_FAIL: '1' });
  assert.equal(failed.code, 1);
  assert.ok(failed.stderr.includes('gh pr view 失败'), failed.stderr);

  const notJson = await run(['follow', String(parent.id)], home, { FAKE_GH_PR_VIEW_JSON: '不是 JSON' });
  assert.equal(notJson.code, 1);
  assert.ok(notJson.stderr.includes('不是合法 JSON'), notJson.stderr);

  const db2 = openDb(path.join(home, 'night-shift.db'));
  t.after(() => db2.close());
  assert.equal(listTasks(db2, { limit: 1000 }).length, 1, '不建任务');
});

test('用法错误：缺 id、id 与 --all 同时给、--json 没有 --all、id 非正整数 → 退出 2 带本命令用法', async (t) => {
  const home = makeTempHome(t);
  const cases = [
    { args: ['follow'], needle: '缺少必填参数' },
    { args: ['follow', '--all', '3'], needle: '--all' },
    { args: ['follow', '--json'], needle: '--json' },
    { args: ['follow', '3', '--json'], needle: '--json' },
    { args: ['follow', 'abc'], needle: '正整数' },
    { args: ['follow', '0'], needle: '正整数' },
    { args: ['follow', '1', '2'], needle: '参数过多' },
  ];
  for (const { args, needle } of cases) {
    const res = await run(args, home, {});
    assert.equal(res.code, 2, JSON.stringify(args));
    assert.equal(res.stdout, '', JSON.stringify(args));
    assert.ok(res.stderr.includes(needle), `${JSON.stringify(args)} 应提到 ${needle}：${res.stderr}`);
    assert.ok(res.stderr.includes('用法：night-shift follow'), res.stderr);
  }
});

// ---------------------------------------------------------------- follow --all

test('验收: follow --all：已入队的跳过、新的入队、--json 可解析；有 gh 失败时退出 1 且已入队的保留', async (t) => {
  const home = makeTempHome(t);
  const db = openDb(path.join(home, 'night-shift.db'));
  const a = seedSucceeded(db, { title: 'a', prUrl: 'https://github.com/a/b/pull/9' });
  const b = seedSucceeded(db, { title: 'b', prUrl: 'https://github.com/a/b/pull/12' });
  db.close();

  // 先单条 follow A（会建一条跟进任务，source = pr-review:a/b#9:99）
  const requested = prViewJson({ reviews: [{ id: 99, state: 'CHANGES_REQUESTED', body: '改' }] });
  const single = await run(['follow', String(a.id)], home, { FAKE_GH_PR_VIEW_JSON: requested });
  assert.equal(single.code, 0, single.stderr);

  // --all：A 的 source 已被占用（skipped 已经入队），B 是 CHANGES_REQUESTED → created；
  // 两条 prUrl 不同，source 不同，互不干扰。
  const all = await run(['follow', '--all', '--json'], home, { FAKE_GH_PR_VIEW_JSON: requested });
  assert.equal(all.code, 0, all.stderr);
  const parsed = JSON.parse(all.stdout);
  assert.equal(parsed.created.length, 1);
  assert.equal(parsed.created[0].parentId, b.id);
  assert.equal(parsed.created[0].branch, b.branch);
  assert.equal(parsed.created[0].source, 'pr-review:a/b#12:99');
  assert.ok(Number.isInteger(parsed.created[0].id));
  assert.equal(parsed.skipped.length, 1);
  assert.equal(parsed.skipped[0].parentId, a.id);
  assert.ok(parsed.skipped[0].message.includes(`已经入队 #3（queued）`), JSON.stringify(parsed.skipped));
  assert.deepEqual(parsed.failed, []);

  // gh 全部失败（FAKE_GH_PR_VIEW_FAIL 只能全局设）：退出 1，已入队的两条仍在库里排队
  const failing = await run(['follow', '--all'], home, { FAKE_GH_PR_VIEW_FAIL: '1' });
  assert.equal(failing.code, 1);
  assert.ok(failing.stdout.includes('失败'), failing.stdout);

  const db2 = openDb(path.join(home, 'night-shift.db'));
  t.after(() => db2.close());
  const tasks = listTasks(db2, { limit: 1000 });
  assert.equal(tasks.length, 4, 'A、B 各一条 + 两条跟进任务');
  const followTasks = tasks.filter((task) => task.gitRef !== null);
  assert.equal(followTasks.length, 2, '之前已入队的跟进任务仍保留');
  for (const task of followTasks) {
    assert.equal(task.status, 'queued');
    assert.ok(task.gitRef.startsWith('night-shift/'));
  }
});

// ---------------------------------------------------------------- 端到端：调度器跑跟进任务

test('验收: 用假 claude 把跟进任务跑完：pr create 只有父任务那一次，跟进任务的 prUrl 与父任务相同，开放 PR 仍是 1 个', async (t) => {
  const remote = makeBareRemote(t);
  const home = makeTempHome(t);
  const db = openDb(path.join(home, 'night-shift.db'));
  const config = {
    ...DEFAULT_CONFIG,
    remoteUrlTemplate: path.join(remote.dir, '{owner}__{name}.git'),
    ghBin: FAKE_GH,
    claudeBin: FAKE_CLAUDE,
    gitAuthorName: '夜班跟进测试',
    gitAuthorEmail: 'follow-test@example.com',
  };
  const ghLog = path.join(home, 'gh-log.jsonl');
  const env = fakeEnv({
    FAKE_GH_LOG: ghLog,
    FAKE_GH_PR_NUMBER: '9',
    FAKE_CLAUDE_ARGS_LOG: path.join(home, 'claude.jsonl'),
  });
  let now = new Date('2026-10-10T07:00:00Z'); // 周六非高峰
  const scheduler = createScheduler({ db, config, home, clock: () => now, cancelPollMs: 50, env });
  // done 事件在 worktree 清理、并发名额释放**之后**才发：等它而不是等库里的状态，
  // 下一轮 tick 才一定领得到跟进任务，t.after 关库也不会撞上还在收尾的流水线。
  const doneEvents = [];
  scheduler.events.on('done', (payload) => doneEvents.push(payload));
  t.after(() => {
    scheduler.stop();
    db.close();
  });

  // 父任务全流程跑完：开了 PR（fake gh 的 pr create → pull/9）
  const parent = createTask(db, {
    repo: 'a/b', prompt: '做点修改', title: 'fix login bug', testCommand: 'test -f NIGHT_SHIFT_FAKE.md',
  });
  assert.deepEqual(await scheduler.tick(), [parent.id]);
  await waitUntil(
    () => doneEvents.some((payload) => payload.taskId === parent.id && payload.status === 'succeeded'),
    { message: '父任务应成功' },
  );
  const parentRow = getTask(db, parent.id);
  assert.equal(parentRow.prUrl, 'https://github.com/a/b/pull/9');
  const prCreateCount = () => readJsonl(ghLog).filter((argv) => argv.includes('pr') && argv.includes('create')).length;
  assert.equal(prCreateCount(), 1, '父任务开了一次 PR');

  // follow 入队跟进任务（gh pr view 走本命令自己的环境变量）
  const followRun = await run(['follow', String(parent.id)], home, {
    FAKE_GH_PR_VIEW_JSON: prViewJson({ reviews: [{ id: 7, state: 'CHANGES_REQUESTED', body: '再改改' }] }) },
  );
  assert.equal(followRun.code, 0, followRun.stderr);
  const followRow = getTask(db, parent.id + 1);
  assert.equal(followRow.gitRef, parentRow.branch, '跟进任务回父任务的分支');

  // 之后 gh 报告该分支已有开放 PR（FAKE_GH_EXISTING_PR_URL）：createPr 复用，不再 create。
  // 调度器闭包里持有这同一个 env 对象，改它即可影响后续 gh 子进程调用。
  env.FAKE_GH_EXISTING_PR_URL = parentRow.prUrl;
  assert.deepEqual(await scheduler.tick(), [followRow.id]);
  await waitUntil(
    () => doneEvents.some((payload) => payload.taskId === followRow.id && payload.status === 'succeeded'),
    { message: '跟进任务应成功' },
  );
  const followFinal = getTask(db, followRow.id);
  assert.equal(followFinal.prUrl, parentRow.prUrl, '跟进任务的 prUrl 与父任务相同');
  assert.equal(followFinal.branch, parentRow.branch, '跟进任务推回了原分支');
  assert.equal(prCreateCount(), 1, 'FAKE_GH_LOG 里 pr create 只有父任务那一次');

  // 开放 PR 语义上仍是 1 个：bare 仓库里只有一个 night-shift 分支，且含跟进的新提交
  const branches = git(['for-each-ref', '--format=%(refname:short)', 'refs/heads/night-shift/'], remote.bare)
    .trim().split('\n').filter((name) => name !== '');
  assert.deepEqual(branches, [parentRow.branch]);
  const blob = git(['show', `${parentRow.branch}:NIGHT_SHIFT_FAKE.md`], remote.bare);
  assert.ok(blob.includes('做点修改'), '父任务的提交还在');
  assert.ok(blob.includes('再改改'), '跟进任务在原分支上追加了提交');
});

// ---------------------------------------------------------------- 假 gh 的 pr view

test('验收: 未设 FAKE_GH_PR_VIEW_* 时 pr view 仍是静默成功；设置后输出 JSON / 文件 / 失败', (t) => {
  const viewArgs = ['pr', 'view', '1', '--repo', 'a/b', '--json', 'reviewDecision,reviews,url,headRefName'];
  const runFakeGh = (envOverrides = {}) => {
    const res = spawnSync(process.execPath, [FAKE_GH, ...viewArgs], {
      cwd: makeTempHome(t),
      env: fakeEnv(envOverrides),
      encoding: 'utf8',
    });
    assert.ok(!res.error, `假 gh 启动失败：${res.error}`);
    return { code: res.status, stdout: res.stdout, stderr: res.stderr };
  };

  const silent = runFakeGh();
  assert.equal(silent.code, 0, '与改前的静默成功一致');
  assert.equal(silent.stdout, '');
  assert.equal(silent.stderr, '');

  const payload = '{"reviewDecision":"CHANGES_REQUESTED","reviews":[]}';
  const withJson = runFakeGh({ FAKE_GH_PR_VIEW_JSON: payload });
  assert.equal(withJson.code, 0);
  assert.equal(withJson.stdout, `${payload}\n`, 'JSON 字符串 + 一个换行');
  assert.deepEqual(JSON.parse(withJson.stdout), { reviewDecision: 'CHANGES_REQUESTED', reviews: [] });

  const box = makeTempHome(t);
  const file = path.join(box, 'pr-view.json');
  fs.writeFileSync(file, payload); // 故意不带换行
  const withFile = runFakeGh({ FAKE_GH_PR_VIEW_FILE: file });
  assert.equal(withFile.code, 0);
  assert.equal(withFile.stdout, payload, '文件内容原样输出，不补换行');

  const fail = runFakeGh({ FAKE_GH_PR_VIEW_FAIL: '1' });
  assert.notEqual(fail.code, 0);
  assert.equal(fail.stdout, '');
  assert.ok(fail.stderr.trim() !== '');

  const failWins = runFakeGh({ FAKE_GH_PR_VIEW_FAIL: '1', FAKE_GH_PR_VIEW_JSON: payload, FAKE_GH_PR_VIEW_FILE: file });
  assert.notEqual(failWins.code, 0, 'FAIL 优先于 JSON / FILE');
  assert.equal(failWins.stdout, '');
});

// ---------------------------------------------------------------- 帮助与文档

test('验收: night-shift --help / help 的 stdout 含 follow；follow --help 打印自己的用法', async (t) => {
  const home = makeTempHome(t);
  for (const args of [['--help'], ['help']]) {
    const res = await run(args, home);
    assert.equal(res.code, 0, JSON.stringify(args));
    assert.ok(res.stdout.includes('follow'), JSON.stringify(args));
    assert.ok(res.stdout.includes('night-shift follow'), JSON.stringify(args));
  }
  const own = await run(['follow', '--help'], home);
  assert.equal(own.code, 0);
  assert.ok(own.stdout.startsWith('用法：night-shift follow'));
});
