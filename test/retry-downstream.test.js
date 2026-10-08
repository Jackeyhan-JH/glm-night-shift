// #55 重试连带下游的验收测试：retryTask 把「被这次失败连累」的下游（failed 且
// last_error 是级联写的「依赖 #<n> <原因>」、n 在本次重试集合里）一并重新排队；
// 自己跑失败的下游保持失败。返回值附加 requeued（不进 rowToTask，GET /api/tasks/:id
// 不带）；retry 命令行尾点名连带。只跑 store 层与真实 bin 子进程 / 本地 HTTP 服务，
// 不调用真实 claude / gh，不联网（loopback 除外），临时目录用 makeTempHome。
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fakeEnv, makeTempHome } from './helpers.js';
import { loadConfig } from '../src/config.js';
import { systemClock } from '../src/clock.js';
import { openDb } from '../src/db.js';
import { createServer } from '../src/server.js';
import {
  createTask, getTask, claimNextTask, finishTask, cancelTask, retryTask,
  ValidationError,
} from '../src/tasks.js';

const VALID = { repo: 'owner/name', prompt: 'do the thing' };
const binPath = fileURLToPath(new URL('../bin/night-shift.mjs', import.meta.url));

function openMemory(t) {
  const db = openDb(':memory:');
  t.after(() => db.close());
  return db;
}

// 起一组「跑完就失败」的任务：领取 → finishTask(failed)。领取顺序按创建先后，
// 调用方要保证它就是当前最该被领到的那条。
function failTask(db, id, lastError = 'boom') {
  const claimed = claimNextTask(db);
  assert.ok(claimed !== null, `应能领到 #${id} 去跑失败流程`);
  assert.equal(claimed.id, id);
  return finishTask(db, id, { status: 'failed', lastError });
}

// 作为独立进程跑 bin；TZ 固定 UTC（与 cli-deps.test.js 的同名实现一致）。
function spawnCli(t, args, { cwd, home } = {}) {
  const dir = cwd ?? makeTempHome(t);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [binPath, ...args], {
      cwd: dir,
      env: fakeEnv({ NIGHT_SHIFT_HOME: home ?? dir, TZ: 'UTC' }),
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

// 本地起一个 API 服务（随机端口），t.after 里关闭；不挂调度器。
function startServer(t) {
  const home = makeTempHome(t);
  fs.mkdirSync(path.join(home, 'logs'), { recursive: true });
  const db = openDb(path.join(home, 'night-shift.db'));
  const config = loadConfig({ home, env: fakeEnv() });
  const server = createServer({ db, config, home, clock: systemClock(fakeEnv()) });
  t.after(() => {
    server.close();
    server.closeAllConnections();
    db.close();
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve({ db, base: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

// ---------------------------------------------------------------- 连带重新排队

test('验收: A 失败级联 B、C 后 retry(A)：三者都 queued、attempts 0、last_error 空，requeued 为 [B, C]，branch / pr_url 保留', (t) => {
  const db = openMemory(t);
  const a = createTask(db, { ...VALID, prompt: 'A' });
  const b = createTask(db, { ...VALID, prompt: 'B', dependsOn: [a.id] });
  const c = createTask(db, { ...VALID, prompt: 'C', dependsOn: [b.id] });
  failTask(db, a.id, 'a-boom');
  assert.equal(getTask(db, b.id).lastError, `依赖 #${a.id} 失败`, '两条 last_error 都是级联写出来的');
  assert.equal(getTask(db, c.id).lastError, `依赖 #${b.id} 失败`);
  // 下游跑不到（依赖拦着），attempts / started_at / branch / pr_url 用 SQL 预置，
  // 让「重置与保留」的断言有非平凡的初值
  db.prepare(`
    UPDATE tasks SET attempts = 2, started_at = '2026-01-01T00:00:00.000Z',
                     branch = 'ns/b', pr_url = 'https://example.com/pr/1'
    WHERE id IN (?, ?)
  `).run(b.id, c.id);

  const retried = retryTask(db, a.id);

  for (const task of [getTask(db, a.id), getTask(db, b.id), getTask(db, c.id)]) {
    assert.equal(task.status, 'queued');
    assert.equal(task.attempts, 0);
    assert.equal(task.lastError, null);
    assert.equal(task.finishedAt, null);
    assert.equal(task.notBefore, null);
  }
  assert.equal(retried.id, a.id, '返回值仍是重试的那条任务');
  assert.equal(retried.status, 'queued');
  assert.deepEqual(retried.requeued, [b.id, c.id], '实际 id 升序，不含 A 自己');
  assert.equal(getTask(db, b.id).branch, 'ns/b', 'branch 保留');
  assert.equal(getTask(db, b.id).prUrl, 'https://example.com/pr/1', 'pr_url 保留');
  assert.equal(getTask(db, c.id).branch, 'ns/b');
  assert.equal(getTask(db, c.id).prUrl, 'https://example.com/pr/1');
  assert.equal(getTask(db, b.id).startedAt, '2026-01-01T00:00:00.000Z', 'started_at 不在这里清');
  assert.equal(getTask(db, c.id).startedAt, '2026-01-01T00:00:00.000Z', 'started_at 不在这里清');
});

test('验收: B 自己跑失败（last_error 非级联格式）时 retry(A) 只重新排队 A：B、C 保持失败，requeued 是 []，stdout 逐字不变', async (t) => {
  // store 层：A 与 B 各自失败（B 不依赖 A——依赖 A 的任务在 A 失败时跑不了，
  // 「自己跑失败的下游」只能来自别的链）；C 依赖 B、被 B 的失败级联标失败
  const db = openMemory(t);
  const a = createTask(db, { ...VALID, prompt: 'A' });
  const b = createTask(db, { ...VALID, prompt: 'B' });
  const c = createTask(db, { ...VALID, prompt: 'C', dependsOn: [b.id] });
  failTask(db, a.id, 'a-boom');
  failTask(db, b.id, 'b-boom');
  assert.equal(getTask(db, c.id).lastError, `依赖 #${b.id} 失败`);

  const retried = retryTask(db, a.id);

  assert.equal(retried.status, 'queued');
  assert.deepEqual(retried.requeued, []);
  assert.equal(getTask(db, b.id).status, 'failed', '自己跑失败的下游不被捎上');
  assert.equal(getTask(db, b.id).lastError, 'b-boom');
  assert.equal(getTask(db, b.id).attempts, 1);
  assert.equal(getTask(db, c.id).status, 'failed', '链的根（B）不在重试集合里，更下游也不连带');
  assert.equal(getTask(db, c.id).lastError, `依赖 #${b.id} 失败`);

  // 命令行：同一局面下 stdout 与改前逐字一样（没有连带就没有后缀）
  const home = makeTempHome(t);
  {
    const file = openDb(path.join(home, 'night-shift.db'));
    createTask(file, { ...VALID, prompt: 'A' }); // id 1：将被 retry 的无关上游
    createTask(file, { ...VALID, prompt: 'B' }); // id 2：自己跑失败
    createTask(file, { ...VALID, prompt: 'C', dependsOn: [2] }); // id 3：被 B 连累
    let claimed = claimNextTask(file);
    finishTask(file, claimed.id, { status: 'failed', lastError: 'a-boom' });
    claimed = claimNextTask(file);
    finishTask(file, claimed.id, { status: 'failed', lastError: 'b-boom' });
    file.close();
  }
  const res = await spawnCli(t, ['retry', '1'], { cwd: home });
  assert.equal(res.code, 0, res.stderr);
  assert.equal(res.stdout, '#1 已重新排队（queued）\n');
});

test('验收: A 的依赖里还有失败任务时 retry(A) 抛 ValidationError（dependsOn），下游零连带', (t) => {
  const db = openMemory(t);
  const up = createTask(db, { ...VALID, prompt: 'UP' });
  const a = createTask(db, { ...VALID, prompt: 'A', dependsOn: [up.id] });
  const b = createTask(db, { ...VALID, prompt: 'B', dependsOn: [a.id] });
  failTask(db, up.id, 'up-boom'); // A、B 都被级联标 failed
  assert.equal(getTask(db, a.id).lastError, `依赖 #${up.id} 失败`);
  assert.equal(getTask(db, b.id).lastError, `依赖 #${a.id} 失败`);

  assert.throws(
    () => retryTask(db, a.id),
    (err) => err instanceof ValidationError && err.field === 'dependsOn'
      && err.message.includes(`依赖 #${up.id} 仍是 failed，请先重试它`),
  );
  assert.equal(getTask(db, a.id).status, 'failed', '保存点回滚，A 原样');
  assert.equal(getTask(db, a.id).lastError, `依赖 #${up.id} 失败`);
  assert.equal(getTask(db, b.id).status, 'failed', '下游一个都不动');
  assert.equal(getTask(db, b.id).lastError, `依赖 #${a.id} 失败`);
});

// ---------------------------------------------------------------- 命令行

test('验收: 有连带时 retry 命令 stdout 逐字「#<A> 已重新排队（queued），连带 #<B>、#<C>」（id 升序、中文顿号）', async (t) => {
  const home = makeTempHome(t);
  {
    const db = openDb(path.join(home, 'night-shift.db'));
    const a = createTask(db, { ...VALID, prompt: 'A' }); // id 1
    createTask(db, { ...VALID, prompt: 'B', dependsOn: [a.id] }); // id 2
    createTask(db, { ...VALID, prompt: 'C', dependsOn: [2] }); // id 3
    failTask(db, a.id, 'a-boom');
    db.close();
  }
  const res = await spawnCli(t, ['retry', '1'], { cwd: home });
  assert.equal(res.code, 0, res.stderr);
  assert.equal(res.stdout, '#1 已重新排队（queued），连带 #2、#3\n');
});

// ---------------------------------------------------------------- HTTP

test('验收: GET /api/tasks/<id> 的 JSON 没有 requeued；POST /api/tasks/<id>/retry 的 JSON 有', async (t) => {
  const { db, base } = await startServer(t);
  const a = createTask(db, { ...VALID, prompt: 'A' });
  const b = createTask(db, { ...VALID, prompt: 'B', dependsOn: [a.id] });
  failTask(db, a.id, 'a-boom');

  const before = await (await fetch(`${base}/api/tasks/${b.id}`)).json();
  assert.equal('requeued' in before, false, 'GET 的任务 JSON 不带 requeued');

  const retry = await fetch(`${base}/api/tasks/${a.id}/retry`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });
  assert.equal(retry.status, 200);
  const body = await retry.json();
  assert.equal(body.status, 'queued');
  assert.deepEqual(body.requeued, [b.id], 'POST /retry 原样序列化返回值，带上 requeued');

  const after = await (await fetch(`${base}/api/tasks/${a.id}`)).json();
  assert.equal('requeued' in after, false, '重试后的 GET 同样不带');
  assert.equal(after.status, 'queued');
  assert.equal((await (await fetch(`${base}/api/tasks/${b.id}`)).json()).status, 'queued');
});

// ---------------------------------------------------------------- canceled 不连带

test('验收: canceled 不被连带：retry 无关任务不动它；retry canceled 上游只拉回 failed 且 last_error 匹配的下游', (t) => {
  const db = openMemory(t);
  // 场景一：A 已取消、B 因它级联失败；X 是无关的自己失败任务
  const x = createTask(db, { ...VALID, prompt: 'X' });
  const a = createTask(db, { ...VALID, prompt: 'A' });
  const b = createTask(db, { ...VALID, prompt: 'B', dependsOn: [a.id] });
  cancelTask(db, a.id);
  assert.equal(getTask(db, b.id).lastError, `依赖 #${a.id} 已取消`);
  failTask(db, x.id, 'x-boom');

  assert.deepEqual(retryTask(db, x.id).requeued, []);
  assert.equal(getTask(db, a.id).status, 'canceled', '被取消的任务不被动');
  assert.equal(getTask(db, b.id).status, 'failed', '指向 canceled 的下游也不连带');
  assert.equal(getTask(db, b.id).lastError, `依赖 #${a.id} 已取消`);

  // 场景二：retry 一个 canceled 的上游——只拉回 failed 且 last_error 匹配的 B；
  // 用户自己取消的 C（canceled）不被拉回 queued
  const a2 = createTask(db, { ...VALID, prompt: 'A2' });
  const b2 = createTask(db, { ...VALID, prompt: 'B2', dependsOn: [a2.id] });
  const c2 = createTask(db, { ...VALID, prompt: 'C2', dependsOn: [b2.id] });
  cancelTask(db, c2.id); // 用户自己取消的下游（级联只碰 queued，不会改写它）
  cancelTask(db, a2.id); // B2 级联失败：依赖 #a2 已取消
  assert.equal(getTask(db, b2.id).status, 'failed');
  assert.equal(getTask(db, b2.id).lastError, `依赖 #${a2.id} 已取消`);
  assert.equal(getTask(db, c2.id).status, 'canceled');

  const retried = retryTask(db, a2.id);
  assert.equal(retried.status, 'queued');
  assert.deepEqual(retried.requeued, [b2.id], '取消级联写出的 last_error 同样匹配');
  assert.equal(getTask(db, b2.id).status, 'queued');
  assert.equal(getTask(db, b2.id).lastError, null);
  assert.equal(getTask(db, c2.id).status, 'canceled', 'canceled 下游不被拉回 queued');
});
