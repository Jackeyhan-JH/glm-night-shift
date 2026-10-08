// 手动暂停 / 恢复领取（issue #38）的调度器测试：注入可控的假 runner（挂起中的任务
// 由测试决定何时结束）+ 假 git + 可调时钟 + 文件库（另一个连接可以像 CLI/看板进程
// 一样改 meta.userPaused），不真跑 claude、不等墙钟。
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { openDb } from '../src/db.js';
import { createTask, getTask, getUserPaused, setUserPaused } from '../src/tasks.js';
import { DEFAULT_CONFIG } from '../src/config.js';
import { createScheduler } from '../src/scheduler.js';
import * as realGit from '../src/git.js';
import { fakeEnv, makeTempHome } from './helpers.js';

/** 与 runTask 成功结果同形的结果对象（可按用例覆盖字段）。 */
const RUN_OK = {
  runId: 1, status: 'succeeded', exitCode: 0, signal: null, numTurns: 3, isError: false,
  summary: 'fake summary', error: null, rateLimited: false,
  model: 'glm-5.3', effort: 'medium', peak: false, quotaUnits: 1, durationMs: 1200,
  logPath: '/tmp/fake.log',
};

/**
 * 手动收尾的假 runner：每次调用挂起在一个由测试控制的 Promise 上，
 * finishOne() 让最早那次调用以成功结果结束。calls 记录每次调用的任务。
 * （流水线是异步启动的：tick/runNow 返回时 runner 可能还没被调到，
 * finishOne 会先等它挂起来再放行。）
 */
function makeManualRunner() {
  const calls = [];
  const finishers = [];
  const runner = (info) => new Promise((resolve) => {
    calls.push(info);
    finishers.push(() => resolve({ ...RUN_OK }));
  });
  const finishOne = async () => {
    await waitUntil(() => finishers.length > 0, { message: '假 runner 应已被调用（先挂起再放行）' });
    finishers.shift()();
  };
  return { runner, calls, finishOne };
}

/** 前几次按脚本返回、之后按 RUN_OK 成功的假 runner（脚本项合并进 RUN_OK）。 */
function scriptedRunner(script) {
  let calls = 0;
  const infos = [];
  const runner = async (info) => {
    infos.push(info);
    const index = calls;
    calls += 1;
    return index < script.length ? { ...RUN_OK, ...script[index] } : { ...RUN_OK };
  };
  return { runner, calls: infos };
}

/** 假 git 模块（与 scheduler-unit.test.js 同款的最小实现；PR 文本用真函数）。 */
function makeFakeGit() {
  return {
    prTitle: realGit.prTitle,
    buildPrBody: realGit.buildPrBody,
    ensureRepoCache: async ({ home }) => path.join(home, 'repos', 'a__b'),
    defaultBranch: async () => 'main',
    createWorktree: async ({ task }) => ({
      path: path.join('/wt', `task-${task.id}`),
      branch: `night-shift/${task.id}-fake`,
      baseBranch: 'main',
      baseSha: 'f'.repeat(40),
    }),
    runTestCommand: async () => ({ ok: true, skipped: true, exitCode: 0, timedOut: false, durationMs: 0, output: '' }),
    commitAll: async () => ({ changed: true, sha: 'a'.repeat(40) }),
    pushBranch: async ({ branch }) => ({ branch, sha: 'a'.repeat(40) }),
    createPr: async () => ({ url: 'https://github.com/a/b/pull/7', existed: false }),
    removeWorktree: async () => undefined,
  };
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
 * 一套暂停测试环境：文件库 + 可控 runner + 假 git + 可调时钟（周六非高峰）+ 第二个
 * 连接（模拟 CLI / 看板进程改 meta.userPaused，WAL 多连接同库）。并发缺省 2。
 */
function setup(t, { concurrency = 2, runner } = {}) {
  const home = makeTempHome(t);
  const db = openDb(path.join(home, 'night-shift.db'));
  let now = new Date('2026-10-10T07:00:00Z');
  const clock = () => now;
  const manual = runner ?? makeManualRunner();
  const scheduler = createScheduler({
    db, config: { ...DEFAULT_CONFIG, concurrency }, home, clock,
    runner: manual.runner, git: makeFakeGit(), cancelPollMs: 20, env: fakeEnv(),
  });
  const db2 = openDb(path.join(home, 'night-shift.db'));
  t.after(() => {
    scheduler.stop();
    db2.close();
    db.close();
  });
  return {
    home, db, db2, scheduler, manual,
    setNow: (at) => { now = new Date(at); },
  };
}

// ---------------------------------------------------------------- 暂停挡住领取

test('验收·暂停：有空闲名额也不领排队任务；正在跑的照常跑完；resume 后下一轮 tick 领走', async (t) => {
  const ctx = setup(t); // 并发 2
  const running = createTask(ctx.db, { repo: 'a/b', prompt: '先跑的', title: 'first' });
  assert.deepEqual(await ctx.scheduler.tick(), [running.id], '未暂停时领走唯一的排队任务');
  // running 挂在手动 runner 上不结束；此刻再放一个进队列（并发还有 1 个空闲名额）
  const waiting = createTask(ctx.db, { repo: 'a/b', prompt: '排队的', title: 'second' });

  setUserPaused(ctx.db2, true); // 另一进程（CLI / 看板）按下暂停
  ctx.setNow('2026-10-10T07:05:00Z');
  assert.deepEqual(await ctx.scheduler.tick(), [], '手动暂停：有空闲名额也不领');
  assert.equal(getTask(ctx.db, waiting.id).status, 'queued');
  assert.equal(ctx.scheduler.status().userPaused, true);

  // 正在跑的不被暂停打断：让它成功结束，任务落 succeeded
  await ctx.manual.finishOne();
  await waitUntil(() => getTask(ctx.db, running.id).status === 'succeeded');
  assert.deepEqual(ctx.scheduler.status().running, [], '并发名额已全部空出');

  // 暂停没解除：再 tick 排队任务仍是 queued
  ctx.setNow('2026-10-10T07:10:00Z');
  assert.deepEqual(await ctx.scheduler.tick(), []);
  assert.equal(getTask(ctx.db, waiting.id).status, 'queued');

  // resume 之后下一轮 tick 把排队任务领走
  setUserPaused(ctx.db2, false);
  assert.deepEqual(await ctx.scheduler.tick(), [waiting.id]);
  await ctx.manual.finishOne();
  await waitUntil(() => getTask(ctx.db, waiting.id).status === 'succeeded');
  assert.equal(ctx.scheduler.status().userPaused, false);
});

test('status().userPaused 每次从库里现读：另一连接改库立即反映，不在进程里缓存', (t) => {
  const ctx = setup(t);
  assert.equal(ctx.scheduler.status().userPaused, false);
  setUserPaused(ctx.db2, true);
  assert.equal(ctx.scheduler.status().userPaused, true);
  setUserPaused(ctx.db2, false);
  assert.equal(ctx.scheduler.status().userPaused, false);
});

// ---------------------------------------------------------------- 与限流退避互相独立

test('验收·限流退避与手动暂停独立：resume 不清 pausedUntil，退避未过仍不领，过了才领', async (t) => {
  const ctx = setup(t, {
    concurrency: 1,
    // 第一次调用返回限流失败（调度器会设内存 pausedUntil + 任务 not_before）
    runner: scriptedRunner([{ status: 'failed', rateLimited: true, error: 'rate_limit: 429' }]),
  });
  const first = createTask(ctx.db, { repo: 'a/b', prompt: '被限流的', title: 'first' });
  const T = '2026-10-10T07:00:00Z';
  ctx.setNow(T);
  assert.deepEqual(await ctx.scheduler.tick(), [first.id]);
  await waitUntil(() => getTask(ctx.db, first.id).status === 'queued');
  // 限流公式（src/scheduler.js）：pausedUntil = now + rateLimitBackoffMinutes
  const pausedUntil = new Date(new Date(T).getTime() + DEFAULT_CONFIG.rateLimitBackoffMinutes * 60_000);
  assert.deepEqual(ctx.scheduler.status().pausedUntil, pausedUntil);

  const second = createTask(ctx.db, { repo: 'a/b', prompt: '旁观者', title: 'second' });
  // 退避还没结束时手动暂停再恢复：userPaused 回到 0，但 pausedUntil 必须原样保留
  setUserPaused(ctx.db2, true);
  setUserPaused(ctx.db2, false);
  assert.equal(getUserPaused(ctx.db2), false);
  ctx.setNow('2026-10-10T07:01:00Z'); // 仍在退避期内（默认 15 分钟）
  assert.deepEqual(ctx.scheduler.status().pausedUntil, pausedUntil, 'resume 不得清掉 pausedUntil');
  assert.deepEqual(await ctx.scheduler.tick(), [], '退避未过：resume 了也不领普通任务');
  assert.equal(getTask(ctx.db, second.id).status, 'queued');

  // 时钟拨过 pausedUntil 之后任务才可以被领（first 的 not_before 同一时刻也已过）
  ctx.setNow(new Date(pausedUntil.getTime() + 60_000).toISOString());
  assert.deepEqual(await ctx.scheduler.tick(), [first.id], '退避结束后领到创建更早的 first');
  await waitUntil(() => getTask(ctx.db, first.id).status === 'succeeded');
});

// ---------------------------------------------------------------- run-now 不受影响

test('验收·run-now：手动暂停期间点名任务仍跑完（succeeded），也不因此领取别的排队任务', async (t) => {
  const ctx = setup(t);
  const named = createTask(ctx.db, { repo: 'a/b', prompt: '点名的', title: 'named' });
  const other = createTask(ctx.db, { repo: 'a/b', prompt: '不该被领的', title: 'other' });

  setUserPaused(ctx.db2, true);
  assert.deepEqual(await ctx.scheduler.tick(), [], '暂停期间 tick 什么都不领');
  assert.equal(ctx.manual.calls.length, 0, 'runner 还没被调用过');

  // runNow 不读 userPaused：人点名要跑的还是跑（只经 claimTaskById，不走 claimNextTask）。
  // 流水线挂在手动 runner 上：等它开始后放行成功结果。
  const finalPromise = ctx.scheduler.runNow(named.id);
  await ctx.manual.finishOne();
  const final = await finalPromise;
  assert.equal(final.status, 'succeeded');
  assert.equal(final.id, named.id);
  assert.deepEqual(ctx.manual.calls.map((info) => info.task.id), [named.id], '只有点名的任务被跑');
  assert.equal(getTask(ctx.db, other.id).status, 'queued', '别的排队任务没被顺带领走');
  assert.equal(ctx.scheduler.status().userPaused, true, '暂停标记原样保留');
});
