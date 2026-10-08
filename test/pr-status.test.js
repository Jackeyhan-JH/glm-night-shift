// issue #56（记下 PR 已合并或已关闭）的验收测试：迁移增量、默认不轮询、间隔与
// 「从未查过立即查」、MERGED/CLOSED/OPEN 的写入与 status 不变、坏 state 跳过不写、
// 高峰 / 手动暂停 / 限流退避期间照查但只写列不领取、gh 失败中止本轮且计入间隔、
// 配置键类型检查、与 #49 自动跟进互不影响、详情页「PR 结果」行、假 gh 默认静默成功。
// 调度器一律注入可控时钟与挂起的假 runner / 假 git（照 test/auto-follow.test.js），
// gh 走仓库里的 fake-gh.mjs（FAKE_GH_LOG 记每次调用的 argv），用 --json 参数区分两种
// pr view：本功能是 state,mergedAt，#49/#60 的跟进是 reviewDecision,reviews,url,headRefName,state,mergeable。
// 绝不联网、不碰真实 ~/.glm-night-shift、不调用真实 claude / gh。
// runCli 在其他模块之前 import：先装好 SQLite 警告过滤再（经 src/db.js）加载 node:sqlite。
import { runCli } from '../bin/night-shift.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDb, MIGRATIONS } from '../src/db.js';
import {
  claimTaskById,
  createTask,
  findTaskBySource,
  finishTask,
  getTask,
  listRuns,
  setUserPaused,
} from '../src/tasks.js';
import { DEFAULT_CONFIG } from '../src/config.js';
import { branchName } from '../src/git.js';
import { createScheduler } from '../src/scheduler.js';
import { createPage } from '../web/task.js';
import { fakeEnv, fixturePath, makeTempHome } from './helpers.js';

const FAKE_GH = fixturePath('fake-gh.mjs');

/** 与 runTask 成功结果同形的结果对象（scriptedRunner 的基底）。 */
const RUN_OK = {
  runId: 1, status: 'succeeded', exitCode: 0, signal: null, numTurns: 3, isError: false,
  summary: 'fake summary', error: null, rateLimited: false,
  model: 'glm-5.3', effort: 'medium', peak: false, quotaUnits: 1, durationMs: 1200,
  logPath: '/tmp/fake.log',
};

/** 挂起不结束的假 runner：领到的任务停在 running，测试好断言「没被领走 / 没跑完」。 */
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

/** 假 git 模块（与 auto-follow.test.js 同款的最小实现）。 */
function makeFakeGit() {
  return {
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

/** FAKE_GH_LOG 里 `pr view --json <json>` 的调用（argv 数组）。 */
function prViewArgv(log, json) {
  return readJsonl(log).filter((argv) => argv[0] === 'pr' && argv[1] === 'view' && argv.includes(json));
}

/** 带 state,mergedAt（本功能）的 gh pr view 调用次数。 */
const prStatusGhCalls = (log) => prViewArgv(log, 'state,mergedAt').length;

/** 带 reviewDecision,reviews,url,headRefName,state,mergeable（#49/#60 跟进；argv.includes
 *  是整元素匹配，短串匹配不到 #60 加长后的字段串）的 gh pr view 调用次数。 */
const followGhCalls = (log) => prViewArgv(log, 'reviewDecision,reviews,url,headRefName,state,mergeable').length;

/** MERGED + CHANGES_REQUESTED：prStatus 写 merged；#64 起 state 压过 reviewDecision，
 *  跟进跳过不入队（fake gh 原样回吐，高峰段的断言也还用它）。 */
const BOTH_JSON = JSON.stringify({
  state: 'MERGED',
  mergedAt: '2026-10-08T00:00:00Z',
  reviewDecision: 'CHANGES_REQUESTED',
  reviews: [{ id: 99, state: 'CHANGES_REQUESTED', body: '请把变量名改清楚' }],
  url: 'https://github.com/a/b/pull/9',
  headRefName: 'night-shift/1-fix-login-bug',
});

/** OPEN + CHANGES_REQUESTED（reviews 与 BOTH_JSON 同一条 id 99）：跟进照 #49 入队、
 *  prStatus 写 open；mergeable 给 MERGEABLE（不触发冲突提示那行）。 */
const OPEN_JSON = JSON.stringify({
  state: 'OPEN',
  mergedAt: null,
  reviewDecision: 'CHANGES_REQUESTED',
  reviews: [{ id: 99, state: 'CHANGES_REQUESTED', body: '请把变量名改清楚' }],
  url: 'https://github.com/a/b/pull/9',
  headRefName: 'night-shift/1-fix-login-bug',
  mergeable: 'MERGEABLE',
});

const MERGED_JSON = '{"state":"MERGED","mergedAt":"2026-10-08T00:00:00Z"}';

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

/**
 * 一套 PR 状态测试环境：文件库 + 可调时钟（缺省周六 2026-10-10T07:00Z 非高峰）+
 * 挂起的假 runner + 假 git + 假 gh（FAKE_GH_LOG 记 argv）+ 第二个连接（模拟 CLI /
 * 看板进程改 meta.userPaused）。prStatus 缺省用 DEFAULT_CONFIG 的 false，
 * 要开的测试在 configOverrides 里显式传 true。
 */
function setup(t, { startAt = '2026-10-10T07:00:00Z', configOverrides = {}, envOverrides = {}, runner, ghBin = FAKE_GH } = {}) {
  const home = makeTempHome(t);
  const db = openDb(path.join(home, 'night-shift.db'));
  let now = new Date(startAt);
  const clock = () => now;
  const ghLog = path.join(home, 'gh-log.jsonl');
  const scheduler = createScheduler({
    db,
    config: { ...DEFAULT_CONFIG, ghBin, ...configOverrides },
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

/**
 * 「同轮一条坏结果 + 一条合法结果」专用的迷你假 gh：仓库的 fake-gh 用环境变量控制
 * pr view 输出，一轮内对所有任务回同一个 JSON，做不出按任务区分；这里按 PR 编号回
 * 不同输出（9 → 小写 merged 坏 state，12 → MERGED 合法，其余 → 空 stdout 坏 JSON），
 * FAKE_GH_LOG 照记 argv。只写在本测试的临时目录里，绝不联网。
 */
function writeVariantGh(t) {
  const outputs = {
    9: { state: 'merged', mergedAt: null }, // 小写：不识别
    12: { state: 'MERGED', mergedAt: '2026-10-08T00:00:00Z' },
  };
  const script = path.join(makeTempHome(t), 'variant-gh.mjs');
  fs.writeFileSync(script, `${[
    '#!/usr/bin/env node',
    "import { appendFileSync } from 'node:fs';",
    'const argv = process.argv.slice(2);',
    'if (process.env.FAKE_GH_LOG) appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify(argv) + "\\n");',
    `const OUTPUTS = ${JSON.stringify(outputs)};`,
    "if (argv[0] === 'pr' && argv[1] === 'view' && OUTPUTS[argv[2]] !== undefined) {",
    '  process.stdout.write(JSON.stringify(OUTPUTS[argv[2]]) + "\\n");',
    '}',
  ].join('\n')}\n`);
  fs.chmodSync(script, 0o755); // 直接 spawn 它：要有执行位（shebang 走 env node）
  return script;
}

// ---------------------------------------------------------------- 1. 默认关闭：不轮询

test('验收: 默认配置（prStatus=false）：时钟拨过 1 小时、多轮 tick，带 state,mergedAt 的 gh 调用为 0，prOutcome 仍 null、status 仍 succeeded', async (t) => {
  const ctx = setup(t, {
    // 故意把 state 设成 MERGED：默认关闭时若错误地去查了，prOutcome 就会被写上
    envOverrides: { FAKE_GH_PR_VIEW_JSON: MERGED_JSON },
  });
  const parent = seedSucceeded(ctx.db);
  ctx.setNow('2026-10-10T07:20:00Z');
  assert.deepEqual(await ctx.scheduler.tick(), []);
  ctx.setNow('2026-10-10T07:40:00Z');
  assert.deepEqual(await ctx.scheduler.tick(), []);
  ctx.setNow('2026-10-10T08:05:00Z'); // 距调度器创建已过 1 小时
  assert.deepEqual(await ctx.scheduler.tick(), []);
  assert.equal(fs.existsSync(ctx.ghLog), false, '假 gh 一次都没被调用（连日志文件都没建）');
  assert.equal(prStatusGhCalls(ctx.ghLog), 0);
  const task = getTask(ctx.db, parent.id);
  assert.equal(task.prOutcome, null, 'prOutcome 未被写过');
  assert.equal(task.status, 'succeeded', 'status 不变');
});

// ---------------------------------------------------------------- 2. MERGED：写入与间隔

test('验收: prStatus=true 从未查过时第一轮 tick 立刻查：MERGED 写入 merged、status/attempts 不变、argv 精确；+10 分钟不再调；间隔满后因已 merged 仍不再调', async (t) => {
  const ctx = setup(t, {
    configOverrides: { prStatus: true, prStatusPollMinutes: 30 },
    envOverrides: { FAKE_GH_PR_VIEW_JSON: MERGED_JSON },
  });
  const parent = seedSucceeded(ctx.db);
  assert.deepEqual(await ctx.scheduler.tick(), []);
  const task = getTask(ctx.db, parent.id);
  assert.equal(task.prOutcome, 'merged');
  assert.equal(task.status, 'succeeded', '成功仍是成功');
  assert.equal(task.attempts, parent.attempts, 'attempts 不变');
  assert.equal(task.branch, parent.branch, 'branch 不动');
  assert.equal(task.prUrl, parent.prUrl, 'pr_url 不动');
  assert.equal(task.finishedAt, parent.finishedAt, 'finished_at 不动');
  assert.deepEqual(
    prViewArgv(ctx.ghLog, 'state,mergedAt'),
    [['pr', 'view', '9', '--repo', 'a/b', '--json', 'state,mergedAt']],
    '命令字面：gh pr view 9 --repo a/b --json state,mergedAt',
  );

  ctx.setNow('2026-10-10T07:10:00Z'); // +10 分钟（间隔未满）
  assert.deepEqual(await ctx.scheduler.tick(), []);
  assert.equal(prStatusGhCalls(ctx.ghLog), 1, '间隔未满：不再调 gh');

  ctx.setNow('2026-10-10T07:40:00Z'); // 距首次查询 40 分钟（间隔已满），但已是 merged
  assert.deepEqual(await ctx.scheduler.tick(), []);
  assert.equal(prStatusGhCalls(ctx.ghLog), 1, 'merged 的任务不再查');
  assert.equal(getTask(ctx.db, parent.id).prOutcome, 'merged');
});

// ---------------------------------------------------------------- 3. CLOSED / OPEN

test('验收: CLOSED 写入 closed、OPEN 写入 open 且间隔到了还会再查一次（open 还要查），status 都仍是 succeeded', async (t) => {
  const closed = setup(t, {
    configOverrides: { prStatus: true, prStatusPollMinutes: 30 },
    envOverrides: { FAKE_GH_PR_VIEW_JSON: '{"state":"CLOSED","mergedAt":null}' },
  });
  const parentA = seedSucceeded(closed.db);
  assert.deepEqual(await closed.scheduler.tick(), []);
  const closedTask = getTask(closed.db, parentA.id);
  assert.equal(closedTask.prOutcome, 'closed');
  assert.equal(closedTask.status, 'succeeded');

  const open = setup(t, {
    configOverrides: { prStatus: true, prStatusPollMinutes: 30 },
    envOverrides: { FAKE_GH_PR_VIEW_JSON: '{"state":"OPEN","mergedAt":null}' },
  });
  const parentB = seedSucceeded(open.db);
  assert.deepEqual(await open.scheduler.tick(), []);
  const openTask = getTask(open.db, parentB.id);
  assert.equal(openTask.prOutcome, 'open');
  assert.equal(openTask.status, 'succeeded');
  assert.equal(prStatusGhCalls(open.ghLog), 1);

  open.setNow('2026-10-10T07:30:00Z'); // 间隔已满：open 的下一轮还要查
  assert.deepEqual(await open.scheduler.tick(), []);
  assert.equal(prStatusGhCalls(open.ghLog), 2, 'open 的任务间隔到了会再查');
  assert.equal(getTask(open.db, parentB.id).prOutcome, 'open');
});

// ---------------------------------------------------------------- 4. 坏 state：跳过不写

test('验收: state 为小写 merged / 缺 state / state:1 / stdout 不是 JSON：该任务 prOutcome 仍 null、有带任务 id 的日志、status 仍 succeeded；同轮后面的合法任务仍写入（坏结果不中止整轮）', async (t) => {
  // 三种坏 JSON 各一轮（仓库 fake-gh 对整轮回同一个 JSON）
  for (const bad of [
    '{"state":"merged","mergedAt":null}',       // 小写：大小写敏感，不识别
    '{"mergedAt":"2026-10-08T00:00:00Z"}',      // 缺 state
    '{"state":1,"mergedAt":null}',              // state 不是字符串
  ]) {
    const ctx = setup(t, {
      configOverrides: { prStatus: true },
      envOverrides: { FAKE_GH_PR_VIEW_JSON: bad },
    });
    const parent = seedSucceeded(ctx.db);
    const errMock = t.mock.method(console, 'error', () => {});
    try {
      assert.deepEqual(await ctx.scheduler.tick(), []);
    } finally {
      errMock.mock.restore();
    }
    const task = getTask(ctx.db, parent.id);
    assert.equal(task.prOutcome, null, `坏结果不写列：${bad}`);
    assert.equal(task.status, 'succeeded');
    assert.equal(prStatusGhCalls(ctx.ghLog), 1, `确实查过这一条：${bad}`);
    const logged = errMock.mock.calls.map((call) => call.arguments.join(' ')).join('\n');
    assert.ok(logged.includes(`#${parent.id}`), `日志应带任务 id：${logged}`);
  }

  // 同一轮：坏 state（#1）→ 空 stdout（#2）→ 合法 MERGED（#3），按 id 升序逐条查
  const variantGh = writeVariantGh(t);
  const ctx = setup(t, {
    configOverrides: { prStatus: true },
    ghBin: variantGh,
  });
  const badState = seedSucceeded(ctx.db, { prUrl: 'https://github.com/a/b/pull/9' });
  const badJson = seedSucceeded(ctx.db, { title: '空输出', prUrl: 'https://github.com/a/b/pull/777' });
  const good = seedSucceeded(ctx.db, { title: '合法那条', prUrl: 'https://github.com/a/b/pull/12' });
  const errMock = t.mock.method(console, 'error', () => {});
  try {
    assert.deepEqual(await ctx.scheduler.tick(), []);
  } finally {
    errMock.mock.restore();
  }
  assert.equal(getTask(ctx.db, badState.id).prOutcome, null, '小写 merged 不写');
  assert.equal(getTask(ctx.db, badJson.id).prOutcome, null, '空 stdout 不写');
  assert.equal(getTask(ctx.db, good.id).prOutcome, 'merged', '坏结果不中止整轮：合法那条仍写入');
  assert.equal(getTask(ctx.db, good.id).status, 'succeeded');
  assert.equal(prStatusGhCalls(ctx.ghLog), 3, '三条各查了一次');
  const logged = errMock.mock.calls.map((call) => call.arguments.join(' ')).join('\n');
  assert.ok(logged.includes(`#${badState.id}`) && logged.includes(`#${badJson.id}`), `两条坏结果都有日志：${logged}`);
});

// ---------------------------------------------------------------- 5. 工作日高峰：照查且计间隔

test('验收: 工作日高峰（2026-10-08T09:45Z，北京周四 17:45）照样查并写入 merged；allowPeak=false 的 queued 不被领走（仍是 queued、没有 run 行）；高峰也把「刚查过」记上：+10 分钟不再调 gh', async (t) => {
  const ctx = setup(t, {
    startAt: '2026-10-08T09:45:00Z',
    configOverrides: { prStatus: true },
    envOverrides: { FAKE_GH_PR_VIEW_JSON: MERGED_JSON },
  });
  const parent = seedSucceeded(ctx.db);
  const queued = createTask(ctx.db, { repo: 'a/b', prompt: '排队的', title: 'queued' }); // allowPeak 缺省 false
  assert.deepEqual(await ctx.scheduler.tick(), [], '高峰且任务不许高峰：不领取');
  assert.equal(getTask(ctx.db, parent.id).prOutcome, 'merged', '高峰期间仍写入 PR 结果');
  assert.equal(getTask(ctx.db, queued.id).status, 'queued', '排队任务不被领走');
  assert.equal(listRuns(ctx.db, { limit: 100 }).length, 0, '没有 run 行');
  assert.equal(prStatusGhCalls(ctx.ghLog), 1);

  ctx.setNow('2026-10-08T09:55:00Z'); // +10 分钟（间隔未满）
  assert.deepEqual(await ctx.scheduler.tick(), []);
  assert.equal(prStatusGhCalls(ctx.ghLog), 1, '高峰查过也计入间隔：间隔内不再调 gh');
  assert.equal(getTask(ctx.db, queued.id).status, 'queued');
});

// ---------------------------------------------------------------- 6. 手动暂停：只写列

test('验收: 手动 pause 期间同样写入 prOutcome；queued 不被领走、没有 run 行', async (t) => {
  const ctx = setup(t, {
    configOverrides: { prStatus: true },
    envOverrides: { FAKE_GH_PR_VIEW_JSON: MERGED_JSON },
  });
  const parent = seedSucceeded(ctx.db);
  const queued = createTask(ctx.db, { repo: 'a/b', prompt: '排队的', title: 'queued' });
  setUserPaused(ctx.db2, true); // 另一进程（CLI / 看板）按下暂停
  assert.deepEqual(await ctx.scheduler.tick(), [], '暂停期间不领取');
  assert.equal(ctx.scheduler.status().userPaused, true);
  assert.equal(getTask(ctx.db, parent.id).prOutcome, 'merged', '暂停期间仍写入 PR 结果');
  assert.equal(getTask(ctx.db, queued.id).status, 'queued', '排队任务不被领走');
  assert.equal(listRuns(ctx.db, { limit: 100 }).length, 0, '没有 run 行');
  assert.equal(prStatusGhCalls(ctx.ghLog), 1);
});

// ---------------------------------------------------------------- 7. 限流退避：只写列

test('验收: 限流退避（pausedUntil 未到）期间同样只写列、不领取', async (t) => {
  const ctx = setup(t, {
    configOverrides: { prStatus: true, rateLimitBackoffMinutes: 60 },
    runner: scriptedRunner([{ status: 'failed', rateLimited: true, error: 'rate_limit: 429' }]).runner,
    envOverrides: { FAKE_GH_PR_VIEW_JSON: MERGED_JSON },
  });
  const first = createTask(ctx.db, { repo: 'a/b', prompt: '被限流的', title: 'first' });
  assert.deepEqual(await ctx.scheduler.tick(), [first.id]); // 这轮还没有候选，只领任务
  await waitUntil(() => getTask(ctx.db, first.id).status === 'queued', { message: '限流后任务应退回队列' });
  assert.deepEqual(ctx.scheduler.status().pausedUntil, new Date('2026-10-10T08:00:00Z')); // 07:00 + 60 分钟

  const parent = seedSucceeded(ctx.db);
  ctx.setNow('2026-10-10T07:31:00Z'); // 距上次查询 31 分钟（够间隔），仍在退避期内
  assert.deepEqual(await ctx.scheduler.tick(), [], '退避期间不领取');
  assert.equal(getTask(ctx.db, parent.id).prOutcome, 'merged', '退避期间仍写入 PR 结果');
  assert.equal(getTask(ctx.db, first.id).status, 'queued', '被限流的普通任务也还在排队');
  assert.equal(listRuns(ctx.db, { limit: 100 }).length, 0, '没有 run 行');
  assert.equal(prStatusGhCalls(ctx.ghLog), 1);
});

// ---------------------------------------------------------------- 8. 配置类型检查

test('验收: prStatusPollMinutes 为 0 / "soon" 时 createScheduler 抛 TypeError（信息含字段名）；prStatus 为 "yes" 同样抛', (t) => {
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
  for (const bad of [0, 'soon']) {
    assert.throws(
      () => createScheduler({ ...base, config: { ...DEFAULT_CONFIG, prStatusPollMinutes: bad } }),
      (err) => err instanceof TypeError && err.message.includes('prStatusPollMinutes'),
      JSON.stringify(bad),
    );
  }
  assert.throws(
    () => createScheduler({ ...base, config: { ...DEFAULT_CONFIG, prStatus: 'yes' } }),
    (err) => err instanceof TypeError && err.message.includes('prStatus'),
    '非布尔要在创建调度器时报 TypeError',
  );
});

// ---------------------------------------------------------------- 9. 详情页（最小 DOM 桩，拷自 test/web-task-detail.test.js）

class StubElement {
  constructor(tagName) {
    this.tagName = String(tagName).toUpperCase();
    this.children = [];
    this.parentNode = null;
    this._text = '';
    this._class = '';
    this._innerHTML = ''; // 谁用了 innerHTML 一目了然（安全断言用）
    this.attributes = new Map();
    this.listeners = new Map();
    this.scrollTop = 0;
    this.scrollHeight = 0;
    this.clientHeight = 0;
    this.style = {};
    this.disabled = false;
  }

  get textContent() {
    return this._text + this.children.map((c) => c.textContent).join('');
  }

  set textContent(value) {
    this._text = String(value);
    this.children = [];
    this._innerHTML = '';
  }

  get innerHTML() {
    return this._innerHTML;
  }

  set innerHTML(value) {
    this._innerHTML = String(value);
    this.children = [];
    this._text = '';
  }

  get className() {
    return this._class;
  }

  set className(value) {
    this._class = String(value);
  }

  appendChild(child) {
    if (child.parentNode !== null) child.parentNode.removeChild(child);
    this.children.push(child);
    child.parentNode = this;
    return child;
  }

  removeChild(child) {
    const i = this.children.indexOf(child);
    if (i !== -1) {
      this.children.splice(i, 1);
      child.parentNode = null;
    }
    return child;
  }

  remove() {
    if (this.parentNode !== null) this.parentNode.removeChild(this);
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
    if (name === 'class') this._class = String(value);
  }

  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : '';
  }

  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }
}

function makeStubDoc() {
  const byId = new Map();
  return {
    title: '',
    createElement: (tag) => new StubElement(tag),
    getElementById(id) {
      if (!byId.has(id)) byId.set(id, new StubElement('div'));
      return byId.get(id);
    },
  };
}

function walk(node, visit) {
  visit(node);
  for (const child of [...(node.children ?? [])]) walk(child, visit);
}

function findAll(root, pred) {
  const out = [];
  walk(root, (n) => {
    if (pred(n)) out.push(n);
  });
  return out;
}

function findByTag(root, tag) {
  return findAll(root, (n) => n.tagName === String(tag).toUpperCase());
}

/** 按 GET /api/tasks/:id 真 handler 的形状构造响应体（任务字段展开 + runs）。 */
function taskPayload(overrides = {}) {
  return {
    id: 1,
    repo: 'a/b',
    source: null,
    gitRef: null,
    title: '标题',
    prompt: '做点事',
    difficulty: 'medium',
    priority: 0,
    testCommand: null,
    allowPeak: false,
    status: 'succeeded',
    attempts: 1,
    maxAttempts: 2,
    branch: 'night-shift/1-fix-login-bug',
    prUrl: 'https://github.com/a/b/pull/7',
    prOutcome: null,
    lastError: null,
    notBefore: null,
    createdAt: '2026-10-08T07:00:00.000Z',
    updatedAt: '2026-10-08T07:00:00.000Z',
    startedAt: null,
    finishedAt: null,
    dependsOn: [],
    blockedBy: [],
    runs: [],
    ...overrides,
  };
}

/** 起一个真页面：桩 DOM + fetch 桩（api() 底下就是 fetch）。t.after 统一收尾。 */
function makePage(t, payload) {
  const doc = makeStubDoc();
  const real = globalThis.fetch;
  globalThis.fetch = (input) => Promise.resolve({
    ok: true,
    status: 200,
    text: () => Promise.resolve(JSON.stringify(payload)),
  });
  const page = createPage({ doc, location: { search: '?id=1' } }).init();
  t.after(() => {
    page.destroy();
    globalThis.fetch = real;
  });
  return { page, doc };
}

/** fields 里 (dt, dd) 成对取：labels() 给全部标签，ddOf() 按标签取值节点。 */
function labels(page) {
  const kids = page.refs.fields.children;
  const out = [];
  for (let i = 0; i + 1 < kids.length; i += 2) out.push(kids[i].textContent);
  return out;
}

function ddOf(page, label) {
  const kids = page.refs.fields.children;
  for (let i = 0; i + 1 < kids.length; i += 2) {
    if (kids[i].textContent === label) return kids[i + 1];
  }
  assert.fail(`页面上没有「${label}」行，实际：${labels(page).join(' | ')}`);
}

test('验收: 详情页 prOutcome=merged：PR 行后面出现 dt 恰为「PR 结果」、值恰为「已合并」，在「依赖」「来源」之前；closed → 已关闭；open / null / 空串不画这行；值不是链接、不用 innerHTML', async (t) => {
  const merged = makePage(t, taskPayload({
    prOutcome: 'merged',
    dependsOn: [2],
    source: 'github:a/b#12',
  }));
  await merged.page.busy;
  assert.deepEqual(labels(merged.page), [
    '仓库', '难度', '优先级', '允许高峰', '尝试次数', '测试命令', '创建时间',
    '开始时间', '结束时间', '分支', 'PR', 'PR 结果', '依赖', '来源',
  ], '「PR 结果」紧跟「PR」、在「依赖」「来源」之前');
  assert.equal(ddOf(merged.page, 'PR 结果').textContent, '已合并');
  assert.equal(findByTag(ddOf(merged.page, 'PR 结果'), 'a').length, 0, '值不是链接');

  const closed = makePage(t, taskPayload({ prOutcome: 'closed' }));
  await closed.page.busy;
  assert.equal(ddOf(closed.page, 'PR 结果').textContent, '已关闭');

  for (const absent of ['open', null, undefined, '']) {
    const { page, doc } = makePage(t, taskPayload({ prOutcome: absent }));
    await page.busy;
    assert.ok(!labels(page).includes('PR 结果'), `${String(absent)} 不画「PR 结果」行（也不画 -）`);
    assert.ok(!doc.getElementById('app').textContent.includes('PR 结果'), `${String(absent)} 全文没有「PR 结果」`);
  }

  // 全页只有导航（navHtml 静态串）用过 innerHTML——PR 结果行只经 textContent
  const htmlUsers = [...findAll(merged.doc.getElementById('nav'), (n) => n._innerHTML !== ''),
    ...findAll(merged.doc.getElementById('app'), (n) => n._innerHTML !== '')];
  assert.equal(htmlUsers.length, 1);
  assert.equal(htmlUsers[0], merged.doc.getElementById('nav'));
});

// ---------------------------------------------------------------- 10. gh 失败

test('验收: gh 失败（FAKE_GH_PR_VIEW_FAIL=1）：tick 仍 resolve、console 有日志、prOutcome 仍 null、status 仍 succeeded；间隔内再 tick 不再打 gh；同轮另一条 queued 照常被领取；两条都该查时第一条失败后第二条不再查', async (t) => {
  const ctx = setup(t, {
    configOverrides: { prStatus: true },
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
  const task = getTask(ctx.db, parent.id);
  assert.equal(task.prOutcome, null, '失败不写列');
  assert.equal(task.status, 'succeeded');
  assert.equal(prStatusGhCalls(ctx.ghLog), 1, '只打了一次 gh');
  const logged = errMock.mock.calls.map((call) => call.arguments.join(' ')).join('\n');
  assert.ok(logged.includes('PR 状态'), `日志应提到 PR 状态查询：${logged}`);
  assert.ok(logged.includes('本轮停止'), `日志应说明本轮停止：${logged}`);

  ctx.setNow('2026-10-10T07:10:00Z');
  await ctx.scheduler.tick();
  assert.equal(prStatusGhCalls(ctx.ghLog), 1, '这次失败也算查过：间隔内不再打 gh');
  assert.equal(getTask(ctx.db, other.id).status, 'running', '已领取的普通任务不受影响');

  // 两条 succeeded 都该查：第一条 gh 就失败的话第二条不再查（本轮停止）
  const ctx2 = setup(t, {
    configOverrides: { prStatus: true },
    envOverrides: { FAKE_GH_PR_VIEW_FAIL: '1' },
  });
  const first = seedSucceeded(ctx2.db, { prUrl: 'https://github.com/a/b/pull/9' });
  const second = seedSucceeded(ctx2.db, { title: '第二条', prUrl: 'https://github.com/a/b/pull/12' });
  const errMock2 = t.mock.method(console, 'error', () => {});
  try {
    assert.deepEqual(await ctx2.scheduler.tick(), []);
  } finally {
    errMock2.mock.restore();
  }
  assert.equal(prStatusGhCalls(ctx2.ghLog), 1, '第一条 gh 失败后第二条不再查');
  assert.equal(getTask(ctx2.db, first.id).prOutcome, null);
  assert.equal(getTask(ctx2.db, second.id).prOutcome, null);
});

// ---------------------------------------------------------------- 11. 与 #49 自动跟进互不影响

test('验收: autoFollowReviews=true 且 prStatus=true 非高峰：OPEN+CHANGES_REQUESTED 时 follow 照常入队（source/gitRef 同 #49）且 prOutcome 写 open；MERGED 时按 #64 跳过不入队（state 压过 CHANGES_REQUESTED、prOutcome 写 merged）；高峰时 prStatus 查、follow 不查不入队；prStatus=false 时 follow 仍按 #49/#60 工作（--json 是长字段串）且不多一次 state,mergedAt', async (t) => {
  // 两个都开、非高峰、OPEN + CHANGES_REQUESTED：follow 入队（同 #49），prStatus 写
  // open。两组 --json 不同：follow 是 #60 的 reviewDecision,reviews,url,headRefName,
  // state,mergeable，prStatus 是 state,mergedAt。
  const ctx = setup(t, {
    configOverrides: { autoFollowReviews: true, prStatus: true },
    envOverrides: { FAKE_GH_PR_VIEW_JSON: OPEN_JSON },
  });
  const parent = seedSucceeded(ctx.db);
  assert.deepEqual(await ctx.scheduler.tick(), [2], '入队的跟进这轮被领走');
  const found = findTaskBySource(ctx.db, 'pr-review:a/b#9:99');
  assert.ok(found !== null, 'follow 照常入队一条');
  const follow = getTask(ctx.db, found.id);
  assert.equal(follow.gitRef, parent.branch, 'gitRef 与 #49 相同（父任务分支）');
  assert.equal(follow.source, 'pr-review:a/b#9:99', 'source 与 #49 相同');
  assert.equal(getTask(ctx.db, parent.id).prOutcome, 'open', 'prOutcome 按 state 写入 open（不是 merged）');
  assert.equal(followGhCalls(ctx.ghLog), 1);
  assert.equal(prStatusGhCalls(ctx.ghLog), 1);
  assert.deepEqual(
    prViewArgv(ctx.ghLog, 'reviewDecision,reviews,url,headRefName,state,mergeable'),
    [['pr', 'view', '9', '--repo', 'a/b', '--json', 'reviewDecision,reviews,url,headRefName,state,mergeable']],
    'follow 的命令字面（#60 的长字段串）',
  );
  assert.deepEqual(
    prViewArgv(ctx.ghLog, 'state,mergedAt'),
    [['pr', 'view', '9', '--repo', 'a/b', '--json', 'state,mergedAt']],
    'prStatus 的命令字面：与 follow 的 --json 不是同一组',
  );

  // 两个都开、非高峰、BOTH_JSON（MERGED + CHANGES_REQUESTED）：#64 起 state 压过
  // reviewDecision，follow 跳过、不入队——唯一的跳过原因是「PR 已合并」。调度器先扫
  // follow 再查 prStatus，扫描时 prOutcome 还是 null，所以 follow 仍打了一次 gh；
  // skipped 不进 console，这里只按入队 / gh 次数断言，不要求日志。
  const merged = setup(t, {
    configOverrides: { autoFollowReviews: true, prStatus: true },
    envOverrides: { FAKE_GH_PR_VIEW_JSON: BOTH_JSON },
  });
  const mergedParent = seedSucceeded(merged.db);
  assert.deepEqual(await merged.scheduler.tick(), [], '这次跟进没有入队任何任务可领');
  assert.equal(findTaskBySource(merged.db, 'pr-review:a/b#9:99'), null, 'MERGED 的 PR 不入队');
  assert.equal(getTask(merged.db, mergedParent.id).prOutcome, 'merged', 'prOutcome 按 state 写入 merged');
  assert.equal(followGhCalls(merged.ghLog), 1, 'prOutcome 当时是 null：follow 仍打了一次 gh 才跳过');
  assert.equal(prStatusGhCalls(merged.ghLog), 1);

  // 高峰（周四北京 17:45）：prStatus 查，follow 不查也不入队
  const peak = setup(t, {
    startAt: '2026-10-08T09:45:00Z',
    configOverrides: { autoFollowReviews: true, prStatus: true },
    envOverrides: { FAKE_GH_PR_VIEW_JSON: BOTH_JSON },
  });
  const peakParent = seedSucceeded(peak.db);
  assert.deepEqual(await peak.scheduler.tick(), []);
  assert.equal(prStatusGhCalls(peak.ghLog), 1, '高峰 prStatus 照查');
  assert.equal(followGhCalls(peak.ghLog), 0, '高峰 follow 连 gh 都不调');
  assert.equal(findTaskBySource(peak.db, 'pr-review:a/b#9:99'), null, '高峰不入队');
  assert.equal(getTask(peak.db, peakParent.id).prOutcome, 'merged');

  // 只开 follow（prStatus=false）+ OPEN：与 #49 的 auto-follow 行为一致，prStatus 关着
  // 不多一次 state,mergedAt、不写结论；follow 的 --json 是 #60 的长字段串。
  const offOpen = setup(t, {
    configOverrides: { autoFollowReviews: true },
    envOverrides: { FAKE_GH_PR_VIEW_JSON: OPEN_JSON },
  });
  const offOpenParent = seedSucceeded(offOpen.db);
  assert.deepEqual(await offOpen.scheduler.tick(), [2], 'prStatus 关不影响跟进入队并被领走');
  const offFound = findTaskBySource(offOpen.db, 'pr-review:a/b#9:99');
  assert.ok(offFound !== null);
  assert.equal(getTask(offOpen.db, offFound.id).gitRef, offOpenParent.branch);
  assert.equal(getTask(offOpen.db, offOpenParent.id).prOutcome, null, 'prStatus 关：不写结论');
  assert.equal(prStatusGhCalls(offOpen.ghLog), 0, 'prStatus 关：不多一次 state,mergedAt 的 gh');
  assert.equal(followGhCalls(offOpen.ghLog), 1);
  assert.deepEqual(
    prViewArgv(offOpen.ghLog, 'reviewDecision,reviews,url,headRefName,state,mergeable'),
    [['pr', 'view', '9', '--repo', 'a/b', '--json', 'reviewDecision,reviews,url,headRefName,state,mergeable']],
    'argv 是 #60 的长字段串（不是多了一次 prStatus 调用）',
  );

  // 只开 follow + BOTH_JSON（MERGED）：follow 跳过、不入队；prStatus 关着所以不打
  // state,mergedAt、prOutcome 保持 null。follow 自己仍打一次 gh（prOutcome 是 null），
  // 那一次的 --json 就是 #60 的长字段串。
  const offMerged = setup(t, {
    configOverrides: { autoFollowReviews: true },
    envOverrides: { FAKE_GH_PR_VIEW_JSON: BOTH_JSON },
  });
  const offMergedParent = seedSucceeded(offMerged.db);
  assert.deepEqual(await offMerged.scheduler.tick(), []);
  assert.equal(findTaskBySource(offMerged.db, 'pr-review:a/b#9:99'), null, 'MERGED 的 PR 不入队');
  assert.equal(getTask(offMerged.db, offMergedParent.id).prOutcome, null, 'prStatus 关：不写结论');
  assert.equal(prStatusGhCalls(offMerged.ghLog), 0, 'prStatus 关：一次 state,mergedAt 都不打');
  assert.equal(followGhCalls(offMerged.ghLog), 1, 'prOutcome 当时是 null：follow 仍打了一次 gh');
  assert.deepEqual(
    prViewArgv(offMerged.ghLog, 'reviewDecision,reviews,url,headRefName,state,mergeable'),
    [['pr', 'view', '9', '--repo', 'a/b', '--json', 'reviewDecision,reviews,url,headRefName,state,mergeable']],
    '唯一那次 gh 是 follow 的长字段 pr view',
  );
});

// ---------------------------------------------------------------- 12. 假 gh 的 pr view 默认行为

test('验收: 未设置 FAKE_GH_PR_VIEW_JSON / FILE / FAIL 时，spawn 仓库里的 fake-gh 做 pr view 1 --repo a/b --json state,mergedAt：退出码 0、stdout 为空、stderr 为空', (t) => {
  const res = spawnSync(process.execPath, [
    FAKE_GH, 'pr', 'view', '1', '--repo', 'a/b', '--json', 'state,mergedAt',
  ], {
    cwd: makeTempHome(t),
    env: fakeEnv(), // 三个 PR_VIEW_* 都不设
    encoding: 'utf8',
  });
  assert.ok(!res.error, `假 gh 启动失败：${res.error}`);
  assert.equal(res.status, 0, '静默成功（默认行为没被改）');
  assert.equal(res.stdout, '');
  assert.equal(res.stderr, '');
});

// ---------------------------------------------------------------- 13. 迁移增量

test('验收: 打开没有 pr_outcome 列的旧库，user_version 只加 1，旧任务还在、pr_outcome 为 null', (t) => {
  const file = path.join(makeTempHome(t), 'night-shift.db');
  // pr_outcome 不一定是最后一步（后合并的 issue 会顺延）。找出加上它的那一步，
  // 旧库只跑到它之前；版本号一律用步数算，不写死数字。
  const probe = new DatabaseSync(':memory:');
  let prOutcomeStep = -1;
  for (let i = 0; i < MIGRATIONS.length; i++) {
    const hadTasks = probe.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='tasks'").get();
    const before = hadTasks
      ? probe.prepare('PRAGMA table_info(tasks)').all().some((row) => row.name === 'pr_outcome')
      : false;
    MIGRATIONS[i](probe);
    const after = probe.prepare('PRAGMA table_info(tasks)').all().some((row) => row.name === 'pr_outcome');
    if (!before && after) prOutcomeStep = i;
  }
  probe.close();
  assert.ok(prOutcomeStep > 0, '应有一步迁移加上 pr_outcome 列');
  const old = new DatabaseSync(file);
  const previous = MIGRATIONS.slice(0, prOutcomeStep);
  for (const migration of previous) migration(old);
  old.exec(`PRAGMA user_version = ${previous.length}`);
  assert.equal(
    old.prepare('PRAGMA table_info(tasks)').all().some((row) => row.name === 'pr_outcome'),
    false,
    '升级前不应有 pr_outcome 列',
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
  const row = db.prepare('SELECT title, pr_outcome FROM tasks WHERE id = 1').get();
  assert.equal(row.title, '旧标题', '旧任务还在');
  assert.equal(row.pr_outcome, null, '旧行 pr_outcome 为 null');
  assert.equal(getTask(db, 1).prOutcome, null, '经任务对象读出 prOutcome 也是 null');
});
