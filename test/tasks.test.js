// src/tasks.js 的领域测试（issue #3 验收项全覆盖）。临时文件库用 makeTempHome，
// 库在 t.after 里 close；绝不碰 ~/.glm-night-shift。db 层（WAL / 迁移 / 约束）见 db.test.js。
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { openDb, MIGRATIONS } from '../src/db.js';
import {
  createTask, getTask, listTasks, claimNextTask, finishTask, cancelTask, retryTask,
  recoverStaleRunning, startRun, finishRun, listRuns,
  ValidationError, NotFoundError, InvalidTransitionError,
} from '../src/tasks.js';
import { makeTempHome } from './helpers.js';

const VALID = { repo: 'owner/name', prompt: 'do the thing' };

function openMemory(t) {
  const db = openDb(':memory:');
  t.after(() => db.close());
  return db;
}

// 故意多套一层不存在的目录，顺带覆盖 openDb 递归建父目录
function tempDbFile(t) {
  return path.join(makeTempHome(t), 'data', 'night-shift.db');
}

// ---------------------------------------------------------------- createTask

test('createTask 默认值与字段形状：驼峰、真布尔、null 保留', (t) => {
  const db = openMemory(t);
  const task = createTask(db, { ...VALID });
  assert.equal(task.repo, 'owner/name');
  assert.equal(task.title, 'do the thing'); // 缺省 title = prompt
  assert.equal(task.difficulty, 'medium');
  assert.equal(task.priority, 0);
  assert.equal(task.testCommand, null);
  assert.equal(task.allowPeak, false);
  assert.strictEqual(typeof task.allowPeak, 'boolean');
  assert.equal(task.status, 'queued');
  assert.equal(task.attempts, 0);
  assert.equal(task.maxAttempts, 2); // DEFAULT_CONFIG.maxAttempts
  assert.equal(task.branch, null);
  assert.equal(task.prUrl, null);
  assert.equal(task.lastError, null);
  assert.equal(task.startedAt, null);
  assert.equal(task.finishedAt, null);
  assert.ok(Number.isInteger(task.id));
  assert.ok(!Number.isNaN(Date.parse(task.createdAt)));
  assert.equal(task.updatedAt, task.createdAt);
});

test('title 缺省取 prompt 前 60 个 Unicode 码点，中文 / emoji 不会被切半', (t) => {
  const db = openMemory(t);
  const chinese = createTask(db, { ...VALID, prompt: '修'.repeat(70) });
  assert.equal([...chinese.title].length, 60);
  assert.equal(chinese.title, '修'.repeat(60));
  assert.equal(chinese.prompt.length, 70);

  const emoji = createTask(db, { ...VALID, prompt: '😀👍'.repeat(40) }); // 80 码点
  assert.equal([...emoji.title].length, 60);
  assert.equal(emoji.title, '😀👍'.repeat(30));
  assert.ok(emoji.title.endsWith('👍'), '不应留下半个代理对');
});

test('显式 title：trim 后入库；空白 title 报 ValidationError', (t) => {
  const db = openMemory(t);
  assert.equal(createTask(db, { ...VALID, title: '  fix login  ' }).title, 'fix login');
  assert.throws(
    () => createTask(db, { ...VALID, title: '   ' }),
    (err) => err instanceof ValidationError && err.field === 'title' && err.message.includes('title'),
  );
});

test('验收: createTask 传 repo "not a repo" 或 difficulty "extreme" 抛 ValidationError，错误里能看出是哪个字段', (t) => {
  const db = openMemory(t);
  const cases = [
    [{ ...VALID, repo: 'not a repo' }, 'repo'],
    [{ ...VALID, repo: 'a/b/c' }, 'repo'],
    [{ ...VALID, repo: '' }, 'repo'],
    [{ ...VALID, repo: 'owner/' }, 'repo'],
    [{ ...VALID, repo: 42 }, 'repo'],
    [{ ...VALID, difficulty: 'extreme' }, 'difficulty'],
    [{ ...VALID, difficulty: 3 }, 'difficulty'],
    [{ ...VALID, prompt: '' }, 'prompt'],
    [{ ...VALID, prompt: '   ' }, 'prompt'],
    [{ ...VALID, priority: '5' }, 'priority'],
    [{ ...VALID, priority: 1.5 }, 'priority'],
    [{ ...VALID, maxAttempts: 0 }, 'maxAttempts'],
    [{ ...VALID, maxAttempts: 2.5 }, 'maxAttempts'],
    [{ ...VALID, maxAttempts: '3' }, 'maxAttempts'],
    [{ ...VALID, testCommand: '' }, 'testCommand'],
    [{ ...VALID, testCommand: '  ' }, 'testCommand'],
    [{ ...VALID, allowPeak: 'yes' }, 'allowPeak'],
    [{ ...VALID, allowPeak: 1 }, 'allowPeak'],
  ];
  for (const [input, field] of cases) {
    assert.throws(
      () => createTask(db, input),
      (err) => err instanceof ValidationError && err.field === field && err.message.includes(field),
      `输入 ${JSON.stringify(input)} 应报 ${field} 的 ValidationError`,
    );
  }
});

test('createTask 接受合法值：先 trim 再入库，maxAttempts / testCommand / allowPeak 可显式给', (t) => {
  const db = openMemory(t);
  const task = createTask(db, {
    repo: ' Jackeyhan-JH/glm-night-shift ',
    prompt: '  please do it  ',
    title: ' 定制标题 ',
    difficulty: 'hard',
    priority: -3, // 任意整数都合法（负数 = 更晚领取）
    testCommand: ' npm test ',
    allowPeak: true,
    maxAttempts: 5,
  });
  assert.equal(task.repo, 'Jackeyhan-JH/glm-night-shift');
  assert.equal(task.prompt, 'please do it');
  assert.equal(task.title, '定制标题');
  assert.equal(task.difficulty, 'hard');
  assert.equal(task.priority, -3);
  assert.equal(task.testCommand, 'npm test');
  assert.equal(task.allowPeak, true);
  assert.equal(task.maxAttempts, 5);
});

// ---------------------------------------------------------------- 领取与列表

test('验收: 3 个排队任务 priority 0/5/0 依次创建，claimNextTask 依次返回 priority 5 的、第 1 个、第 3 个，之后 null；每个 running 且 attempts 1', (t) => {
  const db = openMemory(t);
  const first = createTask(db, { ...VALID, prompt: 'first' });
  const top = createTask(db, { ...VALID, prompt: 'top', priority: 5 });
  const third = createTask(db, { ...VALID, prompt: 'third' });

  const c1 = claimNextTask(db);
  const c2 = claimNextTask(db);
  const c3 = claimNextTask(db);
  assert.equal(c1.id, top.id);
  assert.equal(c2.id, first.id);
  assert.equal(c3.id, third.id);
  assert.equal(claimNextTask(db), null);
  for (const claimed of [c1, c2, c3]) {
    assert.equal(claimed.status, 'running');
    assert.equal(claimed.attempts, 1);
    assert.ok(!Number.isNaN(Date.parse(claimed.startedAt)));
  }
  assert.deepEqual(listTasks(db, { status: 'queued' }), []);
});

test('同一毫秒创建的同优先级任务按 id 升序领取（FIFO 兜底，顺序确定）', (t) => {
  const db = openMemory(t);
  const ids = ['a', 'b', 'c', 'd'].map((p) => createTask(db, { ...VALID, prompt: p }).id);
  db.prepare('UPDATE tasks SET created_at = ?').run('2026-01-01T00:00:00.000Z');
  const claimed = [1, 2, 3, 4].map(() => claimNextTask(db));
  assert.deepEqual(claimed.map((task) => task.id), ids);
  assert.equal(claimNextTask(db), null);
});

test('验收: allowPeakOnly true 时只领取 allowPeak 为 true 的任务', (t) => {
  const db = openMemory(t);
  const plain1 = createTask(db, { ...VALID, prompt: 'plain1' });
  const peaky = createTask(db, { ...VALID, prompt: 'peaky', allowPeak: true, priority: -1 });
  const plain2 = createTask(db, { ...VALID, prompt: 'plain2' });

  const got = claimNextTask(db, { allowPeakOnly: true });
  assert.equal(got.id, peaky.id);
  assert.equal(got.allowPeak, true);
  assert.equal(claimNextTask(db, { allowPeakOnly: true }), null);
  assert.equal(getTask(db, plain1.id).status, 'queued');
  assert.equal(getTask(db, plain2.id).status, 'queued');

  assert.equal(claimNextTask(db).id, plain1.id); // 不限时照常领取
  assert.throws(
    () => claimNextTask(db, { allowPeakOnly: 'yes' }),
    (err) => err instanceof ValidationError && err.field === 'allowPeakOnly',
  );
});

test('listTasks：queued 按队列序，其他状态与不传 status 按 created_at DESC（同毫秒 id DESC）', (t) => {
  const db = openMemory(t);
  const a = createTask(db, { ...VALID, prompt: 'a' });
  const b = createTask(db, { ...VALID, prompt: 'b', priority: 9 });
  const c = createTask(db, { ...VALID, prompt: 'c' });
  db.prepare('UPDATE tasks SET created_at = ?').run('2026-01-01T00:00:00.000Z'); // 全部同毫秒

  assert.deepEqual(listTasks(db, { status: 'queued' }).map((task) => task.id), [b.id, a.id, c.id]);
  assert.deepEqual(listTasks(db).map((task) => task.id), [c.id, b.id, a.id]); // 同毫秒 → id DESC
  assert.deepEqual(listTasks(db, { status: 'running' }), []);

  db.prepare('UPDATE tasks SET created_at = ? WHERE id = ?').run('2026-01-03T00:00:00.000Z', c.id);
  db.prepare('UPDATE tasks SET created_at = ? WHERE id = ?').run('2026-01-02T00:00:00.000Z', b.id);
  assert.deepEqual(listTasks(db).map((task) => task.id), [c.id, b.id, a.id]);
  claimNextTask(db); // 领走 b
  assert.deepEqual(listTasks(db, { status: 'queued' }).map((task) => task.id), [a.id, c.id]);
});

test('listTasks 参数校验与 limit（默认 100）', (t) => {
  const db = openMemory(t);
  assert.throws(() => listTasks(db, { status: 'paused' }), (err) => err.field === 'status');
  assert.throws(() => listTasks(db, { limit: 0 }), (err) => err.field === 'limit');
  for (let i = 0; i < 105; i++) createTask(db, { ...VALID, prompt: `p${i}` });
  assert.equal(listTasks(db).length, 100);
  assert.equal(listTasks(db, { limit: 5 }).length, 5);
});

test('getTask：不存在返回 null；id 非正整数报 ValidationError', (t) => {
  const db = openMemory(t);
  const task = createTask(db, { ...VALID });
  assert.equal(getTask(db, task.id).id, task.id);
  assert.equal(getTask(db, 999), null);
  for (const bad of [0, -1, 1.5, '3', null]) {
    assert.throws(() => getTask(db, bad), (err) => err instanceof ValidationError && err.field === 'id');
  }
});

// ---------------------------------------------------------------- 状态流转

test('finishTask succeeded：写 finished_at 与给了的字段，没给的保持原值', (t) => {
  const db = openMemory(t);
  const task = createTask(db, { ...VALID });
  const claimed = claimNextTask(db);
  assert.equal(claimed.id, task.id);
  const done = finishTask(db, task.id, {
    status: 'succeeded',
    prUrl: 'https://github.com/owner/name/pull/1',
    branch: 'ns/1',
  });
  assert.equal(done.status, 'succeeded');
  assert.ok(!Number.isNaN(Date.parse(done.finishedAt)));
  assert.equal(done.prUrl, 'https://github.com/owner/name/pull/1');
  assert.equal(done.branch, 'ns/1');
  assert.equal(done.lastError, null);
  assert.equal(done.startedAt, claimed.startedAt, 'started_at 语义：最近一次领取时间');
  assert.deepEqual(getTask(db, task.id), done);
});

test('finishTask → queued（重试）：清 finished_at、保留 started_at，再领取 attempts 变 2', (t) => {
  const db = openMemory(t);
  const task = createTask(db, { ...VALID });
  claimNextTask(db);
  const again = finishTask(db, task.id, { status: 'queued', lastError: 'claude 崩了' });
  assert.equal(again.status, 'queued');
  assert.equal(again.finishedAt, null);
  assert.equal(again.lastError, 'claude 崩了');
  assert.ok(again.startedAt, '重试不清 started_at，等下次领取覆盖');
  const reclaimed = claimNextTask(db);
  assert.equal(reclaimed.id, task.id);
  assert.equal(reclaimed.attempts, 2);
  assert.ok(reclaimed.startedAt >= again.startedAt);
});

test('finishTask 只允许 running → succeeded|failed|queued，其余抛 InvalidTransitionError', (t) => {
  const db = openMemory(t);
  const queued = createTask(db, { ...VALID });
  for (const status of ['succeeded', 'failed', 'queued']) {
    assert.throws(
      () => finishTask(db, queued.id, { status }),
      (err) => err instanceof InvalidTransitionError && err.from === 'queued' && err.to === status
        && err.message.includes('queued') && err.message.includes(status),
      `queued → ${status} 应报 InvalidTransitionError`,
    );
  }
  cancelTask(db, queued.id); // 清出队列，别挡住后面的领取

  const done = createTask(db, { ...VALID });
  claimNextTask(db);
  finishTask(db, done.id, { status: 'succeeded' });
  assert.throws(
    () => finishTask(db, done.id, { status: 'failed', lastError: 'x' }),
    (err) => err instanceof InvalidTransitionError && err.from === 'succeeded' && err.to === 'failed',
  );

  const running = createTask(db, { ...VALID });
  claimNextTask(db);
  for (const status of ['running', 'canceled', 'paused', undefined]) {
    assert.throws(
      () => finishTask(db, running.id, { status }),
      (err) => err instanceof ValidationError && err.field === 'status',
      `目标状态 ${status} 不在 finishTask 允许的集合里`,
    );
  }
  assert.throws(() => finishTask(db, 999, { status: 'succeeded' }), (err) => err instanceof NotFoundError && err.id === 999);
  assert.throws(() => finishTask(db, 0, { status: 'succeeded' }), ValidationError);
});

test('验收: cancelTask 对 succeeded 任务抛 InvalidTransitionError；queued / running 可取消并写 finished_at', (t) => {
  const db = openMemory(t);
  const queued = createTask(db, { ...VALID });
  assert.equal(cancelTask(db, queued.id).status, 'canceled');
  assert.ok(!Number.isNaN(Date.parse(getTask(db, queued.id).finishedAt)));

  const running = createTask(db, { ...VALID });
  claimNextTask(db);
  assert.equal(cancelTask(db, running.id).status, 'canceled');

  const succeeded = createTask(db, { ...VALID });
  claimNextTask(db);
  finishTask(db, succeeded.id, { status: 'succeeded' });
  assert.throws(
    () => cancelTask(db, succeeded.id),
    (err) => err instanceof InvalidTransitionError && err.from === 'succeeded' && err.to === 'canceled'
      && err.message.includes('succeeded') && err.message.includes('canceled'),
  );
  assert.equal(getTask(db, succeeded.id).status, 'succeeded');

  const failed = createTask(db, { ...VALID });
  claimNextTask(db);
  finishTask(db, failed.id, { status: 'failed', lastError: 'x' });
  assert.throws(() => cancelTask(db, failed.id), InvalidTransitionError);
  assert.throws(() => cancelTask(db, queued.id), InvalidTransitionError); // 已 canceled
  assert.throws(() => cancelTask(db, 999), (err) => err instanceof NotFoundError && err.id === 999);
});

test('验收: retryTask 把 failed 任务变回 queued 且 attempts 归零、last_error / finished_at 清空', (t) => {
  const db = openMemory(t);
  const failed = createTask(db, { ...VALID });
  claimNextTask(db);
  finishTask(db, failed.id, { status: 'failed', lastError: 'boom' });
  const retried = retryTask(db, failed.id);
  assert.equal(retried.status, 'queued');
  assert.equal(retried.attempts, 0);
  assert.equal(retried.lastError, null);
  assert.equal(retried.finishedAt, null);
  const reclaimed = claimNextTask(db);
  assert.equal(reclaimed.id, failed.id);
  assert.equal(reclaimed.attempts, 1);

  const canceled = createTask(db, { ...VALID });
  claimNextTask(db);
  cancelTask(db, canceled.id);
  assert.equal(retryTask(db, canceled.id).status, 'queued');
  claimNextTask(db); // 领走清队列

  const queued = createTask(db, { ...VALID });
  assert.throws(
    () => retryTask(db, queued.id),
    (err) => err instanceof InvalidTransitionError && err.from === 'queued' && err.to === 'queued',
  );
  cancelTask(db, queued.id); // 清出队列
  const running = createTask(db, { ...VALID });
  claimNextTask(db);
  assert.throws(() => retryTask(db, running.id), (err) => err.from === 'running');
  const succeeded = createTask(db, { ...VALID });
  claimNextTask(db);
  finishTask(db, succeeded.id, { status: 'succeeded' });
  assert.throws(() => retryTask(db, succeeded.id), (err) => err.from === 'succeeded');
  assert.throws(() => retryTask(db, 999), (err) => err instanceof NotFoundError && err.id === 999);
});

// ---------------------------------------------------------------- 崩溃恢复

test('验收: recoverStaleRunning 后任务为 queued，未结束的 run 为 failed 且 error = "interrupted"', (t) => {
  const db = openMemory(t);
  assert.deepEqual(recoverStaleRunning(db), []); // 空库无副作用

  // A：running + 未结束的 run（崩溃现场）
  const a = createTask(db, { ...VALID, prompt: 'A' });
  claimNextTask(db);
  startRun(db, { taskId: a.id, attempt: 1, model: 'glm-5.3', effort: 'high', peak: false, logPath: '/tmp/a.log' });
  // B：running 但 run 已结束——run 不应被改写
  const b = createTask(db, { ...VALID, prompt: 'B' });
  claimNextTask(db);
  const runB = startRun(db, { taskId: b.id, attempt: 1, model: 'glm-5.3', effort: 'medium', peak: true, logPath: '/tmp/b.log' });
  finishRun(db, runB.id, { status: 'failed', exitCode: 1, error: 'real error' });
  // C：早已失败又重新排队，带历史 run——不受影响
  const c = createTask(db, { ...VALID, prompt: 'C' });
  claimNextTask(db);
  const runC = startRun(db, { taskId: c.id, attempt: 1, model: 'glm-5.3-flash', effort: 'low', peak: false, logPath: '/tmp/c.log' });
  finishRun(db, runC.id, { status: 'succeeded' });
  finishTask(db, c.id, { status: 'failed', lastError: 'tests' });
  retryTask(db, c.id);

  const affected = recoverStaleRunning(db);
  assert.deepEqual(affected, [a.id, b.id]); // 升序，且不含排队的 C
  assert.equal(getTask(db, a.id).status, 'queued');
  assert.equal(getTask(db, b.id).status, 'queued');
  assert.equal(getTask(db, a.id).attempts, 1, '中断的那次尝试保留计数');

  const [runA] = listRuns(db, { taskId: a.id });
  assert.equal(runA.status, 'failed');
  assert.equal(runA.error, 'interrupted');
  assert.ok(runA.finishedAt, '恢复时刻写入 finished_at');
  assert.equal(runA.durationMs, null, '进程已死，真实耗时不可知，不编造');
  assert.equal(listRuns(db, { taskId: b.id })[0].error, 'real error');
  assert.equal(listRuns(db, { taskId: c.id })[0].status, 'succeeded');

  assert.deepEqual(recoverStaleRunning(db), []); // 再跑一遍没有 running 的了
  assert.equal(claimNextTask(db).id, a.id); // 恢复后 A、B 回队列（FIFO）
});

// ---------------------------------------------------------------- 运行记录

test('验收: finishRun 后 durationMs 为正数；prompts 默认 1，可选字段给了才更新', (t) => {
  const db = openMemory(t);
  const task = createTask(db, { ...VALID });
  claimNextTask(db);
  const run = startRun(db, {
    taskId: task.id,
    attempt: 1,
    model: 'glm-5.3',
    effort: 'medium',
    peak: true,
    logPath: '/tmp/run-1.log',
  });
  assert.equal(run.status, 'running');
  assert.equal(run.taskId, task.id);
  assert.equal(run.attempt, 1);
  assert.equal(run.model, 'glm-5.3');
  assert.equal(run.effort, 'medium');
  assert.equal(run.peak, true);
  assert.strictEqual(typeof run.peak, 'boolean');
  assert.equal(run.prompts, 1);
  assert.equal(run.exitCode, null);
  assert.equal(run.numTurns, null);
  assert.equal(run.quotaUnits, null);
  assert.equal(run.error, null);
  assert.equal(run.finishedAt, null);
  assert.equal(run.durationMs, null);
  assert.ok(!Number.isNaN(Date.parse(run.startedAt)));

  // 同一毫秒里立即结束：durationMs 也必须是正数（验收）
  const done = finishRun(db, run.id, { status: 'succeeded', exitCode: 0, numTurns: 12, quotaUnits: 3.5 });
  assert.equal(done.status, 'succeeded');
  assert.ok(Number.isInteger(done.durationMs) && done.durationMs >= 1, `durationMs 应为正整数，实际 ${done.durationMs}`);
  assert.equal(done.exitCode, 0);
  assert.equal(done.numTurns, 12);
  assert.equal(done.prompts, 1, '没给 prompts 就保持 startRun 写入的默认 1');
  assert.equal(done.quotaUnits, 3.5);
  assert.equal(done.error, null);
  assert.ok(!Number.isNaN(Date.parse(done.finishedAt)));

  // duration 确实按 started_at 差值算：把起点拨回 1 小时前再结束
  const task2 = createTask(db, { ...VALID, prompt: 'two' });
  claimNextTask(db);
  const run2 = startRun(db, { taskId: task2.id, attempt: 1, model: 'glm-5.3', effort: 'low', peak: false, logPath: '/tmp/run-2.log' });
  db.prepare('UPDATE runs SET started_at = ? WHERE id = ?')
    .run(new Date(Date.now() - 3600_000).toISOString(), run2.id);
  const done2 = finishRun(db, run2.id, { status: 'failed', error: 'tests failed', prompts: 2.5 });
  assert.ok(done2.durationMs >= 3_500_000, `一小时左右的耗时，实际 ${done2.durationMs}`);
  assert.equal(done2.prompts, 2.5);
  assert.equal(done2.error, 'tests failed');
});

test('finishRun：非 running 的 run 不能再结束；非法 status / 字段值报 ValidationError', (t) => {
  const db = openMemory(t);
  const task = createTask(db, { ...VALID });
  claimNextTask(db);
  const run = startRun(db, { taskId: task.id, attempt: 1, model: 'm', effort: 'low', peak: false, logPath: '/l' });
  finishRun(db, run.id, { status: 'timeout' });
  for (const status of ['succeeded', 'failed', 'timeout', 'canceled']) {
    assert.throws(
      () => finishRun(db, run.id, { status }),
      (err) => err instanceof InvalidTransitionError && err.from === 'timeout' && err.to === status,
      `timeout → ${status} 应报 InvalidTransitionError`,
    );
  }
  for (const status of ['running', 'paused', undefined]) {
    assert.throws(
      () => finishRun(db, run.id, { status }),
      (err) => err instanceof ValidationError && err.field === 'status',
    );
  }
  assert.throws(() => finishRun(db, 999, { status: 'succeeded' }), (err) => err instanceof NotFoundError && err.id === 999);
  assert.throws(() => finishRun(db, 0, { status: 'succeeded' }), ValidationError);

  const task2 = createTask(db, { ...VALID, prompt: 'two' });
  claimNextTask(db);
  const open = startRun(db, { taskId: task2.id, attempt: 1, model: 'm', effort: 'low', peak: false, logPath: '/l2' });
  const badFields = [
    [{ status: 'failed', exitCode: '0' }, 'exitCode'],
    [{ status: 'failed', exitCode: 1.5 }, 'exitCode'],
    [{ status: 'failed', numTurns: -1 }, 'numTurns'],
    [{ status: 'failed', numTurns: 1.5 }, 'numTurns'],
    [{ status: 'failed', prompts: -1 }, 'prompts'],
    [{ status: 'failed', prompts: 'x' }, 'prompts'],
    [{ status: 'failed', quotaUnits: 'x' }, 'quotaUnits'],
    [{ status: 'failed', error: 42 }, 'error'],
  ];
  for (const [input, field] of badFields) {
    assert.throws(
      () => finishRun(db, open.id, input),
      (err) => err instanceof ValidationError && err.field === field,
      `${field} 非法应报 ValidationError`,
    );
  }
  assert.equal(finishRun(db, open.id, { status: 'failed', exitCode: null, error: null }).exitCode, null, '显式 null 合法');
});

test('startRun 参数校验：缺字段 / 类型不对报 ValidationError，任务不存在 NotFoundError', (t) => {
  const db = openMemory(t);
  createTask(db, { ...VALID }); // id = 1
  const base = { taskId: 1, attempt: 1, model: 'm', effort: 'low', peak: false, logPath: '/l' };
  assert.throws(() => startRun(db, { ...base, taskId: 999 }), (err) => err instanceof NotFoundError && err.id === 999);
  const cases = [
    [{ ...base, taskId: 0 }, 'taskId'],
    [{ ...base, attempt: 0 }, 'attempt'],
    [{ ...base, model: ' ' }, 'model'],
    [{ ...base, effort: '' }, 'effort'],
    [{ ...base, peak: 1 }, 'peak'],
    [{ ...base, logPath: '  ' }, 'logPath'],
    [{}, 'taskId'],
  ];
  for (const [input, field] of cases) {
    assert.throws(
      () => startRun(db, input),
      (err) => err instanceof ValidationError && err.field === field,
      `${field} 缺失或非法应报 ValidationError`,
    );
  }
});

test('listRuns：taskId / since / limit 过滤，started_at DESC → id DESC，since 接受 Date 或 ISO 串', (t) => {
  const db = openMemory(t);
  const task = createTask(db, { ...VALID });
  claimNextTask(db);
  const r1 = startRun(db, { taskId: task.id, attempt: 1, model: 'm', effort: 'low', peak: false, logPath: '/1' });
  const r2 = startRun(db, { taskId: task.id, attempt: 2, model: 'm', effort: 'low', peak: false, logPath: '/2' });
  db.prepare('UPDATE runs SET started_at = ?').run('2026-01-01T00:00:00.000Z'); // 全部同毫秒
  assert.deepEqual(listRuns(db).map((run) => run.id), [r2.id, r1.id]);
  assert.deepEqual(listRuns(db, { taskId: task.id }).map((run) => run.id), [r2.id, r1.id]);

  db.prepare('UPDATE runs SET started_at = ? WHERE id = ?').run('2026-01-02T00:00:00.000Z', r1.id);
  assert.deepEqual(listRuns(db).map((run) => run.id), [r1.id, r2.id]);
  assert.deepEqual(listRuns(db, { since: new Date('2026-01-01T12:00:00Z') }).map((run) => run.id), [r1.id]);
  assert.deepEqual(listRuns(db, { since: '2026-01-02T00:00:00.000Z' }).map((run) => run.id), [r1.id], 'since 含等于');
  assert.deepEqual(listRuns(db, { since: '2026-01-03T00:00:00.000Z' }), []);
  assert.deepEqual(listRuns(db, { limit: 1 }).map((run) => run.id), [r1.id]);
  assert.throws(() => listRuns(db, { since: 'not a date' }), (err) => err instanceof ValidationError && err.field === 'since');
  assert.throws(() => listRuns(db, { limit: 0 }), ValidationError);
  assert.throws(() => listRuns(db, { taskId: -1 }), ValidationError);

  const other = createTask(db, { ...VALID, prompt: 'other' });
  claimNextTask(db);
  startRun(db, { taskId: other.id, attempt: 1, model: 'm', effort: 'low', peak: false, logPath: '/3' });
  assert.equal(listRuns(db, { taskId: task.id }).length, 2, '别的任务的 run 不混进来');
});

// ---------------------------------------------------------------- 持久性与并发

test('验收: 关闭再用 openDb 打开同一文件，数据仍在，user_version 等于迁移步数（当前为 1），迁移不重跑', (t) => {
  const file = tempDbFile(t);
  const db = openDb(file);
  const task = createTask(db, { ...VALID, priority: 2 });
  claimNextTask(db);
  const run = startRun(db, { taskId: task.id, attempt: 1, model: 'glm-5.3', effort: 'medium', peak: false, logPath: '/tmp/x.log' });
  const doneRun = finishRun(db, run.id, { status: 'succeeded', exitCode: 0, quotaUnits: 1.25 });
  const doneTask = finishTask(db, task.id, {
    status: 'succeeded',
    prUrl: 'https://github.com/owner/name/pull/9',
    branch: 'ns/9',
  });
  db.close();

  const db2 = openDb(file); // 迁移不重跑（重跑必因裸 CREATE TABLE 报错）
  t.after(() => db2.close());
  assert.equal(db2.prepare('PRAGMA user_version').get().user_version, MIGRATIONS.length);
  assert.deepEqual(getTask(db2, task.id), doneTask);
  const [runAgain] = listRuns(db2, { taskId: task.id });
  assert.equal(runAgain.status, 'succeeded');
  assert.equal(runAgain.durationMs, doneRun.durationMs);
  assert.ok(runAgain.durationMs >= 1);
  assert.equal(runAgain.quotaUnits, 1.25);
  assert.equal(getTask(db2, 999), null);
});

test('两个连接开同一文件库：交替领取永不重复，写入互相可见（验收：并发领取）', (t) => {
  const file = tempDbFile(t);
  const db1 = openDb(file);
  const db2 = openDb(file);
  t.after(() => {
    db1.close();
    db2.close();
  });

  const made = [];
  for (let i = 0; i < 6; i++) {
    const db = i % 2 === 0 ? db1 : db2; // 交替写入，顺带验证另一连接能看到
    made.push(createTask(db, { ...VALID, prompt: `t${i}`, priority: i % 3 }).id);
  }
  const seen = [];
  for (let i = 0; i < 6; i++) {
    const db = i % 2 === 0 ? db1 : db2;
    const got = claimNextTask(db);
    assert.ok(got, '还有排队任务，应能领到');
    assert.ok(!seen.includes(got.id), `任务 ${got.id} 被领取了两次`);
    seen.push(got.id);
  }
  assert.equal(claimNextTask(db1), null);
  assert.equal(claimNextTask(db2), null);
  assert.deepEqual([...seen].sort((a, b) => a - b), [...made].sort((a, b) => a - b));
  for (const id of made) {
    const task = getTask(db2, id); // 在任一连接看都一样
    assert.equal(task.status, 'running');
    assert.equal(task.attempts, 1);
  }
});

// ---------------------------------------------------------------- 并发下的过期状态（TOCTOU）

test('验收: 另一连接取消后，过期的 finishTask(succeeded) 抛 InvalidTransitionError 且不覆盖 canceled', (t) => {
  const file = tempDbFile(t);
  const sched = openDb(file); // 调度器
  const dash = openDb(file); // 看板 / CLI
  t.after(() => {
    sched.close();
    dash.close();
  });

  const task = createTask(sched, { ...VALID });
  assert.equal(claimNextTask(sched).id, task.id); // 调度器领取，开始跑
  assert.equal(cancelTask(dash, task.id).status, 'canceled'); // 期间看板取消了它

  // 调度器拿着过期的 running 认知来报成功：必须抛错，且 canceled 不被覆盖
  assert.throws(
    () => finishTask(sched, task.id, { status: 'succeeded', prUrl: 'https://github.com/o/r/pull/1' }),
    (err) => err instanceof InvalidTransitionError && err.from === 'canceled' && err.to === 'succeeded'
      && err.message.includes('canceled') && err.message.includes('succeeded'),
  );
  const after = getTask(dash, task.id);
  assert.equal(after.status, 'canceled');
  assert.equal(after.prUrl, null);
});

test('两连接下 retryTask / cancelTask / finishRun 都以数据库当前状态为准，不覆盖并发结果', (t) => {
  const file = tempDbFile(t);
  const a = openDb(file);
  const b = openDb(file);
  t.after(() => {
    a.close();
    b.close();
  });

  // retryTask：a 端看到的 failed，已被 b 端 retry 并重新领走（running）
  const t1 = createTask(a, { ...VALID, prompt: 't1' });
  claimNextTask(a);
  finishTask(a, t1.id, { status: 'failed', lastError: 'x' });
  retryTask(b, t1.id);
  assert.equal(claimNextTask(b).id, t1.id);
  assert.throws(
    () => retryTask(a, t1.id),
    (err) => err instanceof InvalidTransitionError && err.from === 'running' && err.to === 'queued',
  );
  assert.equal(getTask(b, t1.id).status, 'running');

  // cancelTask：a 端想取消，但 b 端已把任务跑到 succeeded
  const t2 = createTask(a, { ...VALID, prompt: 't2' });
  assert.equal(claimNextTask(b).id, t2.id);
  finishTask(b, t2.id, { status: 'succeeded' });
  assert.throws(
    () => cancelTask(a, t2.id),
    (err) => err instanceof InvalidTransitionError && err.from === 'succeeded' && err.to === 'canceled',
  );
  assert.equal(getTask(b, t2.id).status, 'succeeded');

  // finishRun：run 已被 b 端标 timeout，a 端再报 succeeded 要抛错且不覆盖
  const t3 = createTask(a, { ...VALID, prompt: 't3' });
  assert.equal(claimNextTask(a).id, t3.id);
  const run = startRun(a, { taskId: t3.id, attempt: 1, model: 'm', effort: 'low', peak: false, logPath: '/l' });
  finishRun(b, run.id, { status: 'timeout', error: '60min 上限' });
  assert.throws(
    () => finishRun(a, run.id, { status: 'succeeded', exitCode: 0 }),
    (err) => err instanceof InvalidTransitionError && err.from === 'timeout' && err.to === 'succeeded',
  );
  const after = listRuns(b, { taskId: t3.id })[0];
  assert.equal(after.status, 'timeout');
  assert.equal(after.error, '60min 上限');
  assert.equal(after.exitCode, null, '未被 a 端的 exitCode=0 覆盖');
});

test('finishTask 可选字段给了就必须是字符串或 null（undefined = 保持）', (t) => {
  const db = openMemory(t);
  const task = createTask(db, { ...VALID });
  claimNextTask(db);
  for (const fields of [{ lastError: 42 }, { prUrl: 9 }, { branch: {} }]) {
    assert.throws(
      () => finishTask(db, task.id, { status: 'succeeded', ...fields }),
      (err) => err instanceof ValidationError && err.message.includes(Object.keys(fields)[0]),
      `${JSON.stringify(fields)} 应报 ValidationError`,
    );
  }
  assert.equal(getTask(db, task.id).status, 'running', '校验失败不应改动任务');
});

// ---------------------------------------------------------------- 排序与过滤的组合

test('listTasks 按每个状态过滤各自排序，limit 生效，未知 status 报 ValidationError', (t) => {
  const db = openMemory(t);
  // 先把要进各终态的任务走完流程，再建留在队列里的，最后建 running 的，
  // 这样每一步 claimNextTask 领到的都是刚建的任务，互不干扰。
  const succeeded = createTask(db, { ...VALID, prompt: 's' });
  assert.equal(claimNextTask(db).id, succeeded.id);
  finishTask(db, succeeded.id, { status: 'succeeded' });
  const failed = createTask(db, { ...VALID, prompt: 'f' });
  assert.equal(claimNextTask(db).id, failed.id);
  finishTask(db, failed.id, { status: 'failed' });
  const canceled = createTask(db, { ...VALID, prompt: 'c' });
  cancelTask(db, canceled.id);
  const q2 = createTask(db, { ...VALID, prompt: 'q2', priority: 3 });
  assert.equal(claimNextTask(db).id, q2.id); // q2 running
  const q1 = createTask(db, { ...VALID, prompt: 'q1' });
  const q3 = createTask(db, { ...VALID, prompt: 'q3' });

  assert.deepEqual(listTasks(db, { status: 'queued' }).map((task) => task.id), [q1.id, q3.id]);
  assert.deepEqual(listTasks(db, { status: 'running' }).map((task) => task.id), [q2.id]);
  assert.deepEqual(listTasks(db, { status: 'succeeded' }).map((task) => task.id), [succeeded.id]);
  assert.deepEqual(listTasks(db, { status: 'failed' }).map((task) => task.id), [failed.id]);
  assert.deepEqual(listTasks(db, { status: 'canceled' }).map((task) => task.id), [canceled.id]);
  // 不传 status：全部，created_at DESC → id DESC（创建顺序 s f c q2 q1 q3 的倒序）
  assert.deepEqual(listTasks(db).map((task) => task.id), [q3.id, q1.id, q2.id, canceled.id, failed.id, succeeded.id]);
  assert.deepEqual(listTasks(db, { limit: 2 }).map((task) => task.id), [q3.id, q1.id]);
  assert.throws(() => listTasks(db, { status: 'paused' }), (err) => err instanceof ValidationError && err.field === 'status');
});

test('listRuns 组合过滤：taskId + since + limit 一起用，since 等于 started_at 也包含', (t) => {
  const db = openMemory(t);
  const t1 = createTask(db, { ...VALID });
  claimNextTask(db);
  const t2 = createTask(db, { ...VALID, prompt: 'two' });
  claimNextTask(db);
  const run = (taskId, logPath) => startRun(db, { taskId, attempt: 1, model: 'm', effort: 'low', peak: false, logPath });
  const a1 = run(t1.id, '/a1');
  const a2 = run(t1.id, '/a2');
  const b1 = run(t2.id, '/b1');
  const setStartedAt = (id, iso) => db.prepare('UPDATE runs SET started_at = ? WHERE id = ?').run(iso, id);
  setStartedAt(a1.id, '2026-01-01T00:00:00.000Z');
  setStartedAt(a2.id, '2026-01-03T00:00:00.000Z');
  setStartedAt(b1.id, '2026-01-02T00:00:00.000Z');

  assert.deepEqual(listRuns(db, { taskId: t1.id }).map((r) => r.id), [a2.id, a1.id]);
  assert.deepEqual(listRuns(db, { taskId: t2.id }).map((r) => r.id), [b1.id]);
  // since 恰好等于 a2 的 started_at：包含
  assert.deepEqual(listRuns(db, { taskId: t1.id, since: '2026-01-03T00:00:00.000Z' }).map((r) => r.id), [a2.id]);
  assert.deepEqual(listRuns(db, { taskId: t2.id, since: '2026-01-01T00:00:00.000Z' }).map((r) => r.id), [b1.id]);
  // 三个条件一起：全库只有 a2 晚于 1 月 2 日中午，limit 1 也拿到它
  assert.deepEqual(listRuns(db, { since: '2026-01-02T12:00:00Z', limit: 1 }).map((r) => r.id), [a2.id]);
  assert.deepEqual(listRuns(db, { taskId: t1.id, limit: 1 }).map((r) => r.id), [a2.id]);
  assert.deepEqual(listRuns(db, { since: new Date('2026-01-04T00:00:00Z') }), []);
});
