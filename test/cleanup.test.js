// cleanup 子命令（issue #40）的测试：已结束任务的 worktree 清理 + 过期日志清理。
// git 全部用本地 bare 仓库当远端（照 test/git.test.js 的 makeBareRemote /
// ensureRepoCache / createWorktree），不联网；cleanup 本体作为子进程跑 bin。
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeTempHome, fakeEnv } from './helpers.js';
import { openDb, SCHEMA_VERSION } from '../src/db.js';
import {
  cancelTask,
  claimNextTask,
  createTask,
  finishTask,
  getTask,
  startRun,
} from '../src/tasks.js';
import { createWorktree, ensureRepoCache } from '../src/git.js';

// 隔离 git 配置（node:test 每个文件独立进程）：不读机器的系统/全局配置；提交身份用
// 环境变量显式给。fakeEnv() 基于 process.env 复制，子进程里的 cleanup 也会带上。
process.env.GIT_CONFIG_NOSYSTEM = '1';
process.env.GIT_CONFIG_GLOBAL = path.join(os.tmpdir(), 'night-shift-cleanup-test-absent-global-config');
process.env.GIT_AUTHOR_NAME = '夜班测试';
process.env.GIT_AUTHOR_EMAIL = 'night-shift-test@example.com';
process.env.GIT_COMMITTER_NAME = '夜班测试';
process.env.GIT_COMMITTER_EMAIL = 'night-shift-test@example.com';

const DAY_MS = 86_400_000;
const binPath = fileURLToPath(new URL('../bin/night-shift.mjs', import.meta.url));

/** 同步跑 git（参数数组，无 shell），失败即断言失败并附 stderr。 */
function git(args, cwd) {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.ok(res.status === 0, `git ${args.join(' ')} 失败（cwd=${cwd}）：${res.stderr}`);
  return res.stdout;
}

/** 建一个本地 bare 仓库当远端（main 分支 + 一个提交），照 test/git.test.js。 */
function makeBareRemote(t) {
  const dir = makeTempHome(t);
  const bare = path.join(dir, 'a__b.git');
  git(['init', '--bare', '-q', '-b', 'main', bare]);
  const seed = path.join(dir, 'seed');
  git(['clone', '--quiet', bare, seed]);
  git(['symbolic-ref', 'HEAD', 'refs/heads/main'], seed);
  fs.writeFileSync(path.join(seed, 'README.md'), '# a/b\n');
  git(['add', '-A'], seed);
  git(['commit', '--quiet', '-m', 'init'], seed);
  git(['push', '--quiet', 'origin', 'HEAD:refs/heads/main'], seed);
  return { dir, bare };
}

/** remoteUrlTemplate 指向本地 bare 仓库目录的配置。 */
function configFor(bareDir) {
  return { remoteUrlTemplate: path.join(bareDir, '{owner}__{name}.git') };
}

/** 常用前置：bare 远端 + 数据目录 + 仓库缓存 + 打开的数据库连接（测试结束自动关）。 */
async function setupHome(t) {
  const remote = makeBareRemote(t);
  const home = makeTempHome(t);
  const config = configFor(remote.dir);
  await ensureRepoCache({ home, repo: 'a/b', config });
  const db = openDb(path.join(home, 'night-shift.db'));
  t.after(() => db.close());
  return { home, db, config };
}

function addTask(db, title) {
  return createTask(db, { repo: 'a/b', prompt: `提示词 ${title}`, title });
}

const wtPath = (home, id) => path.join(home, 'worktrees', `task-${id}`);

/** 建任务并配好 worktree，终态（succeeded / failed）、canceled、queued 或 running；返回任务。 */
async function makeTask({ db, home, config, status }) {
  const task = addTask(db, `${status} 任务`);
  if (status === 'canceled') {
    cancelTask(db, task.id); // queued → canceled
  } else if (status === 'queued' || status === 'running') {
    const claimed = claimNextTask(db);
    assert.ok(claimed !== null && claimed.id === task.id, '刚建的任务应被立刻领到');
  } else {
    const claimed = claimNextTask(db);
    assert.ok(claimed !== null && claimed.id === task.id, '刚建的任务应被立刻领到');
    finishTask(db, task.id, { status });
  }
  await createWorktree({ home, repo: 'a/b', task, baseBranch: 'main' });
  assert.ok(fs.existsSync(wtPath(home, task.id)), 'worktree 应建在 worktrees/task-<id>');
  return task;
}

/** 把文件 mtime/atime 设到 days 天前。 */
function ageFile(file, days) {
  const when = new Date(Date.now() - days * DAY_MS);
  fs.utimesSync(file, when, when);
}

/** 在 <home>/logs/<rel> 写一个文件并把 mtime 设到 days 天前（rel 可以在子目录里）。 */
function writeAgedFile(home, rel, days) {
  const file = path.join(home, 'logs', rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'log content\n');
  ageFile(file, days);
  return file;
}

/** 作为独立子进程跑 bin/night-shift.mjs（端到端），收集 stdout / stderr / 退出码。 */
function spawnCli(t, args, { home }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [binPath, ...args], {
      cwd: home,
      env: fakeEnv({ NIGHT_SHIFT_HOME: home, TZ: 'UTC' }),
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

// ---------------------------------------------------------------- 验收：worktree

test('验收：dry-run 只列 succeeded/failed 的路径；真删后只剩 running；再跑删除 0 个', async (t) => {
  const { home, db, config } = await setupHome(t);
  const ok = await makeTask({ db, home, config, status: 'succeeded' });
  const bad = await makeTask({ db, home, config, status: 'failed' });
  const running = await makeTask({ db, home, config, status: 'running' });
  const paths = [wtPath(home, ok.id), wtPath(home, bad.id), wtPath(home, running.id)];

  const dry = await spawnCli(t, ['cleanup', '--dry-run'], { home });
  assert.equal(dry.code, 0);
  assert.ok(dry.stdout.includes(paths[0]), 'dry-run 应列出 succeeded 的 worktree');
  assert.ok(dry.stdout.includes(paths[1]), 'dry-run 应列出 failed 的 worktree');
  assert.ok(!dry.stdout.includes(paths[2]), 'dry-run 不应列出 running 的 worktree');
  assert.ok(!dry.stdout.includes('删除'), 'dry-run 不打印摘要行');
  for (const p of paths) assert.ok(fs.existsSync(p), `dry-run 不应删目录：${p}`);

  const real = await spawnCli(t, ['cleanup'], { home });
  assert.equal(real.code, 0);
  assert.equal(real.stdout, 'worktree：删除 2 个\n日志：删除 0 个\n');
  assert.ok(!fs.existsSync(paths[0]) && !fs.existsSync(paths[1]), '终态任务的目录应被删');
  assert.ok(fs.existsSync(paths[2]), 'running 的目录必须留下');
  assert.equal(real.stderr, '');

  const again = await spawnCli(t, ['cleanup'], { home });
  assert.equal(again.code, 0);
  assert.equal(again.stdout, 'worktree：删除 0 个\n日志：删除 0 个\n');
});

test('canceled 的 worktree 会被删；queued 的目录不动，dry-run 也不列出', async (t) => {
  const { home, db, config } = await setupHome(t);
  const canceled = await makeTask({ db, home, config, status: 'canceled' });
  const queued = await makeTask({ db, home, config, status: 'queued' });

  const dry = await spawnCli(t, ['cleanup', '--dry-run'], { home });
  assert.equal(dry.code, 0);
  assert.ok(dry.stdout.includes(wtPath(home, canceled.id)));
  assert.ok(!dry.stdout.includes(wtPath(home, queued.id)));

  const real = await spawnCli(t, ['cleanup'], { home });
  assert.equal(real.code, 0);
  assert.equal(real.stdout, 'worktree：删除 1 个\n日志：删除 0 个\n');
  assert.ok(!fs.existsSync(wtPath(home, canceled.id)), 'canceled 的目录应被删');
  assert.ok(fs.existsSync(wtPath(home, queued.id)), 'queued 的目录必须留下');
});

// ---------------------------------------------------------------- 验收：日志

test('验收：默认只删 14 天前的日志；--logs-older-than 0 一个日志都不删', async (t) => {
  const { home, db, config } = await setupHome(t);
  const task = await makeTask({ db, home, config, status: 'succeeded' });
  const old = writeAgedFile(home, 'orphan-old.log', 15);
  const fresh = writeAgedFile(home, 'orphan-new.log', 1);

  const real = await spawnCli(t, ['cleanup'], { home });
  assert.equal(real.code, 0);
  assert.equal(real.stdout, 'worktree：删除 1 个\n日志：删除 1 个\n');
  assert.ok(!fs.existsSync(old), '15 天前的日志应被删');
  assert.ok(fs.existsSync(fresh), '1 天前的日志必须留下');
  assert.ok(!fs.existsSync(wtPath(home, task.id)));

  // 0 = 这次完全不处理日志：15 天前的日志也留下，worktree 照常处理
  fs.writeFileSync(old, 'log content\n');
  ageFile(old, 15);
  const zero = await spawnCli(t, ['cleanup', '--logs-older-than', '0'], { home });
  assert.equal(zero.code, 0);
  assert.equal(zero.stdout, 'worktree：删除 0 个\n日志：删除 0 个\n');
  assert.ok(fs.existsSync(old), '--logs-older-than 0 不删任何日志');

  const eqForm = await spawnCli(t, ['cleanup', '--logs-older-than=0'], { home });
  assert.equal(eqForm.code, 0, '--logs-older-than=0 的等号写法也应可用');
});

test('running 任务的旧日志、非 .log 文件、repos/ 缓存、数据库行都保留', async (t) => {
  const { home, db, config } = await setupHome(t);
  const running = await makeTask({ db, home, config, status: 'running' });
  const done = await makeTask({ db, home, config, status: 'succeeded' });

  // running 任务的日志：目录名规则 + runs.log_path 都指向它，15 天前也不删
  const activeLog = path.join(home, 'logs', `task-${running.id}`, 'run-1.log');
  fs.mkdirSync(path.dirname(activeLog), { recursive: true });
  fs.writeFileSync(activeLog, 'running log\n');
  ageFile(activeLog, 15);
  startRun(db, {
    taskId: running.id, attempt: 1, model: 'glm-5.3', effort: 'medium',
    peak: false, logPath: activeLog,
  });
  // 已结束任务的旧日志到龄就删
  const doneLog = writeAgedFile(home, `task-${done.id}/run-1.log`, 15);
  // 非 .log 文件不删
  const notes = writeAgedFile(home, 'notes.txt', 15);
  const taskCountBefore = db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n;

  const real = await spawnCli(t, ['cleanup'], { home });
  assert.equal(real.code, 0);
  assert.equal(real.stdout, 'worktree：删除 1 个\n日志：删除 1 个\n');
  assert.ok(fs.existsSync(activeLog), 'running 任务的日志必须留下');
  assert.ok(!fs.existsSync(doneLog), '已结束任务的旧日志应被删');
  assert.ok(fs.existsSync(notes), '非 .log 文件不删');
  assert.ok(!fs.existsSync(wtPath(home, done.id)), 'succeeded 的 worktree 应被删');
  assert.ok(fs.existsSync(wtPath(home, running.id)), 'running 的 worktree 必须留下');
  assert.ok(fs.existsSync(path.join(home, 'repos', 'a__b')), 'repos/ 缓存不删');

  // 任务行都还在，状态不变
  assert.equal(getTask(db, running.id).status, 'running');
  assert.equal(getTask(db, done.id).status, 'succeeded');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n, taskCountBefore);
});

// ---------------------------------------------------------------- --json

test('--json：stdout 是可解析的 JSON，路径以数据目录为前缀且与实际删除一一对应', async (t) => {
  const { home, db, config } = await setupHome(t);
  const ok = await makeTask({ db, home, config, status: 'succeeded' });
  const running = await makeTask({ db, home, config, status: 'running' });
  const old = writeAgedFile(home, 'orphan-old.log', 15);
  const realHome = fs.realpathSync(home);

  const dry = await spawnCli(t, ['cleanup', '--dry-run', '--json'], { home });
  assert.equal(dry.code, 0);
  const dryParsed = JSON.parse(dry.stdout);
  assert.deepEqual(Object.keys(dryParsed), ['worktrees', 'logs']);
  assert.deepEqual(dryParsed.worktrees, [fs.realpathSync(wtPath(home, ok.id))]);
  assert.deepEqual(dryParsed.logs, [fs.realpathSync(old)]);
  for (const p of [...dryParsed.worktrees, ...dryParsed.logs]) {
    assert.ok(p.startsWith(realHome + path.sep), `路径应以数据目录为前缀：${p}`);
  }
  // dry-run 不动磁盘
  assert.ok(fs.existsSync(wtPath(home, ok.id)));
  assert.ok(fs.existsSync(old));

  const real = await spawnCli(t, ['cleanup', '--json'], { home });
  assert.equal(real.code, 0);
  assert.deepEqual(JSON.parse(real.stdout), dryParsed, '非 dry-run 输出这次真正删掉的路径');
  assert.ok(!fs.existsSync(wtPath(home, ok.id)));
  assert.ok(!fs.existsSync(old));
  assert.ok(fs.existsSync(wtPath(home, running.id)));
});

// ---------------------------------------------------------------- 失败路径

test('git 删除失败：普通目录报错保留并退出 1，同一个 home 里其余 worktree 仍被删', async (t) => {
  const { home, db, config } = await setupHome(t);
  // 任务 1：已结束，但 worktrees/task-1 是个普通目录（不是 git worktree）→ git 会失败
  const plainTask = addTask(db, '普通目录任务');
  const claimed = claimNextTask(db);
  assert.equal(claimed.id, plainTask.id);
  finishTask(db, plainTask.id, { status: 'succeeded' });
  const plainDir = wtPath(home, plainTask.id);
  fs.mkdirSync(plainDir, { recursive: true });
  fs.writeFileSync(path.join(plainDir, 'not-a-worktree.txt'), 'x\n');
  // 任务 2：正常的 succeeded worktree，应照常删掉（证明失败后继续）
  const good = await makeTask({ db, home, config, status: 'succeeded' });

  const res = await spawnCli(t, ['cleanup'], { home });
  assert.equal(res.code, 1);
  assert.ok(res.stderr.includes('not a git repository'), `stderr 应含 git 的错误输出：${res.stderr}`);
  assert.ok(res.stderr.includes(plainDir), `stderr 应点名失败的路径：${res.stderr}`);
  assert.ok(fs.existsSync(plainDir), '失败的目录必须还在');
  assert.ok(fs.existsSync(path.join(plainDir, 'not-a-worktree.txt')));
  assert.ok(!fs.existsSync(wtPath(home, good.id)), '后续 worktree 仍应被删');
  assert.equal(res.stdout, 'worktree：删除 1 个\n日志：删除 0 个\n');
});

// ---------------------------------------------------------------- 用法错误与其他

test('用法错误：--logs-older-than 负数 / 非数字退出 2；--help 列出 cleanup', async (t) => {
  const { home } = await setupHome(t);
  for (const bad of [['-1'], ['foo'], ['1.5']]) {
    const res = await spawnCli(t, ['cleanup', '--logs-older-than', ...bad], { home });
    assert.equal(res.code, 2, `--logs-older-than ${bad[0]} 应是用法错误`);
    assert.equal(res.stdout, '');
    assert.ok(res.stderr.includes('--logs-older-than'));
  }
  const help = await spawnCli(t, ['--help'], { home });
  assert.equal(help.code, 0);
  assert.ok(help.stdout.includes('cleanup'), '--help 应列出 cleanup 命令');
});

test('cleanup 不写死也不改动数据库 user_version', async (t) => {
  const { home, db, config } = await setupHome(t);
  await makeTask({ db, home, config, status: 'succeeded' });
  const before = db.prepare('PRAGMA user_version').get().user_version;
  const res = await spawnCli(t, ['cleanup'], { home });
  assert.equal(res.code, 0);
  assert.equal(before, SCHEMA_VERSION, '新库的 user_version 应等于当前 schema 版本');
  assert.equal(
    db.prepare('PRAGMA user_version').get().user_version,
    SCHEMA_VERSION,
    'cleanup 不应改动 user_version',
  );
});
