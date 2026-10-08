// src/server.js 的端到端测试（issue #14 验收项全覆盖）：随机端口 + fetch 直连。
// SSE 用 fetch 读流解析事件，AbortController 模拟客户端断开；服务与数据库都在 t.after 关闭。
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { systemClock } from '../src/clock.js';
import { openDb } from '../src/db.js';
import { createServer } from '../src/server.js';
import {
  claimNextTask,
  createTask,
  finishRun,
  startRun,
} from '../src/tasks.js';
import { makeTempHome } from './helpers.js';

// ---------- 辅助 ----------

function startServer(t, { env = {}, scheduler = null, config: overrides = {} } = {}) {
  const home = makeTempHome(t);
  fs.mkdirSync(path.join(home, 'logs'), { recursive: true });
  const db = openDb(path.join(home, 'night-shift.db'));
  const config = { ...loadConfig({ home, env }), ...overrides };
  const server = createServer({ db, config, home, clock: systemClock(env), scheduler });
  t.after(() => {
    server.close();
    server.closeAllConnections();
    db.close();
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, db, home, base: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

/** 发原始路径的请求（fetch 会先按 URL 规范把 /../ 与 %2e%2e 归一化，测不到服务端的解析）。 */
function rawRequest(base, rawPath, { method = 'GET', headers = {} } = {}) {
  const url = new URL(base);
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: url.hostname, port: url.port, path: rawPath, method, headers },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => resolve({
          status: res.statusCode,
          headers: res.headers,
          text: Buffer.concat(chunks).toString('utf8'),
        }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

const JSON_HEADERS = { 'Content-Type': 'application/json' };

async function postJson(url, body, headers = {}) {
  return fetch(url, {
    method: 'POST',
    headers: { ...JSON_HEADERS, ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** 轮询等条件成立（超时抛错）；SSE 断开清理这类异步收敛点用。 */
async function waitUntil(predicate, { timeoutMs = 5000, stepMs = 50, what = '条件' } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return;
    if (Date.now() > deadline) throw new Error(`等待${what}超时（${timeoutMs}ms）`);
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
}

/** fetch 响应流上的极简 SSE 客户端：按空行切事件，next()/waitFor() 取事件，abort() 断开。 */
class SseClient {
  constructor(response, controller) {
    this.response = response;
    this.controller = controller;
    this.queue = [];
    this.closed = false;
    this.#pump();
  }

  async #pump() {
    const reader = this.response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let sep;
        while ((sep = buffer.indexOf('\n\n')) !== -1) {
          const event = this.#parse(buffer.slice(0, sep));
          buffer = buffer.slice(sep + 2);
          if (event !== null) this.queue.push(event);
        }
      }
    } catch {
      // abort / 连接断开：正常收尾
    }
    this.closed = true;
  }

  #parse(raw) {
    let event = 'message';
    const dataLines = [];
    for (const line of raw.split('\n')) {
      if (line.startsWith(':')) continue; // ping 等注释行
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
    }
    return dataLines.length === 0 ? null : { event, data: dataLines.join('\n') };
  }

  /** 取下一个事件；连接关闭且队列空时抛错。 */
  async next(timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (this.queue.length > 0) return this.queue.shift();
      if (this.closed) throw new Error('SSE 连接已关闭，没有更多事件');
      if (Date.now() > deadline) throw new Error(`等待 SSE 事件超时（${timeoutMs}ms）`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  /** 一直取到指定名称的事件（跳过途中无关事件）。 */
  async waitFor(event, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const got = await this.next(Math.max(50, deadline - Date.now()));
      if (got.event === event) return got;
      if (Date.now() > deadline) throw new Error(`等待 SSE 事件 ${event} 超时`);
    }
  }

  abort() {
    this.controller.abort();
  }
}

// ---------- 任务增删查与操作 ----------

test('验收: POST /api/tasks 返回 201，status 为 queued，maxAttempts 取配置；GET /api/tasks 能看到它', async (t) => {
  const { server, db, base } = await startServer(t, { config: { maxAttempts: 4 } });
  assert.equal(server.address().address, '127.0.0.1');

  const res = await postJson(`${base}/api/tasks`, { repo: 'a/b', prompt: '修复登录' });
  assert.equal(res.status, 201);
  const task = await res.json();
  assert.equal(task.status, 'queued');
  assert.equal(task.maxAttempts, 4, 'maxAttempts 缺省取配置');
  assert.equal(task.repo, 'a/b');
  assert.equal(task.prompt, '修复登录');
  assert.equal(task.title, '修复登录', 'title 缺省取 prompt 前 60 码点');

  const listRes = await fetch(`${base}/api/tasks`);
  assert.equal(listRes.status, 200);
  const tasks = await listRes.json();
  assert.ok(Array.isArray(tasks));
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].id, task.id);
  assert.equal(tasks[0].status, 'queued');

  // 显式给 maxAttempts 优先于配置
  const explicit = await postJson(`${base}/api/tasks`, { repo: 'c/d', prompt: 'x', maxAttempts: 9 });
  assert.equal(explicit.status, 201);
  assert.equal((await explicit.json()).maxAttempts, 9);
});

test('验收: bad repo → 400 field 为 repo；请求体 {oops → 400；text/plain → 415；evil Origin → 403', async (t) => {
  const { base } = await startServer(t);

  const bad = await postJson(`${base}/api/tasks`, { repo: 'bad repo', prompt: 'x' });
  assert.equal(bad.status, 400);
  const badBody = await bad.json();
  assert.equal(badBody.field, 'repo');
  assert.ok(typeof badBody.error === 'string' && badBody.error.includes('repo'));

  const oops = await fetch(`${base}/api/tasks`, { method: 'POST', headers: JSON_HEADERS, body: '{oops' });
  assert.equal(oops.status, 400);
  assert.ok((await oops.json()).error.includes('JSON'));

  const plain = await fetch(`${base}/api/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: '{"repo":"a/b","prompt":"x"}',
  });
  assert.equal(plain.status, 415);

  const evil = await postJson(`${base}/api/tasks`, { repo: 'a/b', prompt: 'x' }, { Origin: 'http://evil.example' });
  assert.equal(evil.status, 403);

  // 同源 Origin（host:port 与 Host 一致）放行
  const sameOrigin = await postJson(`${base}/api/tasks`, { repo: 'a/b', prompt: 'x' }, { Origin: base });
  assert.equal(sameOrigin.status, 201);
});

test('POST 防护细节：charset 参数与大小写不敏感的 JSON Content-Type 放行；未知字段 400 且 field 点名；非对象体 400', async (t) => {
  const { base } = await startServer(t);

  const charset = await fetch(`${base}/api/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'Application/JSON; charset=utf-8' },
    body: '{"repo":"a/b","prompt":"x"}',
  });
  assert.equal(charset.status, 201);

  const unknown = await postJson(`${base}/api/tasks`, { repo: 'a/b', prompt: 'x', hack: 1 });
  assert.equal(unknown.status, 400);
  const unknownBody = await unknown.json();
  assert.equal(unknownBody.field, 'hack');
  assert.ok(unknownBody.error.includes('hack'));

  for (const body of ['[1,2]', '"str"', 'null', '42']) {
    const res = await fetch(`${base}/api/tasks`, { method: 'POST', headers: JSON_HEADERS, body });
    assert.equal(res.status, 400, body);
    assert.ok((await res.json()).error.length > 0, body);
  }
});

test('验收: GET /api/tasks/1 含 runs 数组；GET /api/tasks/99 → 404 {error}；cancel 后 canceled，再 cancel 409，retry 回 queued', async (t) => {
  const { db, base } = await startServer(t);
  const created = await postJson(`${base}/api/tasks`, { repo: 'a/b', prompt: 'x' });
  const { id } = await created.json();
  startRun(db, { taskId: id, attempt: 1, model: 'glm-5.3', effort: 'low', peak: false, logPath: '/tmp/x.log' });

  const detail = await fetch(`${base}/api/tasks/${id}`);
  assert.equal(detail.status, 200);
  const withRuns = await detail.json();
  assert.ok(Array.isArray(withRuns.runs));
  assert.equal(withRuns.runs.length, 1);
  assert.equal(withRuns.runs[0].model, 'glm-5.3');
  assert.equal(withRuns.status, 'queued'); // 任务字段在顶层
  assert.equal(withRuns.repo, 'a/b');

  const missing = await fetch(`${base}/api/tasks/99`);
  assert.equal(missing.status, 404);
  const missingBody = await missing.json();
  assert.ok(typeof missingBody.error === 'string' && missingBody.error.includes('99'));

  const cancel = await postJson(`${base}/api/tasks/${id}/cancel`);
  assert.equal(cancel.status, 200);
  assert.equal((await cancel.json()).status, 'canceled');

  const cancelAgain = await postJson(`${base}/api/tasks/${id}/cancel`);
  assert.equal(cancelAgain.status, 409);
  assert.ok((await cancelAgain.json()).error.includes('canceled'));

  const retry = await postJson(`${base}/api/tasks/${id}/retry`);
  assert.equal(retry.status, 200);
  assert.equal((await retry.json()).status, 'queued');

  const retryAgain = await postJson(`${base}/api/tasks/${id}/retry`); // queued 不能 retry
  assert.equal(retryAgain.status, 409);

  // 不存在的任务：cancel / retry 也是 404
  for (const action of ['cancel', 'retry']) {
    const res = await postJson(`${base}/api/tasks/99/${action}`);
    assert.equal(res.status, 404, action);
  }
});

test('GET /api/tasks 的 status / limit 查询参数：过滤生效，非法值 400 带字段名，空串按未传', async (t) => {
  const { base } = await startServer(t);
  await postJson(`${base}/api/tasks`, { repo: 'a/b', prompt: 'one' });
  await postJson(`${base}/api/tasks`, { repo: 'c/d', prompt: 'two' });

  const queued = await fetch(`${base}/api/tasks?status=queued&limit=1`);
  const queuedTasks = await queued.json();
  assert.equal(queued.status, 200);
  assert.equal(queuedTasks.length, 1);
  assert.equal(queuedTasks[0].status, 'queued');

  const emptyParams = await fetch(`${base}/api/tasks?status=&limit=`);
  assert.equal(emptyParams.status, 200);
  assert.equal((await emptyParams.json()).length, 2);

  const badStatus = await fetch(`${base}/api/tasks?status=bogus`);
  assert.equal(badStatus.status, 400);
  assert.equal((await badStatus.json()).field, 'status');

  const badLimit = await fetch(`${base}/api/tasks?limit=abc`);
  assert.equal(badLimit.status, 400);
  assert.equal((await badLimit.json()).field, 'limit');

  const zeroLimit = await fetch(`${base}/api/tasks?limit=0`);
  assert.equal(zeroLimit.status, 400);
});

// ---------- 运行日志与 SSE ----------

test('验收: /api/runs/:id/log 返回全部行；/stream 重放 3 行 → 追加 2 行收到 2 行 → finishRun 后 2 秒内 done 且连接关闭', async (t) => {
  const { server, db, home, base } = await startServer(t);
  const task = createTask(db, { repo: 'a/b', prompt: 'x' });
  const logPath = path.join(home, 'logs', `task-${task.id}-run-1.log`);
  const run = startRun(db, {
    taskId: task.id, attempt: 1, model: 'glm-5.3', effort: 'low', peak: false, logPath,
  });
  fs.writeFileSync(logPath, '第一行\n第二行\n第三行\n');

  const logRes = await fetch(`${base}/api/runs/${run.id}/log`);
  assert.equal(logRes.status, 200);
  assert.equal(logRes.headers.get('content-type'), 'text/plain; charset=utf-8');
  assert.equal(await logRes.text(), '第一行\n第二行\n第三行\n');

  const controller = new AbortController();
  const streamRes = await fetch(`${base}/api/runs/${run.id}/stream`, { signal: controller.signal });
  assert.equal(streamRes.status, 200);
  assert.ok(streamRes.headers.get('content-type').startsWith('text/event-stream'));
  assert.equal(streamRes.headers.get('cache-control'), 'no-cache');
  const client = new SseClient(streamRes, controller);
  for (const line of ['第一行', '第二行', '第三行']) {
    const event = await client.next();
    assert.equal(event.event, 'log');
    assert.equal(event.data, line);
  }

  fs.appendFileSync(logPath, '第四行\n第五行\n');
  for (const line of ['第四行', '第五行']) {
    const event = await client.next();
    assert.equal(event.event, 'log');
    assert.equal(event.data, line);
  }

  const t0 = Date.now();
  finishRun(db, run.id, { status: 'succeeded' });
  const done = await client.waitFor('done');
  assert.ok(Date.now() - t0 < 2000, 'done 应在 finishRun 后 2 秒内到达');
  assert.equal(JSON.parse(done.data).status, 'succeeded');
  await waitUntil(() => client.closed, { what: 'SSE 连接关闭' });
  assert.equal(server.sseConnections, 0, '连接关闭后计数应回到 0');
});

test('验收: 先打开 /stream 再创建日志文件，也能收到后写入的行；客户端断开后服务端没有残留 watcher', async (t) => {
  const { server, db, home, base } = await startServer(t);
  const task = createTask(db, { repo: 'a/b', prompt: 'x' });
  const logPath = path.join(home, 'logs', `task-${task.id}-run-1.log`);
  const run = startRun(db, {
    taskId: task.id, attempt: 1, model: 'glm-5.3', effort: 'low', peak: false, logPath,
  });
  assert.equal(fs.existsSync(logPath), false, '日志文件尚未创建');

  const controller = new AbortController();
  const streamRes = await fetch(`${base}/api/runs/${run.id}/stream`, { signal: controller.signal });
  const client = new SseClient(streamRes, controller);
  await waitUntil(() => server.sseConnections === 1, { what: 'SSE 连接建立' });

  fs.writeFileSync(logPath, '后写入的一行\n另一行\n');
  for (const line of ['后写入的一行', '另一行']) {
    const event = await client.next();
    assert.equal(event.event, 'log');
    assert.equal(event.data, line);
  }

  client.abort(); // 客户端中途断开
  await waitUntil(() => server.sseConnections === 0, { what: '断开后 SSE 计数回到 0' });
  await waitUntil(
    () => !process.getActiveResourcesInfo().includes('FSWatcher'),
    { what: 'FSWatcher 清理' },
  );
});

test('SSE：log_path 还是空串时等待，路径补写后（#7 的 setRunLogPath 流程）照常跟踪', async (t) => {
  const { server, db, home, base } = await startServer(t);
  const task = createTask(db, { repo: 'a/b', prompt: 'x' });
  const logPath = path.join(home, 'logs', 'late-path.log');
  // 模拟 #7 的 runTask：startRun 先拿 id、随后才补写真实日志路径。
  // 本分支的 startRun 还不接受空串，用 SQL 直接置空（schema 只要求 NOT NULL，'' 合法；
  // rebase 到带 setRunLogPath 的 main 后此测试同样成立）。
  const run = startRun(db, {
    taskId: task.id, attempt: 1, model: 'glm-5.3', effort: 'low', peak: false,
    logPath: '/tmp/placeholder-then-emptied.log',
  });
  db.prepare("UPDATE runs SET log_path = '' WHERE id = ?").run(run.id);

  const controller = new AbortController();
  const streamRes = await fetch(`${base}/api/runs/${run.id}/stream`, { signal: controller.signal });
  const client = new SseClient(streamRes, controller);
  await waitUntil(() => server.sseConnections === 1, { what: 'SSE 连接建立' });
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(client.queue.length, 0, 'log_path 未定时不该发出任何日志事件');

  db.prepare('UPDATE runs SET log_path = ? WHERE id = ?').run(logPath, run.id);
  fs.writeFileSync(logPath, '补写路径后的行\n');
  const event = await client.next();
  assert.equal(event.event, 'log');
  assert.equal(event.data, '补写路径后的行');

  client.abort();
  await waitUntil(() => server.sseConnections === 0, { what: '断开后 SSE 计数回到 0' });
});

test('SSE：多字节 UTF-8 字符跨读取不被劈坏；结束时末尾不完整的一行也发出', async (t) => {
  const { db, home, base } = await startServer(t);
  const task = createTask(db, { repo: 'a/b', prompt: 'x' });
  const logPath = path.join(home, 'logs', `task-${task.id}-run-1.log`);
  const run = startRun(db, {
    taskId: task.id, attempt: 1, model: 'glm-5.3', effort: 'low', peak: false, logPath,
  });
  fs.writeFileSync(logPath, '开头\n');

  const controller = new AbortController();
  const streamRes = await fetch(`${base}/api/runs/${run.id}/stream`, { signal: controller.signal });
  const client = new SseClient(streamRes, controller);
  assert.equal((await client.next()).data, '开头');

  // 「汉」的 UTF-8 三字节拆成两次写入：中间那次 poll 只能读到半截，不能解码输出
  const bytes = Buffer.from('汉');
  fs.appendFileSync(logPath, bytes.subarray(0, 1));
  await new Promise((resolve) => setTimeout(resolve, 800)); // 跨过一个轮询周期
  fs.appendFileSync(logPath, Buffer.concat([bytes.subarray(1), Buffer.from('\n结尾没有换行')]));
  const event = await client.next();
  assert.equal(event.data, '汉');

  finishRun(db, run.id, { status: 'failed' });
  const tail = await client.waitFor('log'); // 末尾不完整的行在 done 前补发
  assert.equal(tail.data, '结尾没有换行');
  const done = await client.waitFor('done');
  assert.equal(JSON.parse(done.data).status, 'failed');
});

test('SSE：run 不存在 → 404 JSON；连接已结束的 run 时立即重放并 done', async (t) => {
  const { db, home, base } = await startServer(t);
  const missing = await fetch(`${base}/api/runs/99/stream`);
  assert.equal(missing.status, 404);
  assert.ok((await missing.json()).error.includes('99'));

  const task = createTask(db, { repo: 'a/b', prompt: 'x' });
  const logPath = path.join(home, 'logs', `task-${task.id}-run-1.log`);
  const run = startRun(db, {
    taskId: task.id, attempt: 1, model: 'glm-5.3', effort: 'low', peak: false, logPath,
  });
  fs.writeFileSync(logPath, '唯一一行\n');
  finishRun(db, run.id, { status: 'timeout' });

  const controller = new AbortController();
  const streamRes = await fetch(`${base}/api/runs/${run.id}/stream`, { signal: controller.signal });
  const client = new SseClient(streamRes, controller);
  assert.equal((await client.next()).data, '唯一一行');
  const done = await client.waitFor('done');
  assert.equal(JSON.parse(done.data).status, 'timeout');
  await waitUntil(() => client.closed, { what: 'SSE 连接关闭' });
  controller.abort();
});

test('GET /api/runs/99/log → 404；run 存在但日志文件缺失 → 404', async (t) => {
  const { db, home, base } = await startServer(t);
  const missing = await fetch(`${base}/api/runs/99/log`);
  assert.equal(missing.status, 404);

  const task = createTask(db, { repo: 'a/b', prompt: 'x' });
  const logPath = path.join(home, 'logs', 'never-created.log');
  const run = startRun(db, {
    taskId: task.id, attempt: 1, model: 'glm-5.3', effort: 'low', peak: false, logPath,
  });
  const res = await fetch(`${base}/api/runs/${run.id}/log`);
  assert.equal(res.status, 404);
  assert.ok((await res.json()).error.length > 0);
});

// ---------- /api/status ----------

test('验收: NIGHT_SHIFT_NOW=2026-10-08T07:00Z 时 /api/status 的 peak.peak 为 true、multipliers[glm-5.3]=3、scheduler 为 null、runningCount 等于库里 running 数', async (t) => {
  const { db, base } = await startServer(t, { env: { NIGHT_SHIFT_NOW: '2026-10-08T07:00:00Z' } });
  createTask(db, { repo: 'a/b', prompt: 'x' });
  createTask(db, { repo: 'c/d', prompt: 'y' });
  createTask(db, { repo: 'e/f', prompt: 'z' });
  claimNextTask(db); // 1 个 running、2 个 queued

  const res = await fetch(`${base}/api/status`);
  assert.equal(res.status, 200);
  const status = await res.json();
  assert.equal(status.now, '2026-10-08T07:00:00.000Z');
  assert.equal(status.peak.peak, true, '北京 15:00 周四，高峰');
  assert.equal(status.peak.multipliers['glm-5.3'], 3);
  assert.equal(status.peak.multipliers['glm-5.3-flash'], 1.2);
  assert.ok(typeof status.peak.nextChange === 'string' && status.peak.nextChange.endsWith('Z'));
  assert.equal(status.scheduler, null);
  assert.equal(status.runningCount, 1);
  assert.equal(status.queuedCount, 2);
  assert.equal(status.plan, 'v2-max');
  assert.ok(status.usage && typeof status.usage === 'object');
  assert.ok(status.usage.fiveHour && status.usage.weekly);
});

test('/api/status：给了 scheduler 时带上它的 status()；用量窗口覆盖 7 天', async (t) => {
  const { db, base } = await startServer(t, {
    env: { NIGHT_SHIFT_NOW: '2026-10-08T12:00:00Z' },
    scheduler: { status: () => ({ running: 1, paused: false }) },
  });
  const task = createTask(db, { repo: 'a/b', prompt: 'x' });
  for (const spec of [
    { model: 'glm-5.3', startedAt: '2026-10-08T07:30:00Z' },
    { model: 'glm-5.3-flash', startedAt: '2026-10-08T08:00:00Z' },
    { model: 'glm-5.3', startedAt: '2026-10-08T11:00:00Z' },
  ]) {
    const run = startRun(db, {
      taskId: task.id, attempt: 1, model: spec.model, effort: 'low', peak: true,
      logPath: '/tmp/none.log',
    });
    db.prepare('UPDATE runs SET started_at = ? WHERE id = ?').run(spec.startedAt, run.id);
    finishRun(db, run.id, { status: 'succeeded' });
  }

  const status = await (await fetch(`${base}/api/status`)).json();
  assert.deepEqual(status.scheduler, { running: 1, paused: false });
  // 与 #4 验收同款窗口：五小时窗口内 3 + 1.2 + 1 = 5.2
  assert.equal(status.usage.fiveHour.used, 5.2);
  assert.equal(status.usage.fiveHour.limit, 1600);
});

// ---------- /api/usage/history ----------

test('验收: #4 那组运行、now=2026-10-08T12:00Z → days=1 返回 24 项，07:00 桶 glm-5.3=3、08:00 桶 flash=1.2；days=0/31 → 400', async (t) => {
  const { db, base } = await startServer(t, { env: { NIGHT_SHIFT_NOW: '2026-10-08T12:00:00Z' } });
  const task = createTask(db, { repo: 'a/b', prompt: 'x' });
  for (const spec of [
    { model: 'glm-5.3', startedAt: '2026-10-08T07:30:00Z' },
    { model: 'glm-5.3-flash', startedAt: '2026-10-08T08:00:00Z' },
    { model: 'glm-5.3', startedAt: '2026-10-08T11:00:00Z' },
    { model: 'glm-5.3', startedAt: '2026-10-08T06:30:00Z' },
  ]) {
    const run = startRun(db, {
      taskId: task.id, attempt: 1, model: spec.model, effort: 'low', peak: true,
      logPath: '/tmp/none.log',
    });
    db.prepare('UPDATE runs SET started_at = ? WHERE id = ?').run(spec.startedAt, run.id);
    finishRun(db, run.id, { status: 'succeeded' });
  }

  const res = await fetch(`${base}/api/usage/history?days=1`);
  assert.equal(res.status, 200);
  const history = await res.json();
  assert.equal(history.buckets.length, 24);
  assert.equal(history.from, '2026-10-07T13:00:00.000Z');
  assert.equal(history.to, '2026-10-08T12:00:00.000Z');
  const at07 = history.buckets.find((b) => b.hour === '2026-10-08T07:00:00.000Z');
  assert.equal(at07.byModel['glm-5.3'], 3);
  const at08 = history.buckets.find((b) => b.hour === '2026-10-08T08:00:00.000Z');
  assert.equal(at08.byModel['glm-5.3-flash'], 1.2);

  for (const bad of ['0', '31', 'abc', '1.5', '-1']) {
    const badRes = await fetch(`${base}/api/usage/history?days=${bad}`);
    assert.equal(badRes.status, 400, `days=${bad}`);
    const body = await badRes.json();
    assert.equal(body.field, 'days', `days=${bad}`);
  }

  const def = await fetch(`${base}/api/usage/history`);
  assert.equal(def.status, 200);
  assert.equal((await def.json()).buckets.length, 7 * 24, '缺省 days=7');
});

// ---------- 静态文件与通用防护 ----------

test('验收: GET / 返回 web/index.html（text/html），/style.css 为 text/css；/../package.json 与 /%2e%2e/package.json 返回 404', async (t) => {
  const { base } = await startServer(t);

  const home = await fetch(`${base}/`);
  assert.equal(home.status, 200);
  assert.ok(home.headers.get('content-type').startsWith('text/html'));
  const html = await home.text();
  assert.ok(html.includes('/queue.js'), '队列页（#15）加载 queue.js');
  assert.ok(html.includes('/style.css'), '引用公共样式');

  const css = await fetch(`${base}/style.css`);
  assert.equal(css.status, 200);
  assert.ok(css.headers.get('content-type').startsWith('text/css'));
  assert.ok((await css.text()).includes('.badge-queued'));

  const js = await fetch(`${base}/common.js`);
  assert.equal(js.status, 200);
  assert.ok(js.headers.get('content-type').startsWith('text/javascript'));

  // fetch 会先归一化 /../ 与 %2e%2e，用原始请求打过去才能测到服务端的路径解析
  for (const raw of ['/../package.json', '/%2e%2e/package.json', '/..%5Cpackage.json', '/%5Cpackage.json', '/%00package.json', '/xxx/../../package.json']) {
    const res = await rawRequest(base, raw);
    assert.equal(res.status, 404, raw);
  }
  const leaked = await rawRequest(base, '/../package.json');
  assert.ok(!leaked.text.includes('"name"'), '不能泄漏 package.json 内容');

  const missing = await fetch(`${base}/no-such-page.html`);
  assert.equal(missing.status, 404);
  const dir = await fetch(`${base}/logs`); // web/ 下没有这个目录
  assert.equal(dir.status, 404);
});

test('验收: 未知 /api/xxx 返回 404 JSON；DELETE /api/tasks 返回 405', async (t) => {
  const { base } = await startServer(t);
  const unknown = await fetch(`${base}/api/xxx`);
  assert.equal(unknown.status, 404);
  assert.ok(unknown.headers.get('content-type').includes('application/json'));
  assert.ok(typeof (await unknown.json()).error === 'string');

  const deleted = await fetch(`${base}/api/tasks`, { method: 'DELETE' });
  assert.equal(deleted.status, 405);
  assert.ok((deleted.headers.get('allow') ?? '').includes('GET'));
  assert.ok((deleted.headers.get('allow') ?? '').includes('POST'));

  const patched = await fetch(`${base}/api/status`, { method: 'PATCH' });
  assert.equal(patched.status, 405);

  const apiPath = await fetch(`${base}/api/tasks/abc`); // 非数字 id → 没有这个资源
  assert.equal(apiPath.status, 404);

  const staticPost = await fetch(`${base}/style.css`, { method: 'POST' });
  assert.equal(staticPost.status, 405);
});

test('验收: 请求体超过 1MB → 413（停止读取，不无限缓冲）', async (t) => {
  const { base } = await startServer(t);
  const res = await postJson(`${base}/api/tasks`, {
    repo: 'a/b',
    prompt: 'x'.repeat(2 * 1024 * 1024), // 2MB
  });
  assert.equal(res.status, 413);
  const body = await res.json();
  assert.ok(body.error.includes('上限') || body.error.includes('MB'));
});

test('HEAD / 静态文件：200、内容类型正确、无响应体（加分项）', async (t) => {
  const { base } = await startServer(t);
  const res = await fetch(`${base}/`, { method: 'HEAD' });
  assert.equal(res.status, 200);
  assert.ok(res.headers.get('content-type').startsWith('text/html'));
  assert.equal(await res.text(), '');
});

test('createServer 参数校验：缺 db / 缺 config 抛错', async () => {
  assert.throws(() => createServer({ config: {} }), /db/);
  assert.throws(() => createServer({ db: {} }), /config/);
});
