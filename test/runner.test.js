// src/runner.js 的测试（issue #7 验收项 + 边界情况）。所有 claude 调用都走
// test/fixtures/fake-claude.mjs（或测试自建的迷你假脚本），绝不消耗真实额度；
// home / workdir / 库都在临时目录里，测试结束自动清理。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { openDb } from '../src/db.js';
import { createTask, claimNextTask, listRuns } from '../src/tasks.js';
import { DEFAULT_CONFIG } from '../src/config.js';
import { runCost } from '../src/quota.js';
import { runTask, buildPrompt, runEvents } from '../src/runner.js';
import { fakeEnv, makeTempHome, fixturePath } from './helpers.js';

const FAKE_CLAUDE = fixturePath('fake-claude.mjs');
const LOG_LINE_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.\d{3}Z \[(stdout|stderr|meta)\] /;

/**
 * 一套独立的运行环境：临时 home（库 + 日志）、临时 workdir、已领取的任务、
 * 指向假 claude 的 config、剥掉真实凭据的 env。envOverrides 里给 FAKE_CLAUDE_* / MAX_THINKING_TOKENS。
 */
function setup(t, { difficulty = 'medium', scenario, env: envOverrides = {}, ...taskOverrides } = {}) {
  const home = makeTempHome(t);
  const workdir = makeTempHome(t);
  const db = openDb(path.join(home, 'night-shift.db'));
  t.after(() => db.close());
  const created = createTask(db, {
    repo: 'owner/name',
    prompt: '把登录页修好',
    difficulty,
    testCommand: 'npm test',
    ...taskOverrides,
  });
  const task = claimNextTask(db); // attempts → 1（runner 的 attempt 缺省取它）
  assert.equal(task.id, created.id);
  const config = { ...DEFAULT_CONFIG, claudeBin: FAKE_CLAUDE };
  const env = fakeEnv({
    FAKE_CLAUDE_ARGS_LOG: path.join(home, 'args.jsonl'),
    ...(scenario ? { FAKE_CLAUDE_SCENARIO: scenario } : {}),
    ...envOverrides,
  });
  return { home, workdir, db, task, config, env };
}

function readArgsLog(home) {
  return fs.readFileSync(path.join(home, 'args.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line));
}

function readLogLines(logPath) {
  return fs.readFileSync(logPath, 'utf8').split('\n').filter((line) => line !== '');
}

function runRow(db, runId) {
  return listRuns(db, {}).find((run) => run.id === runId);
}

/**
 * 在临时目录里写一个迷你假 claude（无扩展名 + shebang；临时目录里没有 package.json，
 * 按 CommonJS 解析，body 里要用 require）。测试专用的假替身，不碰真实 claude。
 */
function writeMiniClaude(t, body) {
  const dir = makeTempHome(t);
  const script = path.join(dir, 'mini-claude');
  fs.writeFileSync(script, `#!/usr/bin/env node\n${body}\n`);
  fs.chmodSync(script, 0o755);
  return script;
}

// ---------------------------------------------------------------- buildPrompt

test('验收: buildPrompt 包含任务 prompt、仓库名、testCommand 与「不要 git push」', () => {
  const prompt = buildPrompt(
    { prompt: '把登录页修好', repo: 'owner/name', testCommand: 'npm test' },
    {},
  );
  assert.ok(prompt.startsWith('把登录页修好'));
  assert.ok(prompt.includes('owner/name'));
  assert.ok(prompt.includes('- 完成后运行测试命令：npm test，确保通过。'));
  assert.ok(prompt.includes('不要 git push，不要切换或新建分支，不要开 PR'));

  const noCmd = buildPrompt({ prompt: 'p', repo: 'o/r', testCommand: null }, {});
  assert.ok(noCmd.includes('- 如果仓库有现成的测试，运行并确保通过。'));
  assert.ok(!noCmd.includes('运行测试命令'));
});

test('验收: extraPrompt 追加「上次失败的诊断」段', () => {
  const prompt = buildPrompt(
    { prompt: 'p', repo: 'o/r', testCommand: null },
    { extraPrompt: '测试没跑过：jest 挂在 auth.test.js' },
  );
  const at = prompt.indexOf('## 上次失败的诊断');
  assert.ok(at > 0, '应包含诊断标题');
  assert.ok(prompt.slice(at).includes('jest 挂在 auth.test.js'));
  assert.equal(buildPrompt({ prompt: 'p', repo: 'o/r' }, {}).includes('上次失败的诊断'), false);
  assert.equal(
    buildPrompt({ prompt: 'p', repo: 'o/r' }, { extraPrompt: '   ' }).includes('上次失败的诊断'),
    false,
    '纯空白的 extraPrompt 视为没有',
  );
});

// ---------------------------------------------------------------- 参数与环境

test('验收: hard 任务 argv 依次含 -p/--model glm-5.3/…，MAX_THINKING_TOKENS=32000，cwd 为 workdir', async (t) => {
  const ctx = setup(t, { difficulty: 'hard' });
  const result = await runTask(ctx);
  assert.equal(result.status, 'succeeded');

  const [entry] = readArgsLog(ctx.home);
  const argv = entry.argv;
  const markers = ['-p', '--model', '--dangerously-skip-permissions', '--output-format', '--verbose'];
  const positions = markers.map((marker) => argv.indexOf(marker));
  assert.ok(positions.every((at) => at >= 0), `argv 应包含全部旗标：${JSON.stringify(argv)}`);
  assert.deepEqual(positions, [...positions].sort((a, b) => a - b), '旗标应依次出现');
  assert.equal(argv[positions[0] + 1], buildPrompt(ctx.task, {}), '-p 后面跟完整 prompt');
  assert.equal(argv[positions[1] + 1], 'glm-5.3');
  assert.equal(argv[positions[3] + 1], 'stream-json');
  assert.equal(entry.cwd, ctx.workdir);
  assert.equal(entry.env.MAX_THINKING_TOKENS, '32000');
  assert.equal(result.model, 'glm-5.3');
  assert.equal(result.effort, 'high');
});

test('验收: easy 任务用 glm-5.3-flash；外层环境 MAX_THINKING_TOKENS=999 时 args log 里也是 null', async (t) => {
  const ctx = setup(t, { difficulty: 'easy', env: { MAX_THINKING_TOKENS: '999' } });
  const result = await runTask(ctx);
  assert.equal(result.status, 'succeeded');

  const [entry] = readArgsLog(ctx.home);
  const modelAt = entry.argv.indexOf('--model');
  assert.equal(entry.argv[modelAt + 1], 'glm-5.3-flash');
  assert.equal(entry.env.MAX_THINKING_TOKENS, null, 'effort=low 时必须从子进程环境里删掉');
  assert.equal(ctx.env.MAX_THINKING_TOKENS, '999', '调用方传入的 env 对象绝不能被改动');
});

// ---------------------------------------------------------------- 成功与日志

test('验收: success 场景结果、runs 行、NIGHT_SHIFT_FAKE.md 与日志格式', async (t) => {
  // 固定在周日非高峰：medium 的额度就是 1 倍，runCost 可精确断言
  const clock = () => new Date('2026-10-11T07:00:00Z');
  const ctx = setup(t);
  const result = await runTask({ ...ctx, clock });

  assert.equal(result.status, 'succeeded');
  assert.equal(result.exitCode, 0);
  assert.equal(result.numTurns, 3);
  assert.equal(result.isError, false);
  assert.equal(result.summary, 'done');
  assert.equal(result.error, null);
  assert.equal(result.rateLimited, false);
  assert.equal(result.peak, false);
  assert.equal(result.quotaUnits, 1);
  assert.equal(result.durationMs > 0, true);
  assert.equal(fs.existsSync(path.join(ctx.workdir, 'NIGHT_SHIFT_FAKE.md')), true);

  const expectedLog = path.join(ctx.home, 'logs', `task-${ctx.task.id}`, `run-${result.runId}.log`);
  assert.equal(result.logPath, expectedLog);
  const row = runRow(ctx.db, result.runId);
  assert.equal(row.status, 'succeeded');
  assert.equal(row.exitCode, 0);
  assert.equal(row.numTurns, 3);
  assert.equal(row.prompts, 1);
  assert.equal(row.quotaUnits, runCost({ model: 'glm-5.3', startedAt: clock() }));
  assert.equal(row.quotaUnits, 1);
  assert.equal(row.durationMs, result.durationMs, '返回值与 runs 行一致');
  assert.equal(row.logPath, expectedLog, 'log_path 即返回的 logPath');
  assert.equal(row.error, null);

  const [entry] = readArgsLog(ctx.home);
  assert.equal(entry.env.MAX_THINKING_TOKENS, '8000', 'medium → 8000');
  assert.throws(() => process.kill(entry.pid, 0), (err) => err.code === 'ESRCH', '正常结束后子进程应已不在');

  const lines = readLogLines(expectedLog);
  assert.ok(lines.length > 0);
  for (const line of lines) assert.match(line, LOG_LINE_PATTERN);
  assert.ok(lines.some((line) => line.includes(' [stdout] ')), '日志应含 stdout 行');
  assert.ok(lines.some((line) => line.includes('[meta] 开始 model=glm-5.3 effort=medium')));
  assert.ok(lines.some((line) => line.includes('[meta] 结束 status=succeeded exit=0')));
  assert.ok(lines.some((line) => line.includes('[stdout] ') && line.includes('"type":"result"')));
});

test('验收: fail 场景 status=failed、exitCode=1、isError=true、error 非空、rateLimited=false', async (t) => {
  const ctx = setup(t, { scenario: 'fail' });
  const clock = () => new Date('2026-10-11T07:00:00Z'); // 固定非高峰，额度断言才稳定
  const result = await runTask({ ...ctx, clock });
  assert.equal(result.status, 'failed');
  assert.equal(result.exitCode, 1);
  assert.equal(result.isError, true);
  assert.ok(result.error && result.error !== '');
  assert.equal(result.rateLimited, false);
  const row = runRow(ctx.db, result.runId);
  assert.equal(row.status, 'failed');
  assert.equal(row.quotaUnits, runCost({ model: 'glm-5.3', startedAt: clock() }), '失败的运行照常计额度');
  const lines = readLogLines(result.logPath);
  assert.ok(lines.some((line) => line.includes('[stderr] fake failure')), 'stderr 错误行要进日志');
});

// ---------------------------------------------------------------- 高峰与额度（注入时钟）

test('验收: 时钟 2026-10-08T07:00:00Z（周四北京 15:00）peak=true、medium quotaUnits=3；'
  + '2026-10-10T07:00:00Z（周六）easy quotaUnits=0.4', async (t) => {
  const peakCtx = setup(t, { difficulty: 'medium' });
  const offCtx = setup(t, { difficulty: 'easy' });
  const [peakRun, offRun] = await Promise.all([
    runTask({ ...peakCtx, clock: () => new Date('2026-10-08T07:00:00Z') }),
    runTask({ ...offCtx, clock: () => new Date('2026-10-10T07:00:00Z') }),
  ]);

  assert.equal(peakRun.peak, true);
  assert.equal(peakRun.quotaUnits, 3);
  assert.equal(runCost({ model: 'glm-5.3', startedAt: new Date('2026-10-08T07:00:00Z') }), 3);
  assert.equal(runRow(peakCtx.db, peakRun.runId).peak, true);

  assert.equal(offRun.peak, false);
  assert.equal(offRun.quotaUnits, 0.4);
  assert.equal(runRow(offCtx.db, offRun.runId).quotaUnits, 0.4);
});

// ---------------------------------------------------------------- 限流与截断

test('验收: rate-limit 场景 rateLimited=true、error 以 rate_limit: 开头且含 429，runs 行额度为 0', async (t) => {
  const ctx = setup(t, { scenario: 'rate-limit' });
  const result = await runTask(ctx);
  assert.equal(result.status, 'failed');
  assert.equal(result.rateLimited, true);
  assert.ok(result.error.startsWith('rate_limit:'));
  assert.ok(result.error.includes('429'));
  const row = runRow(ctx.db, result.runId);
  assert.equal(row.quotaUnits, 0, '请求被拒，不算额度');
  assert.equal(row.prompts, 0);
  assert.equal(result.quotaUnits, 0);
});

test('验收: truncated 场景 status=failed、rateLimited=false、error 以 truncated: 开头', async (t) => {
  const ctx = setup(t, { scenario: 'truncated' });
  const result = await runTask(ctx);
  assert.equal(result.status, 'failed');
  assert.equal(result.rateLimited, false);
  assert.ok(result.error.startsWith('truncated:'));
  assert.ok(result.error.includes('exit 1'));
  assert.equal(result.numTurns, null, '没有 result 行就没有轮数');
  assert.equal(result.summary, null);
});

// ---------------------------------------------------------------- 超时与击杀

test('验收: hang + timeoutMs=500：1.5 秒内返回 timeout', async (t) => {
  const ctx = setup(t, { scenario: 'hang' });
  const startedAt = Date.now();
  const result = await runTask({ ...ctx, timeoutMs: 500 });
  const elapsed = Date.now() - startedAt;
  assert.ok(elapsed < 1500, `应在 1.5 秒内返回，实际 ${elapsed}ms`);
  assert.equal(result.status, 'timeout');
  assert.match(result.error, /^超时（.+ 分钟）$/);
  assert.equal(runRow(ctx.db, result.runId).status, 'timeout');
  const [entry] = readArgsLog(ctx.home);
  assert.throws(() => process.kill(entry.pid, 0), (err) => err.code === 'ESRCH', '超时击杀后子进程应已不在');
});

test('验收: stubborn + timeoutMs=300, killGraceMs=300：1.5 秒内 timeout，且假 claude 进程已不存在', async (t) => {
  const ctx = setup(t, { scenario: 'stubborn' });
  const startedAt = Date.now();
  const result = await runTask({ ...ctx, timeoutMs: 300, killGraceMs: 300 });
  const elapsed = Date.now() - startedAt;
  assert.ok(elapsed < 1500, `应在 1.5 秒内返回，实际 ${elapsed}ms`);
  assert.equal(result.status, 'timeout');
  // 不断言 signal === 'SIGKILL'：规格定的 300ms SIGTERM 在高负载下可能赶在假 claude
  // 完成启动（装好信号处理器）之前到达，按默认动作把它杀死（signal 为 SIGTERM）——
  // 结论同样是 timeout、进程同样被清掉。「SIGTERM 被无视、必须 SIGKILL」的确定性
  // 断言在下面「无视 SIGTERM 的孙进程」用例里（有就绪屏障）。

  const [entry] = readArgsLog(ctx.home);
  assert.ok(Number.isInteger(entry.pid), 'args log 里应有 pid');
  assert.throws(
    () => process.kill(entry.pid, 0),
    (err) => err.code === 'ESRCH',
    '进程组击杀后子进程应确实不在了',
  );
});

// ---------------------------------------------------------------- 取消与停机

test('验收: hang 运行中 abort() 1 秒内返回 canceled；abort("shutdown") 返回 failed 且 error=interrupted', async (t) => {
  const cancelCtx = setup(t, { scenario: 'hang' });
  const shutdownCtx = setup(t, { scenario: 'hang' });
  const cancelController = new AbortController();
  const shutdownController = new AbortController();

  const cancelRun = runTask({ ...cancelCtx, signal: cancelController.signal, timeoutMs: 60_000 });
  const shutdownRun = runTask({ ...shutdownCtx, signal: shutdownController.signal, timeoutMs: 60_000 });
  setTimeout(() => cancelController.abort(), 200);
  setTimeout(() => shutdownController.abort('shutdown'), 200);

  let startedAt = Date.now();
  const canceled = await cancelRun;
  assert.ok(Date.now() - startedAt < 1000, `abort 后 1 秒内返回，实际 ${Date.now() - startedAt}ms`);
  assert.equal(canceled.status, 'canceled');
  assert.equal(runRow(cancelCtx.db, canceled.runId).status, 'canceled');

  startedAt = Date.now();
  const interrupted = await shutdownRun;
  assert.ok(Date.now() - startedAt < 1000);
  assert.equal(interrupted.status, 'failed');
  assert.equal(interrupted.error, 'interrupted');
});

test('验收: 调用前 signal 已 aborted：不启动子进程，按规则记录（canceled / interrupted）', async (t) => {
  const canceledCtx = setup(t, { scenario: 'hang' });
  const canceledController = new AbortController();
  canceledController.abort();
  const canceled = await runTask({ ...canceledCtx, signal: canceledController.signal });
  assert.equal(canceled.status, 'canceled');
  assert.equal(canceled.exitCode, null);
  assert.equal(fs.existsSync(path.join(canceledCtx.home, 'args.jsonl')), false, '没有启动过子进程');
  const lines = readLogLines(canceled.logPath);
  assert.ok(lines.some((line) => line.includes('未启动子进程')));
  assert.ok(lines.some((line) => line.includes('[meta] 结束 status=canceled')));
  assert.equal(runRow(canceledCtx.db, canceled.runId).status, 'canceled');

  const downCtx = setup(t, { scenario: 'hang' });
  const downController = new AbortController();
  downController.abort('shutdown');
  const down = await runTask({ ...downCtx, signal: downController.signal });
  assert.equal(down.status, 'failed');
  assert.equal(down.error, 'interrupted');
});

// ---------------------------------------------------------------- spawn 失败

test('验收: claudeBin 指向不存在的路径：返回 failed，error 含该路径，不抛异常', async (t) => {
  const ctx = setup(t);
  const result = await runTask({ ...ctx, config: { ...ctx.config, claudeBin: '/nonexistent/claude-none' } });
  assert.equal(result.status, 'failed');
  assert.ok(result.error.includes('/nonexistent/claude-none'));
  assert.equal(result.exitCode, null);
  assert.equal(runRow(ctx.db, result.runId).status, 'failed');
  assert.ok(fs.existsSync(result.logPath), 'spawn 失败也要留下日志');
});

// ---------------------------------------------------------------- 事件

test('验收: runEvents 依次收到 start、若干 log（含 stdout 的 result 行）、finish，runId 一致', async (t) => {
  const ctx = setup(t);
  const events = [];
  const capture = (name) => (payload) => events.push({ name, payload });
  runEvents.on('start', capture('start'));
  runEvents.on('log', capture('log'));
  runEvents.on('finish', capture('finish'));
  t.after(() => {
    runEvents.off('start', capture('start'));
    runEvents.off('log', capture('log'));
    runEvents.off('finish', capture('finish'));
  });

  const result = await runTask(ctx);

  assert.equal(events[0].name, 'start');
  assert.equal(events[0].payload.taskId, ctx.task.id);
  assert.equal(events[0].payload.runId, result.runId);
  assert.equal(events[0].payload.logPath, result.logPath);
  assert.equal(events[events.length - 1].name, 'finish');
  assert.equal(events[events.length - 1].payload.runId, result.runId);
  assert.equal(events[events.length - 1].payload.status, 'succeeded');

  const logs = events.filter((event) => event.name === 'log');
  assert.ok(logs.length >= 4, '至少有 meta 开始、stdout 若干、meta 结束');
  assert.ok(logs.every((event) => event.payload.runId === result.runId
    && event.payload.taskId === ctx.task.id));
  assert.ok(logs.some((event) => event.payload.stream === 'stdout'
    && event.payload.line.includes('"type":"result"')), 'log 事件要含 stdout 的 result 行');
  assert.ok(logs.some((event) => event.payload.stream === 'meta'));
  // 相对顺序：start < 全部 log < finish（start / finish 之间的才属于本次运行的日志）
  const firstLogAt = events.findIndex((event) => event.name === 'log');
  const finishAt = events.findIndex((event) => event.name === 'finish');
  assert.ok(firstLogAt > 0 && firstLogAt < finishAt);
  for (const event of logs) assert.ok(events.indexOf(event) < finishAt);
});

// ---------------------------------------------------------------- 场景序列

test('验收: FAKE_CLAUDE_SEQUENCE=fail,success 连续跑：先 failed 后 succeeded', async (t) => {
  const home = makeTempHome(t);
  const stateFile = path.join(home, 'sequence-state.txt');
  const ctx = setup(t, {
    env: { FAKE_CLAUDE_SEQUENCE: 'fail,success', FAKE_CLAUDE_STATE_FILE: stateFile },
  });
  const first = await runTask(ctx);
  const second = await runTask(ctx);
  assert.equal(first.status, 'failed');
  assert.equal(second.status, 'succeeded');
  assert.equal(fs.readFileSync(stateFile, 'utf8'), '2');
});

// ---------------------------------------------------------------- 边界：断行与流式

test('跨 chunk 的 UTF-8 半字符能拼回，无换行的最后一行在进程结束时补写', async (t) => {
  // 本用例不用 fake-claude（它的输出都以换行结尾）：在临时目录里放一个迷你假脚本，
  // 把最后一行按字节切开、延后再写、且不带换行。同样是假替身，不碰真实 claude。
  const script = writeMiniClaude(t, `
    const tail = ${JSON.stringify('中文尾巴'.repeat(3))};
    const line = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, num_turns: 2, result: '尾巴完整' });
    process.stdout.write(line + '\\n');
    process.stderr.write('半路 stderr\\n');
    const buf = Buffer.from(tail, 'utf8');
    process.stdout.write(buf.subarray(0, 5)); // 切在多字节字符中间
    setTimeout(() => process.stdout.write(buf.subarray(5)), 50); // 不带换行
  `);
  const ctx = setup(t);
  const result = await runTask({ ...ctx, config: { ...ctx.config, claudeBin: script } });
  assert.equal(result.status, 'succeeded');
  assert.equal(result.numTurns, 2);
  assert.equal(result.summary, '尾巴完整');
  const lines = readLogLines(result.logPath);
  assert.ok(lines.some((line) => line.endsWith(`[stdout] ${'中文尾巴'.repeat(3)}`)), '补写的最后一行应完整且无替换字符');
  assert.ok(lines.some((line) => line.endsWith('[stderr] 半路 stderr')));
});

// ---------------------------------------------------------------- 孤儿进程清场

test('孙进程抱着 stdout 不放：子进程 exit 后 SIGTERM 清场，及时按 exit 结果结算，孙进程被清掉', async (t) => {
  const script = writeMiniClaude(t, `
    const { spawn } = require('node:child_process');
    const { appendFileSync } = require('node:fs');
    // 后台 sleep 继承 stdout/stderr：子进程退出后管道仍被它抱着，close 不会自己来
    const sleep = spawn('sleep', ['30'], { stdio: ['ignore', process.stdout, process.stderr] });
    sleep.unref(); // 让本进程能退出，sleep 留在进程组里
    appendFileSync(process.env.PIDS_FILE, JSON.stringify({ holder: sleep.pid }) + '\\n');
    process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, result: 'orphan' }) + '\\n');
  `);
  const ctx = setup(t);
  const pidsFile = path.join(ctx.home, 'pids.jsonl');
  const startedAt = Date.now();
  const result = await runTask({
    ...ctx,
    config: { ...ctx.config, claudeBin: script },
    env: { ...ctx.env, PIDS_FILE: pidsFile },
    killGraceMs: 800,
  });
  const elapsed = Date.now() - startedAt;
  assert.ok(elapsed < 1500, `不应拖到超时，实际 ${elapsed}ms`);
  assert.equal(result.status, 'succeeded', '按 exit 时的退出码 0 + result 行判定');
  assert.equal(result.summary, 'orphan');
  const lines = readLogLines(result.logPath);
  assert.ok(lines.some((line) => line.includes('进程组仍有成员')), '清场动作要记进日志');
  const { holder } = JSON.parse(fs.readFileSync(pidsFile, 'utf8').trim());
  assert.throws(() => process.kill(holder, 0), (err) => err.code === 'ESRCH', '抱管道的孙进程应被清掉');
});

test('无视 SIGTERM 的孙进程抱着管道：短宽限后 SIGKILL 清场，仍按 exit 结果结算', async (t) => {
  // 两个确定性保障，缺一个高负载下就偶发翻车：
  // 1. holder 先落「信号处理器已就绪」文件、父进程见到它才退出——否则执行器在子进程
  //    exit 时发的 SIGTERM 可能赶在 holder 注册处理器之前把它打死，测不到升级路径；
  // 2. 子进程等到绝对时刻 EXIT_AT_MS 才退出（而不是「启动后约 60ms」）——超时定时器
  //    （1200ms）必然落在它退出之后、清场完成之前，慢启动也挤不进别的顺序。
  const script = writeMiniClaude(t, `
    const { spawn } = require('node:child_process');
    const { appendFileSync, existsSync } = require('node:fs');
    const holder = spawn(process.execPath, ['-e', 'const fs = require("node:fs"); process.on("SIGTERM", () => {}); process.on("SIGINT", () => {}); fs.writeFileSync(process.env.READY_FILE, "1"); setInterval(() => {}, 60000);'], { stdio: ['ignore', 'inherit', 'inherit'] });
    holder.unref();
    appendFileSync(process.env.PIDS_FILE, JSON.stringify({ holder: holder.pid }) + '\\n');
    const exitAt = Number(process.env.EXIT_AT_MS);
    const wait = () => {
      if (existsSync(process.env.READY_FILE) && Date.now() >= exitAt) {
        process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, result: 'stubborn-holder' }) + '\\n');
        return; // 没有别的活儿了，事件循环一空本进程自然退出
      }
      setTimeout(wait, 10);
    };
    wait();
  `);
  const ctx = setup(t);
  const pidsFile = path.join(ctx.home, 'pids.jsonl');
  const startedAt = Date.now();
  const result = await runTask({
    ...ctx,
    config: { ...ctx.config, claudeBin: script },
    env: {
      ...ctx.env,
      PIDS_FILE: pidsFile,
      READY_FILE: path.join(ctx.home, 'holder-ready'),
      EXIT_AT_MS: String(startedAt + 400),
    },
    killGraceMs: 1200, // stdio 宽限 = min(2000, 1200) = 1200ms，之后 SIGKILL
    timeoutMs: 1200, // 子进程最迟 ~400ms 已退出：定时器到点时它已退，不许改写成 timeout
  });
  const elapsed = Date.now() - startedAt;
  assert.ok(elapsed < 4000, `SIGKILL 清场后应及时返回，实际 ${elapsed}ms`);
  assert.equal(result.status, 'succeeded');
  assert.equal(result.summary, 'stubborn-holder');
  const lines = readLogLines(result.logPath);
  assert.ok(lines.some((line) => line.includes('对进程组发 SIGKILL')), '升级到 SIGKILL 要记进日志');
  assert.ok(!lines.some((line) => line.includes('超时')), '子进程赶在超时前退出，不应记超时');
  const { holder } = JSON.parse(fs.readFileSync(pidsFile, 'utf8').trim());
  assert.throws(() => process.kill(holder, 0), (err) => err.code === 'ESRCH');
});

// ---------------------------------------------------------------- 内存与健壮性

test('大输出流式处理：2 万行 + 2MB 单行全部进日志，不整段驻留内存', async (t) => {
  const script = writeMiniClaude(t, `
    for (let i = 0; i < 20000; i++) process.stdout.write(JSON.stringify({ type: 'assistant', n: i }) + '\\n');
    process.stdout.write('{"type":"note","blob":"' + 'x'.repeat(2 * 1024 * 1024) + '"}\\n');
    process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, result: 'big' }) + '\\n');
  `);
  const ctx = setup(t);
  const result = await runTask({ ...ctx, config: { ...ctx.config, claudeBin: script } });
  assert.equal(result.status, 'succeeded');
  assert.equal(result.summary, 'big');
  const lines = readLogLines(result.logPath);
  const stdoutLines = lines.filter((line) => line.includes(' [stdout] '));
  assert.equal(stdoutLines.length, 20002, '2 万 assistant + 2MB 单行 + result 各一行');
  assert.ok(stdoutLines.some((line) => line.includes('[stdout] {"type":"note"')), '超长单行也完整入日志');
});

test('runEvents 监听器抛错：不影响运行结果与结束记录，错误记进日志', async (t) => {
  const ctx = setup(t);
  const boom = () => { throw new Error('listener bug'); };
  for (const name of ['start', 'log', 'finish']) runEvents.on(name, boom);
  t.after(() => {
    for (const name of ['start', 'log', 'finish']) runEvents.off(name, boom);
  });
  const result = await runTask(ctx);
  assert.equal(result.status, 'succeeded');
  assert.equal(runRow(ctx.db, result.runId).status, 'succeeded');
  assert.ok(readLogLines(result.logPath).some((line) => line.includes('监听器抛错')));
});

test('日志写不进去（路径被目录占位）：仍正常结算，runTask 不炸', async (t) => {
  const ctx = setup(t); // 全新库，本次 run 的 id 必为 1
  const logDir = path.join(ctx.home, 'logs', `task-${ctx.task.id}`);
  fs.mkdirSync(path.join(logDir, 'run-1.log'), { recursive: true }); // 占住日志文件路径
  const result = await runTask(ctx);
  assert.equal(result.runId, 1);
  assert.equal(result.status, 'succeeded');
  assert.equal(result.logPath, path.join(logDir, 'run-1.log'));
  assert.equal(runRow(ctx.db, 1).status, 'succeeded', '写不了日志也要 finishRun');
});

// ---------------------------------------------------------------- 边界：参数校验

test('缺 task / workdir / db / home / workdir 不存在：参数错误直接 reject', async (t) => {
  const ctx = setup(t);
  const cases = [
    [{ ...ctx, task: null }, 'task'],
    [{ ...ctx, workdir: undefined }, 'workdir'],
    [{ ...ctx, db: undefined }, 'db'],
    [{ ...ctx, home: undefined }, 'home'],
    [{ ...ctx, workdir: '/nonexistent/dir/for/runner' }, 'workdir'],
  ];
  for (const [input, field] of cases) {
    await assert.rejects(
      () => runTask(input),
      (err) => err instanceof TypeError && err.message.includes(field),
      `缺 ${field} 应报参数错误`,
    );
  }
  // 参数错误时不该留下 running 的 run 行
  assert.deepEqual(listRuns(ctx.db, {}), []);
});

// ---------------------------------------------------------------- 收尾：无残留

test('运行结束后没有残留的定时器 / 监听（活动句柄里不再有 Timeout 增长）', async (t) => {
  const before = process.getActiveResourcesInfo().filter((kind) => kind === 'Timeout').length;
  const ctx = setup(t, { scenario: 'fail' });
  await runTask(ctx);
  await runTask(ctx);
  await new Promise((resolve) => setImmediate(resolve)); // 让 close 后的微任务跑完
  const after = process.getActiveResourcesInfo().filter((kind) => kind === 'Timeout').length;
  assert.equal(after, before, '两次运行不应留下新的定时器');
});
