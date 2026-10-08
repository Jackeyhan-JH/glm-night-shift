// issue #12 的调度器集成验收：真调度器 + 真 runner/diagnose + 假 claude + 本地 bare 仓库
// + 假 gh。覆盖「失败 → 自动诊断 → 带诊断重试」的完整链路：诊断写回失败运行、重试
// prompt 附诊断、高峰/额度拦下时跳过诊断并记日志、诊断计入额度、show 展示诊断。
// 绝不联网、不消耗额度；时间用可调时钟，等待一律轮询 + 截止时间。
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../src/db.js';
import { createTask, getTask, listRuns, startRun, finishRun } from '../src/tasks.js';
import { DEFAULT_CONFIG } from '../src/config.js';
import { usage as quotaUsage } from '../src/quota.js';
import { createScheduler } from '../src/scheduler.js';
import { fakeEnv, makeTempHome, fixturePath } from './helpers.js';

// 隔离 git 配置（见 test/git.test.js 的同类说明）：不读机器配置，提交身份显式给
process.env.GIT_CONFIG_NOSYSTEM = '1';
process.env.GIT_CONFIG_GLOBAL = path.join(os.tmpdir(), 'night-shift-diagnose-test-absent-global-config');
process.env.GIT_AUTHOR_NAME = '夜班诊断测试';
process.env.GIT_AUTHOR_EMAIL = 'night-shift-diagnose-test@example.com';
process.env.GIT_COMMITTER_NAME = '夜班诊断测试';
process.env.GIT_COMMITTER_EMAIL = 'night-shift-diagnose-test@example.com';

const FAKE_CLAUDE = fixturePath('fake-claude.mjs');
const FAKE_GH = fixturePath('fake-gh.mjs');
const BIN_PATH = fileURLToPath(new URL('../bin/night-shift.mjs', import.meta.url));
const DIAGNOSIS_TEXT = '原因：缺少依赖\n建议：先安装依赖';

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

/** 轮询等待 fn() 为真（默认 10 秒超时），到点仍未真则断言失败。 */
async function waitUntil(fn, { timeoutMs = 10_000, message = '条件在超时内未满足' } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await fn()) return;
    if (Date.now() >= deadline) assert.fail(message);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function readArgsLog(file) {
  try {
    return fs.readFileSync(file, 'utf8').trim().split('\n')
      .filter((line) => line !== '').map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

/** 作为子进程跑 bin（show 用的就是它），home 显式指定、TZ 固定 UTC。 */
function spawnCli(t, args, { home }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN_PATH, ...args], {
      cwd: makeTempHome(t),
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

/**
 * 一套集成环境：bare 远端 + 临时 home + 文件库 + 真调度器（runner/git/gate/诊断都用
 * 真实现）+ 假 claude/gh + 可调时钟（缺省 2026-10-10T07:00:00Z 周六非高峰）。
 */
function setup(t, {
  taskSpecs = [{}], config: configOverrides = {}, env: envOverrides = {},
  clockAt = '2026-10-10T07:00:00Z', cancelPollMs = 50,
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
  const argsLog = path.join(home, 'claude-args.jsonl');
  const env = fakeEnv({
    FAKE_CLAUDE_ARGS_LOG: argsLog,
    FAKE_GH_LOG: path.join(home, 'gh-log.jsonl'),
    FAKE_GH_BODY_COPY: path.join(home, 'pr-body.md'),
    FAKE_GH_PR_NUMBER: '9',
    ...envOverrides,
  });
  const tasks = taskSpecs.map((spec) => createTask(db, { repo: 'a/b', prompt: '做点修改', title: '诊断集成任务', ...spec }));
  let now = new Date(clockAt);
  const clock = () => now;
  const scheduler = createScheduler({ db, config, home, clock, cancelPollMs, env });
  const doneEvents = [];
  const stageEvents = [];
  scheduler.events.on('done', (payload) => doneEvents.push(payload));
  scheduler.events.on('stage', (payload) => stageEvents.push(payload));
  t.after(() => {
    scheduler.stop();
    db.close();
  });
  return {
    remote, home, db, dbPath, config, tasks, scheduler, env, argsLog, stageEvents,
    setNow: (at) => { now = new Date(at); },
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

// ---------------------------------------------------------------- 完整链路

test('验收：fail,success,success + 诊断文本，maxAttempts 2 → 一轮后 queued 且带诊断，二轮后 succeeded', async (t) => {
  const stateFile = path.join(makeTempHome(t), 'sequence-state.txt');
  const ctx = setup(t, {
    taskSpecs: [{ maxAttempts: 2, title: 'flaky deps' }],
    env: {
      FAKE_CLAUDE_SEQUENCE: 'fail,success,success',
      FAKE_CLAUDE_STATE_FILE: stateFile,
      FAKE_CLAUDE_RESULT_TEXT: DIAGNOSIS_TEXT,
    },
  });
  const [task] = ctx.tasks;

  await ctx.scheduler.tick();
  const first = await ctx.waitDone(task.id);
  assert.equal(first.status, 'queued');

  // 第一轮的 stage：worktree → run → diagnose → cleanup（诊断在放回队列之前）
  const stages = ctx.stageEvents.map((e) => e.stage);
  assert.deepEqual(stages.slice(0, 4), ['worktree', 'run', 'diagnose', 'cleanup']);

  // runs：失败运行 + 诊断运行各一条
  const runs = listRuns(ctx.db, { taskId: task.id });
  assert.equal(runs.length, 2);
  const failedRow = runs.find((r) => r.kind === 'task');
  const diagRow = runs.find((r) => r.kind === 'diagnosis');
  assert.equal(failedRow.status, 'failed');
  assert.ok(failedRow.diagnosis !== null && failedRow.diagnosis.includes('缺少依赖'), failedRow.diagnosis);
  assert.equal(diagRow.model, 'glm-5.3-flash');
  assert.equal(diagRow.effort, 'low');
  assert.equal(diagRow.attempt, failedRow.attempt, '诊断的 attempt 与失败运行相同');
  assert.ok(diagRow.quotaUnits > 0, '诊断运行计入额度');
  assert.equal(diagRow.logPath, path.join(ctx.home, 'logs', `task-${task.id}`, `run-${diagRow.id}.log`));

  // 第二轮：带着诊断重跑并成功
  assert.deepEqual(await ctx.scheduler.tick(), [task.id]);
  const second = await ctx.waitDone(task.id, { round: 2 });
  assert.equal(second.status, 'succeeded');
  assert.equal(getTask(ctx.db, task.id).prUrl, 'https://github.com/a/b/pull/9');

  // quota.usage 的统计包含诊断运行的额度（失败 1 + 诊断 0.4 + 成功 1，非高峰）。
  // runs.started_at 落库用真实时钟，所以统计时刻取最新一条运行的时刻（三条同毫秒级，
  // 都落在同一个五小时窗口里；高峰倍率由 runner 的注入时钟判定为非高峰）。
  const allRuns = listRuns(ctx.db, { taskId: task.id });
  const latest = new Date(Math.max(...allRuns.map((r) => Date.parse(r.startedAt))));
  const usage = quotaUsage(allRuns, latest, { plan: 'v2-max', weekStart: null });
  assert.ok(Math.abs(usage.fiveHour.used - 2.4) < 1e-9, `fiveHour.used 应为 2.4，实际 ${usage.fiveHour.used}`);
});

test('验收：重试 prompt 含「上次失败的诊断」；诊断调用只读、在临时目录里跑且跑完即删', async (t) => {
  const stateFile = path.join(makeTempHome(t), 'sequence-state.txt');
  const ctx = setup(t, {
    taskSpecs: [{ maxAttempts: 2, title: 'flaky deps' }],
    env: {
      FAKE_CLAUDE_SEQUENCE: 'fail,success,success',
      FAKE_CLAUDE_STATE_FILE: stateFile,
      FAKE_CLAUDE_RESULT_TEXT: DIAGNOSIS_TEXT,
    },
  });
  const [task] = ctx.tasks;
  await ctx.scheduler.tick();
  await ctx.waitDone(task.id);

  const entries = readArgsLog(ctx.argsLog);
  assert.equal(entries.length, 2, '第一轮：任务运行 + 诊断运行');
  const [taskCall, diagCall] = entries;
  const failedRow = listRuns(ctx.db, { taskId: task.id, kind: 'task' })[0];
  const diagDir = path.join(ctx.home, 'tmp', `diag-${failedRow.id}`);

  // 诊断那次调用：flash、限 3 轮、只读、不在任务 worktree 里、临时目录跑完删掉
  assert.equal(diagCall.argv[diagCall.argv.indexOf('--model') + 1], 'glm-5.3-flash');
  assert.equal(diagCall.argv[diagCall.argv.indexOf('--max-turns') + 1], '3');
  assert.ok(!diagCall.argv.includes('--dangerously-skip-permissions'), '诊断不带跳过权限旗标');
  assert.equal(diagCall.env.MAX_THINKING_TOKENS, null, '诊断不设思考预算');
  assert.notEqual(diagCall.cwd, path.join(ctx.home, 'worktrees', `task-${task.id}`), 'cwd 不是任务 worktree');
  assert.equal(diagCall.cwd, diagDir);
  assert.equal(fs.existsSync(diagDir), false, '诊断临时目录已删除');
  // 对照：任务运行带跳过权限旗标（要改文件）
  assert.ok(taskCall.argv.includes('--dangerously-skip-permissions'));
  // 诊断 prompt 含失败日志的最后一行（结束 meta 行的原文）
  const logText = fs.readFileSync(failedRow.logPath, 'utf8');
  const lastLine = logText.trimEnd().split('\n').pop().replace(/^\S+ \[\w+\] /, '');
  assert.ok(diagCall.argv[1].includes(lastLine), `诊断 prompt 应含日志最后一行「${lastLine}」`);

  // 第二轮（重试）prompt：附上了诊断段
  assert.deepEqual(await ctx.scheduler.tick(), [task.id]);
  await ctx.waitDone(task.id, { round: 2 });
  const retry = readArgsLog(ctx.argsLog)[2];
  assert.ok(retry.argv[1].includes('上次失败的诊断'), '重试 prompt 含诊断段标题');
  assert.ok(retry.argv[1].includes('缺少依赖'), '重试 prompt 含诊断文本');
});

// ---------------------------------------------------------------- 不诊断的情形

test('验收：autoDiagnose false 时失败后不跑诊断（runs 只有失败的那条）', async (t) => {
  const ctx = setup(t, {
    taskSpecs: [{ maxAttempts: 2 }],
    config: { autoDiagnose: false },
    env: { FAKE_CLAUDE_SCENARIO: 'fail' },
  });
  const [task] = ctx.tasks;
  await ctx.scheduler.tick();
  const done = await ctx.waitDone(task.id);
  assert.equal(done.status, 'queued');
  const runs = listRuns(ctx.db, { taskId: task.id });
  assert.equal(runs.length, 1);
  assert.equal(runs[0].kind, 'task');
  assert.equal(runs[0].diagnosis, null);
  assert.equal(readArgsLog(ctx.argsLog).length, 1, '假 claude 只被调用一次');
});

test('验收：maxAttempts 1 失败（最后一次）不诊断，任务直接 failed', async (t) => {
  const ctx = setup(t, {
    taskSpecs: [{ maxAttempts: 1 }],
    env: { FAKE_CLAUDE_SCENARIO: 'fail' },
  });
  const [task] = ctx.tasks;
  await ctx.scheduler.tick();
  const done = await ctx.waitDone(task.id);
  assert.equal(done.status, 'failed');
  const runs = listRuns(ctx.db, { taskId: task.id });
  assert.equal(runs.length, 1);
  assert.equal(runs[0].kind, 'task');
  assert.equal(readArgsLog(ctx.argsLog).length, 1);
});

test('验收：noop（没有改动）不诊断——run 本身成功、任务 failed 不重试', async (t) => {
  const ctx = setup(t, {
    taskSpecs: [{ maxAttempts: 2 }],
    env: { FAKE_CLAUDE_SCENARIO: 'noop' },
  });
  const [task] = ctx.tasks;
  await ctx.scheduler.tick();
  const done = await ctx.waitDone(task.id);
  assert.equal(done.status, 'failed');
  assert.equal(getTask(ctx.db, task.id).lastError, '没有改动');
  const runs = listRuns(ctx.db, { taskId: task.id });
  assert.equal(runs.length, 1);
  assert.equal(runs[0].status, 'succeeded', 'run 成功了，是流水线判定没有改动');
  assert.equal(readArgsLog(ctx.argsLog).length, 1);
});

test('验收：rate-limit 不诊断——限流走退避路径，runs 只有被拒的那条', async (t) => {
  const ctx = setup(t, {
    taskSpecs: [{ maxAttempts: 2 }],
    env: { FAKE_CLAUDE_SCENARIO: 'rate-limit' },
  });
  const [task] = ctx.tasks;
  await ctx.scheduler.tick();
  const done = await ctx.waitDone(task.id);
  assert.equal(done.status, 'queued');
  assert.ok(getTask(ctx.db, task.id).lastError.includes('限流'));
  const runs = listRuns(ctx.db, { taskId: task.id });
  assert.equal(runs.length, 1);
  assert.equal(runs[0].kind, 'task');
  assert.equal(readArgsLog(ctx.argsLog).length, 1);
});

// ---------------------------------------------------------------- 诊断本身失败

test('验收：fail,fail,success（诊断失败）→ 照常回队、diagnosis 为空、重试 prompt 不含诊断段', async (t) => {
  const stateFile = path.join(makeTempHome(t), 'sequence-state.txt');
  const ctx = setup(t, {
    taskSpecs: [{ maxAttempts: 2, title: 'diag breaks' }],
    env: { FAKE_CLAUDE_SEQUENCE: 'fail,fail,success', FAKE_CLAUDE_STATE_FILE: stateFile },
  });
  const [task] = ctx.tasks;

  await ctx.scheduler.tick();
  const first = await ctx.waitDone(task.id);
  assert.equal(first.status, 'queued', '诊断失败不影响重试');

  const runs = listRuns(ctx.db, { taskId: task.id });
  assert.equal(runs.length, 2);
  const failedRow = runs.find((r) => r.kind === 'task');
  const diagRow = runs.find((r) => r.kind === 'diagnosis');
  assert.equal(failedRow.diagnosis, null, '失败运行不留诊断');
  assert.equal(diagRow.status, 'failed', '诊断运行如实记失败');
  assert.equal(diagRow.diagnosis, null);

  assert.deepEqual(await ctx.scheduler.tick(), [task.id]);
  const second = await ctx.waitDone(task.id, { round: 2 });
  assert.equal(second.status, 'succeeded');
  const retry = readArgsLog(ctx.argsLog)[2];
  assert.ok(!retry.argv[1].includes('上次失败的诊断'), '重试 prompt 不含诊断段');
});

// ---------------------------------------------------------------- 闸门拦下：高峰 / 额度

test('验收：高峰 runNow 失败的 allowPeak:false 任务 → 诊断被高峰跳过，日志有跳过原因', async (t) => {
  const ctx = setup(t, {
    taskSpecs: [{ maxAttempts: 2, title: 'peak fail' }],
    clockAt: '2026-10-08T07:00:00Z', // 周四北京 15:00，高峰
    env: { FAKE_CLAUDE_SCENARIO: 'fail' },
  });
  const [task] = ctx.tasks;

  const final = await ctx.scheduler.runNow(task.id); // runNow 无视高峰，任务照跑
  assert.equal(final.status, 'queued');

  const runs = listRuns(ctx.db, { taskId: task.id });
  assert.equal(runs.length, 1, '没有 kind=diagnosis 的运行');
  assert.equal(runs[0].kind, 'task');
  assert.equal(runs[0].quotaUnits, 3, '高峰里的任务运行按 3 倍计');
  const logText = fs.readFileSync(runs[0].logPath, 'utf8');
  assert.ok(logText.includes('诊断被跳过：高峰期'), `失败日志应记跳过原因，实际：\n${logText}`);
  assert.equal(readArgsLog(ctx.argsLog).length, 1, '假 claude 只被调用一次（没跑诊断）');
});

test('验收：五小时额度接近上限 → 诊断因额度被跳过，日志有跳过原因', async (t) => {
  const ctx = setup(t, {
    taskSpecs: [{ maxAttempts: 2, title: 'quota fail' }],
    env: { FAKE_CLAUDE_SCENARIO: 'fail' },
  });
  const [task] = ctx.tasks;
  const feeder = createTask(ctx.db, { repo: 'a/b', prompt: 'feeder' });
  const now = new Date('2026-10-10T07:00:00Z');
  // 4 × 360 = 1440 = 1600 × 0.9：五小时窗口贴着安全线上限
  for (const minutesAgo of [60, 50, 40, 30]) {
    seedRun(ctx.db, feeder.id, {
      startedAt: new Date(now.getTime() - minutesAgo * 60_000),
      quotaUnits: 360,
    });
  }

  const final = await ctx.scheduler.runNow(task.id); // runNow 无视额度，任务照跑（+1 超线）
  assert.equal(final.status, 'queued');

  const runs = listRuns(ctx.db, { taskId: task.id });
  assert.equal(runs.length, 1, '没有 kind=diagnosis 的运行');
  const logText = fs.readFileSync(runs[0].logPath, 'utf8');
  assert.ok(logText.includes('诊断被跳过：五小时额度'), `失败日志应记跳过原因，实际：\n${logText}`);
  assert.equal(readArgsLog(ctx.argsLog).length, 1);
});

// ---------------------------------------------------------------- 命令行展示

test('验收：show <id> 运行列表显示类型与诊断第一行', async (t) => {
  const stateFile = path.join(makeTempHome(t), 'sequence-state.txt');
  const ctx = setup(t, {
    taskSpecs: [{ maxAttempts: 2, title: 'show me' }],
    env: {
      FAKE_CLAUDE_SEQUENCE: 'fail,success,success',
      FAKE_CLAUDE_STATE_FILE: stateFile,
      FAKE_CLAUDE_RESULT_TEXT: DIAGNOSIS_TEXT,
    },
  });
  const [task] = ctx.tasks;
  await ctx.scheduler.tick();
  await ctx.waitDone(task.id);

  const res = await spawnCli(t, ['show', String(task.id)], { home: ctx.home });
  assert.equal(res.code, 0, res.stderr);
  assert.ok(res.stdout.includes('类型'), '运行列表有「类型」列');
  assert.ok(res.stdout.includes('diagnosis'), '诊断运行按类型展示');
  assert.ok(res.stdout.includes(`诊断（run `), '诊断行有标注');
  assert.ok(res.stdout.includes('原因：缺少依赖'), '展示诊断第一行');
  assert.ok(!res.stdout.includes('建议：先安装依赖'), '只显示第一行，多行诊断看 --json');
});
