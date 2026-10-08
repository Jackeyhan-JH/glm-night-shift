// issue #47（oneTaskPerRepo：同一仓库同时最多跑一个任务）的验收测试。
// 真调度器 + test/fixtures/fake-claude.mjs + 真 src/git.js + 本地 bare 仓库 +
// test/fixtures/fake-gh.mjs，绝不联网；setup 模式取自 test/scheduler-integration.test.js，
// 差别是支持多仓库（每个 repo 一个 bare 远端）。存储层（claimNextTask 的开关本身）
// 也在本文件里用内存库直接测；不往 test/tasks.test.js / scheduler-integration.test.js 追加。
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../src/db.js';
import { createTask, getTask, claimNextTask, finishTask, ValidationError } from '../src/tasks.js';
import { DEFAULT_CONFIG } from '../src/config.js';
import { createScheduler } from '../src/scheduler.js';
import { fakeEnv, makeTempHome, fixturePath } from './helpers.js';

// 隔离 git 配置（见 test/git.test.js 的同类说明）：不读机器配置，提交身份显式给
process.env.GIT_CONFIG_NOSYSTEM = '1';
process.env.GIT_CONFIG_GLOBAL = path.join(os.tmpdir(), 'night-shift-one-per-repo-test-absent-global-config');
process.env.GIT_AUTHOR_NAME = '夜班测试';
process.env.GIT_AUTHOR_EMAIL = 'night-shift-test@example.com';
process.env.GIT_COMMITTER_NAME = '夜班测试';
process.env.GIT_COMMITTER_EMAIL = 'night-shift-test@example.com';

const FAKE_CLAUDE = fixturePath('fake-claude.mjs');
const FAKE_GH = fixturePath('fake-gh.mjs');
const root = fileURLToPath(new URL('..', import.meta.url));

/** 同步跑 git（参数数组，无 shell），失败即断言失败并附 stderr。 */
function git(args, cwd) {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.ok(res.status === 0, `git ${args.join(' ')} 失败（cwd=${cwd}）：${res.stderr}`);
  return res.stdout;
}

/**
 * 在 dir 下给每个仓库建一个默认分支 main、含 README 的本地 bare 远端
 * （a/b → a__b.git，c/d → c__d.git，与 remoteUrlTemplate 的 {owner}__{name} 占位一致）。
 */
function makeBareRemotes(t, dir, repos) {
  const bareByRepo = new Map();
  for (const repo of repos) {
    const [owner, name] = repo.split('/');
    const bare = path.join(dir, `${owner}__${name}.git`);
    git(['init', '--bare', '-q', '-b', 'main', bare]);
    const seed = path.join(dir, `${owner}__${name}-seed`);
    git(['clone', '--quiet', bare, seed]);
    git(['symbolic-ref', 'HEAD', 'refs/heads/main'], seed);
    fs.writeFileSync(path.join(seed, 'README.md'), `# ${repo}\n`);
    git(['add', '-A'], seed);
    git(['commit', '--quiet', '-m', 'init'], seed);
    git(['push', '--quiet', 'origin', 'HEAD:refs/heads/main'], seed);
    bareByRepo.set(repo, bare);
  }
  return bareByRepo;
}

/** 轮询等待 fn() 为真（默认 5 秒超时），到点仍未真则断言失败。 */
async function waitUntil(fn, { timeoutMs = 5000, message = '条件在超时内未满足' } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await fn()) return;
    if (Date.now() >= deadline) assert.fail(message);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/**
 * 一套验收环境：每仓库一个 bare 远端 + 临时 home + 文件库 + 真调度器 + 假 claude/gh +
 * 可调时钟（缺省 2026-10-10T07:00:00Z 周六非高峰，额度/高峰判定稳定）。taskSpecs 每项是
 * createTask 的输入，repo 必填（不填按 'a/b'）。config 不显式给 oneTaskPerRepo 时就是
 * DEFAULT_CONFIG 的默认 true —— 验收项要的正是「不写这个键」的默认行为。
 */
function setup(t, {
  taskSpecs = [{ repo: 'a/b' }], config: configOverrides = {}, env: envOverrides = {},
  clockAt = '2026-10-10T07:00:00Z', cancelPollMs = 50,
} = {}) {
  const remotesDir = makeTempHome(t);
  const repos = [...new Set(taskSpecs.map((spec) => spec.repo ?? 'a/b'))];
  const bareByRepo = makeBareRemotes(t, remotesDir, repos);
  const home = makeTempHome(t);
  const db = openDb(path.join(home, 'night-shift.db'));
  const config = {
    ...DEFAULT_CONFIG,
    remoteUrlTemplate: path.join(remotesDir, '{owner}__{name}.git'),
    ghBin: FAKE_GH,
    claudeBin: FAKE_CLAUDE,
    gitAuthorName: '夜班调度器测试',
    gitAuthorEmail: 'night-shift-scheduler-test@example.com',
    ...configOverrides,
  };
  const env = fakeEnv({
    FAKE_GH_LOG: path.join(home, 'gh-log.jsonl'),
    FAKE_GH_BODY_COPY: path.join(home, 'pr-body.md'),
    FAKE_CLAUDE_ARGS_LOG: path.join(home, 'claude-args.jsonl'),
    FAKE_GH_PR_NUMBER: '9',
    ...envOverrides,
  });
  const tasks = taskSpecs.map((spec) => createTask(db, {
    repo: spec.repo ?? 'a/b', prompt: '做点修改', title: '同仓库锁任务', ...spec,
  }));
  let now = new Date(clockAt);
  const clock = () => now;
  const scheduler = createScheduler({ db, config, home, clock, cancelPollMs, env });
  // done 记录器挂在调度器创建时（早于任何 tick），waitDone 轮询它，不漏已发完的事件
  const doneEvents = [];
  scheduler.events.on('done', (payload) => doneEvents.push(payload));
  t.after(() => {
    scheduler.stop();
    db.close();
  });
  return {
    home, db, tasks, scheduler, config, bareByRepo,
    /** 等某个任务第 round 次（缺省第 1 次）收到 done 事件并返回其 payload。 */
    waitDone: async (taskId, { round = 1, timeoutMs = 15_000 } = {}) => {
      await waitUntil(
        () => doneEvents.filter((payload) => payload.taskId === taskId).length >= round,
        { timeoutMs, message: `任务 ${taskId} 应在 ${timeoutMs}ms 内完成第 ${round} 轮` },
      );
      return doneEvents.filter((payload) => payload.taskId === taskId)[round - 1];
    },
  };
}

// ---------------------------------------------------------------- 存储层（claimNextTask 的开关）

test('存储层：claimNextTask 省略 oneTaskPerRepo 时不过滤（直接调用的向后兼容）', (t) => {
  const db = openDb(':memory:');
  t.after(() => db.close());
  const first = createTask(db, { repo: 'a/b', prompt: 'p1' });
  createTask(db, { repo: 'a/b', prompt: 'p2' });

  const c1 = claimNextTask(db); // 省略 = false：同仓库第二条照样可领
  const c2 = claimNextTask(db);
  assert.equal(c1.status, 'running');
  assert.equal(c2.status, 'running');

  // 显式 true：先放一条回排队模拟「同仓库在跑」，再领不到它
  finishTask(db, c2.id, { status: 'queued', refundAttempt: true });
  assert.equal(claimNextTask(db, { oneTaskPerRepo: true }), null);
  assert.equal(getTask(db, c2.id).status, 'queued', '没被领走，attempts 不白加');
  assert.equal(getTask(db, c2.id).attempts, 0);

  // 非布尔报 ValidationError（field 点名）
  assert.throws(
    () => claimNextTask(db, { oneTaskPerRepo: 'yes' }),
    (err) => err instanceof ValidationError && err.field === 'oneTaskPerRepo',
  );
});

test('存储层：oneTaskPerRepo true 时被挡的是同仓库，别的仓库照常领；顺序规则不变', (t) => {
  const db = openDb(':memory:');
  t.after(() => db.close());
  const plain = createTask(db, { repo: 'a/b', prompt: 'p1' });
  const top = createTask(db, { repo: 'a/b', prompt: 'p2', priority: 10 });
  const other = createTask(db, { repo: 'c/d', prompt: 'p3' });

  // 没有运行中的任务：priority 10 照常先领（锁不改变排序规则）
  const c1 = claimNextTask(db, { oneTaskPerRepo: true });
  assert.equal(c1.id, top.id);
  // a/b 已有 running：同仓库的 plain 被挡，c/d 照常领
  const c2 = claimNextTask(db, { oneTaskPerRepo: true });
  assert.equal(c2.id, other.id);
  assert.equal(getTask(db, plain.id).status, 'queued');
  assert.equal(getTask(db, plain.id).attempts, 0);
});

// ---------------------------------------------------------------- 验收项（真调度器端到端）

test('验收: 默认配置（不写 oneTaskPerRepo）+ concurrency 2 —— 同仓库两条排队只领一条，另一条保持 queued；不同仓库可以同时 running', async (t) => {
  const ctx = setup(t, {
    taskSpecs: [
      { repo: 'a/b', title: 'first' },
      { repo: 'a/b', title: 'second' },
      { repo: 'c/d', title: 'other repo' },
    ],
    config: { concurrency: 2 }, // 不写 oneTaskPerRepo：DEFAULT_CONFIG 默认 true
    env: { FAKE_CLAUDE_SCENARIO: 'slow', FAKE_CLAUDE_DELAY_MS: '300' },
  });
  const [first, second, other] = ctx.tasks;

  assert.deepEqual(await ctx.scheduler.tick(), [first.id, other.id], '同仓库只领第一条，名额给别的仓库');
  assert.deepEqual(ctx.scheduler.status().running, [first.id, other.id], '两个不同仓库同时 running');
  const held = getTask(ctx.db, second.id);
  assert.equal(held.status, 'queued', '同仓库第二条保持 queued');
  assert.equal(held.attempts, 0, '没被领过：attempts 不白加');

  await ctx.waitDone(first.id);
  await ctx.waitDone(other.id);
  assert.equal(getTask(ctx.db, first.id).status, 'succeeded');
  assert.equal(getTask(ctx.db, other.id).status, 'succeeded');
  assert.equal(getTask(ctx.db, second.id).status, 'queued', '全程没被领');
});

test('验收: 先跑的同仓库任务成功后，下一轮 tick 把剩下那条领走', async (t) => {
  const ctx = setup(t, {
    taskSpecs: [{ repo: 'a/b', title: 'first' }, { repo: 'a/b', title: 'second' }],
    config: { concurrency: 2 }, // 默认 oneTaskPerRepo: true
  });
  const [first, second] = ctx.tasks;

  assert.deepEqual(await ctx.scheduler.tick(), [first.id]);
  await ctx.waitDone(first.id);
  assert.equal(getTask(ctx.db, first.id).status, 'succeeded');

  assert.deepEqual(await ctx.scheduler.tick(), [second.id], '先跑的成功后，下一轮领走同仓库剩下的');
  await ctx.waitDone(second.id);
  assert.equal(getTask(ctx.db, second.id).status, 'succeeded');
  assert.equal(getTask(ctx.db, second.id).attempts, 1);
});

test('验收: oneTaskPerRepo: false 时同一仓库两条可以同时 running', async (t) => {
  const ctx = setup(t, {
    taskSpecs: [{ repo: 'a/b', title: 'first' }, { repo: 'a/b', title: 'second' }],
    config: { concurrency: 2, oneTaskPerRepo: false },
    env: { FAKE_CLAUDE_SCENARIO: 'slow', FAKE_CLAUDE_DELAY_MS: '300' },
  });
  const [first, second] = ctx.tasks;

  assert.deepEqual(await ctx.scheduler.tick(), [first.id, second.id], 'false = 行为与开关加入前一致');
  assert.deepEqual(ctx.scheduler.status().running, [first.id, second.id], '同仓库两条同时 running');

  await ctx.waitDone(first.id);
  await ctx.waitDone(second.id);
  assert.equal(getTask(ctx.db, first.id).status, 'succeeded');
  assert.equal(getTask(ctx.db, second.id).status, 'succeeded');
});

test('验收: 同仓库任务被挡住时（没有高峰/额度/限流拦截）status().blocked 仍是 null', async (t) => {
  const ctx = setup(t, {
    taskSpecs: [{ repo: 'a/b', title: 'first' }, { repo: 'a/b', title: 'second' }],
    config: { concurrency: 2 }, // 默认 oneTaskPerRepo: true
    env: { FAKE_CLAUDE_SCENARIO: 'slow', FAKE_CLAUDE_DELAY_MS: '300' },
  });
  const [first, second] = ctx.tasks;

  assert.deepEqual(await ctx.scheduler.tick(), [first.id]);
  await waitUntil(() => ctx.scheduler.status().running.includes(first.id));

  // 队列里只剩「等同仓库正在跑的」那条：本轮领不到就结束，不记 blocked、不空转
  assert.deepEqual(await ctx.scheduler.tick(), [], '领不到东西，本轮结束');
  assert.equal(ctx.scheduler.status().blocked, null, '同仓库挡住不算 blocked（那是高峰/额度/限流用的）');
  assert.equal(getTask(ctx.db, second.id).status, 'queued');
  assert.equal(ctx.scheduler.status().pausedUntil, null);

  await ctx.waitDone(first.id);
});

test('验收: 配置写成 "oneTaskPerRepo": "yes" 时创建调度器失败，错误信息里有 oneTaskPerRepo', (t) => {
  const home = makeTempHome(t);
  const db = openDb(path.join(home, 'night-shift.db'));
  t.after(() => db.close());
  assert.throws(
    () => createScheduler({
      db, config: { ...DEFAULT_CONFIG, oneTaskPerRepo: 'yes' }, home,
      clock: () => new Date('2026-10-10T07:00:00Z'),
      runner: () => {}, env: fakeEnv(),
    }),
    (err) => err instanceof TypeError && err.message.includes('oneTaskPerRepo'),
    '非布尔要在创建调度器时报 TypeError',
  );
});

test('验收: 文档两处（README 与 docs/configuration.md）都写了 oneTaskPerRepo 及其默认值', () => {
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
  const doc = fs.readFileSync(path.join(root, 'docs', 'configuration.md'), 'utf8');
  for (const [name, text] of [['README.md', readme], ['docs/configuration.md', doc]]) {
    assert.ok(text.includes('oneTaskPerRepo'), `${name} 缺少 oneTaskPerRepo`);
    assert.ok(text.includes('`true`') || text.includes('"oneTaskPerRepo": true'), `${name} 应写明默认 true`);
    assert.ok(text.includes('`false`') || text.includes('"false"'), `${name} 应写明 false 允许同仓库并行`);
  }
  assert.ok(doc.includes('### oneTaskPerRepo'), 'docs/configuration.md 应有逐项说明小节');
});
