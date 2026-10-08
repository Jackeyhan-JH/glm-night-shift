// start / peak / usage / logs / run-now 子命令的端到端测试（issue #10）：spawn 真实 CLI
// 进程（fakeEnv 隔离环境），调度类命令接本地 bare 仓库 + 假 claude / 假 gh，绝不联网、
// 不碰 GitHub、不消耗额度。时间输出要稳定：子进程 TZ 固定 Asia/Shanghai，测试时钟用
// NIGHT_SHIFT_NOW 固定（周六非高峰 / 周四高峰各一处）。等待一律轮询 + 截止时间。
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../src/db.js';
import { createTask, getTask, getUserPaused, listRuns, startRun, finishRun } from '../src/tasks.js';
import { fakeEnv, makeTempHome } from './helpers.js';

// 隔离 git 配置（同 test/scheduler-integration.test.js）：不读机器配置，提交身份显式给；
// 这些变量经 fakeEnv 复制进每个子进程。
process.env.GIT_CONFIG_NOSYSTEM = '1';
process.env.GIT_CONFIG_GLOBAL = path.join(os.tmpdir(), 'night-shift-cli-run-test-absent-global-config');
process.env.GIT_AUTHOR_NAME = '夜班命令行测试';
process.env.GIT_AUTHOR_EMAIL = 'night-shift-cli-test@example.com';
process.env.GIT_COMMITTER_NAME = '夜班命令行测试';
process.env.GIT_COMMITTER_EMAIL = 'night-shift-cli-test@example.com';

const binPath = fileURLToPath(new URL('../bin/night-shift.mjs', import.meta.url));
/** 周六北京 15:00，非高峰：start / run-now 不被高峰闸门挡住的时间基准。 */
const OFF_PEAK_NOW = '2026-10-10T07:00:00Z';

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

/**
 * 一套 CLI 环境：bare 远端 + 临时 home + config.json（remoteUrlTemplate 指向本地 bare、
 * pollSeconds 0.2、killGraceSeconds 1，其余用默认）。config 覆盖 config.json 的额外键。
 */
function setup(t, { config = {} } = {}) {
  const remote = makeBareRemote(t);
  const home = makeTempHome(t);
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({
    remoteUrlTemplate: path.join(remote.dir, '{owner}__{name}.git'),
    pollSeconds: 0.2,
    killGraceSeconds: 1,
    ...config,
  }));
  return { remote, home };
}

/**
 * spawn 一个 CLI 子进程（TZ 固定 Asia/Shanghai），增量收集 stdout / stderr。
 * 返回 { child, close, stdout, stderr }：close 是退出信息 { code, signal } 的 Promise；
 * stdout()/stderr() 取到目前为止的累积文本。调用方自行负责 kill 兜底。
 */
function spawnCliProc(args, { home, env: envOverrides = {} } = {}) {
  const child = spawn(process.execPath, [binPath, ...args], {
    env: fakeEnv({ NIGHT_SHIFT_HOME: home, TZ: 'Asia/Shanghai', ...envOverrides }),
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const close = new Promise((resolve) => {
    child.on('close', (code, signal) => resolve({ code, signal }));
  });
  return { child, close, stdout: () => stdout, stderr: () => stderr };
}

/** 跑一个预期会退出的 CLI 命令，等它结束并带上全部输出。 */
async function runCli(args, options) {
  const proc = spawnCliProc(args, options);
  const { code, signal } = await proc.close;
  return { code, signal, stdout: proc.stdout(), stderr: proc.stderr() };
}

/** 轮询等待 fn() 为真，到点仍未真则断言失败。 */
async function waitUntil(fn, { timeoutMs = 5000, message = '条件在超时内未满足' } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await fn()) return;
    if (Date.now() >= deadline) assert.fail(message);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** Promise 限时：超时断言失败（给「X 秒内退出」类验收用）。 */
async function withTimeout(promise, timeoutMs, message) {
  let timer;
  await Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
  return promise;
}

/** 从测试进程读某个任务（WAL 支持与 CLI 子进程同时读写同一文件库）。 */
function readTask(home, id) {
  const db = openDb(path.join(home, 'night-shift.db'));
  try {
    return getTask(db, id);
  } finally {
    db.close();
  }
}

/** 造一条历史运行（额度测试用）：写库后改 started_at（同 scheduler-integration 的 seedRun）。 */
function seedRun(home, taskId, { startedAt, model = 'glm-5.3' }) {
  const db = openDb(path.join(home, 'night-shift.db'));
  try {
    const run = startRun(db, {
      taskId, attempt: 1, model, effort: 'medium', peak: false, logPath: '/tmp/x.log',
    });
    finishRun(db, run.id, { status: 'succeeded' });
    db.prepare('UPDATE runs SET started_at = ? WHERE id = ?')
      .run(new Date(startedAt).toISOString(), run.id);
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------- peak

test('验收: peak 高峰（周四北京 15:00）：现在/下次切换/倍率三行；--json 同数据', async (t) => {
  const home = makeTempHome(t);
  const res = await runCli(['peak'], { home, env: { NIGHT_SHIFT_NOW: '2026-10-08T07:00:00Z' } });
  assert.equal(res.code, 0, res.stderr);
  assert.ok(res.stdout.includes('现在：高峰（北京时间 周四 15:00）'), res.stdout);
  assert.ok(res.stdout.includes('下次切换：2026-10-08 18:00 变为非高峰（还有 3 小时 0 分）'), res.stdout);
  assert.ok(res.stdout.includes('当前倍率：glm-5.3 ×3，glm-5.3-flash ×1.2'), res.stdout);

  const j = await runCli(['peak', '--json'], { home, env: { NIGHT_SHIFT_NOW: '2026-10-08T07:00:00Z' } });
  assert.equal(j.code, 0, j.stderr);
  const parsed = JSON.parse(j.stdout);
  assert.equal(parsed.peak, true);
  assert.equal(parsed.now, '2026-10-08T07:00:00.000Z');
  assert.equal(parsed.nextChange, '2026-10-08T10:00:00.000Z');
  assert.equal(parsed.multipliers['glm-5.3'], 3);
  assert.equal(parsed.multipliers['glm-5.3-flash'], 1.2);
});

test('验收: peak 周六非高峰：下次切换 2026-10-12 14:00 变为高峰，倍率 ×1 / ×0.4', async (t) => {
  const home = makeTempHome(t);
  const res = await runCli(['peak'], { home, env: { NIGHT_SHIFT_NOW: '2026-10-10T07:00:00Z' } });
  assert.equal(res.code, 0, res.stderr);
  assert.ok(res.stdout.includes('现在：非高峰（北京时间 周六 15:00）'), res.stdout);
  assert.ok(res.stdout.includes('下次切换：2026-10-12 14:00 变为高峰'), res.stdout);
  assert.ok(res.stdout.includes('当前倍率：glm-5.3 ×1，glm-5.3-flash ×0.4'), res.stdout);

  const j = await runCli(['peak', '--json'], { home, env: { NIGHT_SHIFT_NOW: '2026-10-10T07:00:00Z' } });
  const parsed = JSON.parse(j.stdout);
  assert.equal(parsed.peak, false);
  assert.equal(parsed.nextChange, '2026-10-12T06:00:00.000Z');
  assert.equal(parsed.multipliers['glm-5.3'], 1);
});

// ---------------------------------------------------------------- usage

test('验收: usage 插入 #4 验收那组运行：--json 的 5.2 / 8.2，文本含 5.2 / 1600 与恢复时刻', async (t) => {
  const home = makeTempHome(t);
  const db = openDb(path.join(home, 'night-shift.db'));
  const task = createTask(db, { repo: 'a/b', prompt: '额度统计' });
  db.close();
  const NOW = '2026-10-08T12:00:00Z'; // 周四北京 20:00，非高峰
  // 与 test/quota.test.js 的 #4 验收组一致：5 小时窗口内 3 + 1.2 + 1 = 5.2，周窗口 8.2
  seedRun(home, task.id, { startedAt: '2026-10-08T07:30:00Z' }); // 北京 15:30 高峰 → 3
  seedRun(home, task.id, { startedAt: '2026-10-08T08:00:00Z', model: 'glm-5.3-flash' }); // 高峰 → 1.2
  seedRun(home, task.id, { startedAt: '2026-10-08T11:00:00Z' }); // 北京 19:00 非高峰 → 1
  seedRun(home, task.id, { startedAt: '2026-10-08T06:30:00Z' }); // 高峰 → 3，但在 5 小时窗口外

  const j = await runCli(['usage', '--json'], { home, env: { NIGHT_SHIFT_NOW: NOW } });
  assert.equal(j.code, 0, j.stderr);
  const parsed = JSON.parse(j.stdout);
  assert.equal(parsed.plan, 'v2-max');
  assert.equal(parsed.fiveHour.used, 5.2);
  assert.equal(parsed.fiveHour.limit, 1600);
  assert.equal(parsed.fiveHour.resetsAt, '2026-10-08T12:30:00.000Z');
  assert.equal(parsed.weekly.used, 8.2);
  assert.equal(parsed.weekly.limit, 8000);
  assert.equal(parsed.weekly.resetsAt, null);

  const text = await runCli(['usage'], { home, env: { NIGHT_SHIFT_NOW: NOW } });
  assert.equal(text.code, 0, text.stderr);
  assert.ok(text.stdout.includes('套餐：v2-max'), text.stdout);
  assert.ok(text.stdout.includes('5 小时：已用 5.2 / 1600（0.3%）'), text.stdout);
  assert.ok(text.stdout.includes('2026-10-08 20:30 恢复'), text.stdout);
  assert.ok(text.stdout.includes('本周：已用 8.2 / 8000（0.1%），滚动 7 天统计'), text.stdout);
});

test('usage 配了 weekStart：本周一行改为「<本地时间> 重置」，不再说滚动 7 天', async (t) => {
  const home = makeTempHome(t);
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ weekStart: '2026-10-05T08:00:00Z' }));
  const db = openDb(path.join(home, 'night-shift.db'));
  const task = createTask(db, { repo: 'a/b', prompt: '额度统计' });
  db.close();
  seedRun(home, task.id, { startedAt: '2026-10-08T07:30:00Z' });

  const res = await runCli(['usage'], { home, env: { NIGHT_SHIFT_NOW: '2026-10-08T12:00:00Z' } });
  assert.equal(res.code, 0, res.stderr);
  // 周期 [10-05 16:00 本地, +7d)，重置时刻 2026-10-12T08:00Z = 本地 16:00
  assert.ok(res.stdout.includes('，2026-10-12 16:00 重置'), res.stdout);
  assert.equal(res.stdout.includes('滚动 7 天统计'), false, res.stdout);

  const j = await runCli(['usage', '--json'], { home, env: { NIGHT_SHIFT_NOW: '2026-10-08T12:00:00Z' } });
  assert.equal(JSON.parse(j.stdout).weekly.resetsAt, '2026-10-12T08:00:00.000Z');
});

test('usage 空库：已用 0 / 1600、0 / 8000，退出 0', async (t) => {
  const home = makeTempHome(t);
  const res = await runCli(['usage'], { home, env: { NIGHT_SHIFT_NOW: '2026-10-10T07:00:00Z' } });
  assert.equal(res.code, 0, res.stderr);
  assert.ok(res.stdout.includes('已用 0 / 1600'), res.stdout);
  assert.ok(res.stdout.includes('已用 0 / 8000'), res.stdout);
});

// ---------------------------------------------------------------- usage 阈值提示（#82）

/** 建一个排队任务并返回其 id（阈值测试都要先有任务行才能挂运行）。 */
function makeTask(home) {
  const db = openDb(path.join(home, 'night-shift.db'));
  try {
    return createTask(db, { repo: 'a/b', prompt: '额度阈值' }).id;
  } finally {
    db.close();
  }
}

/**
 * 造一条带 quotaUnits 的历史运行（仿 seedRun）：quotaUnits 有值就按它计、不再乘倍率，
 * 所以落笔时刻的高峰状态不影响扣减量；started_at 事后改写以摆进/摆出五小时窗口。
 */
function seedUnits(home, taskId, { startedAt, quotaUnits }) {
  const db = openDb(path.join(home, 'night-shift.db'));
  try {
    const run = startRun(db, {
      taskId, attempt: 1, model: 'glm-5.3', effort: 'medium', peak: false, logPath: '/tmp/x.log',
    });
    finishRun(db, run.id, { status: 'succeeded', quotaUnits });
    db.prepare('UPDATE runs SET started_at = ? WHERE id = ?')
      .run(new Date(startedAt).toISOString(), run.id);
  } finally {
    db.close();
  }
}

test('验收: usage 第二行固定是本地估算说明；空库默认阈值不出现阈值行；--json 只有 plan/fiveHour/weekly', async (t) => {
  const home = makeTempHome(t);
  const res = await runCli(['usage'], { home, env: { NIGHT_SHIFT_NOW: OFF_PEAK_NOW } });
  assert.equal(res.code, 0, res.stderr);
  const lines = res.stdout.split('\n');
  const planIdx = lines.indexOf('套餐：v2-max');
  assert.notEqual(planIdx, -1, res.stdout);
  assert.equal(
    lines[planIdx + 1],
    '额度是本地估算，不是官方账单。一次运行算 1 次 prompt，再乘模型倍率。',
    res.stdout,
  );
  assert.equal(res.stdout.includes('5 小时额度已达安全阈值'), false, res.stdout);
  assert.equal(res.stdout.includes('每周额度已达安全阈值'), false, res.stdout);
  assert.equal(res.stdout.includes('暂不领'), false, res.stdout);
  assert.ok(res.stdout.includes('已用 0 / 1600'), res.stdout);
  assert.ok(res.stdout.includes('已用 0 / 8000'), res.stdout);

  const j = await runCli(['usage', '--json'], { home, env: { NIGHT_SHIFT_NOW: OFF_PEAK_NOW } });
  assert.equal(j.code, 0, j.stderr);
  const parsed = JSON.parse(j.stdout);
  assert.deepEqual(Object.keys(parsed).sort(), ['fiveHour', 'plan', 'weekly']);
  assert.deepEqual(Object.keys(parsed.fiveHour).sort(), ['limit', 'ratio', 'resetsAt', 'used']);
  assert.deepEqual(Object.keys(parsed.weekly).sort(), ['limit', 'ratio', 'resetsAt', 'used']);
  assert.equal(j.stdout.includes('额度是本地估算'), false, j.stdout);
  assert.equal(j.stdout.includes('安全阈值'), false, j.stdout);
});

test('验收: usage 只五小时超阈值：五小时窗口内 1440，1440+1 > 1600×0.9，只出五小时那行', async (t) => {
  const home = makeTempHome(t);
  const taskId = makeTask(home);
  seedUnits(home, taskId, { startedAt: '2026-10-10T06:00:00Z', quotaUnits: 1440 });
  const res = await runCli(['usage'], { home, env: { NIGHT_SHIFT_NOW: OFF_PEAK_NOW } });
  assert.equal(res.code, 0, res.stderr);
  assert.ok(res.stdout.includes('5 小时额度已达安全阈值'), res.stdout);
  assert.equal(res.stdout.includes('每周额度已达安全阈值'), false, res.stdout);
});

test('验收: usage 只每周超阈值：窗口外、7 天内一条 7200，五小时 used 0，只出每周那行', async (t) => {
  const home = makeTempHome(t);
  const taskId = makeTask(home);
  seedUnits(home, taskId, { startedAt: '2026-10-09T07:00:00Z', quotaUnits: 7200 });
  const res = await runCli(['usage'], { home, env: { NIGHT_SHIFT_NOW: OFF_PEAK_NOW } });
  assert.equal(res.code, 0, res.stderr);
  assert.ok(res.stdout.includes('每周额度已达安全阈值'), res.stdout);
  assert.equal(res.stdout.includes('5 小时额度已达安全阈值'), false, res.stdout);
});

test('验收: usage 两窗口都超阈值：两行都在，五小时那行在每周那行前面', async (t) => {
  const home = makeTempHome(t);
  const taskId = makeTask(home);
  seedUnits(home, taskId, { startedAt: '2026-10-10T06:00:00Z', quotaUnits: 1440 });
  seedUnits(home, taskId, { startedAt: '2026-10-09T07:00:00Z', quotaUnits: 5760 });
  const res = await runCli(['usage'], { home, env: { NIGHT_SHIFT_NOW: OFF_PEAK_NOW } });
  assert.equal(res.code, 0, res.stderr);
  const fiveIdx = res.stdout.indexOf('5 小时额度已达安全阈值');
  const weeklyIdx = res.stdout.indexOf('每周额度已达安全阈值');
  assert.notEqual(fiveIdx, -1, res.stdout);
  assert.notEqual(weeklyIdx, -1, res.stdout);
  assert.ok(fiveIdx < weeklyIdx, res.stdout);
});

test('验收: usage 恰好等于阈值仍放得下：非高峰 nextCost 1，used 1439，1439+1 === 1440', async (t) => {
  const home = makeTempHome(t);
  const taskId = makeTask(home);
  seedUnits(home, taskId, { startedAt: '2026-10-10T06:00:00Z', quotaUnits: 1439 });
  const res = await runCli(['usage'], { home, env: { NIGHT_SHIFT_NOW: OFF_PEAK_NOW } });
  assert.equal(res.code, 0, res.stderr);
  assert.equal(res.stdout.includes('5 小时额度已达安全阈值'), false, res.stdout);
  assert.equal(res.stdout.includes('每周额度已达安全阈值'), false, res.stdout);
});

test('验收: usage 阈值用 config 的 safetyRatio（0.5），不是写死 0.9', async (t) => {
  const home = makeTempHome(t);
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ plan: 'v2-max', safetyRatio: 0.5 }));
  const taskId = makeTask(home);
  seedUnits(home, taskId, { startedAt: '2026-10-10T06:00:00Z', quotaUnits: 800 }); // 801 > 800
  const res = await runCli(['usage'], { home, env: { NIGHT_SHIFT_NOW: OFF_PEAK_NOW } });
  assert.equal(res.code, 0, res.stderr);
  // 若错用 0.9：801 <= 1440，这行就不该出现——这条断言专抓写死 0.9
  assert.ok(res.stdout.includes('5 小时额度已达安全阈值'), res.stdout);
  assert.equal(res.stdout.includes('每周额度已达安全阈值'), false, res.stdout);
});

test('验收: usage 下一笔倍率取当前时刻（高峰 3 / 非高峰 1），不是写死 1', async (t) => {
  // 高峰（周四北京 15:00）：1438 + 3 > 1440 → 有五小时阈值行
  const peakHome = makeTempHome(t);
  const peakTaskId = makeTask(peakHome);
  seedUnits(peakHome, peakTaskId, { startedAt: '2026-10-08T06:00:00Z', quotaUnits: 1438 });
  const peak = await runCli(['usage'], { home: peakHome, env: { NIGHT_SHIFT_NOW: '2026-10-08T07:00:00Z' } });
  assert.equal(peak.code, 0, peak.stderr);
  assert.ok(peak.stdout.includes('5 小时额度已达安全阈值'), peak.stdout);
  assert.equal(peak.stdout.includes('每周额度已达安全阈值'), false, peak.stdout);

  // 同样用量换非高峰（周六）：1438 + 1 <= 1440 → 没有阈值行
  const offHome = makeTempHome(t);
  const offTaskId = makeTask(offHome);
  seedUnits(offHome, offTaskId, { startedAt: '2026-10-10T06:00:00Z', quotaUnits: 1438 });
  const off = await runCli(['usage'], { home: offHome, env: { NIGHT_SHIFT_NOW: OFF_PEAK_NOW } });
  assert.equal(off.code, 0, off.stderr);
  assert.equal(off.stdout.includes('5 小时额度已达安全阈值'), false, off.stdout);
  assert.equal(off.stdout.includes('每周额度已达安全阈值'), false, off.stdout);
});

// ---------------------------------------------------------------- start

test('验收: start 跑完任务：show 变 succeeded 带 prUrl，stdout 有启动行/领取/成功行；SIGINT 3 秒内退出 0', async (t) => {
  const { home } = setup(t);
  const add = await runCli([
    'add', '--repo', 'a/b', '--prompt', '做点修改', '--test', 'test -f NIGHT_SHIFT_FAKE.md',
  ], { home });
  assert.equal(add.code, 0, add.stderr);

  const proc = spawnCliProc(['start'], { home, env: { NIGHT_SHIFT_NOW: OFF_PEAK_NOW } });
  t.after(() => { proc.child.kill('SIGKILL'); }); // 断言中途失败也别留下进程
  // 等成功行本身（done 事件在 worktree 清理之后才发，比库里的 succeeded 晚一拍，
  // 直接等库状态再断言 stdout 会有竞态）
  await waitUntil(() => proc.stdout().includes('#1 成功：'),
    { timeoutMs: 10_000, message: '任务应在 10 秒内跑成并打印成功行' });
  assert.equal(readTask(home, 1).status, 'succeeded');

  const shown = await runCli(['show', '1', '--json'], { home, env: { NIGHT_SHIFT_NOW: OFF_PEAK_NOW } });
  assert.equal(shown.code, 0, shown.stderr);
  const task = JSON.parse(shown.stdout);
  assert.equal(task.status, 'succeeded');
  assert.ok(task.prUrl.startsWith('https://github.com/a/b/pull/'), task.prUrl);
  assert.ok(task.branch.startsWith('night-shift/1-'), task.branch);

  assert.ok(proc.stdout().includes('GLM 夜班已启动：并发 1，每 0.2 秒检查一次'), proc.stdout());
  assert.ok(proc.stdout().includes(`[15:00] 领取 #1 做点修改`), proc.stdout());
  assert.ok(proc.stdout().includes('#1 成功：https://github.com/a/b/pull/'), proc.stdout());
  assert.equal(proc.stderr(), '', proc.stderr());

  proc.child.kill('SIGINT'); // 没有运行中的任务：第一次 Ctrl-C 直接退出
  const closed = await withTimeout(proc.close, 3000, 'SIGINT 后 3 秒内应退出');
  assert.equal(closed.code, 0);
  assert.equal(closed.signal, null);
});

test('验收: hang 时第一次 SIGINT 优雅等待（不退出），第二次强制停止退出 0、任务回 queued', async (t) => {
  const { home } = setup(t);
  const argsLog = path.join(home, 'claude-args.jsonl');
  const add = await runCli(['add', '--repo', 'a/b', '--prompt', '挂起任务'], { home });
  assert.equal(add.code, 0, add.stderr);

  const proc = spawnCliProc(['start'], {
    home,
    env: { NIGHT_SHIFT_NOW: OFF_PEAK_NOW, FAKE_CLAUDE_SCENARIO: 'hang', FAKE_CLAUDE_ARGS_LOG: argsLog },
  });
  t.after(() => { proc.child.kill('SIGKILL'); });
  // 等假 claude 真正启动（就绪约定：init 行之前装好信号处理器），再发信号
  await waitUntil(() => fs.existsSync(argsLog),
    { timeoutMs: 10_000, message: '假 claude 应已启动' });

  proc.child.kill('SIGINT');
  await waitUntil(() => proc.stdout().includes('再来一次 Ctrl-C 或 SIGTERM 强制停止'),
    { timeoutMs: 2000, message: '第一次 SIGINT 应打印优雅停止提示' });
  assert.ok(proc.stdout().includes('正在停止：不再领取新任务，等待 1 个运行中的任务结束'), proc.stdout());
  await new Promise((resolve) => setTimeout(resolve, 700));
  assert.equal(proc.child.exitCode, null, '优雅停止期间进程不应退出');
  assert.equal(readTask(home, 1).status, 'running');

  proc.child.kill('SIGINT');
  await waitUntil(() => proc.stdout().includes('强制停止'),
    { timeoutMs: 2000, message: '第二次 SIGINT 应打印强制停止' });
  const closed = await withTimeout(proc.close, 3000, '第二次 SIGINT 后 3 秒内应退出');
  assert.equal(closed.code, 0);
  assert.equal(closed.signal, null);
  const task = readTask(home, 1);
  assert.equal(task.status, 'queued');
  assert.equal(task.attempts, 0, '停机中断退还这次尝试');
});

test('start 空队列：第一次 SIGINT 直接退出 0', async (t) => {
  const { home } = setup(t);
  const proc = spawnCliProc(['start'], { home, env: { NIGHT_SHIFT_NOW: OFF_PEAK_NOW } });
  t.after(() => { proc.child.kill('SIGKILL'); });
  await waitUntil(() => proc.stdout().includes('GLM 夜班已启动'),
    { timeoutMs: 5000, message: '应打印启动行' });
  proc.child.kill('SIGINT');
  const closed = await withTimeout(proc.close, 3000, '空队列 SIGINT 后 3 秒内应退出');
  assert.equal(closed.code, 0);
  assert.equal(closed.signal, null);
});

test('start 空队列：SIGTERM 与第一次 Ctrl-C 同样直接退出 0', async (t) => {
  const { home } = setup(t);
  const proc = spawnCliProc(['start'], { home, env: { NIGHT_SHIFT_NOW: OFF_PEAK_NOW } });
  t.after(() => { proc.child.kill('SIGKILL'); });
  await waitUntil(() => proc.stdout().includes('GLM 夜班已启动'),
    { timeoutMs: 5000, message: '应打印启动行' });
  proc.child.kill('SIGTERM');
  const closed = await withTimeout(proc.close, 3000, 'SIGTERM 后 3 秒内应退出');
  assert.equal(closed.code, 0);
  assert.equal(closed.signal, null);
});

test('start 失败重试：先打印「放回队列」再「失败」，任务最终 failed（maxAttempts 2）', async (t) => {
  const { home } = setup(t);
  // 假 claude 成功写入文件，但测试命令恒失败：两轮都按普通失败走重试
  const add = await runCli(['add', '--repo', 'a/b', '--prompt', '跑测试', '--test', 'exit 1'], { home });
  assert.equal(add.code, 0, add.stderr);

  const proc = spawnCliProc(['start'], { home, env: { NIGHT_SHIFT_NOW: OFF_PEAK_NOW } });
  t.after(() => { proc.child.kill('SIGKILL'); });
  // 等「失败」行本身（done 事件比库里的 failed 晚一拍，见上一个测试的说明）
  await waitUntil(() => proc.stdout().includes('#1 失败：测试失败：'),
    { timeoutMs: 10_000, message: '两次尝试用尽后应打印失败行' });

  assert.ok(proc.stdout().includes('放回队列：测试失败：'), proc.stdout());
  assert.ok(proc.stdout().includes('#1 失败：测试失败：'), proc.stdout());
  assert.equal(readTask(home, 1).attempts, 2);
  // 两次失败各占一行「放回队列 / 失败」，领取也有两行
  assert.equal(proc.stdout().match(/领取 #1 /g).length, 2, proc.stdout());

  proc.child.kill('SIGINT');
  const closed = await withTimeout(proc.close, 3000, 'SIGINT 后 3 秒内应退出');
  assert.equal(closed.code, 0);
});

test('start 高峰时段：打印「暂停领取：高峰期」，普通任务保持 queued', async (t) => {
  const { home } = setup(t);
  const add = await runCli(['add', '--repo', 'a/b', '--prompt', '高峰任务'], { home });
  assert.equal(add.code, 0, add.stderr);

  const proc = spawnCliProc(['start'], { home, env: { NIGHT_SHIFT_NOW: '2026-10-08T07:00:00Z' } });
  t.after(() => { proc.child.kill('SIGKILL'); });
  await waitUntil(() => proc.stdout().includes('暂停领取'),
    { timeoutMs: 5000, message: '高峰时段应打印暂停领取' });
  assert.ok(proc.stdout().includes('[15:00] 暂停领取：高峰期，2026-10-08 18:00 后恢复'), proc.stdout());
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(readTask(home, 1).status, 'queued');

  proc.child.kill('SIGINT');
  const closed = await withTimeout(proc.close, 3000, 'SIGINT 后 3 秒内应退出');
  assert.equal(closed.code, 0);
});

// ---------------------------------------------------------------- run-now

test('验收: run-now 高峰时段照跑：成功输出 #1 成功并退出 0；已成功的任务再跑退出 1', async (t) => {
  const { home } = setup(t);
  const add = await runCli([
    'add', '--repo', 'a/b', '--prompt', '做点修改', '--test', 'test -f NIGHT_SHIFT_FAKE.md',
  ], { home });
  assert.equal(add.code, 0, add.stderr);

  const res = await runCli(['run-now', '1'], { home, env: { NIGHT_SHIFT_NOW: '2026-10-08T07:00:00Z' } });
  assert.equal(res.code, 0, res.stderr);
  assert.ok(res.stdout.includes('#1 成功：https://github.com/a/b/pull/'), res.stdout);
  assert.ok(res.stdout.includes('[meta] 开始'), '应实时打印日志行');
  assert.ok(res.stdout.includes('[stdout]'), res.stdout);
  assert.ok(res.stdout.includes('[meta] 结束'), res.stdout);
  assert.equal(readTask(home, 1).status, 'succeeded');

  const again = await runCli(['run-now', '1'], { home, env: { NIGHT_SHIFT_NOW: '2026-10-08T07:00:00Z' } });
  assert.equal(again.code, 1);
  assert.ok(again.stderr.includes('succeeded'), again.stderr);
  assert.ok(again.stderr.includes('不是 queued'), again.stderr);
});

test('验收: run-now noop 场景：退出 1，输出含 没有改动', async (t) => {
  const { home } = setup(t);
  const add = await runCli(['add', '--repo', 'a/b', '--prompt', '什么都不做'], { home });
  assert.equal(add.code, 0, add.stderr);
  const res = await runCli(['run-now', '1'], {
    home,
    env: { NIGHT_SHIFT_NOW: OFF_PEAK_NOW, FAKE_CLAUDE_SCENARIO: 'noop' },
  });
  assert.equal(res.code, 1, res.stderr);
  assert.ok(res.stdout.includes('#1 失败：没有改动'), res.stdout);
  assert.equal(readTask(home, 1).status, 'failed');
});

test('run-now 任务不存在：退出 1，stderr 说明', async (t) => {
  const { home } = setup(t);
  const res = await runCli(['run-now', '99'], { home, env: { NIGHT_SHIFT_NOW: OFF_PEAK_NOW } });
  assert.equal(res.code, 1);
  assert.ok(res.stderr.includes('任务 99 不存在'), res.stderr);
});

test('验收·#38：pause 之后 run-now 子进程仍把任务跑完（手动暂停不拦点名执行）', async (t) => {
  const { home } = setup(t);
  const add = await runCli([
    'add', '--repo', 'a/b', '--prompt', '做点修改', '--test', 'test -f NIGHT_SHIFT_FAKE.md',
  ], { home });
  assert.equal(add.code, 0, add.stderr);

  const pause = await runCli(['pause'], { home });
  assert.equal(pause.code, 0, pause.stderr);
  assert.equal(pause.stdout, '已暂停：不再领取新任务（正在跑的会跑完）\n');

  const res = await runCli(['run-now', '1'], { home, env: { NIGHT_SHIFT_NOW: OFF_PEAK_NOW } });
  assert.equal(res.code, 0, res.stderr);
  assert.ok(res.stdout.includes('#1 成功：https://github.com/a/b/pull/'), res.stdout);
  assert.equal(readTask(home, 1).status, 'succeeded');

  // run-now 不动暂停标记：库里仍是暂停状态
  const db = openDb(path.join(home, 'night-shift.db'));
  try {
    assert.equal(getUserPaused(db), true);
  } finally {
    db.close();
  }
});

// ---------------------------------------------------------------- logs

test('验收: logs 打印最新一次运行日志（[meta] 开始 / [stdout] 行）；--run 超范围与任务不存在退出 1', async (t) => {
  const { home } = setup(t);
  const add = await runCli([
    'add', '--repo', 'a/b', '--prompt', '做点修改', '--test', 'test -f NIGHT_SHIFT_FAKE.md',
  ], { home });
  assert.equal(add.code, 0, add.stderr);
  const run = await runCli(['run-now', '1'], { home, env: { NIGHT_SHIFT_NOW: OFF_PEAK_NOW } });
  assert.equal(run.code, 0, run.stderr);

  const res = await runCli(['logs', '1'], { home });
  assert.equal(res.code, 0, res.stderr);
  assert.ok(res.stdout.includes('[meta] 开始'), res.stdout);
  assert.ok(res.stdout.includes('[stdout]'), res.stdout);
  assert.ok(res.stdout.includes('[meta] 结束'), res.stdout);

  const run1 = await runCli(['logs', '1', '--run', '1'], { home });
  assert.equal(run1.code, 0, run1.stderr);
  assert.ok(run1.stdout.includes('[meta] 开始'), run1.stdout);

  const over = await runCli(['logs', '1', '--run', '2'], { home });
  assert.equal(over.code, 1);
  assert.ok(over.stderr.includes('只有 1 次运行'), over.stderr);

  const missing = await runCli(['logs', '99'], { home });
  assert.equal(missing.code, 1);
  assert.ok(missing.stderr.includes('任务 99 不存在'), missing.stderr);
});

test('logs 任务还没有运行记录：退出 1，stderr 说明', async (t) => {
  const { home } = setup(t);
  const add = await runCli(['add', '--repo', 'a/b', '--prompt', '还没跑'], { home });
  assert.equal(add.code, 0, add.stderr);
  const res = await runCli(['logs', '1'], { home });
  assert.equal(res.code, 1);
  assert.ok(res.stderr.includes('还没有运行记录'), res.stderr);
});

test('验收: logs --follow 跟踪 slow 运行，运行结束后 2 秒内退出 0，输出含 [meta] 结束', async (t) => {
  const { home } = setup(t);
  const add = await runCli(['add', '--repo', 'a/b', '--prompt', '慢任务'], { home });
  assert.equal(add.code, 0, add.stderr);

  const runProc = spawnCliProc(['run-now', '1'], {
    home,
    env: { NIGHT_SHIFT_NOW: OFF_PEAK_NOW, FAKE_CLAUDE_SCENARIO: 'slow', FAKE_CLAUDE_DELAY_MS: '1500' },
  });
  t.after(() => { runProc.child.kill('SIGKILL'); });
  // 等 run 行落库（run-now 起 + worktree 建好后 startRun），logs 才有得看
  await waitUntil(() => {
    const db = openDb(path.join(home, 'night-shift.db'));
    try {
      return listRuns(db, { taskId: 1 }).length >= 1;
    } finally {
      db.close();
    }
  }, { timeoutMs: 10_000, message: 'run-now 应已建出 run 行' });

  const follow = spawnCliProc(['logs', '1', '--follow'], { home });
  t.after(() => { follow.child.kill('SIGKILL'); });
  await runProc.close; // run-now 进程退出 = 运行已结束
  const closed = await withTimeout(follow.close, 2000, '运行结束后 2 秒内 --follow 应自动退出');
  assert.equal(closed.code, 0, follow.stderr());
  assert.ok(follow.stdout().includes('[meta] 开始'), follow.stdout());
  assert.ok(follow.stdout().includes('[meta] 结束'), follow.stdout());
});

test('logs --follow 对已结束的运行：打印完内容立即退出 0', async (t) => {
  const { home } = setup(t);
  const add = await runCli([
    'add', '--repo', 'a/b', '--prompt', '做点修改', '--test', 'test -f NIGHT_SHIFT_FAKE.md',
  ], { home });
  assert.equal(add.code, 0, add.stderr);
  await runCli(['run-now', '1'], { home, env: { NIGHT_SHIFT_NOW: OFF_PEAK_NOW } });

  const res = await runCli(['logs', '1', '--follow'], { home });
  assert.equal(res.code, 0, res.stderr);
  assert.ok(res.stdout.includes('[meta] 结束'), res.stdout);
});

// ---------------------------------------------------------------- 用法错误与 help

test('验收: help 列出 start / peak / usage / logs / run-now（含各自用法行）', async (t) => {
  const home = makeTempHome(t);
  const res = await runCli(['help'], { home });
  assert.equal(res.code, 0, res.stderr);
  for (const name of ['start', 'peak', 'usage', 'logs', 'run-now']) {
    assert.ok(res.stdout.includes(`  ${name.padEnd(10)}`), `命令清单应含 ${name}：\n${res.stdout}`);
    assert.ok(res.stdout.includes(`night-shift ${name}`), `命令详解应含 ${name} 的用法行`);
  }
  assert.equal(res.stdout.includes('start / peak / logs'), false, '帮助尾注不应再说这些命令未实现');
});

test('start / peak / usage / logs / run-now 的 <命令> --help：退出 0，打印各自用法', async (t) => {
  const home = makeTempHome(t);
  for (const name of ['start', 'peak', 'usage', 'logs', 'run-now']) {
    const res = await runCli([name, '--help'], { home });
    assert.equal(res.code, 0, `${name}：${res.stderr}`);
    assert.ok(res.stdout.startsWith('用法：night-shift '), `${name}：${res.stdout}`);
  }
  // 关键选项出现在各自用法里
  const logs = await runCli(['logs', '--help'], { home });
  assert.ok(logs.stdout.includes('--run') && logs.stdout.includes('--follow'), logs.stdout);
  const peak = await runCli(['peak', '--help'], { home });
  assert.ok(peak.stdout.includes('--json'), peak.stdout);
});

test('用法错误：logs 缺 <id> / --run 非法、peak 带未知选项 → 退出 2 并附该命令用法', async (t) => {
  const home = makeTempHome(t);
  const noId = await runCli(['logs'], { home });
  assert.equal(noId.code, 2);
  assert.ok(noId.stderr.includes('缺少必填参数'), noId.stderr);

  const badRun = await runCli(['logs', '1', '--run', 'x'], { home });
  assert.equal(badRun.code, 2);
  assert.ok(badRun.stderr.includes('--run'), badRun.stderr);

  const unknown = await runCli(['peak', '--nope'], { home });
  assert.equal(unknown.code, 2);
  assert.ok(unknown.stderr.includes('用法：night-shift peak'), unknown.stderr);

  const badStart = await runCli(['start', 'extra'], { home });
  assert.equal(badStart.code, 2, 'start 不收位置参数');
});

// ---------------------------------------------------------------- 停止文案（#97）

test('验收: start 的停止文案：用法改为「再来一次强制停止」，不再写「再按一次 Ctrl-C 强制停止」', () => {
  const src = fs.readFileSync(fileURLToPath(new URL('../src/cli/run-commands.js', import.meta.url)), 'utf8');
  assert.ok(src.includes('（Ctrl-C / SIGTERM 一次优雅停止；再来一次强制停止）'),
    'start 用法第二行应是「再来一次强制停止」');
  assert.equal(src.includes('再按一次 Ctrl-C 强制停止'), false,
    'start 源码不应再出现「再按一次 Ctrl-C 强制停止」');
  assert.ok(src.includes('（再来一次 Ctrl-C 或 SIGTERM 强制停止）'),
    '第一次停止的运行时括号应是「再来一次 Ctrl-C 或 SIGTERM 强制停止」');
});

test('验收: docs/inconsistencies.md 第 5 条标记已解决：原文保留，第 1–4 条标题不动', () => {
  const doc = fs.readFileSync(fileURLToPath(new URL('../docs/inconsistencies.md', import.meta.url)), 'utf8');
  // 第 5 条：标题加「（已解决）」，原段落（含「帮助字符串本身没改。」）一字未删
  assert.ok(doc.includes('5. **（已解决）帮助文案只写了「再按一次 Ctrl-C」。**'), doc);
  assert.ok(doc.includes('帮助字符串本身没改。'), '第 5 条原文应保留');
  // 第 1–4 条标题与 main 一致：第 1 条本就已解决，第 2–4 条不得新加「（已解决）」
  for (const title of [
    '1. **（已解决）`npm run e2e` 现在有了。**',
    '2. **docs/images/task.png 截图来自看板的旧版本。**',
    '3. **「高峰与额度」没有可链接的官方文档。**',
    '4. **额度数字是本地估算，不是官方账单（备案）。**',
  ]) {
    assert.ok(doc.includes(title), `标题应保持原样：${title}`);
  }
});
