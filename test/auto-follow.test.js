// issue #49（调度器自动跟进 PR 评审）的验收测试：默认不轮询、非高峰按
// followPollMinutes 间隔扫描并入队（gitRef / source 与 #48 的 follow 完全一致）、
// 高峰不查也不计时、手动暂停与限流退避期间只入队不领取、新配置键的类型检查、
// 不开自动跟进时 follow 命令行为不变、假 gh 的 pr view 默认静默成功、扫描遇 gh
// 失败不炸 tick 且不挡领取。
// 调度器一律注入可控时钟与挂起的假 runner / 假 git（照 test/scheduler-pause.test.js），
// gh 走仓库里的 fake-gh.mjs（FAKE_GH_LOG 记每次调用的 argv），绝不联网、不碰真实
// ~/.glm-night-shift、不调用真实 claude。
// runCli 在其他模块之前 import：先装好 SQLite 警告过滤再（经 src/db.js）加载 node:sqlite。
import { runCli } from '../bin/night-shift.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { openDb } from '../src/db.js';
import {
  claimTaskById,
  createTask,
  findTaskBySource,
  finishTask,
  getTask,
  listRuns,
  listTasks,
  setUserPaused,
} from '../src/tasks.js';
import { DEFAULT_CONFIG } from '../src/config.js';
import { branchName, buildPrBody, prTitle } from '../src/git.js';
import { createScheduler } from '../src/scheduler.js';
import { fakeEnv, fixturePath, makeTempHome } from './helpers.js';

const FAKE_GH = fixturePath('fake-gh.mjs');

/** 与 runTask 成功结果同形的结果对象（scriptedRunner 的基底）。 */
const RUN_OK = {
  runId: 1, status: 'succeeded', exitCode: 0, signal: null, numTurns: 3, isError: false,
  summary: 'fake summary', error: null, rateLimited: false,
  model: 'glm-5.3', effort: 'medium', peak: false, quotaUnits: 1, durationMs: 1200,
  logPath: '/tmp/fake.log',
};

/** 挂起不结束的假 runner：领到的任务停在 running，测试好断言「入队了但没跑完」。 */
const hangingRunner = () => new Promise(() => {});

/** 前几次按脚本返回、之后按 RUN_OK 成功的假 runner（脚本项合并进 RUN_OK）。 */
function scriptedRunner(script) {
  let calls = 0;
  const runner = async () => {
    const index = calls;
    calls += 1;
    return index < script.length ? { ...RUN_OK, ...script[index] } : { ...RUN_OK };
  };
  return { runner };
}

/** 假 git 模块（与 scheduler-pause.test.js 同款的最小实现；PR 文本用真函数）。 */
function makeFakeGit() {
  return {
    prTitle,
    buildPrBody,
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

/** 读 jsonl 文件（不存在返回空数组），每行一个 JSON。 */
function readJsonl(file) {
  try {
    return fs.readFileSync(file, 'utf8').trim().split('\n').filter((line) => line !== '')
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

/** FAKE_GH_LOG 里 `pr view` 的调用次数。 */
function ghViewCalls(log) {
  return readJsonl(log).filter((argv) => argv[0] === 'pr' && argv[1] === 'view').length;
}

/** gh pr view 的标准 JSON 输出（fake gh 原样回吐）。 */
function prViewJson({ reviewDecision = 'CHANGES_REQUESTED', reviews = [], url = 'https://github.com/a/b/pull/9' } = {}) {
  return JSON.stringify({ reviewDecision, reviews, url, headRefName: 'night-shift/1-fix-login-bug' });
}

const REQUESTED = prViewJson({ reviews: [{ id: 99, state: 'CHANGES_REQUESTED', body: '请把变量名改清楚' }] });

/**
 * 在库里造一个「已成功且开了 PR」的父任务：createTask → claimTaskById（queued →
 * running）→ finishTask(succeeded, prUrl, branch)。branch 缺省用 branchName(task)。
 */
function seedSucceeded(db, {
  repo = 'a/b', title = 'fix login bug', prUrl = 'https://github.com/a/b/pull/9',
  branch, ...taskSpec
} = {}) {
  const created = createTask(db, { repo, prompt: '做点修改', title, ...taskSpec });
  claimTaskById(db, created.id);
  finishTask(db, created.id, { status: 'succeeded', prUrl, branch: branch ?? branchName(created) });
  return getTask(db, created.id);
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

/** 进程内跑一次 CLI；home 指向全新临时目录，env 走 fakeEnv（指向假 gh）。 */
async function run(args, home, envOverrides = {}) {
  const stdout = sink();
  const stderr = sink();
  const code = await runCli(args, { stdout, stderr, env: fakeEnv({ NIGHT_SHIFT_HOME: home, ...envOverrides }) });
  return { code, stdout: stdout.text(), stderr: stderr.text() };
}

/**
 * 一套自动跟进测试环境：文件库 + 可调时钟（缺省周六 2026-10-10T07:00Z 非高峰）+
 * 挂起的假 runner + 假 git + 假 gh（FAKE_GH_LOG 记 argv）+ 第二个连接（模拟 CLI /
 * 看板进程改 meta.userPaused）。autoFollowReviews 缺省用 DEFAULT_CONFIG 的 false，
 * 要开的测试在 configOverrides 里显式传 true。
 */
function setup(t, { startAt = '2026-10-10T07:00:00Z', configOverrides = {}, envOverrides = {}, runner } = {}) {
  const home = makeTempHome(t);
  const db = openDb(path.join(home, 'night-shift.db'));
  let now = new Date(startAt);
  const clock = () => now;
  const ghLog = path.join(home, 'gh-log.jsonl');
  const scheduler = createScheduler({
    db,
    config: { ...DEFAULT_CONFIG, ghBin: FAKE_GH, ...configOverrides },
    home,
    clock,
    runner: runner ?? hangingRunner,
    git: makeFakeGit(),
    cancelPollMs: 20,
    env: fakeEnv({ FAKE_GH_LOG: ghLog, ...envOverrides }),
  });
  const db2 = openDb(path.join(home, 'night-shift.db'));
  t.after(() => {
    scheduler.stop();
    db2.close();
    db.close();
  });
  return {
    home, db, db2, scheduler, ghLog,
    setNow: (at) => { now = new Date(at); },
  };
}

// ---------------------------------------------------------------- 默认关闭：不轮询

test('验收: 默认配置（autoFollowReviews=false）：时钟拨过 1 小时、多轮 tick，假 gh 一次都没被调用', async (t) => {
  const ctx = setup(t, {
    // 故意把 PR 结论设成 CHANGES_REQUESTED：默认关闭时若错误地去查了，就会入队跟进、
    // 这里的断言会抓到
    envOverrides: { FAKE_GH_PR_VIEW_JSON: REQUESTED },
  });
  const parent = seedSucceeded(ctx.db);
  ctx.setNow('2026-10-10T07:20:00Z');
  assert.deepEqual(await ctx.scheduler.tick(), []);
  ctx.setNow('2026-10-10T08:05:00Z'); // 距调度器创建已过 1 小时
  assert.deepEqual(await ctx.scheduler.tick(), []);
  assert.equal(fs.existsSync(ctx.ghLog), false, '假 gh 一次都没被调用（连日志文件都没建）');
  assert.equal(ghViewCalls(ctx.ghLog), 0);
  assert.equal(findTaskBySource(ctx.db, 'pr-review:a/b#9:99'), null, '没有入队任何跟进');
  assert.equal(listTasks(ctx.db, { limit: 100 }).length, 1, '库里只有父任务');
  assert.equal(getTask(ctx.db, parent.id).status, 'succeeded');
});

// ---------------------------------------------------------------- 非高峰：按间隔扫描

test('验收: autoFollowReviews=true 非高峰：拨过 30 分钟（followPollMinutes）tick 后队列里出现一条跟进（gitRef=父分支、source 同 #48）；再拨 10 分钟不出现第二条、也不再调 gh', async (t) => {
  const ctx = setup(t, {
    configOverrides: { autoFollowReviews: true },
    envOverrides: { FAKE_GH_PR_VIEW_JSON: REQUESTED },
  });
  // 先放一个普通任务占住并发（挂起的假 runner）：07:00 这轮扫描没有候选（父任务还没
  // 成功），只把 lastFollowAt 记上；后面的轮次好证明「隔 30 分钟才再查」。
  const busy = createTask(ctx.db, { repo: 'a/b', prompt: '占住并发的', title: 'busy' });
  assert.deepEqual(await ctx.scheduler.tick(), [busy.id]);
  assert.equal(ghViewCalls(ctx.ghLog), 0, '没有 succeeded 候选时不调 gh');

  const parent = seedSucceeded(ctx.db, { difficulty: 'hard', testCommand: 'npm test', allowPeak: true });
  ctx.setNow('2026-10-10T07:30:00Z'); // 距上次扫描正好 30 分钟（followPollMinutes）
  assert.deepEqual(await ctx.scheduler.tick(), [], '并发被 busy 占着，本轮不领取');
  const found = findTaskBySource(ctx.db, 'pr-review:a/b#9:99');
  assert.ok(found !== null, '队列里应出现一条跟进');
  const follow = getTask(ctx.db, found.id);
  assert.equal(follow.status, 'queued', '照旧排队等领取，没被这轮扫描领走');
  assert.equal(follow.gitRef, parent.branch, 'gitRef 等于父任务的 branch');
  assert.equal(follow.source, 'pr-review:a/b#9:99', 'source 与 #48 的 follow 相同');
  assert.ok(follow.prompt.includes(`只在当前分支 ${parent.branch} 上提交并推送，不要开新分支，不要开新的 PR。`));
  assert.equal(ghViewCalls(ctx.ghLog), 1, '只调了一次 gh pr view');
  assert.deepEqual(
    readJsonl(ctx.ghLog).filter((argv) => argv[0] === 'pr' && argv[1] === 'view'),
    [['pr', 'view', '9', '--repo', 'a/b', '--json', 'reviewDecision,reviews,url,headRefName,state,mergeable']],
  );

  // 再拨 10 分钟（间隔未满）：不再调 gh（证明的是间隔，不只是 source 去重），也没有第二条
  ctx.setNow('2026-10-10T07:40:00Z');
  assert.deepEqual(await ctx.scheduler.tick(), []);
  assert.equal(ghViewCalls(ctx.ghLog), 1, '间隔未满：第二次 tick 不再调 gh');
  assert.equal(findTaskBySource(ctx.db, 'pr-review:a/b#9:99').id, found.id, '同一条，不是新建的');
  assert.equal(listTasks(ctx.db, { limit: 100 }).length, 3, 'busy + 父任务 + 一条跟进，没有第二条');
});

// ---------------------------------------------------------------- 高峰：不查也不计时

test('验收: 工作日高峰（北京时间 14:00～18:00）内 tick 不调 gh；拨出高峰后的下一轮才查——高峰不把「刚查过」记上', async (t) => {
  // 2026-10-08 是周四；北京 17:45 = 09:45Z 仍在高峰（左闭右开），北京 18:00 = 10:00Z 已出高峰。
  // 出高峰才 15 分钟：若高峰那段被记成「刚查过」，这里还得再等 30 分钟才会查——正好抓这个错。
  const ctx = setup(t, {
    startAt: '2026-10-08T09:45:00Z',
    configOverrides: { autoFollowReviews: true },
    envOverrides: { FAKE_GH_PR_VIEW_JSON: REQUESTED },
  });
  const parent = seedSucceeded(ctx.db);
  assert.deepEqual(await ctx.scheduler.tick(), []);
  assert.equal(fs.existsSync(ctx.ghLog), false, '高峰内连 gh 都不调');
  assert.equal(findTaskBySource(ctx.db, 'pr-review:a/b#9:99'), null, '高峰内不入队');

  ctx.setNow('2026-10-08T10:00:00Z'); // 北京 18:00，出高峰
  assert.deepEqual(await ctx.scheduler.tick(), [2], '这轮才查并入队；非高峰领取循环照常把跟进领走');
  assert.equal(ghViewCalls(ctx.ghLog), 1);
  const follow = getTask(ctx.db, 2);
  assert.equal(follow.source, 'pr-review:a/b#9:99');
  assert.equal(follow.gitRef, parent.branch);
});

// ---------------------------------------------------------------- 暂停 / 退避：只入队不领取

test('验收: 手动 pause 期间 tick 仍入队跟进，但新的排队任务不会被领走（仍是 queued、没有 run 行）', async (t) => {
  const ctx = setup(t, {
    configOverrides: { autoFollowReviews: true },
    envOverrides: { FAKE_GH_PR_VIEW_JSON: REQUESTED },
  });
  const parent = seedSucceeded(ctx.db);
  setUserPaused(ctx.db2, true); // 另一进程（CLI / 看板）按下暂停
  ctx.setNow('2026-10-10T07:30:00Z');
  assert.deepEqual(await ctx.scheduler.tick(), [], '暂停期间不领取');
  assert.equal(ctx.scheduler.status().userPaused, true);
  const found = findTaskBySource(ctx.db, 'pr-review:a/b#9:99');
  assert.ok(found !== null, '暂停期间仍会扫描并入队');
  const follow = getTask(ctx.db, found.id);
  assert.equal(follow.status, 'queued', '新入队的跟进不会被领走');
  assert.equal(follow.gitRef, parent.branch);
  assert.equal(listRuns(ctx.db, { limit: 100 }).length, 0, '没有 startRun：runner 从没被调过');
  assert.equal(ghViewCalls(ctx.ghLog), 1);
});

test('验收: 限流退避（pausedUntil 未到）期间同样只入队不领取', async (t) => {
  const ctx = setup(t, {
    configOverrides: { autoFollowReviews: true, rateLimitBackoffMinutes: 60 },
    runner: scriptedRunner([{ status: 'failed', rateLimited: true, error: 'rate_limit: 429' }]).runner,
    envOverrides: { FAKE_GH_PR_VIEW_JSON: REQUESTED },
  });
  const first = createTask(ctx.db, { repo: 'a/b', prompt: '被限流的', title: 'first' });
  assert.deepEqual(await ctx.scheduler.tick(), [first.id]); // 这轮扫描没有候选，只领任务
  await waitUntil(() => getTask(ctx.db, first.id).status === 'queued', { message: '限流后任务应退回队列' });
  const pausedUntil = new Date('2026-10-10T08:00:00Z'); // 07:00 + 60 分钟退避
  assert.deepEqual(ctx.scheduler.status().pausedUntil, pausedUntil);

  const parent = seedSucceeded(ctx.db);
  ctx.setNow('2026-10-10T07:31:00Z'); // 距上次扫描 31 分钟（够间隔），仍在退避期内
  assert.deepEqual(await ctx.scheduler.tick(), [], '退避期间不领取');
  const found = findTaskBySource(ctx.db, 'pr-review:a/b#9:99');
  assert.ok(found !== null, '退避期间仍会扫描并入队');
  const follow = getTask(ctx.db, found.id);
  assert.equal(follow.status, 'queued');
  assert.equal(follow.gitRef, parent.branch);
  assert.equal(follow.source, 'pr-review:a/b#9:99');
  assert.equal(getTask(ctx.db, first.id).status, 'queued', '被限流的普通任务也还在排队');
  assert.equal(ghViewCalls(ctx.ghLog), 1);
});

// ---------------------------------------------------------------- 配置类型检查

test('验收: followPollMinutes 为 0 / -5 / NaN / "soon" 时 createScheduler 抛 TypeError（信息含字段名）；autoFollowReviews 为 "yes" 同样抛', (t) => {
  const home = makeTempHome(t);
  const db = openDb(path.join(home, 'night-shift.db'));
  t.after(() => db.close());
  const base = {
    db,
    home,
    clock: () => new Date('2026-10-10T07:00:00Z'),
    runner: () => {},
    env: fakeEnv(),
  };
  for (const bad of [0, -5, Number.NaN, 'soon']) {
    assert.throws(
      () => createScheduler({ ...base, config: { ...DEFAULT_CONFIG, followPollMinutes: bad } }),
      (err) => err instanceof TypeError && err.message.includes('followPollMinutes'),
      JSON.stringify(bad),
    );
  }
  assert.throws(
    () => createScheduler({ ...base, config: { ...DEFAULT_CONFIG, autoFollowReviews: 'yes' } }),
    (err) => err instanceof TypeError && err.message.includes('autoFollowReviews'),
    '非布尔要在创建调度器时报 TypeError',
  );
});

// ---------------------------------------------------------------- 不开自动跟进：follow 命令行为不变

test('验收: 未开自动跟进时 follow <id> 与 #48 验收一致：入队（source/gitRef 正确）、重复跑提示已入队退出 0、非 CHANGES_REQUESTED 提示且任务数不变', async (t) => {
  const home = makeTempHome(t); // 没有 config.json：全默认，autoFollowReviews=false
  const db = openDb(path.join(home, 'night-shift.db'));
  const parent = seedSucceeded(db);
  db.close();

  const res = await run(['follow', String(parent.id)], home, { FAKE_GH_PR_VIEW_JSON: REQUESTED });
  assert.equal(res.code, 0, res.stderr);
  assert.equal(res.stderr, '');
  assert.equal(res.stdout, `已入队 #2，在分支 ${parent.branch} 上改\n`);
  const db2 = openDb(path.join(home, 'night-shift.db'));
  t.after(() => db2.close());
  const follow = getTask(db2, 2);
  assert.equal(follow.gitRef, parent.branch, 'gitRef 等于父任务的 branch');
  assert.equal(follow.source, 'pr-review:a/b#9:99', 'source 与 #48 相同');
  assert.equal(follow.status, 'queued');

  const again = await run(['follow', String(parent.id)], home, { FAKE_GH_PR_VIEW_JSON: REQUESTED });
  assert.equal(again.code, 0, again.stderr);
  assert.ok(again.stdout.includes('已经入队 #2（queued）'), again.stdout);
  assert.equal(listTasks(db2, { limit: 1000 }).length, 2, '再执行一次不产生第二条');

  const other = seedSucceeded(db2, { title: '第二条', prUrl: 'https://github.com/a/b/pull/12' });
  const approved = prViewJson({ reviewDecision: 'APPROVED', reviews: [{ id: 7, state: 'APPROVED', body: '好' }] });
  const skip = await run(['follow', String(other.id)], home, { FAKE_GH_PR_VIEW_JSON: approved });
  assert.equal(skip.code, 0, skip.stderr);
  assert.ok(skip.stdout.includes('没有待处理的修改请求'), skip.stdout);
  assert.equal(listTasks(db2, { limit: 1000 }).length, 3, '任务数不变（没有为 APPROVED 建任务）');
});

// ---------------------------------------------------------------- 假 gh 的 pr view 默认行为

test('验收: 未设置 FAKE_GH_PR_VIEW_JSON / FILE / FAIL 时，spawn 仓库里的 fake-gh 做 pr view 1 --repo a/b --json reviewDecision：退出码 0、stdout 为空', (t) => {
  const res = spawnSync(process.execPath, [
    FAKE_GH, 'pr', 'view', '1', '--repo', 'a/b', '--json', 'reviewDecision',
  ], {
    cwd: makeTempHome(t),
    env: fakeEnv(), // 三个 PR_VIEW_* 都不设
    encoding: 'utf8',
  });
  assert.ok(!res.error, `假 gh 启动失败：${res.error}`);
  assert.equal(res.status, 0, '静默成功');
  assert.equal(res.stdout, '');
  assert.equal(res.stderr, '');
});

// ---------------------------------------------------------------- 扫描遇 gh 失败

test('验收: 自动扫描遇 gh 失败（FAKE_GH_PR_VIEW_FAIL=1）：tick 仍 resolve、console 有日志、followPollMinutes 内不再打 gh、本轮照常领取其他排队任务', async (t) => {
  const ctx = setup(t, {
    configOverrides: { autoFollowReviews: true },
    envOverrides: { FAKE_GH_PR_VIEW_FAIL: '1' },
  });
  const parent = seedSucceeded(ctx.db);
  const other = createTask(ctx.db, { repo: 'a/b', prompt: '普通排队任务', title: 'other' });
  const errMock = t.mock.method(console, 'error', () => {});
  let claimed;
  try {
    claimed = await ctx.scheduler.tick(); // 不抛：gh 失败不让 tick 出错
  } finally {
    errMock.mock.restore();
  }
  assert.deepEqual(claimed, [other.id], 'gh 失败不阻止领取本来就该领的排队任务');
  assert.equal(findTaskBySource(ctx.db, 'pr-review:a/b#9:99'), null, 'gh 失败不建跟进');
  assert.equal(ghViewCalls(ctx.ghLog), 1, '只打了一次 gh');
  const logged = errMock.mock.calls.map((call) => call.arguments.join(' ')).join('\n');
  assert.ok(logged.includes('自动跟进'), `日志应提到自动跟进：${logged}`);
  assert.ok(logged.includes('gh pr view 失败'), `日志应带失败原因：${logged}`);

  // 10 分钟内再 tick：这次失败也算查过，不再每轮都打 gh
  ctx.setNow('2026-10-10T07:10:00Z');
  await ctx.scheduler.tick();
  assert.equal(ghViewCalls(ctx.ghLog), 1, '失败后 followPollMinutes 内不再打 gh');
  assert.equal(getTask(ctx.db, other.id).status, 'running', '已领取的普通任务不受影响');
  assert.equal(getTask(ctx.db, parent.id).status, 'succeeded');
});
