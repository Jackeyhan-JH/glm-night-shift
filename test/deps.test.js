// src/tasks.js / src/db.js 的任务依赖测试（issue #11 验收项全覆盖）。
// 依赖规则：依赖全部 succeeded 前不领取；依赖失败 / 取消沿边级联失败（同一事务）；
// 改依赖只限 queued 任务且不许成环；重试要按顺序先重试上游。临时文件库用 makeTempHome，
// 绝不碰 ~/.glm-night-shift。
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDb, MIGRATIONS } from '../src/db.js';
import {
  createTask, getTask, listTasks, claimNextTask, finishTask, cancelTask, retryTask,
  setDependencies, listDependencies,
  ValidationError, NotFoundError, InvalidTransitionError,
} from '../src/tasks.js';
import { makeTempHome } from './helpers.js';

const VALID = { repo: 'owner/name', prompt: 'do the thing' };

function openMemory(t) {
  const db = openDb(':memory:');
  t.after(() => db.close());
  return db;
}

// 起一组「跑完就失败」的任务：领取 → finishTask(failed)。
function failTask(db, id) {
  const claimed = claimNextTask(db);
  assert.ok(claimed !== null, `应能领到 #${id} 去跑失败流程`);
  assert.equal(claimed.id, id);
  return finishTask(db, id, { status: 'failed', lastError: 'boom' });
}

function succeedTask(db, id) {
  const claimed = claimNextTask(db);
  assert.ok(claimed !== null, `应能领到 #${id} 去跑成功流程`);
  assert.equal(claimed.id, id);
  return finishTask(db, id, { status: 'succeeded' });
}

// ---------------------------------------------------------------- 领取门

test('验收: B 依赖 A：A queued 时 claimNextTask 只返回 A，再调用返回 null（B 不能被领）；A 成功后返回 B', (t) => {
  const db = openMemory(t);
  const a = createTask(db, { ...VALID, prompt: 'A' });
  const b = createTask(db, { ...VALID, prompt: 'B', dependsOn: [a.id] });
  assert.deepEqual(b.dependsOn, [a.id]);
  assert.deepEqual(b.blockedBy, [a.id]);

  const gotA = claimNextTask(db);
  assert.equal(gotA.id, a.id);
  assert.equal(claimNextTask(db), null, 'A 还没成功，B 不能被领取');
  assert.equal(getTask(db, b.id).status, 'queued');

  finishTask(db, a.id, { status: 'succeeded' });
  const gotB = claimNextTask(db);
  assert.equal(gotB.id, b.id);
  assert.deepEqual(gotB.dependsOn, [a.id]);
  assert.deepEqual(gotB.blockedBy, [], 'A 已成功，不再挡 B');
});

test('间接依赖也要逐级解锁：C→B→A，A、B 依次成功前 C 一直领不到', (t) => {
  const db = openMemory(t);
  const a = createTask(db, { ...VALID, prompt: 'A' });
  const b = createTask(db, { ...VALID, prompt: 'B', dependsOn: [a.id] });
  const c = createTask(db, { ...VALID, prompt: 'C', dependsOn: [b.id] });

  succeedTask(db, a.id);
  assert.equal(claimNextTask(db).id, b.id, 'A 成功后 B 可领');
  assert.equal(claimNextTask(db), null, 'B 还在跑，C 领不到');
  finishTask(db, b.id, { status: 'succeeded' });
  assert.equal(claimNextTask(db).id, c.id);
});

test('依赖是 running 也算未满足；被挡住的高优先级任务跳过，领取后面满足条件的', (t) => {
  const db = openMemory(t);
  const a = createTask(db, { ...VALID, prompt: 'A' });
  const blocked = createTask(db, { ...VALID, prompt: 'blocked', priority: 9, dependsOn: [a.id] });
  const free = createTask(db, { ...VALID, prompt: 'free', priority: -5 });

  claimNextTask(db); // 领走 A（running）
  const got = claimNextTask(db);
  assert.equal(got.id, free.id, 'blocked 优先级再高也领不到，退而领 free');
  assert.equal(getTask(db, blocked.id).status, 'queued');
  assert.deepEqual(getTask(db, blocked.id).blockedBy, [a.id], 'running 的依赖仍在 blockedBy');
});

test('allowPeakOnly 与依赖门叠加：被依赖挡住的 allow_peak 任务也不可领', (t) => {
  const db = openMemory(t);
  const a = createTask(db, { ...VALID, prompt: 'A' });
  const peaky = createTask(db, { ...VALID, prompt: 'peaky', allowPeak: true, dependsOn: [a.id] });
  assert.equal(claimNextTask(db, { allowPeakOnly: true }), null, '唯一的 allow_peak 任务被 A 挡住');
  assert.equal(claimNextTask(db).id, a.id);
});

// ---------------------------------------------------------------- 级联失败

test('验收: B 依赖 A、C 依赖 B：A finishTask(failed) 后 B、C 都是 failed，lastError 分别为 依赖 #A 失败、依赖 #B 失败', (t) => {
  const db = openMemory(t);
  const a = createTask(db, { ...VALID, prompt: 'A' }); // id 1
  const b = createTask(db, { ...VALID, prompt: 'B', dependsOn: [a.id] }); // id 2
  const c = createTask(db, { ...VALID, prompt: 'C', dependsOn: [b.id] }); // id 3

  failTask(db, a.id);
  const afterB = getTask(db, b.id);
  const afterC = getTask(db, c.id);
  assert.equal(afterB.status, 'failed');
  assert.equal(afterB.lastError, `依赖 #${a.id} 失败`);
  assert.equal(afterC.status, 'failed');
  assert.equal(afterC.lastError, `依赖 #${b.id} 失败`, 'C 的 last_error 名直接依赖 B');
  for (const task of [afterB, afterC]) {
    assert.ok(!Number.isNaN(Date.parse(task.finishedAt)), '级联失败也写 finished_at');
  }
  assert.equal(claimNextTask(db), null, '全失败，没有可领的');
});

test('验收: cancelTask(A) 后（另起一组）B 的 lastError 为 依赖 #A 已取消', (t) => {
  const db = openMemory(t);
  const a = createTask(db, { ...VALID, prompt: 'A' });
  const b = createTask(db, { ...VALID, prompt: 'B', dependsOn: [a.id] });

  cancelTask(db, a.id);
  const after = getTask(db, b.id);
  assert.equal(after.status, 'failed');
  assert.equal(after.lastError, `依赖 #${a.id} 已取消`);
});

test('取消 running 的上游同样级联；菱形依赖全部级联，last_error 名直接依赖里最小的', (t) => {
  const db = openMemory(t);
  const a = createTask(db, { ...VALID, prompt: 'A' }); // 1
  const b = createTask(db, { ...VALID, prompt: 'B', dependsOn: [a.id] }); // 2
  const c = createTask(db, { ...VALID, prompt: 'C', dependsOn: [a.id] }); // 3
  const d = createTask(db, { ...VALID, prompt: 'D', dependsOn: [b.id, c.id] }); // 4

  claimNextTask(db); // 领走 A
  cancelTask(db, a.id); // 取消 running 任务也触发级联
  for (const id of [b.id, c.id, d.id]) {
    assert.equal(getTask(db, id).status, 'failed', `#${id} 应级联失败`);
  }
  assert.equal(getTask(db, d.id).lastError, `依赖 #${b.id} 已取消`, '两个直接依赖都失败，取最小 id，结果确定');
  assert.equal(getTask(db, b.id).lastError, `依赖 #${a.id} 已取消`);
});

test('级联只碰 queued：canceled / 已 failed 的下游不被改写', (t) => {
  const db = openMemory(t);
  // canceled 的下游：级联失败不得把 canceled 改成 failed
  const a = createTask(db, { ...VALID, prompt: 'A' });
  const b = createTask(db, { ...VALID, prompt: 'B', dependsOn: [a.id] });
  cancelTask(db, b.id);
  cancelTask(db, a.id);
  const canceledAfter = getTask(db, b.id);
  assert.equal(canceledAfter.status, 'canceled');
  assert.equal(canceledAfter.lastError, null);

  // 已 failed 的下游：第一次级联失败后重试上游、再取消上游——下游保留第一次的 last_error
  const c = createTask(db, { ...VALID, prompt: 'C' });
  const d = createTask(db, { ...VALID, prompt: 'D', dependsOn: [c.id] });
  failTask(db, c.id); // D 级联失败：依赖 #C 失败
  retryTask(db, c.id);
  cancelTask(db, c.id); // 第二次级联若误碰 D，last_error 会变成「已取消」
  const failedAfter = getTask(db, d.id);
  assert.equal(failedAfter.status, 'failed');
  assert.equal(failedAfter.lastError, `依赖 #${c.id} 失败`, '保留第一次的报错，不被第二次触发改写');
});

test('finishTask(succeeded) / finishTask(queued) 不级联；状态守卫未命中时不级联（保存点回滚）', (t) => {
  const db = openMemory(t);
  const a = createTask(db, { ...VALID, prompt: 'A' });
  const b = createTask(db, { ...VALID, prompt: 'B', dependsOn: [a.id] });

  // A 不是 running，finishTask 直接抛错：保存点回滚，B 必须仍在队列、没被级联
  assert.throws(() => finishTask(db, a.id, { status: 'failed' }), InvalidTransitionError);
  assert.equal(getTask(db, b.id).status, 'queued');
  assert.equal(getTask(db, b.id).lastError, null);

  // 成功不级联：B 解锁，仍在队列
  succeedTask(db, a.id);
  assert.equal(getTask(db, b.id).status, 'queued');

  // 排回队列重试也不级联（只有 failed 终态才级联）
  assert.equal(claimNextTask(db).id, b.id);
  finishTask(db, b.id, { status: 'queued', lastError: 'again' });
  assert.equal(getTask(db, b.id).status, 'queued');
  assert.equal(getTask(db, b.id).lastError, 'again');
});

test('任务对象上的 dependsOn / blockedBy 随依赖状态更新（升序去重）', (t) => {
  const db = openMemory(t);
  const a1 = createTask(db, { ...VALID, prompt: '1' });
  const a2 = createTask(db, { ...VALID, prompt: '2' });
  const a3 = createTask(db, { ...VALID, prompt: '3' });
  const b = createTask(db, {
    ...VALID, prompt: 'b', dependsOn: [a3.id, a1.id, a1.id, a2.id], // 乱序 + 重复
  });
  assert.deepEqual(b.dependsOn, [a1.id, a2.id, a3.id], '升序去重');
  assert.deepEqual(b.blockedBy, [a1.id, a2.id, a3.id]);

  succeedTask(db, a1.id);
  assert.deepEqual(getTask(db, b.id).dependsOn, [a1.id, a2.id, a3.id]);
  assert.deepEqual(getTask(db, b.id).blockedBy, [a2.id, a3.id], 'a1 succeeded 后移出 blockedBy');

  const [listed] = listTasks(db, { status: 'queued' }).filter((task) => task.id === b.id);
  assert.deepEqual(listed.blockedBy, [a2.id, a3.id], 'listTasks 也带两个数组');
  for (const task of listTasks(db)) {
    assert.deepEqual(task.dependsOn, task.dependsOn.slice().sort((x, y) => x - y));
    assert.ok(Array.isArray(task.blockedBy));
  }
});

// ---------------------------------------------------------------- 校验

test('验收: createTask 的 dependsOn 含不存在的 id、已失败的任务时抛 ValidationError 且字段为 dependsOn', (t) => {
  const db = openMemory(t);
  const ok = createTask(db, { ...VALID, prompt: 'ok' }); // 合法依赖目标（queued）
  const failed = createTask(db, { ...VALID, prompt: 'f', priority: 10 }); // 最高优先级，先被领走
  failTask(db, failed.id);
  const canceled = createTask(db, { ...VALID, prompt: 'c' });
  cancelTask(db, canceled.id);

  const cases = [
    [{ ...VALID, dependsOn: [99] }, '#99 不存在'],
    [{ ...VALID, dependsOn: [ok.id, 99] }, '#99 不存在', '前面的 id 合法也要点名出问题的那个'],
    [{ ...VALID, dependsOn: [failed.id] }, `#${failed.id} 已是 failed`],
    [{ ...VALID, dependsOn: [canceled.id] }, `#${canceled.id} 已是 canceled`],
  ];
  for (const [input, needle] of cases) {
    assert.throws(
      () => createTask(db, input),
      (err) => err instanceof ValidationError && err.field === 'dependsOn' && err.message.includes(needle),
      `${JSON.stringify(input)} 应报「${needle}」`,
    );
  }
  // 校验失败时任务压根没建（先验依赖再插任务）；listTasks 默认最新在前（id DESC）
  assert.deepEqual(listTasks(db, { limit: 1000 }).map((task) => task.id), [canceled.id, failed.id, ok.id]);
});

test('验收: setDependencies 依赖自己抛 ValidationError（field=dependsOn，点名不能依赖自己）', (t) => {
  const db = openMemory(t);
  const a = createTask(db, { ...VALID, prompt: 'A' });
  assert.throws(
    () => setDependencies(db, a.id, [a.id]),
    (err) => err instanceof ValidationError && err.field === 'dependsOn'
      && err.message.includes(`#${a.id} 不能依赖自己`),
  );
  assert.deepEqual(listDependencies(db, a.id), []);
});

test('dependsOn 形状不对（非数组 / 非正整数元素）抛 ValidationError（field=dependsOn）', (t) => {
  const db = openMemory(t);
  createTask(db, { ...VALID });
  const bad = [5, '1,2', [0], [1.5], ['2'], [null]];
  for (const dependsOn of bad) {
    assert.throws(
      () => createTask(db, { ...VALID, dependsOn }),
      (err) => err instanceof ValidationError && err.field === 'dependsOn',
      `${JSON.stringify(dependsOn)} 应被拒绝`,
    );
  }
  assert.throws(
    () => setDependencies(db, 1, '1'),
    (err) => err instanceof ValidationError && err.field === 'dependsOn',
  );
});

test('验收: A 依赖 B 后 setDependencies(B, [A]) 抛 ValidationError，信息含 # 和 →；A→B→C→A 三环同样被拒', (t) => {
  const db = openMemory(t);
  const a = createTask(db, { ...VALID, prompt: 'A' }); // 1
  const b = createTask(db, { ...VALID, prompt: 'B' }); // 2
  setDependencies(db, a.id, [b.id]); // A 依赖 B：A → B
  assert.throws(
    () => setDependencies(db, b.id, [a.id]),
    (err) => err instanceof ValidationError && err.field === 'dependsOn'
      && err.message.includes('#') && err.message.includes('→')
      && err.message.includes(`#${b.id} → #${a.id} → #${b.id}`),
    '环信息应列出 #B → #A → #B',
  );
  assert.deepEqual(listDependencies(db, b.id), [], '写入被拒，B 没有依赖');
  assert.deepEqual(
    listDependencies(db, a.id).map((d) => d.id),
    [b.id],
    'A 已有的依赖不受 B 那次失败的写入影响（保存点回滚）',
  );

  // 另一组：A→B→C 后让 C 依赖 A，成三环
  const c1 = createTask(db, { ...VALID, prompt: 'C1' }); // 3
  const c2 = createTask(db, { ...VALID, prompt: 'C2' }); // 4
  const c3 = createTask(db, { ...VALID, prompt: 'C3' }); // 5
  setDependencies(db, c1.id, [c2.id]);
  setDependencies(db, c2.id, [c3.id]);
  assert.throws(
    () => setDependencies(db, c3.id, [c1.id]),
    (err) => err instanceof ValidationError && err.field === 'dependsOn'
      && err.message.includes(`#${c3.id} → #${c1.id} → #${c2.id} → #${c3.id}`),
    '三环也应列出完整路径',
  );
});

test('环检测盖住间接路径与多条候选边：B→A、C→B 时 setDependencies(A, [C]) 也成环', (t) => {
  const db = openMemory(t);
  const a = createTask(db, { ...VALID, prompt: 'A' });
  const b = createTask(db, { ...VALID, prompt: 'B', dependsOn: [a.id] });
  const c = createTask(db, { ...VALID, prompt: 'C', dependsOn: [b.id] });
  assert.throws(
    () => setDependencies(db, a.id, [c.id, b.id]), // A→C 会闭合成环（A→C→B→A）
    (err) => err instanceof ValidationError && err.field === 'dependsOn' && err.message.includes('→'),
  );
  // 换成只依赖 B 也成环（A→B→A）；清掉 B 的依赖后同样的边就合法
  assert.throws(() => setDependencies(db, a.id, [b.id]), ValidationError);
  setDependencies(db, b.id, []);
  const updated = setDependencies(db, a.id, [b.id]);
  assert.deepEqual(updated.dependsOn, [b.id], '无环时正常写入');
});

// ---------------------------------------------------------------- setDependencies

test('setDependencies：整体替换、重复去重、[] 清空；只允许 queued 任务', (t) => {
  const db = openMemory(t);
  const a = createTask(db, { ...VALID, prompt: 'A' });
  const b = createTask(db, { ...VALID, prompt: 'B' });
  const c = createTask(db, { ...VALID, prompt: 'C' });
  const target = createTask(db, { ...VALID, prompt: 'T', dependsOn: [a.id] });

  const updated = setDependencies(db, target.id, [c.id, b.id, c.id]);
  assert.deepEqual(updated.dependsOn, [b.id, c.id], '替换旧值，去重升序');
  assert.deepEqual(listDependencies(db, target.id).map((d) => d.id), [b.id, c.id]);

  const cleared = setDependencies(db, target.id, []);
  assert.deepEqual(cleared.dependsOn, []);
  assert.deepEqual(listDependencies(db, target.id), []);
  assert.deepEqual(getTask(db, target.id).blockedBy, []);

  // 非 queued：running / 终态都不许改（runner 用最高优先级保证先被领走）
  const runner = createTask(db, { ...VALID, prompt: 'R', priority: 100 });
  assert.equal(claimNextTask(db).id, runner.id);
  assert.throws(
    () => setDependencies(db, runner.id, [a.id]),
    (err) => err instanceof InvalidTransitionError && err.from === 'running',
  );
  finishTask(db, runner.id, { status: 'failed', lastError: 'x' });
  assert.throws(
    () => setDependencies(db, runner.id, [a.id]),
    (err) => err instanceof InvalidTransitionError && err.from === 'failed',
  );
  assert.throws(() => setDependencies(db, 999, [a.id]), (err) => err instanceof NotFoundError && err.id === 999);
});

test('listDependencies：{id, status} 升序；依赖状态随之变化', (t) => {
  const db = openMemory(t);
  const a = createTask(db, { ...VALID, prompt: 'A' });
  const b = createTask(db, { ...VALID, prompt: 'B' });
  createTask(db, { ...VALID, prompt: 'T', dependsOn: [b.id, a.id] });
  assert.deepEqual(listDependencies(db, 3), [{ id: a.id, status: 'queued' }, { id: b.id, status: 'queued' }]);
  succeedTask(db, a.id);
  assert.deepEqual(listDependencies(db, 3), [{ id: a.id, status: 'succeeded' }, { id: b.id, status: 'queued' }]);
  assert.deepEqual(listDependencies(db, 999), []);
  assert.throws(() => listDependencies(db, 0), (err) => err instanceof ValidationError && err.field === 'taskId');
});

// ---------------------------------------------------------------- 重试

test('验收: B 因 A 失败而级联失败后 retryTask(B) 抛 ValidationError；先 retry A 再 retry B 成功，B 在 A 成功前仍领不到', (t) => {
  const db = openMemory(t);
  const a = createTask(db, { ...VALID, prompt: 'A' });
  const b = createTask(db, { ...VALID, prompt: 'B', dependsOn: [a.id] });
  failTask(db, a.id); // B 被级联标 failed
  assert.equal(getTask(db, b.id).status, 'failed');

  assert.throws(
    () => retryTask(db, b.id),
    (err) => err instanceof ValidationError && err.field === 'dependsOn'
      && err.message.includes(`依赖 #${a.id} 仍是 failed，请先重试它`),
  );
  assert.equal(getTask(db, b.id).status, 'failed', '重试被拒，状态不变');

  const retriedA = retryTask(db, a.id);
  assert.equal(retriedA.status, 'queued');
  assert.deepEqual(retriedA.dependsOn, []);
  const retriedB = retryTask(db, b.id);
  assert.equal(retriedB.status, 'queued');
  assert.deepEqual(retriedB.blockedBy, [a.id], 'A 只是回队列还没成功，B 仍被挡');

  assert.equal(claimNextTask(db).id, a.id, '先领 A（B 被挡）');
  assert.equal(claimNextTask(db), null, 'A 成功前 B 领不到');
  finishTask(db, a.id, { status: 'succeeded' });
  assert.equal(claimNextTask(db).id, b.id);
});

test('重试上游不恢复下游：A 级联失败 B 后 retry(A)，B 保持 failed、lastError 保留', (t) => {
  const db = openMemory(t);
  const a = createTask(db, { ...VALID, prompt: 'A' });
  const b = createTask(db, { ...VALID, prompt: 'B', dependsOn: [a.id] });
  failTask(db, a.id);
  retryTask(db, a.id);
  const after = getTask(db, b.id);
  assert.equal(after.status, 'failed', '下游要单独 retry');
  assert.equal(after.lastError, `依赖 #${a.id} 失败`);
});

test('依赖是 canceled 的任务同样不能重试；重试成功后依赖只剩 queued 不再拦截', (t) => {
  const db = openMemory(t);
  const a = createTask(db, { ...VALID, prompt: 'A' });
  const b = createTask(db, { ...VALID, prompt: 'B', dependsOn: [a.id] });
  cancelTask(db, a.id);
  assert.throws(
    () => retryTask(db, b.id),
    (err) => err instanceof ValidationError && err.field === 'dependsOn'
      && err.message.includes(`依赖 #${a.id} 仍是 canceled，请先重试它`),
  );
  retryTask(db, a.id); // A 回队列
  assert.equal(retryTask(db, b.id).status, 'queued', '依赖不再是 failed/canceled 就能重试');
});

test('无依赖任务的 retryTask 行为不变（回归：不因依赖检查误伤）', (t) => {
  const db = openMemory(t);
  const task = createTask(db, { ...VALID });
  claimNextTask(db);
  finishTask(db, task.id, { status: 'failed', lastError: 'x' });
  const retried = retryTask(db, task.id);
  assert.equal(retried.status, 'queued');
  assert.equal(retried.attempts, 0);
  assert.deepEqual(retried.dependsOn, []);
  assert.deepEqual(retried.blockedBy, []);
  assert.throws(() => retryTask(db, 999), (err) => err instanceof NotFoundError && err.id === 999);
});

// ---------------------------------------------------------------- 迁移（v1 → v2）

test('验收: 只有版本 1 的数据库文件打开后自动升级：原有任务都在，新建任务可以带依赖', (t) => {
  const file = path.join(makeTempHome(t), 'night-shift.db');
  // 手工建一个停在 v1 的库（只跑第一个迁移，版本号写 1），塞两条 #3 时代的任务。
  const raw = new DatabaseSync(file);
  try {
    MIGRATIONS[0](raw);
    raw.exec('PRAGMA user_version = 1');
    const insert = raw.prepare(`
      INSERT INTO tasks (repo, title, prompt, priority, max_attempts, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const now = new Date().toISOString();
    insert.run('a/b', 't1', 'p1', 3, 2, now, now);
    insert.run('a/b', 't2', 'p2', 0, 2, now, now);
  } finally {
    raw.close();
  }

  const db = openDb(file); // 这里触发 v1 → v2 升级
  t.after(() => db.close());
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, MIGRATIONS.length);
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='task_deps'").get());
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_task_deps_depends_on'").get());

  const old = listTasks(db, { limit: 10 });
  assert.deepEqual(old.map((task) => task.title), ['t2', 't1'], '原有数据不丢（created_at DESC）');
  assert.deepEqual(old[0].dependsOn, [], '老任务 hydration 正常');

  const fresh = createTask(db, { ...VALID, dependsOn: [1] }); // 新库上带依赖建任务
  assert.deepEqual(fresh.dependsOn, [1]);
  assert.deepEqual(getTask(db, fresh.id).blockedBy, [1]);
  cancelTask(db, 1); // 级联在升级后的库上照常工作
  assert.equal(getTask(db, fresh.id).status, 'failed');
  assert.equal(getTask(db, fresh.id).lastError, '依赖 #1 已取消');
});

test('user_version 等于迁移步数（不写死数字）；依赖表的主键去重约束生效', (t) => {
  const db = openMemory(t);
  assert.ok(MIGRATIONS.length >= 2, 'v1 之后至少追加了依赖表这一步');
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, MIGRATIONS.length);
  createTask(db, { ...VALID });
  const insert = db.prepare('INSERT INTO task_deps (task_id, depends_on) VALUES (1, 1)');
  insert.run();
  assert.throws(() => insert.run(), /UNIQUE/, '同一对 (task_id, depends_on) 只能存一条');
});

// ---------------------------------------------------------------- 并发（TOCTOU）

test('两连接：A 连接把上游失败，B 连接看到的下游级联结果完整可见（同事务提交）', (t) => {
  const file = path.join(makeTempHome(t), 'night-shift.db');
  const sched = openDb(file);
  const dash = openDb(file);
  t.after(() => {
    sched.close();
    dash.close();
  });

  const a = createTask(sched, { ...VALID, prompt: 'A' });
  const b = createTask(sched, { ...VALID, prompt: 'B', dependsOn: [a.id] });
  claimNextTask(sched);
  finishTask(sched, a.id, { status: 'failed', lastError: 'boom' });

  const seen = getTask(dash, b.id);
  assert.equal(seen.status, 'failed');
  assert.equal(seen.lastError, `依赖 #${a.id} 失败`, '级联与状态变更一起提交，另一连接不会看到半个');
});
