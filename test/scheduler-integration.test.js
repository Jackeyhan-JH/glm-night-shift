// src/scheduler.js 的集成测试（issue #9 验收项）：真 runTask + test/fixtures/fake-claude.mjs
// + 真 src/git.js + 本地 bare 仓库 + test/fixtures/fake-gh.mjs。绝不联网、不碰 GitHub、
// 不消耗额度；时间用可调时钟（不真等），等待一律轮询 + 截止时间。
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, MIGRATIONS } from '../src/db.js';
import {
  createTask, getTask, listRuns, cancelTask, claimTaskById, startRun, finishRun,
  InvalidTransitionError, DependencyBlockedError,
} from '../src/tasks.js';
import { DEFAULT_CONFIG } from '../src/config.js';
import { usage as quotaUsage } from '../src/quota.js';
import { createScheduler } from '../src/scheduler.js';
import { fakeEnv, makeTempHome, fixturePath } from './helpers.js';

// 隔离 git 配置（见 test/git.test.js 的同类说明）：不读机器配置，提交身份显式给
process.env.GIT_CONFIG_NOSYSTEM = '1';
process.env.GIT_CONFIG_GLOBAL = path.join(os.tmpdir(), 'night-shift-scheduler-test-absent-global-config');
process.env.GIT_AUTHOR_NAME = '夜班测试';
process.env.GIT_AUTHOR_EMAIL = 'night-shift-test@example.com';
process.env.GIT_COMMITTER_NAME = '夜班测试';
process.env.GIT_COMMITTER_EMAIL = 'night-shift-test@example.com';

const FAKE_CLAUDE = fixturePath('fake-claude.mjs');
const FAKE_GH = fixturePath('fake-gh.mjs');

/** 同步跑 git（参数数组，无 shell），失败即断言失败并附 stderr。 */
function git(args, cwd) {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.ok(res.status === 0, `git ${args.join(' ')} 失败（cwd=${cwd}）：${res.stderr}`);
  return res.stdout;
}

/** 建一个默认分支 main、含 README 的本地 bare 仓库当远端。 */
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

/** 轮询等待 fn() 为真（默认 5 秒超时），到点仍未真则断言失败。 */
async function waitUntil(fn, { timeoutMs = 5000, message = '条件在超时内未满足' } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await fn()) return;
    if (Date.now() >= deadline) assert.fail(message);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** 收集指定事件的 (name, payload) 序列，测试结束自动解绑。 */
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

/** 读 jsonl 日志文件（不存在返回空数组）。 */
function readJsonl(file) {
  try {
    return fs.readFileSync(file, 'utf8').trim().split('\n').filter((line) => line !== '')
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

/** bare 仓库里 night-shift/ 命名空间的分支列表。 */
function nightShiftBranches(bare) {
  return git(['for-each-ref', '--format=%(refname:short)', 'refs/heads/night-shift/'], bare)
    .trim().split('\n').filter((name) => name !== '');
}

/**
 * 一套集成环境：bare 远端 + 临时 home + 文件库 + 真 runner/git + 假 claude/gh + 可调时钟
 * （缺省 2026-10-10T07:00:00Z 周六非高峰）。taskSpecs 每项是一个 createTask 的输入。
 */
function setup(t, {
  taskSpecs = [{}], config: configOverrides = {}, env: envOverrides = {}, clockAt = '2026-10-10T07:00:00Z',
  cancelPollMs = 50,
} = {}) {
  const remote = makeBareRemote(t);
  const home = makeTempHome(t);
  const dbPath = path.join(home, 'night-shift.db');
  const db = openDb(dbPath);
  const config = {
    ...DEFAULT_CONFIG,
    remoteUrlTemplate: path.join(remote.dir, '{owner}__{name}.git'),
    ghBin: FAKE_GH,
    claudeBin: FAKE_CLAUDE,
    gitAuthorName: '夜班调度器测试',
    gitAuthorEmail: 'night-shift-scheduler-test@example.com',
    ...configOverrides,
  };
  const ghLog = path.join(home, 'gh-log.jsonl');
  const bodyCopy = path.join(home, 'pr-body.md');
  const argsLog = path.join(home, 'claude-args.jsonl');
  const env = fakeEnv({
    FAKE_GH_LOG: ghLog,
    FAKE_GH_BODY_COPY: bodyCopy,
    FAKE_CLAUDE_ARGS_LOG: argsLog,
    FAKE_GH_PR_NUMBER: '9',
    ...envOverrides,
  });
  const tasks = taskSpecs.map((spec) => createTask(db, { repo: 'a/b', prompt: '做点修改', title: '集成任务', ...spec }));
  let now = new Date(clockAt);
  const clock = () => now;
  const scheduler = createScheduler({ db, config, home, clock, cancelPollMs, env });
  // done 事件的记录器在调度器创建时就挂上（早于任何 tick），waitDone 轮询它——
  // 避免「先 tick 再挂监听」把已经发完的 done 漏掉
  const doneEvents = [];
  scheduler.events.on('done', (payload) => doneEvents.push(payload));
  t.after(() => {
    scheduler.stop();
    db.close();
  });
  return {
    remote, home, db, dbPath, config, tasks, scheduler, env,
    ghLog, bodyCopy, argsLog,
    setNow: (at) => { now = new Date(at); },
    waitClaudeStarted: async (count = 1) => {
      await waitUntil(() => readJsonl(argsLog).length >= count,
        { timeoutMs: 10_000, message: `假 claude 应已启动 ${count} 次` });
      return readJsonl(argsLog);
    },
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

/** 造一条历史运行（额度测试用）：写库后改 started_at。 */
function seedRun(db, taskId, { startedAt, quotaUnits }) {
  const run = startRun(db, {
    taskId, attempt: 1, model: 'glm-5.3', effort: 'medium', peak: false, logPath: '/tmp/x.log',
  });
  finishRun(db, run.id, { status: 'succeeded', quotaUnits });
  db.prepare('UPDATE runs SET started_at = ? WHERE id = ?').run(new Date(startedAt).toISOString(), run.id);
  return run;
}

// ---------------------------------------------------------------- 集成·成功

test('验收·集成·成功：test -f NIGHT_SHIFT_FAKE.md 的任务全流程通过', async (t) => {
  const ctx = setup(t, { taskSpecs: [{ testCommand: 'test -f NIGHT_SHIFT_FAKE.md', title: 'fix login bug' }] });
  const events = collectEvents(t, ctx.scheduler.events, ['claim', 'stage', 'done']);
  const [task] = ctx.tasks;

  assert.deepEqual(await ctx.scheduler.tick(), [task.id]);
  const done = await ctx.waitDone(task.id);
  assert.equal(done.status, 'succeeded');
  assert.equal(done.error, null);

  const row = getTask(ctx.db, task.id);
  assert.equal(row.status, 'succeeded');
  assert.equal(row.prUrl, 'https://github.com/a/b/pull/9');
  assert.match(row.branch, /^night-shift\/\d+-fix-login-bug$/);
  assert.equal(row.attempts, 1);

  // stage 事件顺序
  const stages = events.filter((e) => e.name === 'stage' && e.payload.taskId === task.id)
    .map((e) => e.payload.stage);
  assert.deepEqual(stages, ['worktree', 'run', 'test', 'commit', 'push', 'pr', 'cleanup']);

  // bare 仓库里有该分支且包含 NIGHT_SHIFT_FAKE.md
  assert.deepEqual(nightShiftBranches(ctx.remote.bare), [row.branch]);
  const blob = git(['show', `${row.branch}:NIGHT_SHIFT_FAKE.md`], ctx.remote.bare);
  assert.ok(blob.includes('做点修改'));

  // worktree 目录已删除
  assert.equal(fs.existsSync(path.join(ctx.home, 'worktrees', `task-${task.id}`)), false);

  // 假 gh 收到的 pr create 参数
  // 假 gh 的日志每行就是一次调用的 argv 数组
  const ghCalls = readJsonl(ctx.ghLog);
  const prCreate = ghCalls.filter((argv) => argv.includes('pr') && argv.includes('create'));
  assert.equal(prCreate.length, 1);
  const argv = prCreate[0];
  assert.ok(argv.includes('--repo'), argv.join(' '));
  assert.equal(argv[argv.indexOf('--repo') + 1], 'a/b');
  assert.equal(argv[argv.indexOf('--head') + 1], row.branch);
  assert.equal(argv[argv.indexOf('--base') + 1], 'main');
  assert.equal(argv[argv.indexOf('--title') + 1], `night-shift: fix login bug`);
  assert.ok(argv.includes('--body-file'));

  // PR 正文：任务 prompt、运行信息、测试结果与页脚
  const body = fs.readFileSync(ctx.bodyCopy, 'utf8');
  assert.ok(body.includes('做点修改'));
  assert.ok(body.includes('glm-5.3'));
  assert.ok(body.includes('test -f NIGHT_SHIFT_FAKE.md'));
  assert.ok(body.trimEnd().endsWith('由 GLM 夜班自动创建'));

  // runs 表：一条 succeeded 的运行
  const runs = listRuns(ctx.db, { taskId: task.id });
  assert.equal(runs.length, 1);
  assert.equal(runs[0].status, 'succeeded');
  assert.equal(runs[0].attempt, 1);
});

// ---------------------------------------------------------------- 无改动

test('验收·集成·无改动：noop 场景 → failed「没有改动」不重试，远端无新分支', async (t) => {
  const ctx = setup(t, {
    taskSpecs: [{ title: 'noop task' }],
    env: { FAKE_CLAUDE_SCENARIO: 'noop' },
  });
  const [task] = ctx.tasks;
  await ctx.scheduler.tick();
  await ctx.waitDone(task.id);

  const row = getTask(ctx.db, task.id);
  assert.equal(row.status, 'failed');
  assert.equal(row.lastError, '没有改动');
  assert.equal(row.attempts, 1, '没有改动不重试');
  assert.deepEqual(nightShiftBranches(ctx.remote.bare), [], 'bare 仓库不应有新分支');
  assert.equal(readJsonl(ctx.ghLog).filter((argv) => argv.includes('create')).length, 0, '没有开 PR');
});

// ---------------------------------------------------------------- 失败重试 / 用尽 / 测试失败 / 超时

test('验收·集成·失败重试：fail,success 序列，maxAttempts 2 → 第一轮 queued、第二轮 succeeded，runs 2 条', async (t) => {
  const stateFile = path.join(makeTempHome(t), 'sequence-state.txt');
  const ctx = setup(t, {
    taskSpecs: [{ maxAttempts: 2, title: 'flaky' }],
    // #12 的失败诊断默认开启，会额外消耗序列里的一次假 claude 调用并多记一条 run；
    // 本条只验证 #9 的重试语义，关掉它（诊断的集成测试见 test/diagnose*.test.js）
    config: { autoDiagnose: false },
    env: { FAKE_CLAUDE_SEQUENCE: 'fail,success', FAKE_CLAUDE_STATE_FILE: stateFile },
  });
  const [task] = ctx.tasks;

  await ctx.scheduler.tick();
  const first = await ctx.waitDone(task.id);
  assert.equal(first.status, 'queued');
  const afterFirst = getTask(ctx.db, task.id);
  assert.equal(afterFirst.attempts, 1);
  assert.ok(afterFirst.lastError && afterFirst.lastError.startsWith('run:'), afterFirst.lastError);

  assert.deepEqual(await ctx.scheduler.tick(), [task.id]);
  const second = await ctx.waitDone(task.id, { round: 2 });
  assert.equal(second.status, 'succeeded');
  assert.equal(getTask(ctx.db, task.id).prUrl, 'https://github.com/a/b/pull/9');
  assert.equal(listRuns(ctx.db, { taskId: task.id }).length, 2);
});

test('验收·集成·重试用尽：fail + maxAttempts 2 → 两轮后 failed', async (t) => {
  const ctx = setup(t, {
    taskSpecs: [{ maxAttempts: 2, title: 'always fail' }],
    config: { autoDiagnose: false }, // 同上：本条只验证 #9 的重试用尽语义
    env: { FAKE_CLAUDE_SCENARIO: 'fail' },
  });
  const [task] = ctx.tasks;

  await ctx.scheduler.tick();
  await ctx.waitDone(task.id);
  assert.equal(getTask(ctx.db, task.id).status, 'queued');

  await ctx.scheduler.tick();
  await ctx.waitDone(task.id, { round: 2 });
  const row = getTask(ctx.db, task.id);
  assert.equal(row.status, 'failed');
  assert.equal(row.attempts, 2);
  assert.ok(row.lastError.startsWith('run:'));
  assert.equal(listRuns(ctx.db, { taskId: task.id }).length, 2);
});

test('验收·集成·测试失败：testCommand exit 1 → lastError 以「测试失败」开头', async (t) => {
  const ctx = setup(t, { taskSpecs: [{ testCommand: 'echo boom >&2; exit 1' }] });
  const [task] = ctx.tasks;
  await ctx.scheduler.tick();
  await ctx.waitDone(task.id);
  const row = getTask(ctx.db, task.id);
  assert.equal(row.status, 'queued'); // 第一次失败按普通失败重试
  assert.ok(row.lastError.startsWith('测试失败：'), row.lastError);
  assert.ok(row.lastError.includes('boom'));
});

test('验收·集成·超时：hang + timeoutMinutes 0.01 → run 记 timeout，任务按重试规则排队', async (t) => {
  const ctx = setup(t, {
    taskSpecs: [{ maxAttempts: 2 }],
    // 超时也是普通失败，#12 默认会跟一次诊断（多一条 run）；本条只验证 #9 的超时语义
    config: { timeoutMinutes: 0.01, killGraceSeconds: 1, autoDiagnose: false },
    env: { FAKE_CLAUDE_SCENARIO: 'hang' },
  });
  const [task] = ctx.tasks;
  await ctx.scheduler.tick();
  await ctx.waitDone(task.id);

  const runs = listRuns(ctx.db, { taskId: task.id });
  assert.equal(runs.length, 1);
  assert.equal(runs[0].status, 'timeout');
  const row = getTask(ctx.db, task.id);
  assert.equal(row.status, 'queued');
  assert.equal(row.attempts, 1);
  assert.ok(row.lastError.startsWith('run: 超时'), row.lastError);
});

// ---------------------------------------------------------------- 限流退避

test('验收·集成·限流退避：T 退避 15 分钟、T+10 不领、T+16 再领到', async (t) => {
  const ctx = setup(t, {
    taskSpecs: [{ title: 'limited' }, { title: 'bystander' }],
    env: { FAKE_CLAUDE_SCENARIO: 'rate-limit' },
    clockAt: '2026-10-10T07:00:00Z',
  });
  const [first, second] = ctx.tasks;

  ctx.setNow('2026-10-10T07:00:00Z'); // T
  assert.deepEqual(await ctx.scheduler.tick(), [first.id]);
  await ctx.waitDone(first.id);
  const row = getTask(ctx.db, first.id);
  assert.equal(row.status, 'queued');
  assert.equal(row.attempts, 0, '限流退还这次尝试');
  assert.ok(row.lastError.includes('限流'), row.lastError);
  assert.equal(row.notBefore, '2026-10-10T07:15:00.000Z');
  assert.deepEqual(ctx.scheduler.status().pausedUntil, new Date('2026-10-10T07:15:00Z'));

  ctx.setNow('2026-10-10T07:10:00Z'); // T+10：全局暂停，别的任务也不领
  assert.deepEqual(await ctx.scheduler.tick(), []);
  assert.equal(getTask(ctx.db, second.id).status, 'queued');

  ctx.setNow('2026-10-10T07:16:00Z'); // T+16：恢复，领到创建更早的 first
  assert.deepEqual(await ctx.scheduler.tick(), [first.id]);
  await ctx.waitDone(first.id, { round: 2, timeoutMs: 10_000 }); // 仍限流，再退回（清理干净再结束测试）
  assert.equal(getTask(ctx.db, second.id).status, 'queued');
});

test('验收·集成·限流退避：rateLimitBackoffMinutes 1 → 只暂停 1 分钟', async (t) => {
  const ctx = setup(t, {
    config: { rateLimitBackoffMinutes: 1 },
    env: { FAKE_CLAUDE_SCENARIO: 'rate-limit' },
    clockAt: '2026-10-10T07:00:00Z',
  });
  const [task] = ctx.tasks;
  await ctx.scheduler.tick();
  await ctx.waitDone(task.id);
  assert.deepEqual(ctx.scheduler.status().pausedUntil, new Date('2026-10-10T07:01:00Z'));

  ctx.setNow('2026-10-10T07:00:30Z');
  assert.deepEqual(await ctx.scheduler.tick(), []);
  ctx.setNow('2026-10-10T07:01:30Z');
  assert.deepEqual(await ctx.scheduler.tick(), [task.id]);
  await ctx.waitDone(task.id, { round: 2, timeoutMs: 10_000 });
});

// ---------------------------------------------------------------- 高峰

test('验收·集成·高峰：07:00Z 只领 allowPeak，10:30Z 领普通；allowPeak 配置放开后都领', async (t) => {
  const ctx = setup(t, {
    taskSpecs: [{ title: 'normal', priority: 0 }],
    clockAt: '2026-10-08T07:00:00Z', // 周四北京 15:00
  });
  const peaky = createTask(ctx.db, { repo: 'a/b', prompt: '峰值任务', title: 'peak ok', allowPeak: true, priority: -1 });
  const normal = ctx.tasks[0];

  ctx.setNow('2026-10-08T07:00:00Z');
  assert.deepEqual(await ctx.scheduler.tick(), [peaky.id], '高峰只领 allowPeak 任务');
  assert.equal(getTask(ctx.db, normal.id).status, 'queued');
  await ctx.waitDone(peaky.id);
  assert.equal(getTask(ctx.db, peaky.id).status, 'succeeded');
  // 高峰里跑的这一单按 3 倍计额度
  assert.equal(listRuns(ctx.db, { taskId: peaky.id })[0].quotaUnits, 3);

  ctx.setNow('2026-10-08T10:30:00Z'); // 北京 18:30，非高峰
  assert.deepEqual(await ctx.scheduler.tick(), [normal.id]);
  await ctx.waitDone(normal.id);
  assert.equal(getTask(ctx.db, normal.id).status, 'succeeded');
});

test('验收·集成·高峰：config.allowPeak true 时普通任务也能领', async (t) => {
  const ctx = setup(t, {
    taskSpecs: [{ title: 'normal in peak' }],
    config: { allowPeak: true },
    clockAt: '2026-10-08T07:00:00Z',
  });
  const [task] = ctx.tasks;
  assert.deepEqual(await ctx.scheduler.tick(), [task.id]);
  await ctx.waitDone(task.id);
  assert.equal(getTask(ctx.db, task.id).status, 'succeeded');
});

// ---------------------------------------------------------------- 额度

test('验收·集成·额度：五小时窗口用满 → tick 返回 []，blocked five-hour，retryAt = resetsAt', async (t) => {
  const ctx = setup(t, { clockAt: '2026-10-10T07:00:00Z' });
  const feeder = createTask(ctx.db, { repo: 'a/b', prompt: 'feeder' });
  const now = new Date('2026-10-10T07:00:00Z');
  for (const minutesAgo of [60, 50, 40, 30]) {
    seedRun(ctx.db, feeder.id, {
      startedAt: new Date(now.getTime() - minutesAgo * 60_000),
      quotaUnits: 360,
    });
  }

  assert.deepEqual(await ctx.scheduler.tick(), []);
  assert.equal(getTask(ctx.db, ctx.tasks[0].id).status, 'queued');

  const blocked = ctx.scheduler.status().blocked;
  assert.equal(blocked.reason, 'five-hour');
  const expected = quotaUsage(
    listRuns(ctx.db, { since: new Date(now.getTime() - 7 * 24 * 3600_000), limit: 10_000 }),
    now,
    { plan: 'v2-max', weekStart: null },
  );
  assert.deepEqual(blocked.retryAt, expected.fiveHour.resetsAt);
});

// ---------------------------------------------------------------- 并发

test('验收·集成·并发：concurrency 2 + slow(300ms) + 3 任务 → 同时最多 2 个，最终全部成功', async (t) => {
  const ctx = setup(t, {
    taskSpecs: [{ title: 'a' }, { title: 'b' }, { title: 'c' }],
    config: { concurrency: 2 },
    env: { FAKE_CLAUDE_SCENARIO: 'slow', FAKE_CLAUDE_DELAY_MS: '300' },
  });
  // 用 claim/done 事件观察并发：任意时刻「已领未完」数量不超过 2
  let concurrent = 0;
  let maxConcurrent = 0;
  const onClaim = () => { concurrent += 1; maxConcurrent = Math.max(maxConcurrent, concurrent); };
  const onDone = () => { concurrent -= 1; };
  ctx.scheduler.events.on('claim', onClaim);
  ctx.scheduler.events.on('done', onDone);
  t.after(() => {
    ctx.scheduler.events.off('claim', onClaim);
    ctx.scheduler.events.off('done', onDone);
  });

  assert.deepEqual((await ctx.scheduler.tick()).length, 2);
  // done 事件在 worktree 清理之后才发：等它再补位，不会撞上「状态已终、槽位未还」的窗口
  await ctx.waitDone(ctx.tasks[0].id, { timeoutMs: 20_000 });
  await ctx.waitDone(ctx.tasks[1].id, { timeoutMs: 20_000 });
  assert.deepEqual(await ctx.scheduler.tick(), [ctx.tasks[2].id]);
  await ctx.waitDone(ctx.tasks[2].id, { timeoutMs: 20_000 });
  for (const task of ctx.tasks) {
    assert.equal(getTask(ctx.db, task.id).status, 'succeeded');
  }
  assert.ok(maxConcurrent <= 2, `实际峰值并发 ${maxConcurrent}`);
  assert.equal(maxConcurrent, 2, '应把并发用满');
});

// ---------------------------------------------------------------- 取消（另一连接）

test('验收·集成·取消：hang 运行中另一连接 cancelTask → 2 秒内进程消失、任务 canceled、无 PR', async (t) => {
  const ctx = setup(t, {
    taskSpecs: [{ testCommand: 'test -f NIGHT_SHIFT_FAKE.md' }],
    env: { FAKE_CLAUDE_SCENARIO: 'hang' },
    cancelPollMs: 50,
  });
  const [task] = ctx.tasks;
  await ctx.scheduler.tick();
  const [{ pid }] = await ctx.waitClaudeStarted();
  await waitUntil(() => ctx.scheduler.status().running.includes(task.id));

  const db2 = openDb(ctx.dbPath);
  t.after(() => db2.close());
  cancelTask(db2, task.id);

  const startedAt = Date.now();
  await waitUntil(() => {
    try {
      process.kill(pid, 0);
      return false;
    } catch (err) {
      return err.code === 'ESRCH';
    }
  }, { timeoutMs: 2000, message: '假 claude 进程应在 2 秒内消失' });
  assert.ok(Date.now() - startedAt <= 2000);

  const done = await ctx.waitDone(task.id, { timeoutMs: 5000 });
  assert.equal(done.status, 'canceled');
  assert.equal(getTask(ctx.db, task.id).status, 'canceled');
  const run = listRuns(ctx.db, { taskId: task.id })[0];
  assert.equal(run.status, 'canceled');
  assert.equal(fs.existsSync(path.join(ctx.home, 'worktrees', `task-${task.id}`)), false, 'worktree 已删除');
  assert.equal(
    readJsonl(ctx.ghLog).filter((argv) => argv.includes('pr') && argv.includes('create')).length,
    0,
    'FAKE_GH_LOG 里不应有 pr create',
  );
});

// ---------------------------------------------------------------- 停机

test('验收·集成·停机：优雅 stop 不结束；force 后 2 秒内 resolve，任务放回、attempts 复原', async (t) => {
  const ctx = setup(t, {
    taskSpecs: [{ maxAttempts: 2 }],
    env: { FAKE_CLAUDE_SCENARIO: 'hang' },
    cancelPollMs: 50,
  });
  const [task] = ctx.tasks;
  const attemptsBefore = getTask(ctx.db, task.id).attempts; // 0
  await ctx.scheduler.tick();
  await ctx.waitClaudeStarted();

  const graceful = ctx.scheduler.stop();
  let settled = false;
  graceful.then(() => { settled = true; });
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(settled, false, '优雅停止时 Promise 不应结束');

  const startedAt = Date.now();
  await ctx.scheduler.stop({ force: true });
  await graceful;
  assert.ok(Date.now() - startedAt <= 2000, 'force 后 2 秒内 resolve');

  const row = getTask(ctx.db, task.id);
  assert.equal(row.status, 'queued');
  assert.equal(row.attempts, attemptsBefore, '停机中断退还这次尝试');
  const run = listRuns(ctx.db, { taskId: task.id })[0];
  assert.equal(run.status, 'failed');
  assert.equal(run.error, 'interrupted');
  assert.deepEqual(await ctx.scheduler.tick(), [], '停止后 tick 不再领取');
});

// ---------------------------------------------------------------- 启动恢复

test('验收·集成·启动恢复：running 任务 + 未结束 run，start() 放回队列并重新执行', async (t) => {
  const ctx = setup(t, { config: { pollSeconds: 0.05 } });
  const [task] = ctx.tasks;
  // 造现场：上次进程没跑完——任务 running、run 未结束
  claimTaskById(ctx.db, task.id);
  const staleRun = startRun(ctx.db, {
    taskId: task.id, attempt: 1, model: 'glm-5.3', effort: 'medium', peak: false, logPath: '/tmp/old.log',
  });

  const recovered = ctx.scheduler.start();
  assert.deepEqual(recovered, [task.id]);
  await ctx.waitDone(task.id, { timeoutMs: 20_000 });
  await ctx.scheduler.stop();

  assert.equal(getTask(ctx.db, task.id).status, 'succeeded');
  const runs = listRuns(ctx.db, { taskId: task.id });
  assert.equal(runs.length, 2, '旧 run + 重新执行的 run');
  const old = runs.find((r) => r.id === staleRun.id);
  assert.equal(old.status, 'failed');
  assert.equal(old.error, 'interrupted');
  assert.equal(runs.find((r) => r.id !== staleRun.id).status, 'succeeded');
  // 迁移随新库就位
  assert.equal(ctx.db.prepare('PRAGMA user_version').get().user_version, MIGRATIONS.length);
});

// ---------------------------------------------------------------- runNow

test('验收·集成·runNow：高峰时段也能跑完普通任务；对 succeeded 抛 InvalidTransitionError', async (t) => {
  const ctx = setup(t, {
    taskSpecs: [{ testCommand: 'test -f NIGHT_SHIFT_FAKE.md' }],
    clockAt: '2026-10-08T07:00:00Z', // 高峰
  });
  const [task] = ctx.tasks;

  const final = await ctx.scheduler.runNow(String(task.id)); // 字符串 id 也能用
  assert.equal(final.status, 'succeeded');
  assert.equal(final.prUrl, 'https://github.com/a/b/pull/9');
  assert.deepEqual(nightShiftBranches(ctx.remote.bare), [final.branch]);

  await assert.rejects(
    () => ctx.scheduler.runNow(task.id),
    (err) => err instanceof InvalidTransitionError && err.from === 'succeeded',
  );
});

// ---------------------------------------------------------------- 任务依赖（#11 × #9）
// 依赖门在 tasks.js 的 claimNextTask / claimTaskById 里（调度器的 tick / runNow 都只经由
// 这两个函数领任务）；级联失败挂在 finishTask(failed) / cancelTask 上（调度器落终态也只走
// 这两个函数），所以下面直接用真调度器 + 假 claude 验证端到端行为。

test('依赖·集成：重试用尽的上游 failed → 下游与下游的下游同一事务级联失败，下游从未被领取', async (t) => {
  const ctx = setup(t, {
    taskSpecs: [
      { maxAttempts: 2, title: 'upstream' },
      { title: 'mid', dependsOn: [1] },
      { title: 'leaf', dependsOn: [2] },
    ],
    // #12 的失败诊断默认开启（上游第一轮失败会多一次诊断调用）；本条验证 #11 的级联语义
    config: { concurrency: 3, autoDiagnose: false }, // 并发槽位富余：没被领只能是依赖门挡住的
    env: { FAKE_CLAUDE_SCENARIO: 'fail' },
  });
  const [up, mid, leaf] = ctx.tasks;

  assert.deepEqual(await ctx.scheduler.tick(), [up.id], '只领上游');
  await ctx.waitDone(up.id);
  assert.equal(getTask(ctx.db, up.id).status, 'queued', '第一轮失败后排队重试');
  assert.equal(getTask(ctx.db, mid.id).status, 'queued', '上游还没终败：下游不动');

  assert.deepEqual(await ctx.scheduler.tick(), [up.id], '第二轮仍只领上游');
  await ctx.waitDone(up.id, { round: 2 });
  const upRow = getTask(ctx.db, up.id);
  assert.deepEqual([upRow.status, upRow.attempts], ['failed', 2]);

  const midRow = getTask(ctx.db, mid.id);
  const leafRow = getTask(ctx.db, leaf.id);
  assert.deepEqual([midRow.status, midRow.lastError], ['failed', `依赖 #${up.id} 失败`]);
  assert.deepEqual([leafRow.status, leafRow.lastError], ['failed', `依赖 #${mid.id} 失败`]);
  assert.ok(midRow.finishedAt !== null && leafRow.finishedAt !== null);
  assert.equal(midRow.finishedAt, upRow.finishedAt, '级联与上游终态同一时刻写入（同一事务）');
  assert.deepEqual([midRow.attempts, leafRow.attempts], [0, 0], '下游从未被领取');
  assert.equal(listRuns(ctx.db, { taskId: mid.id }).length + listRuns(ctx.db, { taskId: leaf.id }).length, 0);
  assert.deepEqual(await ctx.scheduler.tick(), [], '之后队列里没有可领的');
  assert.equal(readJsonl(ctx.argsLog).length, 2, '假 claude 只为上游启动过 2 次');
});

test('依赖·集成：上游运行中被另一连接取消 → 下游立即级联失败（依赖已取消），之后也不会被领', async (t) => {
  const ctx = setup(t, {
    taskSpecs: [{ title: 'upstream' }, { title: 'downstream', dependsOn: [1] }],
    config: { concurrency: 2 },
    env: { FAKE_CLAUDE_SCENARIO: 'hang' },
    cancelPollMs: 50,
  });
  const [up, down] = ctx.tasks;
  assert.deepEqual(await ctx.scheduler.tick(), [up.id]);
  await ctx.waitClaudeStarted();
  await waitUntil(() => ctx.scheduler.status().running.includes(up.id));

  const db2 = openDb(ctx.dbPath);
  t.after(() => db2.close());
  cancelTask(db2, up.id);
  // 级联与取消在同一事务里：取消一返回，下游已经是 failed。先记下快照、等上游收尾后
  // 再断言——断言失败时也不会把 hang 的假 claude 留在后台拖住测试进程。
  const downRow = getTask(ctx.db, down.id);

  const done = await ctx.waitDone(up.id, { timeoutMs: 5000 });
  assert.equal(done.status, 'canceled');
  assert.deepEqual([downRow.status, downRow.lastError], ['failed', `依赖 #${up.id} 已取消`]);
  assert.equal(getTask(ctx.db, up.id).status, 'canceled', '调度器保持 canceled，不改写');
  assert.equal(getTask(ctx.db, down.id).status, 'failed', '再 tick 之前确认下游已终态（否则 hang 场景会被领走）');
  assert.deepEqual(await ctx.scheduler.tick(), []);
  assert.equal(getTask(ctx.db, down.id).attempts, 0, '下游从未被领取');
  assert.equal(listRuns(ctx.db, { taskId: down.id }).length, 0);
});

test('依赖·集成：上游运行时下游不被领（并发有空位也不领）；上游成功后下一轮 tick 领到下游并跑完', async (t) => {
  const ctx = setup(t, {
    taskSpecs: [{ title: 'api' }, { title: 'frontend', dependsOn: [1], priority: 10 }],
    config: { concurrency: 2 },
    env: { FAKE_CLAUDE_SCENARIO: 'slow', FAKE_CLAUDE_DELAY_MS: '300' },
  });
  const [up, down] = ctx.tasks;
  assert.deepEqual(await ctx.scheduler.tick(), [up.id], '下游优先级更高也不能先领');
  await waitUntil(() => ctx.scheduler.status().running.includes(up.id));
  assert.deepEqual(await ctx.scheduler.tick(), [], '上游 running：下游仍被挡住');
  assert.deepEqual(getTask(ctx.db, down.id).blockedBy, [up.id]);

  await ctx.waitDone(up.id, { timeoutMs: 20_000 });
  assert.equal(getTask(ctx.db, up.id).status, 'succeeded');
  assert.deepEqual(getTask(ctx.db, down.id).blockedBy, []);
  assert.deepEqual(await ctx.scheduler.tick(), [down.id]);
  await ctx.waitDone(down.id, { timeoutMs: 20_000 });
  const downRow = getTask(ctx.db, down.id);
  assert.deepEqual([downRow.status, downRow.attempts], ['succeeded', 1]);
});

test('依赖·集成·runNow：不绕过依赖门——等依赖时抛 DependencyBlockedError、不启动 claude；上游成功后 runNow 跑完', async (t) => {
  const ctx = setup(t, {
    taskSpecs: [{ title: 'api' }, { title: 'frontend', dependsOn: [1] }],
    clockAt: '2026-10-08T07:00:00Z', // 高峰：runNow 无视高峰，但不无视依赖
  });
  const [up, down] = ctx.tasks;

  await assert.rejects(
    () => ctx.scheduler.runNow(down.id),
    (err) => err instanceof DependencyBlockedError && err instanceof InvalidTransitionError
      && JSON.stringify(err.blockedBy) === `[${up.id}]`,
  );
  const blocked = getTask(ctx.db, down.id);
  assert.deepEqual([blocked.status, blocked.attempts], ['queued', 0], '被拒时任务原样不动');
  assert.equal(readJsonl(ctx.argsLog).length, 0, '没有启动假 claude');
  assert.deepEqual(ctx.scheduler.status().running, [], '没有登记 running');

  assert.equal((await ctx.scheduler.runNow(up.id)).status, 'succeeded');
  const final = await ctx.scheduler.runNow(down.id);
  assert.deepEqual([final.status, final.attempts], ['succeeded', 1]);
});
