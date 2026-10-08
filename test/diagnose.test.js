// src/diagnose.js 的单元测试（issue #12 验收项）：诊断 prompt 的组装、失败日志末尾的
// 读取、直接调 diagnose()（执行核心复用 #7 的 invokeClaude + 假 claude）以及存储层的
// setRunDiagnosis / startRun kind / listRuns kind 过滤。绝不联网、不调用真实 claude；
// 直接诊断不经过调度器，所以这里不需要 bare 仓库 / 假 gh（那部分见 diagnose-integration）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { openDb } from '../src/db.js';
import {
  createTask, claimNextTask, startRun, finishRun, getRun, listRuns, setRunDiagnosis,
  ValidationError, NotFoundError,
} from '../src/tasks.js';
import { DEFAULT_CONFIG } from '../src/config.js';
import { runEvents } from '../src/runner.js';
import {
  buildDiagnosePrompt, diagnose, readLogTail, TASK_PROMPT_MAX_CHARS,
} from '../src/diagnose.js';
import { fakeEnv, makeTempHome, fixturePath } from './helpers.js';

const FAKE_CLAUDE = fixturePath('fake-claude.mjs');
// 周六 15:00（北京），非高峰：flash 倍率 0.4，断言可以写死
const OFF_PEAK_CLOCK = () => new Date('2026-10-10T07:00:00Z');

/** 临时目录 + 文件库（测试结束 close）。 */
function openTempDb(t) {
  const db = openDb(path.join(makeTempHome(t), 'night-shift.db'));
  t.after(() => db.close());
  return db;
}

/** 造一个已领取的任务（attempts = 1）。 */
function makeClaimedTask(db, overrides = {}) {
  const created = createTask(db, { repo: 'owner/name', prompt: '把登录页修好', ...overrides });
  const task = claimNextTask(db);
  assert.equal(task.id, created.id);
  return task;
}

/** 造一条已结束的失败运行（logPath 指向调用方写好的日志文件）。 */
function makeFailedRun(db, task, { logPath, error = 'fake failure' } = {}) {
  const run = startRun(db, {
    taskId: task.id, attempt: task.attempts, model: 'glm-5.3',
    effort: 'medium', peak: false, logPath,
  });
  finishRun(db, run.id, { status: 'failed', error, quotaUnits: 1 });
  return getRun(db, run.id);
}

function readArgsLog(file) {
  return fs.readFileSync(file, 'utf8').trim().split('\n')
    .filter((line) => line !== '').map((line) => JSON.parse(line));
}

// ---------------------------------------------------------------- buildDiagnosePrompt

test('验收：诊断 prompt = 固定说明 + 任务 prompt（前 1000 字）+ 失败信息 + 日志末尾', () => {
  const prompt = buildDiagnosePrompt(
    { prompt: '修登录', lastError: '上次也炸了' },
    { error: 'boom' },
    'line1\nline2',
  );
  assert.ok(prompt.startsWith(
    '下面是一次自动编码任务的失败记录。请用中文简短回答，不超过 300 字：\n'
    + '原因：<一句话>\n建议：<最多 5 条，每条一行>\n不要修改任何文件。',
  ));
  assert.ok(prompt.includes('## 任务提示词（前 1000 字）\n修登录'));
  assert.ok(prompt.includes('## 失败信息\n运行错误：boom\n任务最近错误：上次也炸了'));
  assert.ok(prompt.includes('## 运行日志（最后 200 行）\nline1\nline2'));
});

test('诊断 prompt 的缺省展示：error / lastError 为 null 记（无），日志为空记（日志为空或不可读）', () => {
  const prompt = buildDiagnosePrompt({ prompt: 'p', lastError: null }, { error: null }, '');
  assert.ok(prompt.includes('运行错误：（无）'));
  assert.ok(prompt.includes('任务最近错误：（无）'));
  assert.ok(prompt.includes('## 运行日志（最后 200 行）\n（日志为空或不可读）'));
  assert.ok(prompt.includes('## 任务提示词（前 1000 字）\np'));
});

test('任务 prompt 超过 1000 字（Unicode 码点）时截到 1000，不切坏内容', () => {
  const long = `头${'中'.repeat(1500)}`; // 1501 个码点
  const prompt = buildDiagnosePrompt({ prompt: long }, { error: null }, '');
  const section = prompt.slice(prompt.indexOf('## 任务提示词'));
  assert.ok(section.includes(`头${'中'.repeat(TASK_PROMPT_MAX_CHARS - 1)}`), '正好前 1000 个码点');
  assert.ok(!section.includes('中'.repeat(TASK_PROMPT_MAX_CHARS + 1)), '不会带第 1001 个字');
});

// ---------------------------------------------------------------- readLogTail

test('验收：300 行日志只取最后 200 行（第 1 行不在、第 300 行在）', (t) => {
  const file = path.join(makeTempHome(t), 'run.log');
  const lines = Array.from({ length: 300 }, (_, i) => `日志第${i + 1}行`);
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
  const tailLines = readLogTail(file).split('\n');
  assert.equal(tailLines.length, 200);
  assert.equal(tailLines[0], '日志第101行');
  assert.equal(tailLines[199], '日志第300行');
});

test('readLogTail：不足 200 行全部带且无尾随空行；文件不存在返回空串', (t) => {
  const dir = makeTempHome(t);
  const file = path.join(dir, 'run.log');
  fs.writeFileSync(file, '一\n二\n三\n');
  assert.equal(readLogTail(file), '一\n二\n三');
  assert.equal(readLogTail(path.join(dir, 'absent.log')), '');
});

test('readLogTail：maxLines 参数生效；文件超过 512KB 只读末尾且丢弃被截断的半行', (t) => {
  const dir = makeTempHome(t);
  const file = path.join(dir, 'run.log');
  fs.writeFileSync(file, '一\n二\n三\n四\n五\n');
  assert.equal(readLogTail(file, 3), '三\n四\n五');

  const big = path.join(dir, 'big.log');
  fs.writeFileSync(big, `${'x'.repeat(600_000)}\nfinal line\n`);
  assert.equal(readLogTail(big), 'final line', '起头被拦腰截断的半行丢弃');
});

// ---------------------------------------------------------------- diagnose()（真 invokeClaude + 假 claude）

test('验收：diagnose 用 flash 只读跑一次——argv / cwd / 环境、诊断写回失败运行、临时目录删除', async (t) => {
  const home = makeTempHome(t);
  const db = openDb(path.join(home, 'night-shift.db'));
  t.after(() => db.close());
  const task = makeClaimedTask(db);
  const logFile = path.join(home, 'failed-run.log');
  fs.writeFileSync(logFile, '第一行\n中间一些行\n最后一行 boom\n');
  const failedRun = makeFailedRun(db, task, { logPath: logFile });
  const argsLog = path.join(home, 'args.jsonl');
  const config = { ...DEFAULT_CONFIG, claudeBin: FAKE_CLAUDE };
  const env = fakeEnv({
    FAKE_CLAUDE_ARGS_LOG: argsLog,
    FAKE_CLAUDE_RESULT_TEXT: '原因：缺少依赖\n建议：先安装依赖',
    MAX_THINKING_TOKENS: '31999', // 外层泄漏（本机全局就设着）也不许传给诊断
  });

  // runEvents 与任务运行同一总线：诊断同样发 start / log / finish
  const seen = [];
  const onStart = (payload) => seen.push(['start', payload]);
  const onFinish = (payload) => seen.push(['finish', payload]);
  runEvents.on('start', onStart);
  runEvents.on('finish', onFinish);
  t.after(() => {
    runEvents.off('start', onStart);
    runEvents.off('finish', onFinish);
  });

  const { run, diagnosis } = await diagnose({
    task, failedRun, config, db, home, env, clock: OFF_PEAK_CLOCK,
  });
  assert.equal(run.status, 'succeeded');
  assert.equal(diagnosis, '原因：缺少依赖\n建议：先安装依赖');

  // —— 假 claude 收到的调用
  const entries = readArgsLog(argsLog);
  assert.equal(entries.length, 1);
  const [entry] = entries;
  const diagDir = path.join(home, 'tmp', `diag-${failedRun.id}`);
  const { argv } = entry;
  assert.equal(entry.cwd, diagDir, 'cwd 应是 <home>/tmp/diag-<runId> 临时空目录，不是任务 worktree');
  assert.equal(argv[0], '-p');
  assert.equal(argv[argv.indexOf('--model') + 1], 'glm-5.3-flash');
  assert.equal(argv[argv.indexOf('--max-turns') + 1], '3');
  assert.ok(argv.includes('--output-format'));
  assert.ok(argv.includes('--verbose'));
  assert.ok(!argv.includes('--dangerously-skip-permissions'), '诊断只读，不带跳过权限旗标');
  assert.equal(entry.env.MAX_THINKING_TOKENS, null, '诊断不设 MAX_THINKING_TOKENS');

  // —— 诊断 prompt：固定说明 + 失败信息 + 失败日志的最后一行
  const prompt = argv[1];
  assert.ok(prompt.startsWith('下面是一次自动编码任务的失败记录'));
  assert.ok(prompt.includes('运行错误：fake failure'));
  assert.ok(prompt.includes('最后一行 boom'), 'prompt 含失败日志的最后一行');

  // —— 临时目录跑完即删
  assert.equal(fs.existsSync(diagDir), false, '诊断临时目录已删除');

  // —— runs 表：诊断行 + 失败行各一条，诊断文本写在失败行上
  const runs = listRuns(db, { taskId: task.id });
  assert.equal(runs.length, 2);
  const diagRow = runs.find((r) => r.kind === 'diagnosis');
  const failedRow = runs.find((r) => r.kind === 'task');
  assert.equal(diagRow.model, 'glm-5.3-flash');
  assert.equal(diagRow.effort, 'low');
  assert.equal(diagRow.attempt, failedRun.attempt, 'attempt 与被诊断的失败运行相同');
  assert.equal(diagRow.status, 'succeeded');
  assert.equal(diagRow.peak, false);
  assert.equal(diagRow.quotaUnits, 0.4, '非高峰 flash 倍率，参与额度统计');
  assert.equal(diagRow.logPath, path.join(home, 'logs', `task-${task.id}`, `run-${diagRow.id}.log`));
  assert.ok(fs.existsSync(diagRow.logPath), '诊断日志同样写 logs/task-<id>/run-<runId>.log');
  assert.equal(diagRow.diagnosis, null, '诊断运行自己的行不存诊断文本');
  assert.equal(failedRow.diagnosis, '原因：缺少依赖\n建议：先安装依赖', '文本写回失败运行');
  assert.equal(getRun(db, failedRun.id).diagnosis, '原因：缺少依赖\n建议：先安装依赖');

  // —— runEvents：诊断运行的 start / finish 都发了，runId 与库里一致
  assert.ok(seen.some(([name, payload]) => name === 'start' && payload.runId === diagRow.id
    && payload.taskId === task.id), '发了 start 事件');
  assert.ok(seen.some(([name, payload]) => name === 'finish' && payload.runId === diagRow.id
    && payload.status === 'succeeded'), '发了 finish 事件');
});

test('验收：失败日志 300 行时诊断 prompt 只带最后 200 行（第 1 行不在 prompt 里）', async (t) => {
  const home = makeTempHome(t);
  const db = openDb(path.join(home, 'night-shift.db'));
  t.after(() => db.close());
  const task = makeClaimedTask(db);
  const logFile = path.join(home, 'big-run.log');
  fs.writeFileSync(logFile, `${Array.from({ length: 300 }, (_, i) => `日志第${i + 1}行`).join('\n')}\n`);
  const failedRun = makeFailedRun(db, task, { logPath: logFile });
  const argsLog = path.join(home, 'args.jsonl');
  const config = { ...DEFAULT_CONFIG, claudeBin: FAKE_CLAUDE };
  const env = fakeEnv({ FAKE_CLAUDE_ARGS_LOG: argsLog });

  const { run } = await diagnose({
    task, failedRun, config, db, home, env, clock: OFF_PEAK_CLOCK,
  });
  assert.equal(run.status, 'succeeded');
  const prompt = readArgsLog(argsLog)[0].argv[1];
  const section = prompt.slice(prompt.indexOf('## 运行日志（最后 200 行）')).split('\n');
  assert.equal(section[0], '## 运行日志（最后 200 行）');
  const logLines = section.slice(1);
  assert.equal(logLines.length, 200);
  assert.equal(logLines[0], '日志第101行');
  assert.equal(logLines[199], '日志第300行');
  assert.ok(!prompt.includes('日志第100行'));
  assert.ok(!prompt.includes('日志第1行'));
});

test('验收：诊断失败（fail 场景）不抛错——run 记 failed、diagnosis 为 null、失败运行不留诊断', async (t) => {
  const home = makeTempHome(t);
  const db = openDb(path.join(home, 'night-shift.db'));
  t.after(() => db.close());
  const task = makeClaimedTask(db);
  const logFile = path.join(home, 'failed-run.log');
  fs.writeFileSync(logFile, 'boom\n');
  const failedRun = makeFailedRun(db, task, { logPath: logFile });
  const argsLog = path.join(home, 'args.jsonl');
  const config = { ...DEFAULT_CONFIG, claudeBin: FAKE_CLAUDE };
  const env = fakeEnv({ FAKE_CLAUDE_ARGS_LOG: argsLog, FAKE_CLAUDE_SCENARIO: 'fail' });

  const { run, diagnosis } = await diagnose({
    task, failedRun, config, db, home, env, clock: OFF_PEAK_CLOCK,
  });
  assert.equal(run.status, 'failed');
  assert.equal(diagnosis, null);
  assert.equal(getRun(db, failedRun.id).diagnosis, null);
  const diagRow = listRuns(db, { taskId: task.id, kind: 'diagnosis' })[0];
  assert.equal(diagRow.status, 'failed');
  assert.equal(diagRow.quotaUnits, 0.4, '失败也照常计额度');
});

test('诊断超时（hang + diagnoseTimeoutMinutes 0.01）：记 timeout、diagnosis 为 null、不抛错', async (t) => {
  const home = makeTempHome(t);
  const db = openDb(path.join(home, 'night-shift.db'));
  t.after(() => db.close());
  const task = makeClaimedTask(db);
  const failedRun = makeFailedRun(db, task, { logPath: path.join(home, 'x.log') });
  fs.writeFileSync(path.join(home, 'x.log'), 'boom\n');
  const config = { ...DEFAULT_CONFIG, claudeBin: FAKE_CLAUDE, diagnoseTimeoutMinutes: 0.01 };
  const env = fakeEnv({ FAKE_CLAUDE_SCENARIO: 'hang' });

  const startedAt = Date.now();
  const { run, diagnosis } = await diagnose({
    task, failedRun, config, db, home, env, clock: OFF_PEAK_CLOCK,
  });
  assert.ok(Date.now() - startedAt < 3000, '超时后应立刻返回，不拖满缺省宽限');
  assert.equal(run.status, 'timeout');
  assert.ok(run.error !== null && run.error.includes('超时'), run.error);
  assert.equal(diagnosis, null);
  assert.equal(getRun(db, failedRun.id).diagnosis, null);
});

test('诊断结果超过 2000 字符时按码点截断到 2000', async (t) => {
  const home = makeTempHome(t);
  const db = openDb(path.join(home, 'night-shift.db'));
  t.after(() => db.close());
  const task = makeClaimedTask(db);
  const failedRun = makeFailedRun(db, task, { logPath: path.join(home, 'x.log') });
  fs.writeFileSync(path.join(home, 'x.log'), 'boom\n');
  const argsLog = path.join(home, 'args.jsonl');
  const longText = `因${'长'.repeat(2500)}`;
  const config = { ...DEFAULT_CONFIG, claudeBin: FAKE_CLAUDE };
  const env = fakeEnv({ FAKE_CLAUDE_ARGS_LOG: argsLog, FAKE_CLAUDE_RESULT_TEXT: longText });

  const { diagnosis } = await diagnose({
    task, failedRun, config, db, home, env, clock: OFF_PEAK_CLOCK,
  });
  assert.equal([...diagnosis].length, 2000);
  assert.equal(diagnosis, [...longText].slice(0, 2000).join(''));
});

test('参数校验：缺 task / failedRun / config / home、diagnoseModel 空串、timeout 非正 → TypeError', async (t) => {
  const home = makeTempHome(t);
  const db = openDb(path.join(home, 'night-shift.db'));
  t.after(() => db.close());
  const task = makeClaimedTask(db);
  const failedRun = makeFailedRun(db, task, { logPath: path.join(home, 'x.log') });
  const config = { ...DEFAULT_CONFIG, claudeBin: FAKE_CLAUDE };
  const good = { task, failedRun, config, db, home, clock: OFF_PEAK_CLOCK };
  const args = (drop, overrides = {}) => {
    const input = { ...good, ...overrides };
    delete input[drop];
    return input;
  };

  await assert.rejects(() => diagnose(args('task')), /task/);
  await assert.rejects(() => diagnose({ ...good, task: null }), /task/);
  await assert.rejects(() => diagnose(args('failedRun')), /failedRun/);
  await assert.rejects(() => diagnose(args('config')), /config/);
  await assert.rejects(() => diagnose(args('home')), /home/);
  await assert.rejects(
    () => diagnose({ ...good, config: { ...config, diagnoseModel: ' ' } }),
    /diagnoseModel/,
  );
  await assert.rejects(
    () => diagnose({ ...good, config: { ...config, diagnoseTimeoutMinutes: 0 } }),
    /diagnoseTimeoutMinutes/,
  );
});

// ---------------------------------------------------------------- 存储层（迁移列）

test('验收：runs.kind 缺省 task、diagnosis 入库、非法值被拒；listRuns 按 kind 过滤', (t) => {
  const db = openTempDb(t);
  const task = makeClaimedTask(db);
  const a = startRun(db, {
    taskId: task.id, attempt: 1, model: 'glm-5.3', effort: 'medium', peak: false, logPath: 'a.log',
  });
  const b = startRun(db, {
    taskId: task.id, attempt: 1, model: 'glm-5.3-flash', effort: 'low', peak: false,
    kind: 'diagnosis', logPath: 'b.log',
  });
  assert.equal(a.kind, 'task', '缺省 task');
  assert.equal(a.diagnosis, null);
  assert.equal(b.kind, 'diagnosis');
  assert.throws(
    () => startRun(db, {
      taskId: task.id, attempt: 1, model: 'm', effort: 'low', peak: false,
      kind: 'audit', logPath: 'c.log',
    }),
    (err) => err instanceof ValidationError && err.field === 'kind',
  );
  assert.deepEqual(listRuns(db, { taskId: task.id, kind: 'diagnosis' }).map((r) => r.id), [b.id]);
  assert.deepEqual(listRuns(db, { taskId: task.id, kind: 'task' }).map((r) => r.id), [a.id]);
  assert.deepEqual(listRuns(db, { taskId: task.id }).map((r) => r.id), [b.id, a.id]);
  assert.throws(
    () => listRuns(db, { kind: 'other' }),
    (err) => err instanceof ValidationError && err.field === 'kind',
  );
});

test('验收：setRunDiagnosis 写入 / 清空；空白与非字符串报错、run 不存在报 NotFoundError', (t) => {
  const db = openTempDb(t);
  const task = makeClaimedTask(db);
  const run = startRun(db, {
    taskId: task.id, attempt: 1, model: 'glm-5.3', effort: 'medium', peak: false, logPath: 'x.log',
  });
  const updated = setRunDiagnosis(db, run.id, '原因：缺少依赖\n建议：先安装');
  assert.equal(updated.diagnosis, '原因：缺少依赖\n建议：先安装');
  assert.equal(getRun(db, run.id).diagnosis, '原因：缺少依赖\n建议：先安装');
  assert.equal(setRunDiagnosis(db, run.id, null).diagnosis, null, 'null 清空');
  for (const bad of ['', '   ', 42, undefined]) {
    assert.throws(
      () => setRunDiagnosis(db, run.id, bad),
      (err) => err instanceof ValidationError && err.field === 'diagnosis',
      `text=${String(bad)} 应报 ValidationError`,
    );
  }
  assert.throws(() => setRunDiagnosis(db, 9999, 'x'), NotFoundError);
  assert.equal(getRun(db, run.id).diagnosis, null, '报错的调用不落下任何写入');
});
