// issue #83（详情页「立刻跑」）的服务端与调度器拆分验收：POST /api/tasks/:id/run-now
// 与 beginRunNow / runNow。真 createServer + 真 createScheduler，runner / git 用假替身
// ——runner 是「门控」的：每次调用挂起，直到测试 release（或停机 abort）才收场，用来
// 证明 202 先于流水线结束发出、runNow 仍在等到结束才 resolve。绝不真的 clone / gh /
// claude（git 假、env 走 fakeEnv、home 是临时目录）。
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db.js';
import { createServer } from '../src/server.js';
import { createScheduler } from '../src/scheduler.js';
import * as realGit from '../src/git.js';
import {
  claimTaskById,
  createTask,
  finishTask,
  getTask,
  listRuns,
  setUserPaused,
  startRun,
  finishRun,
} from '../src/tasks.js';
import { fakeEnv, makeTempHome } from './helpers.js';

// —— 假 runner / 假 git（拷自 test/scheduler-unit.test.js 的最小面，runner 换成门控） ——

/** 与 runTask 成功结果同形的结果对象（release 前可改 call.result 脚本化某次的结果）。 */
const RUN_OK = {
  runId: 1, status: 'succeeded', exitCode: 0, signal: null, numTurns: 3, isError: false,
  summary: 'fake summary', error: null, rateLimited: false,
  model: 'glm-5.3', effort: 'medium', peak: false, quotaUnits: 1, durationMs: 1200,
  logPath: '/tmp/fake.log',
};

/**
 * 门控假 runner：每次调用挂起，直到测试调用 calls[i].release()（或停机 abort 信号）
 * 才以 call.result（缺省 RUN_OK）收场。release 前改 call.result 可以脚本化那一次的
 * 结果（如限流）。用来把「服务端已回话」与「流水线已结束」在时间上拆开。
 */
function makeGatedRunner() {
  const calls = [];
  const runner = async (info) => {
    const call = { info, result: { ...RUN_OK }, release: null };
    calls.push(call);
    await new Promise((resolve) => {
      call.release = resolve;
      // 已停止的信号不会再发 abort 事件，先查再挂（与 scheduler-unit 的假 runner 同款）
      if (info.signal.aborted) resolve();
      else info.signal.addEventListener('abort', () => resolve(), { once: true });
    });
    return call.result;
  };
  return { runner, calls };
}

/** 带调用记录的假 git 模块；prTitle/buildPrBody 用真实现（PR 文本不在意）。 */
function makeFakeGit() {
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
    git[name] = async (args) => defaultFn(args);
  }
  return { git };
}

// —— 环境 ——

/** 时钟固定在高峰（周四北京 15:00）：所有用例默认身处高峰，验证 run-now 无视它。 */
const CLOCK_AT = '2026-10-08T07:00:00Z';

/**
 * 一套验收环境：临时 home + 文件库 + n 条排队任务（repo a/b）+ 真 createScheduler
 * （门控假 runner、假 git、注入时钟）+ 真 createServer（缺省把调度器挂进 deps）。
 * 收尾统一强停调度器（abort 让挂着的门全开）再关服务与库。
 */
async function setup(t, { taskCount = 1, withScheduler = true, config: configOverrides = {} } = {}) {
  const home = makeTempHome(t);
  const env = fakeEnv({ NIGHT_SHIFT_HOME: home });
  const db = openDb(path.join(home, 'night-shift.db'));
  const tasks = [];
  for (let i = 0; i < taskCount; i += 1) {
    tasks.push(createTask(db, {
      repo: 'a/b', prompt: `任务 ${i}`, title: `task ${i}`, testCommand: null,
    }));
  }
  const config = { ...loadConfig({ home, env }), ...configOverrides };
  let now = new Date(CLOCK_AT);
  const clock = () => now;
  const fakeRunner = makeGatedRunner();
  const { git } = makeFakeGit();
  const scheduler = createScheduler({
    db, config, home, clock, runner: fakeRunner.runner, git, cancelPollMs: 20, env,
  });
  const server = withScheduler
    ? createServer({ db, config, home, clock, scheduler, env })
    : createServer({ db, config, home, clock, env });
  const base = await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
  });
  t.after(async () => {
    await scheduler.stop({ force: true }); // abort 信号把还没 release 的门都打开
    server.close();
    server.closeAllConnections();
    db.close();
  });
  return {
    base, db, tasks, scheduler, fakeRunner,
    setNow: (at) => { now = new Date(at); },
  };
}

/** POST JSON（服务端的 POST 防护要求 application/json）。 */
function postJson(url, body) {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
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

/** 造一条历史运行（额度满载用）：直接写库并改 started_at，挂在 feeder 任务名下。 */
function seedRun(db, taskId, { startedAt, quotaUnits }) {
  const run = startRun(db, {
    taskId, attempt: 1, model: 'glm-5.3', effort: 'medium', peak: false, logPath: '/tmp/x.log',
  });
  finishRun(db, run.id, { status: 'succeeded', quotaUnits });
  db.prepare('UPDATE runs SET started_at = ? WHERE id = ?').run(new Date(startedAt).toISOString(), run.id);
  return run;
}

// ---------------------------------------------------------------- 202 先于流水线结束

test('验收: 排队任务 POST {}：runner 的门还关着时就回 202，正文 { id, status: "running" }；任务已 running、attempts +1；release 后才 succeeded', async (t) => {
  const ctx = await setup(t);
  const res = await postJson(`${ctx.base}/api/tasks/${ctx.tasks[0].id}/run-now`, {});
  assert.equal(res.status, 202);
  assert.deepEqual(await res.json(), { id: ctx.tasks[0].id, status: 'running' });

  // 响应已经发出（上面 await 的是响应），而流水线还没跑完：门没开，任务已被领走
  const task = getTask(ctx.db, ctx.tasks[0].id);
  assert.equal(task.status, 'running');
  assert.equal(task.attempts, 1);
  assert.ok(ctx.scheduler.status().running.includes(ctx.tasks[0].id), '已登记进 running');

  // 等门真正挂上再放行：done 收尾 succeeded（假 git 全成功），终态与流水线一致
  await waitUntil(() => ctx.fakeRunner.calls.length >= 1, { message: 'runner 应已被调用' });
  ctx.fakeRunner.calls[0].release();
  await waitUntil(() => getTask(ctx.db, ctx.tasks[0].id).status === 'succeeded');
  assert.equal(getTask(ctx.db, ctx.tasks[0].id).attempts, 1);
});

// ---------------------------------------------------------------- 无视高峰 / 额度 / 暂停 / 限流 / not_before / 并发 / 同仓库

test('验收: 高峰（allowPeak 缺省 false）：tick 领不到，POST 仍是 202 且变 running', async (t) => {
  const ctx = await setup(t);
  assert.deepEqual(await ctx.scheduler.tick(), [], '高峰期 tick 不领普通任务');
  assert.equal(ctx.scheduler.status().blocked?.reason, 'peak');
  const res = await postJson(`${ctx.base}/api/tasks/${ctx.tasks[0].id}/run-now`, {});
  assert.equal(res.status, 202);
  assert.equal(getTask(ctx.db, ctx.tasks[0].id).status, 'running');
});

test('验收: 五小时额度已满：tick 领不到（blocked five-hour），POST 仍是 202 且变 running', async (t) => {
  const ctx = await setup(t);
  const feeder = createTask(ctx.db, { repo: 'a/b', prompt: 'feeder' });
  const now = new Date(CLOCK_AT);
  // v2-max 五小时限额 1600 × safetyRatio 0.9 = 1440：四条 360 刚好顶满
  for (const minutesAgo of [60, 50, 40, 30]) {
    seedRun(ctx.db, feeder.id, {
      startedAt: new Date(now.getTime() - minutesAgo * 60_000),
      quotaUnits: 360,
    });
  }
  assert.deepEqual(await ctx.scheduler.tick(), [], '额度预检不通过就不领');
  assert.equal(ctx.scheduler.status().blocked?.reason, 'five-hour');
  assert.equal(getTask(ctx.db, ctx.tasks[0].id).status, 'queued');

  const res = await postJson(`${ctx.base}/api/tasks/${ctx.tasks[0].id}/run-now`, {});
  assert.equal(res.status, 202);
  assert.equal(getTask(ctx.db, ctx.tasks[0].id).status, 'running');
});

test('验收: 手动暂停（setUserPaused true）：tick 领不到，POST 仍是 202 且变 running', async (t) => {
  const ctx = await setup(t);
  setUserPaused(ctx.db, true);
  assert.deepEqual(await ctx.scheduler.tick(), [], '手动暂停期间不领新任务');
  const res = await postJson(`${ctx.base}/api/tasks/${ctx.tasks[0].id}/run-now`, {});
  assert.equal(res.status, 202);
  assert.equal(getTask(ctx.db, ctx.tasks[0].id).status, 'running');
});

test('验收: 限流退避中（pausedUntil 非 null、blocked rate-limit）：POST 另一条排队任务仍是 202 且变 running', async (t) => {
  const ctx = await setup(t, { taskCount: 2 });
  const dones = [];
  ctx.scheduler.events.on('done', (payload) => dones.push(payload));
  // 第一条：POST 点名跑，脚本化成限流失败，走完整个退避收尾
  const first = await postJson(`${ctx.base}/api/tasks/${ctx.tasks[0].id}/run-now`, {});
  assert.equal(first.status, 202);
  await waitUntil(() => ctx.fakeRunner.calls.length >= 1, { message: '第一条的 runner 应已挂上' });
  ctx.fakeRunner.calls[0].result = { ...ctx.fakeRunner.calls[0].result, status: 'failed', rateLimited: true, error: 'rate_limit: 429' };
  ctx.fakeRunner.calls[0].release();
  await waitUntil(() => dones.length >= 1, { message: '第一条的流水线应收尾' });

  const status = ctx.scheduler.status();
  assert.ok(status.pausedUntil !== null, '限流后全局暂停生效');
  assert.equal(status.blocked?.reason, 'rate-limit');
  assert.equal(getTask(ctx.db, ctx.tasks[0].id).status, 'queued', '限流退回队列');
  assert.deepEqual(await ctx.scheduler.tick(), [], '全局暂停期间 tick 不领');

  // 第二条排队任务：限流退避不拦点名跑
  const res = await postJson(`${ctx.base}/api/tasks/${ctx.tasks[1].id}/run-now`, {});
  assert.equal(res.status, 202);
  assert.equal(getTask(ctx.db, ctx.tasks[1].id).status, 'running');
});

test('验收: not_before 在未来：tick 领不到（非高峰时钟，只剩 not_before 拦着），POST 仍是 202 且变 running', async (t) => {
  const ctx = await setup(t);
  ctx.setNow('2026-10-08T10:30:00Z'); // 北京 18:30，非高峰：排除高峰干扰
  ctx.db.prepare('UPDATE tasks SET not_before = ? WHERE id = ?')
    .run('2026-10-08T12:00:00.000Z', ctx.tasks[0].id);
  assert.deepEqual(await ctx.scheduler.tick(), [], 'not_before 未到不领');
  assert.equal(getTask(ctx.db, ctx.tasks[0].id).status, 'queued');
  const res = await postJson(`${ctx.base}/api/tasks/${ctx.tasks[0].id}/run-now`, {});
  assert.equal(res.status, 202);
  assert.equal(getTask(ctx.db, ctx.tasks[0].id).status, 'running');
});

test('验收: 并发已满（concurrency 1 占用中）且同仓库已有 running：tick 领不到，POST 另一条仍是 202 且变 running', async (t) => {
  const ctx = await setup(t, { taskCount: 2 }); // 两条同 repo a/b，oneTaskPerRepo 缺省 true
  ctx.setNow('2026-10-08T10:30:00Z'); // 非高峰：排除高峰干扰
  const first = await postJson(`${ctx.base}/api/tasks/${ctx.tasks[0].id}/run-now`, {});
  assert.equal(first.status, 202);
  await waitUntil(() => ctx.fakeRunner.calls.length >= 1, { message: '第一条的 runner 应已挂上' });
  assert.deepEqual(await ctx.scheduler.tick(), [], '并发满 + 同仓库 running：tick 都领不到');
  assert.equal(getTask(ctx.db, ctx.tasks[1].id).status, 'queued');

  const res = await postJson(`${ctx.base}/api/tasks/${ctx.tasks[1].id}/run-now`, {});
  assert.equal(res.status, 202);
  assert.equal(getTask(ctx.db, ctx.tasks[1].id).status, 'running');
});

// ---------------------------------------------------------------- 拒绝路径

test('验收: 依赖未完成：409，error 含依赖 id；任务仍 queued、attempts 不变、runs 不变、runner 没被调用', async (t) => {
  const ctx = await setup(t, { taskCount: 0 });
  const dep = createTask(ctx.db, { repo: 'a/b', prompt: '上游' });
  const blocked = createTask(ctx.db, { repo: 'a/b', prompt: '下游', dependsOn: [dep.id] });

  const res = await postJson(`${ctx.base}/api/tasks/${blocked.id}/run-now`, {});
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.ok(body.error.includes(`#${dep.id}`), `error 应点名依赖 id：${body.error}`);
  assert.ok(body.error.includes('依赖'), body.error);

  assert.equal(getTask(ctx.db, blocked.id).status, 'queued');
  assert.equal(getTask(ctx.db, blocked.id).attempts, 0);
  assert.deepEqual(listRuns(ctx.db, { taskId: blocked.id }), [], '没有产生 run');
  assert.equal(ctx.fakeRunner.calls.length, 0, 'runner 没被调用');
});

test('验收: 不是 queued（succeeded 与 running 各一条）：409，error 含当前状态、「不是 queued」、「retry」；状态与 attempts 不变', async (t) => {
  const ctx = await setup(t, { taskCount: 2 });
  claimTaskById(ctx.db, ctx.tasks[0].id);
  finishTask(ctx.db, ctx.tasks[0].id, { status: 'succeeded', prUrl: 'https://github.com/a/b/pull/7' });
  claimTaskById(ctx.db, ctx.tasks[1].id); // running，attempts 1

  for (const [task, expected] of [[ctx.tasks[0], 'succeeded'], [ctx.tasks[1], 'running']]) {
    const res = await postJson(`${ctx.base}/api/tasks/${task.id}/run-now`, {});
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.ok(body.error.includes(expected), `error 应含当前状态 ${expected}：${body.error}`);
    assert.ok(body.error.includes('不是 queued'), body.error);
    assert.ok(body.error.includes('retry'), body.error);
    assert.equal(getTask(ctx.db, task.id).status, expected, '状态不变');
  }
  assert.equal(getTask(ctx.db, ctx.tasks[0].id).attempts, 1, 'succeeded 那条 attempts 不变');
  assert.equal(getTask(ctx.db, ctx.tasks[1].id).attempts, 1, 'running 那条 attempts 不变');
});

test('验收: 任务不存在：404（与 GET 详情同一条）', async (t) => {
  const ctx = await setup(t);
  const res = await postJson(`${ctx.base}/api/tasks/9999/run-now`, {});
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.ok(body.error.includes('9999'), body.error);
});

test('验收: 调度器没挂（createServer 不传 scheduler）且任务 queued：409，error 精确是「调度器没在跑」，任务仍 queued', async (t) => {
  const ctx = await setup(t, { withScheduler: false });
  const res = await postJson(`${ctx.base}/api/tasks/${ctx.tasks[0].id}/run-now`, {});
  assert.equal(res.status, 409);
  assert.deepEqual(await res.json(), { error: '调度器没在跑' });
  assert.equal(getTask(ctx.db, ctx.tasks[0].id).status, 'queued');
  assert.equal(getTask(ctx.db, ctx.tasks[0].id).attempts, 0, '未领取');
});

test('验收: 调度器 stop() 之后未 start：409，error 含「调度器正在停止」，任务仍 queued、未领取', async (t) => {
  const ctx = await setup(t);
  await ctx.scheduler.stop();
  const res = await postJson(`${ctx.base}/api/tasks/${ctx.tasks[0].id}/run-now`, {});
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.ok(body.error.includes('调度器正在停止'), body.error);
  assert.ok(body.error.includes('未领取'), body.error);
  const task = getTask(ctx.db, ctx.tasks[0].id);
  assert.equal(task.status, 'queued');
  assert.equal(task.attempts, 0, '停止中拒绝时不领取');
  assert.equal(ctx.fakeRunner.calls.length, 0, 'runner 没被调用');
});

test('验收: 请求体 { extra: 1 }：400，error 含「未知字段」并带 field，任务仍 queued、runner 没被调用', async (t) => {
  const ctx = await setup(t);
  const res = await postJson(`${ctx.base}/api/tasks/${ctx.tasks[0].id}/run-now`, { extra: 1 });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.ok(body.error.includes('未知字段'), body.error);
  assert.equal(body.field, 'extra');
  assert.equal(getTask(ctx.db, ctx.tasks[0].id).status, 'queued');
  assert.equal(ctx.fakeRunner.calls.length, 0, 'runner 没被调用');
});

// ---------------------------------------------------------------- 调度器拆分：runNow 仍等到结束

test('验收: scheduler.runNow：runner 挂起期间 Promise 不 resolve；release 后才 resolve，终态与拆分前一致（命令行只 await 它）', async (t) => {
  const ctx = await setup(t);
  let settled = false;
  const pending = ctx.scheduler.runNow(String(ctx.tasks[0].id)); // id 接受数字字符串
  pending.then(() => { settled = true; });
  await waitUntil(() => ctx.fakeRunner.calls.length >= 1, { message: 'runner 应已挂上' });
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(settled, false, 'runner 还挂着：runNow 不该 resolve');

  ctx.fakeRunner.calls[0].release();
  const final = await pending;
  assert.equal(final.id, ctx.tasks[0].id);
  assert.equal(final.status, 'succeeded');
  assert.equal(final.prUrl, 'https://github.com/a/b/pull/7');
});

test('验收: beginRunNow 立刻返回 { id, status: "running", done }：不等 done，任务已在 running 里；done 结束后 resolve 终态', async (t) => {
  const ctx = await setup(t);
  const started = ctx.scheduler.beginRunNow(ctx.tasks[0].id);
  assert.equal(started.id, ctx.tasks[0].id);
  assert.equal(started.status, 'running');
  assert.equal(getTask(ctx.db, ctx.tasks[0].id).status, 'running', '返回时已领取');
  assert.ok(started.done instanceof Promise);

  await waitUntil(() => ctx.fakeRunner.calls.length >= 1, { message: 'runner 应已挂上' });
  let settled = false;
  started.done.then(() => { settled = true; });
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(settled, false, '门没开：done 不该 resolve');
  ctx.fakeRunner.calls[0].release();
  assert.equal((await started.done).status, 'succeeded');
});
