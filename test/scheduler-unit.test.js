// src/scheduler.js 的单元测试（issue #9）：注入假 runner（按脚本返回结果、可控耗时、
// 可响应 abort）、假 git（记录调用顺序、按脚本抛错）与可调时钟，直接调 tick()/runNow()。
// 真 runner + 真 git + 本地 bare 仓库的集成测试见 test/scheduler-integration.test.js。
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { openDb } from '../src/db.js';
import {
  createTask, getTask, startRun, finishRun, listRuns, cancelTask, claimTaskById, finishTask,
  InvalidTransitionError, NotFoundError,
} from '../src/tasks.js';
import { DEFAULT_CONFIG } from '../src/config.js';
import { formatLocalMinute } from '../src/format.js';
import { usage as quotaUsage } from '../src/quota.js';
import { createScheduler } from '../src/scheduler.js';
import * as realGit from '../src/git.js';
import { fakeEnv, makeTempHome } from './helpers.js';

// —— 假 runner —— ///////////////////////////////////////////////////////////////////////////////////

/** 与 runTask 成功结果同形的结果对象（可按用例覆盖字段）。 */
const RUN_OK = {
  runId: 1, status: 'succeeded', exitCode: 0, signal: null, numTurns: 3, isError: false,
  summary: 'fake summary', error: null, rateLimited: false,
  model: 'glm-5.3', effort: 'medium', peak: false, quotaUnits: 1, durationMs: 1200,
  logPath: '/tmp/fake.log',
};

/**
 * 可脚本化的假 runner。
 * script 是数组（第 N 次调用用第 N 项，用完重复最后一项）或函数（收到调用信息）。
 * 项为：结果对象（合并到 RUN_OK）／函数／`{ hang: true, onAbort }`（挂起直到 signal
 * abort 才以 onAbort 结果收场——测取消与停机）。记录每次调用与并发峰值。
 */
function makeFakeRunner(script = [], { delayMs = 0 } = {}) {
  const calls = [];
  let active = 0;
  let maxActive = 0;
  const pick = (index, info) => {
    const item = typeof script === 'function' ? script(index, info) : script[Math.min(index, script.length - 1)];
    if (typeof item === 'function') return item(info);
    return item;
  };
  const runner = async (info) => {
    const index = calls.length;
    calls.push(info);
    active += 1;
    maxActive = Math.max(maxActive, active);
    try {
      const item = pick(index, info);
      if (item !== undefined && item !== null && item.hang === true) {
        return await new Promise((resolve) => {
          const settle = () => resolve({ ...RUN_OK, ...(item.onAbort ?? { status: 'canceled' }) });
          if (info.signal.aborted) {
            settle();
            return;
          }
          info.signal.addEventListener('abort', settle, { once: true });
        });
      }
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
      return { ...RUN_OK, ...(item ?? {}) };
    } finally {
      active -= 1;
    }
  };
  return { runner, calls, maxActive: () => maxActive };
}

// —— 假 git —— //////////////////////////////////////////////////////////////////////////////////////

/** 带调用记录与脚本覆盖的假 git 模块；prTitle/buildPrBody 用真实现（PR 文本不在意）。 */
function makeFakeGit(script = {}) {
  const calls = [];
  const counts = new Map();
  const defaults = {
    ensureRepoCache: ({ home }) => path.join(home, 'repos', 'a__b'),
    defaultBranch: () => 'main',
    createWorktree: ({ task }) => ({
      path: path.join('/wt', `task-${task.id}`),
      branch: `night-shift/${task.id}-fake`,
      baseBranch: 'main',
      baseSha: 'f'.repeat(40),
    }),
    runTestCommand: () => ({ ok: true, skipped: true, exitCode: 0, timedOut: false, durationMs: 0, output: '' }),
    commitAll: () => ({ changed: true, sha: 'a'.repeat(40) }),
    pushBranch: ({ branch }) => ({ branch, sha: 'a'.repeat(40) }),
    createPr: () => ({ url: 'https://github.com/a/b/pull/7', existed: false }),
    removeWorktree: () => undefined,
  };
  const git = { prTitle: realGit.prTitle, buildPrBody: realGit.buildPrBody };
  for (const [name, defaultFn] of Object.entries(defaults)) {
    git[name] = async (args) => {
      const nth = counts.get(name) ?? 0;
      counts.set(name, nth + 1);
      calls.push({ name, nth, args });
      const spec = script[name];
      if (spec === undefined) return defaultFn(args);
      const item = Array.isArray(spec) ? spec[Math.min(nth, spec.length - 1)] : spec;
      if (item === undefined || item === null) return defaultFn(args); // 数组里的空位 = 用默认行为
      return typeof item === 'function' ? item(args) : item;
    };
  }
  return { git, calls };
}

/** 收集指定事件的（name, payload）序列，测试结束自动解绑。 */
function collectEvents(t, emitter, names) {
  const seen = [];
  const handlers = new Map();
  for (const name of names) {
    const handler = (payload) => seen.push({ name, payload });
    handlers.set(name, handler);
    emitter.on(name, handler);
  }
  t.after(() => {
    for (const [name, handler] of handlers) emitter.off(name, handler);
  });
  return seen;
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
 * 一套单元测试环境：临时 home + 文件库 + N 个排队任务 + 假 runner / 假 git + 可调时钟
 * （缺省 2026-10-10T07:00:00Z，周六非高峰，额度判断稳定）。
 */
function setup(t, {
  taskCount = 1, taskSpec = {},
  config: configOverrides = {}, runner: runnerOpts = {}, git: gitScript = {},
  clockAt = '2026-10-10T07:00:00Z',
  runnerOverride, gateOverride,
} = {}) {
  const home = makeTempHome(t);
  const db = openDb(path.join(home, 'night-shift.db'));
  const tasks = [];
  for (let i = 0; i < taskCount; i += 1) {
    tasks.push(createTask(db, {
      repo: 'a/b', prompt: `任务 ${i}`, title: `task ${i}`, testCommand: null, ...taskSpec,
    }));
  }
  const config = { ...DEFAULT_CONFIG, ...configOverrides };
  let now = new Date(clockAt);
  const clock = () => now;
  const fakeRunner = makeFakeRunner(runnerOpts.script ?? [], { delayMs: runnerOpts.delayMs ?? 0 });
  const fakeGit = makeFakeGit(gitScript);
  const env = fakeEnv({ FAKE_ENV_MARKER: 'unit' });
  const scheduler = createScheduler({
    db, config, home, clock,
    runner: runnerOverride ?? fakeRunner.runner, git: fakeGit.git,
    gate: gateOverride,
    cancelPollMs: 20, env,
  });
  // 先停调度器再关库，避免取消轮询在测试结束后还去读一个已关闭的连接
  t.after(() => {
    scheduler.stop();
    db.close();
  });
  return {
    home, db, tasks, config, scheduler, env,
    fakeRunner, fakeGit,
    setNow: (at) => { now = new Date(at); },
  };
}

/** 造一条历史运行（额度测试用）：直接写库并改 started_at。 */
function seedRun(db, taskId, { startedAt, quotaUnits }) {
  const run = startRun(db, {
    taskId, attempt: 1, model: 'glm-5.3', effort: 'medium', peak: false, logPath: '/tmp/x.log',
  });
  finishRun(db, run.id, { status: 'succeeded', quotaUnits });
  db.prepare('UPDATE runs SET started_at = ? WHERE id = ?').run(new Date(startedAt).toISOString(), run.id);
  return run;
}

// ---------------------------------------------------------------- 参数校验

test('createScheduler 参数校验：缺 db/config/home、非法数值与函数抛 TypeError', () => {
  const base = { db: { prepare() {} }, config: { ...DEFAULT_CONFIG }, home: '/tmp/x' };
  const badCases = [
    [{ ...base, db: null }, 'db'],
    [{ ...base, config: null }, 'config'],
    [{ ...base, home: '  ' }, 'home'],
    [{ ...base, home: undefined }, 'home'],
    [{ ...base, clock: null }, 'clock'],
    [{ ...base, runner: 'x' }, 'runner'],
    [{ ...base, git: null }, 'git'],
    [{ ...base, env: null }, 'env'],
    [{ ...base, cancelPollMs: 0 }, 'cancelPollMs'],
    [{ ...base, config: { ...DEFAULT_CONFIG, concurrency: 0 } }, 'concurrency'],
    [{ ...base, config: { ...DEFAULT_CONFIG, concurrency: 1.5 } }, 'concurrency'],
    [{ ...base, config: { ...DEFAULT_CONFIG, pollSeconds: 0 } }, 'pollSeconds'],
    [{ ...base, config: { ...DEFAULT_CONFIG, rateLimitBackoffMinutes: -1 } }, 'rateLimitBackoffMinutes'],
  ];
  for (const [input, field] of badCases) {
    assert.throws(
      () => createScheduler(input),
      (err) => err instanceof TypeError && err.message.includes(field),
      `缺/坏 ${field} 应报 TypeError`,
    );
  }
  assert.doesNotThrow(() => createScheduler(base));
});

// ---------------------------------------------------------------- 成功流水线

test('单元·成功：tick 领取并跑完整流水线，stage 顺序与 git 调用顺序正确，任务 succeeded', async (t) => {
  const ctx = setup(t);
  const events = collectEvents(t, ctx.scheduler.events, ['claim', 'stage', 'done']);
  const claimed = await ctx.scheduler.tick();
  assert.deepEqual(claimed, [ctx.tasks[0].id]);
  await waitUntil(() => events.some((e) => e.name === 'done'));

  const stages = events.filter((e) => e.name === 'stage').map((e) => e.payload.stage);
  assert.deepEqual(stages, ['worktree', 'run', 'test', 'commit', 'push', 'pr', 'cleanup']);
  assert.deepEqual(events[0], { name: 'claim', payload: { taskId: ctx.tasks[0].id } });

  const done = events.find((e) => e.name === 'done').payload;
  assert.equal(done.taskId, ctx.tasks[0].id);
  assert.equal(done.status, 'succeeded');
  assert.equal(done.prUrl, 'https://github.com/a/b/pull/7');
  assert.equal(done.error, null);

  const task = getTask(ctx.db, ctx.tasks[0].id);
  assert.equal(task.status, 'succeeded');
  assert.equal(task.prUrl, 'https://github.com/a/b/pull/7');
  assert.equal(task.branch, `night-shift/${ctx.tasks[0].id}-fake`);
  assert.equal(task.attempts, 1);

  // git 调用顺序：缓存 → 默认分支 → worktree → 测试 → 提交 → 推送 → PR → 清理
  assert.deepEqual(ctx.fakeGit.calls.map((c) => c.name), [
    'ensureRepoCache', 'defaultBranch', 'createWorktree', 'runTestCommand',
    'commitAll', 'pushBranch', 'createPr', 'removeWorktree',
  ]);
  // commitAll 拿到 createWorktree 返回的 baseSha；createPr 拿到 base 与 env
  const commitCall = ctx.fakeGit.calls.find((c) => c.name === 'commitAll');
  assert.equal(commitCall.args.baseSha, 'f'.repeat(40));
  const prCall = ctx.fakeGit.calls.find((c) => c.name === 'createPr');
  assert.equal(prCall.args.base, 'main');
  assert.equal(prCall.args.title, realGit.prTitle(ctx.tasks[0]));
  assert.equal(prCall.args.env, ctx.env, 'createPr 必须收到调用方传入的 env 原对象');
  assert.equal(ctx.fakeGit.calls.find((c) => c.name === 'removeWorktree').args.worktree, path.join('/wt', `task-${ctx.tasks[0].id}`));

  // runner 收到的关键参数
  const call = ctx.fakeRunner.calls[0];
  assert.equal(call.attempt, 1);
  assert.equal(call.extraPrompt, null);
  assert.equal(call.workdir, path.join('/wt', `task-${ctx.tasks[0].id}`));
  assert.equal(call.env, ctx.env, 'runner 必须收到调用方传入的 env 原对象');
  assert.ok(call.signal instanceof AbortSignal);
  // buildPrBody 的 run 参数来自 runner 结果
  assert.ok(prCall.args.body.includes('fake summary'));
  assert.ok(prCall.args.body.includes('glm-5.3'));

  // 空队列再 tick 返回 []
  assert.deepEqual(await ctx.scheduler.tick(), []);
});

test('env 原样透传：ANTHROPIC_* 不被剥掉，runner 与 createPr 看到同一个对象', async (t) => {
  const env = fakeEnv({
    ANTHROPIC_BASE_URL: 'https://glm.example/api',
    ANTHROPIC_AUTH_TOKEN: 'secret-token',
  });
  const home = makeTempHome(t);
  const db = openDb(path.join(home, 'night-shift.db'));
  t.after(() => db.close());
  const task = createTask(db, { repo: 'a/b', prompt: 'p' });
  const fakeRunner = makeFakeRunner();
  const fakeGit = makeFakeGit();
  const scheduler = createScheduler({
    db, config: { ...DEFAULT_CONFIG }, home,
    clock: () => new Date('2026-10-10T07:00:00Z'),
    runner: fakeRunner.runner, git: fakeGit.git, cancelPollMs: 20, env,
  });
  await scheduler.tick();
  await waitUntil(() => getTask(db, task.id).status === 'succeeded');
  assert.equal(fakeRunner.calls[0].env, env);
  assert.equal(fakeRunner.calls[0].env.ANTHROPIC_BASE_URL, 'https://glm.example/api');
  assert.equal(fakeRunner.calls[0].env.ANTHROPIC_AUTH_TOKEN, 'secret-token');
  const prCall = fakeGit.calls.find((c) => c.name === 'createPr');
  assert.equal(prCall.args.env, env);
  assert.equal(prCall.args.env.ANTHROPIC_BASE_URL, 'https://glm.example/api');
});

// ---------------------------------------------------------------- push 的 stale info 重试

test('push 撞 stale info：重新 ensureRepoCache 后重推一次成功', async (t) => {
  const staleErr = Object.assign(new Error('命令失败（退出码 1）：git push'), {
    stderr: '! [rejected] HEAD -> night-shift/1-x (stale info)\nfetch first',
  });
  const ctx = setup(t, {
    git: { pushBranch: [() => { throw staleErr; }, ({ branch }) => ({ branch, sha: 'b'.repeat(40) })] },
  });
  const claimed = await ctx.scheduler.tick();
  assert.deepEqual(claimed, [ctx.tasks[0].id]);
  await waitUntil(() => getTask(ctx.db, ctx.tasks[0].id).status === 'succeeded');
  const pushes = ctx.fakeGit.calls.filter((c) => c.name === 'pushBranch');
  const caches = ctx.fakeGit.calls.filter((c) => c.name === 'ensureRepoCache');
  assert.equal(pushes.length, 2, '第二次推送应成功');
  assert.equal(caches.length, 2, '重试前恰好重新 ensureRepoCache 一次');
});

test('push 两次都 stale info：按普通失败处理（重试排队），ensureRepoCache 也只重试一次', async (t) => {
  // 真 GitError 的 message 自带 stderr 末尾，这里照实构造
  const staleErr = Object.assign(
    new Error('命令失败（退出码 1）：git push …\n! [rejected] (stale info)'),
    { stderr: '! [rejected] (stale info)' },
  );
  const ctx = setup(t, {
    git: { pushBranch: () => { throw staleErr; } },
  });
  await ctx.scheduler.tick();
  await waitUntil(() => getTask(ctx.db, ctx.tasks[0].id).status === 'queued');
  const task = getTask(ctx.db, ctx.tasks[0].id);
  assert.equal(task.attempts, 1, '普通失败不退还尝试');
  assert.ok(task.lastError.startsWith('git:'), `lastError 应以 git: 开头：${task.lastError}`);
  assert.ok(task.lastError.includes('stale info'));
  assert.equal(ctx.fakeGit.calls.filter((c) => c.name === 'pushBranch').length, 2);
  assert.equal(ctx.fakeGit.calls.filter((c) => c.name === 'ensureRepoCache').length, 2);
});

// ---------------------------------------------------------------- 普通失败各分支

test('runner 结果 failed → 普通失败：有次数排回队列，lastError 以 run: 开头', async (t) => {
  const ctx = setup(t, { runner: { script: [{ status: 'failed', error: 'fake failure' }] } });
  await ctx.scheduler.tick();
  await waitUntil(() => getTask(ctx.db, ctx.tasks[0].id).status === 'queued');
  const task = getTask(ctx.db, ctx.tasks[0].id);
  assert.equal(task.lastError, 'run: fake failure');
  assert.equal(task.attempts, 1);

  // 用尽次数后落终态 failed
  await ctx.scheduler.tick();
  await waitUntil(() => getTask(ctx.db, ctx.tasks[0].id).status === 'failed');
  assert.equal(getTask(ctx.db, ctx.tasks[0].id).attempts, 2);
});

test('runner 抛异常 → 普通失败，lastError 以 run: 开头，调度器不崩', async (t) => {
  const ctx = setup(t, { runner: { script: [() => { throw new Error('runner boom'); }] } });
  assert.deepEqual(await ctx.scheduler.tick(), [ctx.tasks[0].id]);
  await waitUntil(() => getTask(ctx.db, ctx.tasks[0].id).status === 'queued');
  assert.equal(getTask(ctx.db, ctx.tasks[0].id).lastError, 'run: runner boom');
});

test('测试命令失败 → 普通失败，lastError = 测试失败：<末尾 500 码点>', async (t) => {
  const longOutput = `${'x'.repeat(300)}尾${'y'.repeat(300)}`; // 601 码点，取末尾 500
  const ctx = setup(t, {
    taskSpec: { testCommand: 'exit 1' },
    git: { runTestCommand: () => ({ ok: false, skipped: false, exitCode: 1, timedOut: false, durationMs: 3, output: longOutput }) },
  });
  await ctx.scheduler.tick();
  await waitUntil(() => getTask(ctx.db, ctx.tasks[0].id).status === 'queued');
  const { lastError } = getTask(ctx.db, ctx.tasks[0].id);
  assert.ok(lastError.startsWith('测试失败：'), lastError);
  assert.equal([...lastError].length, `测试失败：`.length + 500);
  assert.ok(lastError.endsWith('y'.repeat(299)), '应保留输出末尾');
});

test('没有改动 → 直接 failed 不重试（attempts 停在 1），worktree 已清理', async (t) => {
  const ctx = setup(t, { git: { commitAll: () => ({ changed: false, sha: null }) } });
  await ctx.scheduler.tick();
  await waitUntil(() => getTask(ctx.db, ctx.tasks[0].id).status === 'failed');
  const task = getTask(ctx.db, ctx.tasks[0].id);
  assert.equal(task.lastError, '没有改动');
  assert.equal(task.attempts, 1, '没有改动不重试');
  assert.ok(ctx.fakeGit.calls.some((c) => c.name === 'removeWorktree'));
  assert.ok(!ctx.fakeGit.calls.some((c) => c.name === 'pushBranch'), '没改动就不推送');
});

test('keepFailedWorktrees: true 时失败的 worktree 保留，成功的仍清理', async (t) => {
  const failed = setup(t, {
    taskSpec: { maxAttempts: 1 },
    config: { keepFailedWorktrees: true },
    runner: { script: [{ status: 'failed', error: 'x' }] },
  });
  await failed.scheduler.tick();
  await waitUntil(() => getTask(failed.db, failed.tasks[0].id).status === 'failed');
  assert.ok(!failed.fakeGit.calls.some((c) => c.name === 'removeWorktree'), '失败现场应保留');

  const ok = setup(t, { config: { keepFailedWorktrees: true } });
  await ok.scheduler.tick();
  await waitUntil(() => getTask(ok.db, ok.tasks[0].id).status === 'succeeded');
  assert.ok(ok.fakeGit.calls.some((c) => c.name === 'removeWorktree'), '成功照常清理');
});

test('git 某步抛错 → git: 前缀普通失败；同轮的下一个任务照常处理', async (t) => {
  const ctx = setup(t, {
    taskCount: 2,
    config: { concurrency: 2 },
    git: { createWorktree: [() => { throw new Error('worktree boom'); }, null] },
  });
  const claimed = await ctx.scheduler.tick();
  assert.deepEqual(claimed, [ctx.tasks[0].id, ctx.tasks[1].id]);
  await waitUntil(() => getTask(ctx.db, ctx.tasks[1].id).status === 'succeeded');

  const first = getTask(ctx.db, ctx.tasks[0].id);
  assert.equal(first.status, 'queued', '第一个任务按普通失败排回队列');
  assert.ok(first.lastError.startsWith('git:'), first.lastError);
  assert.ok(first.lastError.includes('worktree boom'));
  assert.equal(getTask(ctx.db, ctx.tasks[1].id).status, 'succeeded', '第二个任务不受影响');
});

// ---------------------------------------------------------------- 限流退避

test('单元·限流退避：T 时刻退回队列退还尝试并全局暂停；T+10 不领任何任务；T+16 恢复领取', async (t) => {
  const ctx = setup(t, {
    taskCount: 2,
    runner: { script: [{ status: 'failed', rateLimited: true, error: 'rate_limit: 429' }] },
  });
  const dones = collectEvents(t, ctx.scheduler.events, ['done']);
  const T = '2026-10-10T07:00:00Z';
  ctx.setNow(T);
  assert.deepEqual(await ctx.scheduler.tick(), [ctx.tasks[0].id]);
  await waitUntil(() => dones.length >= 1);

  const task = getTask(ctx.db, ctx.tasks[0].id);
  assert.equal(task.status, 'queued');
  assert.equal(task.attempts, 0, '限流退还这次尝试');
  assert.ok(task.lastError.includes('被限流'), task.lastError);
  // 「本地时间」由 formatLocalMinute 按进程时区渲染；用同一函数算期望值，断言与机器时区无关
  assert.equal(task.lastError, `被限流，${formatLocalMinute('2026-10-10T07:15:00.000Z')} 后重试`);
  assert.equal(task.notBefore, '2026-10-10T07:15:00.000Z');
  assert.deepEqual(ctx.scheduler.status().pausedUntil, new Date('2026-10-10T07:15:00Z'));
  assert.equal(ctx.scheduler.status().blocked.reason, 'rate-limit');

  // T+10 分钟：全局暂停中，连别的任务也不领
  ctx.setNow('2026-10-10T07:10:00Z');
  assert.deepEqual(await ctx.scheduler.tick(), []);
  assert.equal(getTask(ctx.db, ctx.tasks[1].id).status, 'queued');

  // T+16 分钟：暂停与 not_before 都已过，领到它（创建更早，队列序在前）；再被限流退回
  ctx.setNow('2026-10-10T07:16:00Z');
  assert.deepEqual(await ctx.scheduler.tick(), [ctx.tasks[0].id]);
  await waitUntil(() => dones.length >= 2, { message: '第二次限流运行应收尾' });
  assert.equal(getTask(ctx.db, ctx.tasks[0].id).status, 'queued');
  assert.equal(getTask(ctx.db, ctx.tasks[1].id).status, 'queued', '第二个任务还没轮到');
});

test('rateLimitBackoffMinutes: 1 时只暂停 1 分钟', async (t) => {
  const ctx = setup(t, {
    config: { rateLimitBackoffMinutes: 1 },
    runner: { script: [{ status: 'failed', rateLimited: true, error: 'rate_limit: 429' }] },
  });
  const dones = collectEvents(t, ctx.scheduler.events, ['done']);
  await ctx.scheduler.tick();
  await waitUntil(() => dones.length >= 1);
  assert.deepEqual(ctx.scheduler.status().pausedUntil, new Date('2026-10-10T07:01:00Z'));

  ctx.setNow('2026-10-10T07:00:30Z');
  assert.deepEqual(await ctx.scheduler.tick(), []);
  ctx.setNow('2026-10-10T07:01:30Z');
  assert.deepEqual(await ctx.scheduler.tick(), [ctx.tasks[0].id]);
  await waitUntil(() => dones.length >= 2, { message: '第二次限流运行应收尾' });
});

// ---------------------------------------------------------------- 高峰

test('单元·高峰：07:00Z 只领 allowPeak；10:30Z 恢复领普通任务；allowPeak 配置放开后都领', async (t) => {
  const ctx = setup(t, {
    taskCount: 2,
    taskSpec: {}, // 第一个普通
    clockAt: '2026-10-08T07:00:00Z', // 周四北京 15:00，高峰
  });
  const peaky = createTask(ctx.db, { repo: 'a/b', prompt: 'allow peak', allowPeak: true });
  ctx.setNow('2026-10-08T07:00:00Z');
  assert.deepEqual(await ctx.scheduler.tick(), [peaky.id], '高峰只领 allowPeak 任务');
  assert.equal(getTask(ctx.db, ctx.tasks[0].id).status, 'queued');
  await waitUntil(() => getTask(ctx.db, peaky.id).status === 'succeeded');

  const blockedStatus = ctx.scheduler.status().blocked;
  // blocked 是 tick 间记下的判定；此刻最后一次判定发生在领取前（高峰）——领完后没有再 tick
  assert.ok(blockedStatus === null || blockedStatus.reason === 'peak');

  // 10:30Z（北京 18:30）非高峰：普通任务可领
  ctx.setNow('2026-10-08T10:30:00Z');
  assert.deepEqual(await ctx.scheduler.tick(), [ctx.tasks[0].id]);
  await waitUntil(() => getTask(ctx.db, ctx.tasks[0].id).status === 'succeeded');
  assert.equal(ctx.scheduler.status().blocked, null, '非高峰且队列已空：不再被拦');
});

test('高峰时 status().blocked = peak，retryAt 为本次高峰结束时刻（10:00Z）', async (t) => {
  const ctx = setup(t, { clockAt: '2026-10-08T07:00:00Z' });
  await ctx.scheduler.tick(); // 队列里有普通任务，但高峰 + 不允许 → 不领
  const blocked = ctx.scheduler.status().blocked;
  assert.ok(blocked !== null);
  assert.equal(blocked.reason, 'peak');
  assert.deepEqual(blocked.retryAt, new Date('2026-10-08T10:00:00Z'));
});

test('config.allowPeak: true 时高峰也领普通任务', async (t) => {
  const ctx = setup(t, {
    config: { allowPeak: true },
    clockAt: '2026-10-08T07:00:00Z',
  });
  assert.deepEqual(await ctx.scheduler.tick(), [ctx.tasks[0].id]);
  await waitUntil(() => getTask(ctx.db, ctx.tasks[0].id).status === 'succeeded');
});

// ---------------------------------------------------------------- 额度

test('单元·额度：五小时窗口已满 → tick 不领，blocked = five-hour，retryAt 等于 resetsAt', async (t) => {
  const ctx = setup(t, { clockAt: '2026-10-10T07:00:00Z' }); // 周六非高峰
  const feeder = createTask(ctx.db, { repo: 'a/b', prompt: 'feeder' });
  const now = new Date('2026-10-10T07:00:00Z');
  for (const minutesAgo of [60, 50, 40, 30]) {
    seedRun(ctx.db, feeder.id, {
      startedAt: new Date(now.getTime() - minutesAgo * 60_000),
      quotaUnits: 360,
    });
  }
  assert.deepEqual(await ctx.scheduler.tick(), [], '额度预检不通过就不领');
  assert.equal(getTask(ctx.db, ctx.tasks[0].id).status, 'queued');

  const blocked = ctx.scheduler.status().blocked;
  assert.equal(blocked.reason, 'five-hour');
  const expected = quotaUsage(
    listRuns(ctx.db, { since: new Date(now.getTime() - 7 * 24 * 3600_000), limit: 10000 }),
    now,
    { plan: 'v2-max', weekStart: null },
  );
  assert.deepEqual(blocked.retryAt, expected.fiveHour.resetsAt);
});

test('blocked 事件按 (reason, retryAt) 去重：连续多轮只发一次', async (t) => {
  const ctx = setup(t, { clockAt: '2026-10-10T07:00:00Z' });
  const feeder = createTask(ctx.db, { repo: 'a/b', prompt: 'feeder' });
  const now = new Date('2026-10-10T07:00:00Z');
  seedRun(ctx.db, feeder.id, { startedAt: new Date(now.getTime() - 3600_000), quotaUnits: 1600 });
  const events = collectEvents(t, ctx.scheduler.events, ['blocked']);
  await ctx.scheduler.tick();
  await ctx.scheduler.tick();
  await ctx.scheduler.tick();
  assert.equal(events.length, 1, '同一拦截只发一次 blocked 事件');
  assert.equal(events[0].payload.reason, 'five-hour');
});

// ---------------------------------------------------------------- 并发与重入

test('单元·并发：concurrency 2 + 300ms 假 runner + 3 个任务 → 峰值恰为 2，最终 3 个都成功', async (t) => {
  const ctx = setup(t, { taskCount: 3, config: { concurrency: 2 }, runner: { delayMs: 300 } });
  assert.deepEqual(await ctx.scheduler.tick(), [ctx.tasks[0].id, ctx.tasks[1].id]);
  // 流水线异步启动：等两个 runner 真正同时挂起在 300ms 延迟上
  await waitUntil(() => ctx.fakeRunner.maxActive() === 2, { message: '两个 runner 应同时运行' });
  assert.deepEqual(await ctx.scheduler.tick(), [], '并发已满，本轮不补');
  await waitUntil(() => getTask(ctx.db, ctx.tasks[1].id).status === 'succeeded');
  assert.deepEqual(await ctx.scheduler.tick(), [ctx.tasks[2].id]);
  await waitUntil(() => getTask(ctx.db, ctx.tasks[2].id).status === 'succeeded');
  for (const task of ctx.tasks) {
    assert.equal(getTask(ctx.db, task.id).status, 'succeeded');
  }
  assert.equal(ctx.fakeRunner.maxActive(), 2, '任意时刻运行中不超过 2 个');
});

test('tick 重入安全：并发两次 tick（concurrency 1）只领一个任务', async (t) => {
  const ctx = setup(t, { runner: { delayMs: 200 } });
  const [a, b] = await Promise.all([ctx.scheduler.tick(), ctx.scheduler.tick()]);
  const claimed = [...a, ...b];
  assert.equal(claimed.length, 1, '两次重叠的 tick 绝不超发');
  await waitUntil(() => getTask(ctx.db, claimed[0]).status === 'succeeded');
});

test('tick 的时钟非法：记日志返回 []，不抛错', async (t) => {
  const ctx = setup(t);
  const broken = createScheduler({
    db: ctx.db, config: ctx.config, home: ctx.home,
    clock: () => null, runner: ctx.fakeRunner.runner, git: ctx.fakeGit.git, env: fakeEnv(),
  });
  assert.deepEqual(await broken.tick(), []);
});

// ---------------------------------------------------------------- runNow

test('单元·runNow：无视高峰跑完整流水，返回最终任务；id 接受数字字符串', async (t) => {
  const ctx = setup(t, { clockAt: '2026-10-08T07:00:00Z' }); // 高峰
  const done = [];
  ctx.scheduler.events.on('done', (payload) => done.push(payload));
  const final = await ctx.scheduler.runNow(String(ctx.tasks[0].id));
  assert.equal(final.id, ctx.tasks[0].id);
  assert.equal(final.status, 'succeeded');
  assert.equal(final.prUrl, 'https://github.com/a/b/pull/7');
  assert.equal(done.length, 1);

  // 非 queued（已 succeeded）→ InvalidTransitionError
  await assert.rejects(
    () => ctx.scheduler.runNow(ctx.tasks[0].id),
    (err) => err instanceof InvalidTransitionError && err.from === 'succeeded',
  );
  // 非法 id → TypeError
  for (const bad of ['abc', '12x', 0, -1, 1.5, null, {}]) {
    await assert.rejects(() => ctx.scheduler.runNow(bad), TypeError, JSON.stringify(bad));
  }
});

test('runNow 绕过并发与限流暂停，但登记进 running（stop 能看到它）', async (t) => {
  const ctx = setup(t, {
    taskCount: 2,
    runner: { script: [{ hang: true, onAbort: { status: 'failed', error: 'interrupted' } }] },
  });
  const first = ctx.scheduler.runNow(ctx.tasks[0].id);
  await waitUntil(() => ctx.scheduler.status().running.includes(ctx.tasks[0].id));
  assert.deepEqual(ctx.scheduler.status().running, [ctx.tasks[0].id]);
  const second = ctx.scheduler.runNow(ctx.tasks[1].id); // 并发 1 也能 runNow
  await waitUntil(() => ctx.scheduler.status().running.length === 2);
  await ctx.scheduler.stop({ force: true });
  assert.equal((await first).status, 'queued');
  assert.equal((await second).status, 'queued');
  assert.deepEqual(ctx.scheduler.status().running, []);
});

// ---------------------------------------------------------------- 取消与停机

test('单元·取消：另一连接 cancelTask → 轮询 abort → done canceled，任务保持 canceled', async (t) => {
  const ctx = setup(t, { runner: { script: [{ hang: true }] } });
  const events = collectEvents(t, ctx.scheduler.events, ['done']);
  await ctx.scheduler.tick();
  await waitUntil(() => ctx.scheduler.status().running.length === 1);

  const db2 = openDb(path.join(ctx.home, 'night-shift.db'));
  t.after(() => db2.close());
  cancelTask(db2, ctx.tasks[0].id);
  await waitUntil(() => events.some((e) => e.name === 'done'), { timeoutMs: 2000, message: '取消应在 2 秒内完成' });

  const done = events.find((e) => e.name === 'done').payload;
  assert.equal(done.status, 'canceled');
  assert.equal(getTask(ctx.db, ctx.tasks[0].id).status, 'canceled', '不被 finishTask 覆盖');
  assert.ok(ctx.fakeGit.calls.some((c) => c.name === 'removeWorktree'), '取消也要清理 worktree');
});

test('单元·停机：优雅 stop 不结束；升级 force 后任务放回队列、退还尝试、tick 不再领', async (t) => {
  const ctx = setup(t, { runner: { script: [{ hang: true, onAbort: { status: 'failed', error: 'interrupted' } }] } });
  const events = collectEvents(t, ctx.scheduler.events, ['done']);
  assert.deepEqual(await ctx.scheduler.tick(), [ctx.tasks[0].id]);
  await waitUntil(() => ctx.scheduler.status().running.length === 1);

  const graceful = ctx.scheduler.stop();
  let settled = false;
  graceful.then(() => { settled = true; });
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(settled, false, '优雅停止要等运行中的任务，Promise 不应结束');
  assert.equal(ctx.scheduler.status().stopping, true);

  await ctx.scheduler.stop({ force: true });
  await graceful;
  assert.equal(settled, true);

  const task = getTask(ctx.db, ctx.tasks[0].id);
  assert.equal(task.status, 'queued');
  assert.equal(task.attempts, 0, '停机中断退还这次尝试');
  assert.equal(task.notBefore, null, '停机中断不写退避时刻');
  const done = events.find((e) => e.name === 'done').payload;
  assert.equal(done.status, 'queued');
  assert.deepEqual(await ctx.scheduler.tick(), [], '停止后不再领取');
});

test('stop 后再 start 可重启；start 幂等', async (t) => {
  const ctx = setup(t, { config: { pollSeconds: 0.02 } });
  await ctx.scheduler.start();
  await ctx.scheduler.start(); // 幂等
  await ctx.scheduler.stop();
  const recovered = ctx.scheduler.start();
  assert.deepEqual(recovered, []);
  await waitUntil(() => getTask(ctx.db, ctx.tasks[0].id).status === 'succeeded');
  await ctx.scheduler.stop();
});

// ---------------------------------------------------------------- 启动恢复与轮询

test('单元·启动恢复：库里有 running 任务与未结束 run，start() 放回队列并重新执行', async (t) => {
  const home = makeTempHome(t);
  const db = openDb(path.join(home, 'night-shift.db'));
  const task = createTask(db, { repo: 'a/b', prompt: 'p' });
  const stale = claimTaskById(db, task.id);
  const staleRun = startRun(db, {
    taskId: task.id, attempt: 1, model: 'glm-5.3', effort: 'medium', peak: false, logPath: '/tmp/old.log',
  });

  const fakeRunner = makeFakeRunner();
  const fakeGit = makeFakeGit();
  const scheduler = createScheduler({
    db, config: { ...DEFAULT_CONFIG, pollSeconds: 0.02 }, home,
    clock: () => new Date('2026-10-10T07:00:00Z'),
    runner: fakeRunner.runner, git: fakeGit.git, cancelPollMs: 20, env: fakeEnv(),
  });
  t.after(() => {
    scheduler.stop();
    db.close();
  });
  const recovered = scheduler.start();
  assert.deepEqual(recovered, [task.id]);
  await waitUntil(() => getTask(db, task.id).status === 'succeeded');
  await scheduler.stop();

  assert.equal(stale.status, 'running');
  // 假 runner 不写 runs 表：重新执行体现为 runner 被调用过一次、任务最终 succeeded
  assert.equal(fakeRunner.calls.length, 1);
  const old = listRuns(db, { taskId: task.id }).find((r) => r.id === staleRun.id);
  assert.equal(old.status, 'failed');
  assert.equal(old.error, 'interrupted');
});

// ---------------------------------------------------------------- status 初始态

test('status() 初始：running 空、未停止、无暂停、无拦截', (t) => {
  const ctx = setup(t);
  assert.deepEqual(ctx.scheduler.status(), {
    running: [], stopping: false, pausedUntil: null, blocked: null,
  });
});


// ---------------------------------------------------------------- 加固轮（自查）

test('闸门二次确认不通过：任务原样退回队列（attempts/not_before 不变、无 run 行），blocked 带原因', async (t) => {
  const retryAt = new Date('2026-10-10T08:00:00Z');
  const ctx = setup(t, {
    gateOverride: { startDecision: () => ({ ok: false, reason: 'five-hour', retryAt }) },
  });
  const id = ctx.tasks[0].id;
  // 预置一个带历史 not_before 的 queued 任务（时刻已过，可被领取），验证退回时不被改写
  claimTaskById(ctx.db, id);
  finishTask(ctx.db, id, { status: 'queued', refundAttempt: true, notBefore: '2026-10-10T06:00:00.000Z' });
  const before = getTask(ctx.db, id);
  assert.equal(before.status, 'queued');
  const blockedEvents = collectEvents(t, ctx.scheduler.events, ['blocked']);

  assert.deepEqual(await ctx.scheduler.tick(), [], '二次确认不通过：本轮不执行任何任务');
  const after = getTask(ctx.db, id);
  assert.equal(after.status, 'queued', '任务回到 queued');
  assert.equal(after.attempts, before.attempts, '领取的这次尝试被退还');
  assert.equal(after.notBefore, before.notBefore, 'not_before 不被二次确认改写');
  assert.deepEqual(listRuns(ctx.db), [], '没有创建任何 run 行');
  assert.equal(ctx.scheduler.status().blocked.reason, 'five-hour');
  assert.deepEqual(ctx.scheduler.status().blocked.retryAt, retryAt);
  assert.ok(blockedEvents.some((e) => e.payload.reason === 'five-hour'));
});

test('runNow：停止中明确拒绝且不领任务；任务不存在抛 NotFoundError；已被领走不会执行两次', async (t) => {
  const ctx = setup(t, {
    runner: { script: [{ hang: true, onAbort: { status: 'failed', error: 'interrupted' } }] },
  });
  await assert.rejects(() => ctx.scheduler.runNow(9999), (err) => err instanceof NotFoundError);
  await ctx.scheduler.stop();
  await assert.rejects(
    () => ctx.scheduler.runNow(ctx.tasks[0].id),
    (err) => err instanceof Error && err.message.includes('停止'),
  );
  assert.equal(getTask(ctx.db, ctx.tasks[0].id).status, 'queued', '拒绝时任务未被领取');

  // 重启后：tick 先领走（挂起中），再 runNow 同一个 → InvalidTransitionError，绝不二次执行
  ctx.scheduler.start();
  assert.deepEqual(await ctx.scheduler.tick(), [ctx.tasks[0].id]);
  await waitUntil(() => ctx.scheduler.status().running.includes(ctx.tasks[0].id));
  await assert.rejects(
    () => ctx.scheduler.runNow(ctx.tasks[0].id),
    (err) => err instanceof InvalidTransitionError && err.from === 'running',
  );
  await ctx.scheduler.stop({ force: true });
  assert.equal(getTask(ctx.db, ctx.tasks[0].id).status, 'queued');
  assert.deepEqual(ctx.scheduler.status().running, []);
});

test('removeWorktree 抛错：任务结果不受影响，running 登记照常清空', async (t) => {
  const ctx = setup(t, {
    git: { removeWorktree: () => { throw new Error('cleanup boom'); } },
  });
  const dones = collectEvents(t, ctx.scheduler.events, ['done']);
  assert.deepEqual(await ctx.scheduler.tick(), [ctx.tasks[0].id]);
  await waitUntil(() => dones.length >= 1);
  assert.equal(getTask(ctx.db, ctx.tasks[0].id).status, 'succeeded', '清理失败不影响任务结果');
  assert.deepEqual(ctx.scheduler.status().running, [], '并发名额已释放');
});

test('runner 同步抛错 → 普通失败（run: 前缀），running 清空', async (t) => {
  const ctx = setup(t, {
    runnerOverride: () => { throw new Error('runner sync boom'); },
  });
  assert.deepEqual(await ctx.scheduler.tick(), [ctx.tasks[0].id]);
  await waitUntil(() => getTask(ctx.db, ctx.tasks[0].id).status === 'queued');
  const task = getTask(ctx.db, ctx.tasks[0].id);
  assert.equal(task.lastError, 'run: runner sync boom');
  assert.equal(task.attempts, 1);
  assert.deepEqual(ctx.scheduler.status().running, []);
});

test('claim/done 事件监听器抛错：不拦流水线，任务照常收尾、照常清理 running', async (t) => {
  const ctx = setup(t);
  const badClaim = () => { throw new Error('claim listener boom'); };
  const badDone = () => { throw new Error('done listener boom'); };
  ctx.scheduler.events.on('claim', badClaim);
  ctx.scheduler.events.on('done', badDone);
  t.after(() => {
    ctx.scheduler.events.off('claim', badClaim);
    ctx.scheduler.events.off('done', badDone);
  });
  assert.deepEqual(await ctx.scheduler.tick(), [ctx.tasks[0].id]);
  await waitUntil(() => getTask(ctx.db, ctx.tasks[0].id).status === 'succeeded');
  assert.deepEqual(ctx.scheduler.status().running, []);
});

test('取消轮询读库抛错：记日志跳过该轮不崩，读库恢复后仍能把任务取消掉', async (t) => {
  const home = makeTempHome(t);
  const db = openDb(path.join(home, 'night-shift.db'));
  const task = createTask(db, { repo: 'a/b', prompt: 'x', title: 't', testCommand: null });
  let failReads = false;
  const dbProxy = new Proxy(db, {
    get(target, prop, receiver) {
      if (failReads && prop === 'prepare') throw new Error('db boom');
      const value = Reflect.get(target, prop, receiver);
      // 原生 DatabaseSync 方法必须绑定到真实实例上调用（否则 Illegal invocation）
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const { runner } = makeFakeRunner([{ hang: true }]);
  const { git } = makeFakeGit();
  const scheduler = createScheduler({
    db: dbProxy, config: { ...DEFAULT_CONFIG }, home,
    clock: () => new Date('2026-10-10T07:00:00Z'), runner, git,
    cancelPollMs: 20, env: fakeEnv(),
  });
  t.after(() => {
    scheduler.stop();
    db.close();
  });
  const dones = collectEvents(t, scheduler.events, ['done']);
  assert.deepEqual(await scheduler.tick(), [task.id]);
  await waitUntil(() => scheduler.status().running.includes(task.id));
  failReads = true;
  await new Promise((resolve) => setTimeout(resolve, 60)); // 几轮轮询全部抛错：只记日志
  failReads = false;
  cancelTask(db, task.id);
  await waitUntil(() => dones.length >= 1, { message: '读库恢复后应能取消任务' });
  assert.equal(getTask(db, task.id).status, 'canceled');
  assert.deepEqual(scheduler.status().running, []);
});

test('done 事件在释放并发名额之后才发：监听者看到的 status().running 已不含该任务，紧接着 tick() 能立刻补位', async (t) => {
  const ctx = setup(t, { taskCount: 2, config: { concurrency: 1 } });
  const seen = [];
  const nextClaims = [];
  ctx.scheduler.events.on('done', (e) => {
    seen.push({ taskId: e.taskId, running: ctx.scheduler.status().running.slice() });
  });
  assert.deepEqual(await ctx.scheduler.tick(), [ctx.tasks[0].id]);
  await waitUntil(() => seen.length === 1);
  assert.deepEqual(seen[0], { taskId: ctx.tasks[0].id, running: [] });
  // 收到 done 之后马上 tick：名额已空出，第二个任务立刻被领取
  nextClaims.push(...await ctx.scheduler.tick());
  assert.deepEqual(nextClaims, [ctx.tasks[1].id]);
  await waitUntil(() => seen.length === 2);
  assert.deepEqual(seen[1], { taskId: ctx.tasks[1].id, running: [] });
});
