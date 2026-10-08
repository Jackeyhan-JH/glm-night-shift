// web/task.js + web/task.html 的测试（issue #16 验收项）。
//
// 思路：task.js 把 document / location / EventSource / 定时器都做成 createPage 的
// 可注入依赖，这里用最小 DOM 桩驱动**页面本身的真实代码**，后端用 createServer 起
// 真 HTTP 服务（与 serve-api 同一条代码路径；CLI 参数解析另有 test/cli-serve.test.js
// 覆盖），fetch 临时包一层基地址——页面里的相对路径请求（'/api/tasks/1'）原样发出。
// SSE 用 FetchEventSource：它实现 EventSource 的页面侧接口，底下用 fetch 读真服务的
// /api/runs/:id/stream 流，事件解析后回调页面监听器。
//
// 安全断言：桩元素记录 innerHTML 赋值，测试验证除静态导航外全页没有第二处 innerHTML，
// 且恶意 HTML 只进 textContent（不产生 img / script 元素）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { systemClock } from '../src/clock.js';
import { openDb } from '../src/db.js';
import { createServer } from '../src/server.js';
import {
  claimTaskById,
  createTask,
  finishRun,
  finishTask,
  startRun,
} from '../src/tasks.js';
import {
  canFollow,
  createPage,
  difficultyLabel,
  firstErrorLine,
  kindLabel,
  parseTaskId,
  runStatusLabel,
  waitingOnRepo,
  whyNotClaimed,
} from '../web/task.js';
import { fmtTime } from '../web/common.js';
import { makeTempHome } from './helpers.js';

// ---------- DOM 桩 ----------

/** 覆盖 task.js 用到的最小 DOM 面：createElement / appendChild / textContent /
 * className / setAttribute / addEventListener(+dispatch) / remove / style / 滚动几何。 */
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

  /** 测试侧触发事件（浏览器的 click / scroll）。 */
  dispatch(type, event = { type }) {
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn(event);
  }
}

/** task.html 里有 #nav 与 #app 两个容器；桩文档按 id 惰性建节点。 */
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

function findByClass(root, className) {
  return findAll(root, (n) => typeof n.className === 'string' && n.className.split(/\s+/).includes(className));
}

// ---------- 可控定时器与 EventSource 桩 ----------

/** 定时器桩：不真等 3/5 秒，测试手动 tick；也能断言有没有漏清的定时器。 */
function fakeTimers() {
  const intervals = new Map();
  const timeouts = new Map();
  let next = 1;
  return {
    setInterval(fn) {
      const id = next++;
      intervals.set(id, fn);
      return id;
    },
    clearInterval(id) { intervals.delete(id); },
    setTimeout(fn) {
      const id = next++;
      timeouts.set(id, fn);
      return id;
    },
    clearTimeout(id) { timeouts.delete(id); },
    tickIntervals() { for (const fn of [...intervals.values()]) fn(); },
    fireTimeouts() {
      for (const fn of [...timeouts.values()]) fn();
      timeouts.clear();
    },
    get intervalCount() { return intervals.size; },
    get timeoutCount() { return timeouts.size; },
  };
}

/** 打开过的 FetchEventSource 实例（断言 URL / 是否 close 用）。 */
const esInstances = [];

/** 用 fetch 读真 SSE 流的 EventSource 桩：按空行切块，event:/data: 解析后同步回调。 */
class FetchEventSource {
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.closed = false;
    this.controller = new AbortController();
    this.listeners = new Map();
    esInstances.push(this);
    this.#pump().catch(() => {
      if (!this.closed) this.#emit('error', '');
    });
  }

  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.readyState = 2;
    this.controller.abort();
  }

  #emit(type, data) {
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn({ type, data });
  }

  async #pump() {
    const res = await fetch(this.url, {
      signal: this.controller.signal,
      headers: { accept: 'text/event-stream' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    this.readyState = 1;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let sep;
      while ((sep = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const ev = parseSseBlock(block);
        if (ev !== null) this.#emit(ev.event, ev.data);
      }
    }
  }
}

function parseSseBlock(raw) {
  let event = 'message';
  const dataLines = [];
  for (const line of raw.split('\n')) {
    if (line.startsWith(':')) continue; // ping 注释行
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
  }
  return dataLines.length === 0 ? null : { event, data: dataLines.join('\n') };
}

/** 构造「一连上就报错」的 EventSource 桩（测断线重连路径）。 */
function makeBrokenEs() {
  const created = [];
  class BrokenEventSource {
    constructor(url) {
      this.url = url;
      this.closed = false;
      this.listeners = new Map();
      created.push(this);
      const self = this;
      Promise.resolve().then(() => self.#emit('error', 'boom'));
    }

    addEventListener(type, fn) {
      if (!this.listeners.has(type)) this.listeners.set(type, []);
      this.listeners.get(type).push(fn);
    }

    close() { this.closed = true; }

    #emit(type, data) {
      for (const fn of [...(this.listeners.get(type) ?? [])]) fn({ type, data });
    }
  }
  return { BrokenEventSource, created };
}

// ---------- 服务与页面装配 ----------

function startServer(t) {
  const home = makeTempHome(t);
  fs.mkdirSync(path.join(home, 'logs'), { recursive: true });
  const db = openDb(path.join(home, 'night-shift.db'));
  const config = loadConfig({ home, env: {} });
  const server = createServer({ db, config, home, clock: systemClock({}) });
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

/** 把全局 fetch 包上基地址（页面的相对路径请求可直接打真服务），并记录请求清单。 */
function installFetch(base) {
  const real = globalThis.fetch;
  const calls = [];
  globalThis.fetch = (input, init) => {
    const url = typeof input === 'string' ? new URL(input, base) : input;
    calls.push(`${init?.method ?? 'GET'} ${url.pathname}${url.search}`);
    return real(url, init);
  };
  return { restore: () => { globalThis.fetch = real; }, calls };
}

/** 起一个真页面：桩 DOM + 桩定时器 + 真 HTTP 服务。t.after 统一收尾。 */
function makePage(t, base, search, { EventSource = FetchEventSource } = {}) {
  const doc = makeStubDoc();
  const timers = fakeTimers();
  esInstances.length = 0;
  const wrapped = installFetch(base);
  const page = createPage({
    doc,
    location: { search },
    EventSource,
    timers,
  }).init();
  t.after(() => {
    page.destroy();
    wrapped.restore();
  });
  return { page, doc, timers, calls: wrapped.calls };
}

function writeLogFile(home, name, lines) {
  const file = path.join(home, 'logs', name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
  return file;
}

async function waitUntil(predicate, { timeoutMs = 5000, stepMs = 25, what = '条件' } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return;
    if (Date.now() > deadline) throw new Error(`等待${what}超时（${timeoutMs}ms）`);
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
}

/** 造一个已成功结束的任务 + 一次带日志的运行；返回 { task, run, logPath }。 */
function seedFinishedRun(db, home, { logLines, finish = {} } = {}) {
  const task = createTask(db, { repo: 'a/b', prompt: '做点事' });
  claimTaskById(db, task.id);
  const logPath = writeLogFile(home, `task-${task.id}-run-1.log`, logLines ?? ['[stdout] done']);
  const run = startRun(db, {
    taskId: task.id, attempt: 1, model: 'glm-5.3', effort: 'high', peak: true, logPath,
  });
  finishRun(db, run.id, { status: 'succeeded', ...finish });
  return { task, run, logPath };
}

// ---------- 纯函数 ----------

test('runStatusLabel：runs 的五个状态（含 timeout→超时）；未知原样', () => {
  assert.equal(runStatusLabel('running'), '执行中');
  assert.equal(runStatusLabel('succeeded'), '成功');
  assert.equal(runStatusLabel('failed'), '失败');
  assert.equal(runStatusLabel('timeout'), '超时');
  assert.equal(runStatusLabel('canceled'), '已取消');
  assert.equal(runStatusLabel('weird'), 'weird');
});

test('kindLabel：task→执行、diagnosis→诊断、旧数据（无 kind）→null、未知原样', () => {
  assert.equal(kindLabel('task'), '执行');
  assert.equal(kindLabel('diagnosis'), '诊断');
  assert.equal(kindLabel(undefined), null);
  assert.equal(kindLabel(null), null);
  assert.equal(kindLabel(''), null);
  assert.equal(kindLabel('future-kind'), 'future-kind');
});

test('difficultyLabel / firstErrorLine / parseTaskId', () => {
  assert.equal(difficultyLabel('easy'), '简单');
  assert.equal(difficultyLabel('medium'), '中等');
  assert.equal(difficultyLabel('hard'), '困难');
  assert.equal(difficultyLabel('???'), '???');

  assert.equal(firstErrorLine('第一行\n第二行\n第三行'), '第一行');
  assert.equal(firstErrorLine('单行'), '单行');
  assert.equal(firstErrorLine(null), '');
  assert.equal(firstErrorLine(''), '');

  assert.equal(parseTaskId('?id=42'), 42);
  assert.equal(parseTaskId('?id=0'), null);
  assert.equal(parseTaskId('?id=-3'), null);
  assert.equal(parseTaskId('?id=abc'), null);
  assert.equal(parseTaskId(''), null);
  assert.equal(parseTaskId('?other=1'), null);
});

// ---------- whyNotClaimed（#66：排队任务为什么还没被领） ----------

/** 最小可用的 /api/status 形状（这行只读顶层 userPaused 和 scheduler.blocked）。 */
function statusBody(overrides = {}) {
  return {
    userPaused: false,
    scheduler: { blocked: null, userPaused: false },
    ...overrides,
  };
}

const QUEUED_TASK = { status: 'queued', allowPeak: false };

test('验收: whyNotClaimed：scheduler === null →「调度器没在跑」，userPaused 也压不过它（顺序 3 在 4 之前）', () => {
  assert.equal(whyNotClaimed({ scheduler: null, userPaused: true }, QUEUED_TASK), '调度器没在跑');
  // 顶层夹一个 blocked 也不看：blocked 只认 scheduler.blocked
  assert.equal(
    whyNotClaimed(
      { scheduler: null, userPaused: true, blocked: { reason: 'five-hour' } },
      QUEUED_TASK,
    ),
    '调度器没在跑',
  );
});

test('验收: whyNotClaimed：顶层 userPaused === true 且 blocked five-hour → 只「已暂停领任务」，不含「额度」', () => {
  const out = whyNotClaimed(statusBody({
    userPaused: true,
    scheduler: { blocked: { reason: 'five-hour', retryAt: '2026-10-08T09:00:00.000Z' }, userPaused: false },
  }), QUEUED_TASK);
  assert.equal(out, '已暂停领任务');
  assert.ok(!out.includes('额度'), '暂停时 blocked 是上一轮留下的，不显示');
});

test('验收: whyNotClaimed：不读 scheduler.userPaused——顶层 false、scheduler.userPaused true、blocked null → \'\'', () => {
  assert.equal(whyNotClaimed(statusBody({
    scheduler: { blocked: null, userPaused: true },
  }), QUEUED_TASK), '');
});

test('验收: whyNotClaimed：five-hour 带 retryAt → 句子 +「；预计 fmtTime(retryAt) 恢复」', () => {
  const retryAt = '2026-10-08T09:05:00.000Z';
  const out = whyNotClaimed(statusBody({
    scheduler: { blocked: { reason: 'five-hour', retryAt }, userPaused: false },
  }), QUEUED_TASK);
  assert.ok(out.includes('5 小时额度已达安全阈值'));
  assert.equal(out, `5 小时额度已达安全阈值；预计 ${fmtTime(retryAt)} 恢复`);
});

test('验收: whyNotClaimed：five-hour 无 retryAt → 正好一句，不含「预计」', () => {
  const out = whyNotClaimed(statusBody({
    scheduler: { blocked: { reason: 'five-hour' }, userPaused: false },
  }), QUEUED_TASK);
  assert.equal(out, '5 小时额度已达安全阈值');
  assert.ok(!out.includes('预计'));
  // retryAt 为 null 同样不接这半句
  assert.equal(whyNotClaimed(statusBody({
    scheduler: { blocked: { reason: 'five-hour', retryAt: null }, userPaused: false },
  }), QUEUED_TASK), '5 小时额度已达安全阈值');
});

test('验收: whyNotClaimed：weekly 带 retryAt →「每周额度已达安全阈值」加恢复后缀；非法 retryAt 不接', () => {
  const retryAt = '2026-10-12T23:00:00.000Z';
  assert.equal(whyNotClaimed(statusBody({
    scheduler: { blocked: { reason: 'weekly', retryAt }, userPaused: false },
  }), QUEUED_TASK), `每周额度已达安全阈值；预计 ${fmtTime(retryAt)} 恢复`);
  // fmtTime 得 '-'（非法时间）：只留句子，不写「预计 - 恢复」
  assert.equal(whyNotClaimed(statusBody({
    scheduler: { blocked: { reason: 'weekly', retryAt: 'not-a-date' }, userPaused: false },
  }), QUEUED_TASK), '每周额度已达安全阈值');
});

test('验收: whyNotClaimed：rate-limit 带 retryAt →「触发限流，全局退避中」加同样后缀', () => {
  const retryAt = '2026-10-08T08:30:00.000Z';
  assert.equal(whyNotClaimed(statusBody({
    scheduler: { blocked: { reason: 'rate-limit', retryAt }, userPaused: false },
  }), QUEUED_TASK), `触发限流，全局退避中；预计 ${fmtTime(retryAt)} 恢复`);
});

test('验收: whyNotClaimed：peak 且 allowPeak false →「高峰期，暂不领新任务」', () => {
  assert.equal(whyNotClaimed(statusBody({
    scheduler: { blocked: { reason: 'peak', retryAt: '2026-10-08T13:00:00.000Z' }, userPaused: false },
  }), QUEUED_TASK), `高峰期，暂不领新任务；预计 ${fmtTime('2026-10-08T13:00:00.000Z')} 恢复`);
  assert.equal(whyNotClaimed(statusBody({
    scheduler: { blocked: { reason: 'peak' }, userPaused: false },
  }), { status: 'queued', allowPeak: false }), '高峰期，暂不领新任务');
});

test('验收: whyNotClaimed：peak 且 allowPeak === true → \'\'（这条允许高峰，整行不出现）', () => {
  assert.equal(whyNotClaimed(statusBody({
    scheduler: { blocked: { reason: 'peak' }, userPaused: false },
  }), { status: 'queued', allowPeak: true }), '');
});

test('验收: whyNotClaimed：scheduler 是对象、blocked null、未暂停、queued → \'\'', () => {
  assert.equal(whyNotClaimed(statusBody(), QUEUED_TASK), '');
});

test('验收: whyNotClaimed：task.status running（哪怕 scheduler null）→ \'\'；statusBody null → \'\'', () => {
  assert.equal(whyNotClaimed({ scheduler: null }, { status: 'running', allowPeak: false }), '');
  assert.equal(whyNotClaimed(null, QUEUED_TASK), '');
});

test('验收: whyNotClaimed：不改入参（深拷贝对照）', () => {
  const body = statusBody({
    scheduler: { blocked: { reason: 'peak', retryAt: '2026-10-08T10:00:00.000Z' }, userPaused: false },
  });
  const task = { status: 'queued', allowPeak: false };
  const bodyCopy = structuredClone(body);
  const taskCopy = structuredClone(task);
  whyNotClaimed(body, task);
  assert.deepEqual(body, bodyCopy);
  assert.deepEqual(task, taskCopy);
});

// ---------- waitingOnRepo（#88：排队任务在等同仓库的 running） ----------

/** waitingOnRepo 的最小输入面：config 只读 oneTaskPerRepo，task 只读 id/status/repo。 */
function repoConfig(overrides = {}) {
  return { oneTaskPerRepo: true, ...overrides };
}

/** 排队中的当前任务（id 1、仓库 a/b）。 */
const REPO_TASK = { id: 1, status: 'queued', repo: 'a/b' };

/** running 列表里的一条（缺省：另一条任务、同仓库、在跑）。 */
function runningTask(overrides = {}) {
  return { id: 2, status: 'running', repo: 'a/b', ...overrides };
}

test('验收: waitingOnRepo：queued + oneTaskPerRepo true + 另一条 id 不同、status running、repo 全等 → \'等这个仓库\'', () => {
  assert.equal(waitingOnRepo(repoConfig(), REPO_TASK, [runningTask()]), '等这个仓库');
  // 列表里混着别的仓库 / 别的状态：只要有一条命中就算
  assert.equal(waitingOnRepo(repoConfig(), REPO_TASK, [
    { id: 3, status: 'running', repo: 'c/d' },
    runningTask(),
    { id: 4, status: 'queued', repo: 'a/b' },
  ]), '等这个仓库');
  // id 用 !== 全等：另一条 id 是字符串 '1'（与数字 1 不同）也算另一条
  assert.equal(waitingOnRepo(repoConfig(), REPO_TASK, [runningTask({ id: '1' })]), '等这个仓库');
});

test('验收: waitingOnRepo：不改入参（深拷贝对照）', () => {
  const config = repoConfig();
  const task = structuredClone(REPO_TASK);
  const running = [runningTask(), { id: 3, status: 'queued', repo: 'c/d' }];
  const configCopy = structuredClone(config);
  const taskCopy = structuredClone(task);
  const runningCopy = structuredClone(running);
  waitingOnRepo(config, task, running);
  assert.deepEqual(config, configCopy);
  assert.deepEqual(task, taskCopy);
  assert.deepEqual(running, runningCopy);
});

test('验收: waitingOnRepo：oneTaskPerRepo 为 false / 缺字段 / "true" / 1 / config null / undefined → \'\'', () => {
  const running = [runningTask()];
  assert.equal(waitingOnRepo(repoConfig({ oneTaskPerRepo: false }), REPO_TASK, running), '');
  const missing = repoConfig();
  delete missing.oneTaskPerRepo;
  assert.equal(waitingOnRepo(missing, REPO_TASK, running), '', '缺字段');
  assert.equal(waitingOnRepo(repoConfig({ oneTaskPerRepo: 'true' }), REPO_TASK, running), '', '字符串 "true" 不算');
  assert.equal(waitingOnRepo(repoConfig({ oneTaskPerRepo: 1 }), REPO_TASK, running), '', '数字 1 不算');
  assert.equal(waitingOnRepo(null, REPO_TASK, running), '', 'config null（请求失败）');
  assert.equal(waitingOnRepo(undefined, REPO_TASK, running), '', 'config undefined');
});

test('验收: waitingOnRepo：running 列表不是数组（null / 对象 / 缺字段）、空数组 → \'\'', () => {
  const config = repoConfig();
  assert.equal(waitingOnRepo(config, REPO_TASK, null), '', '请求失败得 null');
  assert.equal(waitingOnRepo(config, REPO_TASK, { tasks: [runningTask()] }), '', '响应体是对象');
  assert.equal(waitingOnRepo(config, REPO_TASK, undefined), '', '缺字段');
  assert.equal(waitingOnRepo(config, REPO_TASK, []), '', '空数组：没有另一条');
});

test('验收: waitingOnRepo：只有别的仓库、repo 只差大小写、repo 只差首尾空格、当前任务 repo 非字符串 → \'\'', () => {
  const config = repoConfig();
  assert.equal(waitingOnRepo(config, REPO_TASK, [runningTask({ repo: 'c/d' })]), '', '别的仓库');
  assert.equal(waitingOnRepo(config, REPO_TASK, [runningTask({ repo: 'A/B' })]), '', '大小写不同不算同一个仓库');
  assert.equal(waitingOnRepo(config, REPO_TASK, [runningTask({ repo: 'a/b ' })]), '', '末尾多空格不算');
  assert.equal(waitingOnRepo(config, REPO_TASK, [runningTask({ repo: ' a/b' })]), '', '开头多空格不算');
  assert.equal(waitingOnRepo(config, { id: 1, status: 'queued', repo: null }, [runningTask()]), '', '当前任务 repo 不是字符串');
  assert.equal(waitingOnRepo(config, { id: 1, status: 'queued' }, [runningTask()]), '', '当前任务缺 repo 字段');
});

test('验收: waitingOnRepo：同仓库另一条 status 是 queued（不是 running）→ \'\'', () => {
  assert.equal(waitingOnRepo(repoConfig(), REPO_TASK, [runningTask({ status: 'queued' })]), '');
  assert.equal(waitingOnRepo(repoConfig(), REPO_TASK, [runningTask({ status: 'succeeded' })]), '');
  const noStatus = runningTask();
  delete noStatus.status;
  assert.equal(waitingOnRepo(repoConfig(), REPO_TASK, [noStatus]), '', '缺 status 字段');
});

test('验收: waitingOnRepo：列表里只有自己的 id → \'\'', () => {
  assert.equal(waitingOnRepo(repoConfig(), REPO_TASK, [runningTask({ id: 1 })]), '');
  // 自己在跑、又排了一条：当前这条才是 running，另一条（自己视角的「另一条」）不存在
  assert.equal(waitingOnRepo(repoConfig(), REPO_TASK, [runningTask({ id: 1 }), runningTask({ id: 3, repo: 'c/d' })]), '');
});

test('验收: waitingOnRepo：task.status 不是 queued（running / 终态 / 缺）→ \'\'', () => {
  const config = repoConfig();
  const running = [runningTask()];
  for (const status of ['running', 'succeeded', 'failed', 'canceled']) {
    assert.equal(waitingOnRepo(config, { ...REPO_TASK, status }, running), '', status);
  }
  const noStatus = { ...REPO_TASK };
  delete noStatus.status;
  assert.equal(waitingOnRepo(config, noStatus, running), '', '缺 status');
  assert.equal(waitingOnRepo(config, null, running), '', 'task null 也不炸');
});

// ---------- 页面 ----------

test('验收: 成功任务的详情页：PR 链接（新标签页）、运行列表含模型/耗时/额度/轮数、日志内容可见', async (t) => {
  const { db, home, base } = await startServer(t);
  const { task, run } = seedFinishedRun(db, home, {
    logLines: [
      '2026-10-08T07:00:00.000Z [meta] 开始 model=glm-5.3 effort=high',
      '2026-10-08T07:00:01.000Z [stdout] {"type":"assistant","message":{"content":[{"type":"text","text":"done"}]}}',
    ],
  });
  db.prepare('UPDATE runs SET duration_ms = 42000, quota_units = 3, num_turns = 7 WHERE id = ?').run(run.id);
  finishTask(db, task.id, {
    status: 'succeeded', prUrl: 'https://github.com/a/b/pull/7', branch: 'task/1-login',
  });

  const { page, doc } = makePage(t, base, `?id=${task.id}`);
  await page.busy;
  const app = doc.getElementById('app');

  // PR 链接：新标签页打开
  const prLinks = findAll(app, (n) => n.tagName === 'A' && n.getAttribute('href') === 'https://github.com/a/b/pull/7');
  assert.equal(prLinks.length, 1);
  assert.equal(prLinks[0].getAttribute('target'), '_blank');

  // 运行列表：模型 / 耗时 / 额度 / 轮数 / 状态徽章
  const text = app.textContent;
  assert.ok(text.includes('glm-5.3'));
  assert.ok(text.includes('42 秒'), `耗时，实际页面文本：${text}`);
  assert.ok(text.includes('3.0'), '额度保留 1 位小数');
  const row = page.refs.runsTBody.children[0];
  assert.equal(row.children[9].textContent, '7', '轮数');
  assert.equal(row.children[5].textContent, '成功', '运行状态徽章');

  // 默认选中最新（唯一）一次运行：日志区可见内容，行按流着色
  const logView = page.refs.logView;
  assert.ok(logView.textContent.includes('[meta] 开始 model=glm-5.3 effort=high'));
  assert.ok(logView.textContent.includes('{"type":"assistant"'));
  assert.equal(findByClass(logView, 'log-meta').length, 1);
  assert.equal(findByClass(logView, 'log-stdout').length, 1);
  // 「原始日志」链接指向该次运行
  assert.equal(page.refs.rawLogLink.getAttribute('href'), `/api/runs/${run.id}/log`);
});

test('验收: prompt 与日志里写 <img src=x onerror=alert(1)>：原样显示为文本、不插入 img 元素、innerHTML 只有静态导航', async (t) => {
  const { db, home, base } = await startServer(t);
  const evil = '<img src=x onerror=alert(1)>';
  const task = createTask(db, {
    repo: 'a/b',
    prompt: `${evil}\n第二行<script>alert(2)</script>`,
    title: `标题 ${evil}`,
  });
  claimTaskById(db, task.id);
  const logPath = writeLogFile(home, `task-${task.id}-run-1.log`, [
    `2026-10-08T07:00:00.000Z [stdout] 输出 ${evil}`,
    '2026-10-08T07:00:01.000Z [stderr] 错误 <script>alert(3)</script>',
  ]);
  const run = startRun(db, {
    taskId: task.id, attempt: 1, model: 'glm-5.3', effort: 'low', peak: false, logPath,
  });
  finishRun(db, run.id, { status: 'succeeded' });
  // prUrl 是库里的数据：伪协议不能进 <a href>（点了会执行），只按文本显示
  finishTask(db, task.id, { status: 'succeeded', prUrl: 'javascript:alert(9)' });

  const { page, doc } = makePage(t, base, `?id=${task.id}`);
  await page.busy;
  const app = doc.getElementById('app');
  const text = app.textContent;

  // 这串文字原样出现（标题 + 提示词 + 日志），没有被当 HTML 解析
  assert.ok((text.match(/<img src=x onerror=alert\(1\)>/g) ?? []).length >= 3, text);
  assert.ok(text.includes('<script>alert(2)</script>'));
  assert.ok(text.includes('javascript:alert(9)'), '伪协议 prUrl 按文本原样显示');
  // 没有真的 img / script 元素，也没有挂伪协议的链接
  assert.equal(findByTag(app, 'img').length, 0);
  assert.equal(findByTag(app, 'script').length, 0);
  assert.equal(findAll(app, (n) => n.tagName === 'A' && n.getAttribute('href').startsWith('javascript:')).length, 0);
  // 全页只有导航（navHtml 静态串）用过 innerHTML，其余一律 textContent
  const htmlUsers = [...findAll(doc.getElementById('nav'), (n) => n._innerHTML !== ''),
    ...findAll(app, (n) => n._innerHTML !== '')];
  assert.equal(htmlUsers.length, 1);
  assert.equal(htmlUsers[0], doc.getElementById('nav'));
  // 提示词全文保留换行、按文本插入
  assert.equal(page.refs.promptBody.textContent, `${evil}\n第二行<script>alert(2)</script>`);
});

test('验收: 正在运行的任务：SSE 逐行出现（共 10 行）、结束后状态徽章更新、EventSource 已关闭', async (t) => {
  const { server, db, home, base } = await startServer(t);
  const task = createTask(db, { repo: 'a/b', prompt: 'x' });
  claimTaskById(db, task.id);
  const logPath = path.join(home, 'logs', `task-${task.id}-run-1.log`);
  fs.writeFileSync(logPath, '');
  const run = startRun(db, {
    taskId: task.id, attempt: 1, model: 'glm-5.3', effort: 'low', peak: false, logPath,
  });

  const { page } = makePage(t, base, `?id=${task.id}`);
  await page.busy; // 默认选中 running 运行 → 打开 SSE

  assert.equal(esInstances.length, 1);
  assert.equal(esInstances[0].url, `/api/runs/${run.id}/stream`);
  const lineCount = () => page.refs.logView.children.length;

  // 规格的手工验收是每 300ms 一行共 10 行；自动化里压缩间隔，行为完全一致
  const expected = [];
  for (let i = 1; i <= 10; i++) {
    const line = `2026-10-08T07:00:00.000Z [stdout] 第 ${i} 行`;
    expected.push(line);
    fs.appendFileSync(logPath, `${line}\n`);
    await waitUntil(() => lineCount() >= i, { what: `第 ${i} 行逐行出现` });
  }
  // 直播期间页面没有整页刷新：任务仍是执行中
  assert.equal(page.refs.headBadge.textContent, '执行中');

  finishRun(db, run.id, { status: 'succeeded' });
  finishTask(db, task.id, { status: 'succeeded', prUrl: 'https://github.com/a/b/pull/8' });
  await waitUntil(() => esInstances[0].closed, { what: 'done 后 EventSource 关闭' });
  await page.busy; // done 触发的任务信息刷新

  assert.equal(page.refs.headBadge.textContent, '成功', '状态徽章更新');
  assert.deepEqual(page.refs.logView.children.map((c) => c.textContent), expected);
  assert.equal(page.refs.runsTBody.children[0].children[5].textContent, '成功');
  await waitUntil(() => server.sseConnections === 0, { what: '服务端连接计数回到 0' });
});

test('验收: 有 diagnosis 的运行能展开看到诊断全文；默认 kind=task 的运行页面不报错', async (t) => {
  const { db, home, base } = await startServer(t);
  // #12 已在 main：迁移版本 4 自带 runs.kind（NOT NULL DEFAULT 'task'）和 diagnosis。
  // 不再 ALTER。未指定 kind 的运行是 task；缺 kind 的空单元格由 kindLabel 单测覆盖。

  const task = createTask(db, { repo: 'a/b', prompt: 'x' });
  claimTaskById(db, task.id);
  const run1 = startRun(db, {
    taskId: task.id, attempt: 1, model: 'glm-5.3', effort: 'high', peak: false,
    logPath: writeLogFile(home, 'r1.log', ['[stdout] 失败输出']),
  });
  finishRun(db, run1.id, { status: 'failed', error: '测试失败\n第二行细节' });
  db.prepare("UPDATE runs SET kind = 'task', diagnosis = ? WHERE id = ?")
    .run('原因：缺少依赖\n建议：先安装依赖', run1.id);
  const run2 = startRun(db, {
    taskId: task.id, attempt: 1, model: 'glm-5.3-flash', effort: 'low', peak: false,
    logPath: writeLogFile(home, 'r2.log', ['[stdout] 诊断输出']),
  });
  finishRun(db, run2.id, { status: 'succeeded' });
  db.prepare("UPDATE runs SET kind = 'diagnosis' WHERE id = ?").run(run2.id);
  const run3 = startRun(db, {
    taskId: task.id, attempt: 2, model: 'glm-5.3', effort: 'low', peak: false,
    logPath: writeLogFile(home, 'r3.log', ['[stdout] 旧数据']),
  });
  finishRun(db, run3.id, { status: 'succeeded' });
  finishTask(db, task.id, { status: 'succeeded' });

  const { page, doc } = makePage(t, base, `?id=${task.id}`);
  await page.busy;

  // 运行列表新到旧：run3（默认 task）、run2（诊断）、run1（执行 + 诊断全文）
  const rows = page.refs.runsTBody.children.filter((n) => n.className.includes('run-row'));
  assert.equal(rows.length, 3);
  const kindCell = (row) => row.children[1].textContent;
  assert.equal(kindCell(rows[0]), '执行', '未指定 kind 时默认 task，页面显示「执行」且不报错');
  assert.equal(kindCell(rows[1]), '诊断');
  assert.equal(kindCell(rows[2]), '执行');

  // 诊断全文：可展开的 <details>，多行原样保留
  const bodies = findByClass(doc.getElementById('app'), 'diag-body');
  assert.equal(bodies.length, 1, '只有 run1 带 diagnosis');
  assert.equal(bodies[0].textContent, '原因：缺少依赖\n建议：先安装依赖');
  const fold = bodies[0].parentNode; // <details>
  assert.equal(fold.tagName, 'DETAILS');
  assert.equal(fold.children[0].tagName, 'SUMMARY');

  // 错误列只显示第一行
  assert.equal(rows[2].children[10].textContent, '测试失败');
});

test('验收: task.html?id=999 显示「任务 #999 不存在」并带返回首页链接', async (t) => {
  const { base } = await startServer(t);
  const { page, doc } = makePage(t, base, '?id=999');
  await page.busy;
  const app = doc.getElementById('app');
  assert.ok(app.textContent.includes('任务 #999 不存在'), app.textContent);
  const home = findByTag(app, 'a').filter((a) => a.getAttribute('href') === '/');
  assert.equal(home.length, 1, '返回首页链接');
});

test('验收: 点「取消」「重试」后状态变化正确；非法操作显示后端错误', async (t) => {
  const { db, base } = await startServer(t);
  const task = createTask(db, { repo: 'a/b', prompt: 'x' });
  const { page } = makePage(t, base, `?id=${task.id}`);
  await page.busy;

  assert.equal(page.refs.headBadge.textContent, '排队中');
  assert.equal(page.refs.cancelBtn.style.display, '', 'queued 显示「取消」');
  assert.equal(page.refs.retryBtn.style.display, 'none', 'queued 不显示「重试」');

  page.refs.cancelBtn.dispatch('click');
  await page.busy;
  assert.equal(page.refs.headBadge.textContent, '已取消');
  assert.equal(page.refs.retryBtn.style.display, '', '终态显示「重试」');

  page.refs.retryBtn.dispatch('click');
  await page.busy;
  assert.equal(page.refs.headBadge.textContent, '排队中');

  page.refs.cancelBtn.dispatch('click');
  await page.busy;
  assert.equal(page.refs.headBadge.textContent, '已取消');

  // 已是终态再取消：后端 409，错误文本显示在按钮旁
  page.refs.cancelBtn.dispatch('click');
  await page.busy;
  assert.equal(page.refs.headBadge.textContent, '已取消');
  assert.ok(page.refs.actionMsg.textContent.includes('不能从'),
    `应显示后端错误，实际：${page.refs.actionMsg.textContent}`);
});

test('验收: 单任务（没有下游）取消后重试：徽章回「排队中」，requeued 为空不出现「连带」「重新排队」（#106）', async (t) => {
  const { db, base } = await startServer(t);
  const task = createTask(db, { repo: 'a/b', prompt: 'x' });
  const { page } = makePage(t, base, `?id=${task.id}`);
  await page.busy;

  page.refs.cancelBtn.dispatch('click');
  await page.busy;
  assert.equal(page.refs.headBadge.textContent, '已取消');

  page.refs.retryBtn.dispatch('click');
  await page.busy;
  assert.equal(page.refs.headBadge.textContent, '排队中');
  // 没有被连带重新排队的下游（requeued 是空数组）：不写连带句，也不另做成功提示
  assert.equal(page.refs.actionMsg.textContent, '');
  assert.ok(!page.refs.actionMsg.textContent.includes('连带'));
  assert.ok(!page.refs.actionMsg.textContent.includes('重新排队'));
});

test('running 时每 5 秒刷新任务信息（日志由 SSE 负责）；离开 running 停止定时器', async (t) => {
  const { db, base } = await startServer(t);
  const task = createTask(db, { repo: 'a/b', prompt: 'x' });
  claimTaskById(db, task.id);
  const { page, timers, calls } = makePage(t, base, `?id=${task.id}`);
  await page.busy;

  assert.ok(timers.intervalCount >= 1, 'running：装了 5 秒刷新定时器');
  assert.equal(page.refs.headBadge.textContent, '执行中');

  const before = calls.length;
  timers.tickIntervals();
  await page.busy;
  assert.ok(calls.slice(before).some((c) => c === `GET /api/tasks/${task.id}`), '定时器触发了任务信息刷新');
  assert.equal(page.refs.headBadge.textContent, '执行中');

  // 任务结束后：下一次刷新把定时器停掉
  finishTask(db, task.id, { status: 'failed', lastError: 'boom' });
  timers.tickIntervals();
  await page.busy;
  assert.equal(page.refs.headBadge.textContent, '失败');
  assert.equal(timers.intervalCount, 0, '非 running：刷新定时器已停');
});

test('日志超过 5000 行只保留最后 5000 行；原始 / 精简切换后仍封顶', async (t) => {
  const { db, home, base } = await startServer(t);
  const lines = Array.from({ length: 5010 }, (_, i) => `[stdout] 行 ${i}`);
  const { task } = seedFinishedRun(db, home, { logLines: lines });

  const { page } = makePage(t, base, `?id=${task.id}`);
  await page.busy;
  const logView = page.refs.logView;
  assert.equal(logView.children.length, 5000);
  assert.equal(logView.children[0].textContent, '[stdout] 行 10', '最旧的 10 行被丢掉');
  assert.equal(logView.children[4999].textContent, '[stdout] 行 5009');

  page.setLogMode('simple'); // 非 JSON 行精简后原样显示：行数不变
  assert.equal(logView.children.length, 5000);
  assert.equal(logView.children[0].textContent, '[stdout] 行 10');
  page.setLogMode('raw');
  assert.equal(logView.children.length, 5000);
});

test('超长日志（13 万行，超过 push(...lines) 的引擎参数上限）一次性加载不炸，仍只渲染最后 5000 行', async (t) => {
  const { db, home, base } = await startServer(t);
  // 已结束运行的日志一次性取回：130000 行 spread 进 push 在 Node 22.13 / 24 都会
  // RangeError（Maximum call stack size exceeded），页面必须逐行入缓冲。
  const lines = Array.from({ length: 130000 }, (_, i) => `[stdout] 行 ${i}`);
  const { task } = seedFinishedRun(db, home, { logLines: lines });

  const { page } = makePage(t, base, `?id=${task.id}`);
  await page.busy;
  const logView = page.refs.logView;
  assert.equal(logView.children.length, 5000);
  assert.equal(logView.children[0].textContent, '[stdout] 行 125000', '丢掉最旧的 125000 行');
  assert.equal(logView.children[4999].textContent, '[stdout] 行 129999');
});

test('原始 / 精简切换：精简只留 assistant 文本、工具名、result；原始恢复全文', async (t) => {
  const { db, home, base } = await startServer(t);
  const lines = [
    '2026-10-08T07:00:00.000Z [meta] 开始 model=glm-5.3',
    '2026-10-08T07:00:01.000Z [stdout] {"type":"system","subtype":"init"}',
    '2026-10-08T07:00:02.000Z [stdout] {"type":"assistant","message":{"content":[{"type":"text","text":"你好"}]}}',
    '2026-10-08T07:00:03.000Z [stdout] {"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash"}]}}',
    '2026-10-08T07:00:04.000Z [stdout] 普通输出行',
    '2026-10-08T07:00:05.000Z [stdout] {"type":"result","num_turns":2,"is_error":false}',
    '2026-10-08T07:00:06.000Z [stderr] 一条错误',
    '2026-10-08T07:00:07.000Z [meta] 结束 status=succeeded',
  ];
  const { task } = seedFinishedRun(db, home, { logLines: lines });

  const { page } = makePage(t, base, `?id=${task.id}`);
  await page.busy;
  const logView = page.refs.logView;

  assert.equal(page.logMode, 'raw');
  assert.equal(logView.children.length, 8);
  assert.equal(page.refs.rawBtn.className, 'primary');

  page.refs.simpleBtn.dispatch('click');
  assert.deepEqual(logView.children.map((c) => c.textContent), [
    '[meta] 开始 model=glm-5.3',
    '[stdout] 你好',
    '[stdout] 工具 Bash',
    '[stdout] 普通输出行',
    '[stdout] result num_turns=2 is_error=false',
    '[stderr] 一条错误',
    '[meta] 结束 status=succeeded',
  ], 'system 行隐藏，其余精简');
  assert.equal(page.refs.simpleBtn.className, 'primary');

  page.refs.rawBtn.dispatch('click');
  assert.equal(logView.children.length, 8);
  assert.equal(logView.children[1].textContent, lines[1]);
});

test('点运行列表一行：日志区切换到该次运行的日志，选中行高亮', async (t) => {
  const { db, home, base } = await startServer(t);
  const task = createTask(db, { repo: 'a/b', prompt: 'x' });
  claimTaskById(db, task.id);
  const run1 = startRun(db, {
    taskId: task.id, attempt: 1, model: 'glm-5.3', effort: 'low', peak: false,
    logPath: writeLogFile(home, 'a1.log', ['[stdout] 第一次运行的日志']),
  });
  finishRun(db, run1.id, { status: 'failed' });
  const run2 = startRun(db, {
    taskId: task.id, attempt: 2, model: 'glm-5.3', effort: 'low', peak: false,
    logPath: writeLogFile(home, 'a2.log', ['[stdout] 第二次运行的日志']),
  });
  finishRun(db, run2.id, { status: 'succeeded' });
  finishTask(db, task.id, { status: 'succeeded' });

  const { page } = makePage(t, base, `?id=${task.id}`);
  await page.busy;
  assert.ok(page.refs.logView.textContent.includes('第二次运行的日志'), '默认选最新一次');

  const rows = page.refs.runsTBody.children.filter((n) => n.className.includes('run-row'));
  assert.ok(rows[0].className.includes('selected'));
  rows[1].dispatch('click'); // 点旧的那次
  await page.busy;
  assert.ok(page.refs.logView.textContent.includes('第一次运行的日志'));
  assert.ok(!page.refs.logView.textContent.includes('第二次运行的日志'));
  const rowsAfter = page.refs.runsTBody.children.filter((n) => n.className.includes('run-row'));
  assert.ok(!rowsAfter[0].className.includes('selected'));
  assert.ok(rowsAfter[1].className.includes('selected'));
});

test('日志自动滚到底；用户上翻暂停并出现「回到底部」；点击后恢复自动滚动', async (t) => {
  const { db, home, base } = await startServer(t);
  const task = createTask(db, { repo: 'a/b', prompt: 'x' });
  claimTaskById(db, task.id);
  const logPath = path.join(home, 'logs', 'scroll.log');
  fs.writeFileSync(logPath, '');
  startRun(db, {
    taskId: task.id, attempt: 1, model: 'glm-5.3', effort: 'low', peak: false, logPath,
  });

  const { page } = makePage(t, base, `?id=${task.id}`);
  await page.busy;
  const logView = page.refs.logView;
  // 桩没有真实布局：手动设定几何（内容高 1000 / 视口 200）
  logView.scrollHeight = 1000;
  logView.clientHeight = 200;
  const lineCount = () => logView.children.length;

  fs.appendFileSync(logPath, '2026-10-08T07:00:00.000Z [stdout] 第 1 行\n');
  await waitUntil(() => lineCount() === 1, { what: '第 1 行' });
  assert.equal(logView.scrollTop, 1000, '新行到达自动滚到底');

  logView.scrollTop = 100; // 用户往上翻
  logView.dispatch('scroll');
  assert.equal(page.refs.jumpBtn.style.display, '', '出现「回到底部」按钮');

  fs.appendFileSync(logPath, '2026-10-08T07:00:01.000Z [stdout] 第 2 行\n');
  await waitUntil(() => lineCount() === 2, { what: '第 2 行' });
  assert.equal(logView.scrollTop, 100, '暂停自动滚动：不再跟着滚');

  page.refs.jumpBtn.dispatch('click');
  assert.equal(logView.scrollTop, 1000);
  assert.equal(page.refs.jumpBtn.style.display, 'none', '回到底部后按钮消失');

  fs.appendFileSync(logPath, '2026-10-08T07:00:02.000Z [stdout] 第 3 行\n');
  await waitUntil(() => lineCount() === 3, { what: '第 3 行' });
  assert.equal(logView.scrollTop, 1000, '恢复自动滚动');
});

test('SSE 连接失败：关闭旧连接，3 秒后清空重连（服务器会从头重放，避免重复行）', async (t) => {
  const { db, base } = await startServer(t);
  const task = createTask(db, { repo: 'a/b', prompt: 'x' });
  claimTaskById(db, task.id);
  startRun(db, {
    taskId: task.id, attempt: 1, model: 'glm-5.3', effort: 'low', peak: false,
    logPath: '/tmp/16-sse-retry.log',
  });

  const { BrokenEventSource, created } = makeBrokenEs();
  const { page, timers } = makePage(t, base, `?id=${task.id}`, { EventSource: BrokenEventSource });
  await page.busy;
  assert.equal(created.length, 1, '初次打开');

  await waitUntil(() => created[0].closed, { what: '出错后关闭连接' });
  assert.equal(timers.timeoutCount, 1, '安排了重连定时器');

  timers.fireTimeouts();
  assert.equal(created.length, 2, '重连重新打开 EventSource');
  assert.equal(created[1].url, `/api/runs/1/stream`);
});

test('没有运行记录：列表与日志区给出提示；日志文件缺失的运行显示「这次运行没有日志文件」', async (t) => {
  const { db, home, base } = await startServer(t);
  const queued = createTask(db, { repo: 'a/b', prompt: '还没跑' });

  const first = makePage(t, base, `?id=${queued.id}`);
  await first.page.busy;
  assert.ok(first.page.refs.runsTBody.textContent.includes('还没有运行记录'));
  assert.ok(first.page.refs.logView.textContent.includes('还没有运行记录'));

  // 运行存在但日志文件不在了（被清理）：页面不炸，给出提示
  const task2 = createTask(db, { repo: 'c/d', prompt: '日志丢了' });
  claimTaskById(db, task2.id);
  const run = startRun(db, {
    taskId: task2.id, attempt: 1, model: 'glm-5.3', effort: 'low', peak: false,
    logPath: path.join(home, 'logs', 'already-deleted.log'),
  });
  finishRun(db, run.id, { status: 'failed' });
  finishTask(db, task2.id, { status: 'failed' });

  const second = makePage(t, base, `?id=${task2.id}`);
  await second.page.busy;
  assert.ok(second.page.refs.logView.textContent.includes('这次运行没有日志文件'));
});

test('验收: GET /task.html 返回页面并引用 /task.js、/style.css；/task.js 与 /log-lib.js 可取', async (t) => {
  const { base } = await startServer(t);
  const htmlRes = await fetch(`${base}/task.html`);
  assert.equal(htmlRes.status, 200);
  assert.ok(htmlRes.headers.get('content-type').startsWith('text/html'));
  const html = await htmlRes.text();
  assert.ok(html.includes('/task.js'));
  assert.ok(html.includes('/style.css'));

  for (const p of ['/task.js', '/log-lib.js']) {
    const res = await fetch(base + p);
    assert.equal(res.status, 200, p);
    assert.ok(res.headers.get('content-type').startsWith('text/javascript'), p);
  }
});

// ---------------------------------------------------------------- #68「跟进」按钮的显示判定

// canFollow 的最小输入面（只读这三个字段）。
function followableTask(overrides = {}) {
  return {
    status: 'succeeded',
    prUrl: 'https://github.com/a/b/pull/9',
    prOutcome: 'open',
    ...overrides,
  };
}

test('验收: canFollow：succeeded + https prUrl + prOutcome open → true', () => {
  assert.equal(canFollow(followableTask()), true);
});

test('验收: canFollow：succeeded + http（非 https 也算）prUrl + prOutcome null → true', () => {
  assert.equal(canFollow(followableTask({ prUrl: 'http://github.com/a/b/pull/9', prOutcome: null })), true);
});

test('验收: canFollow：succeeded + https + 缺 prOutcome 字段（老数据）→ true', () => {
  const task = followableTask();
  delete task.prOutcome;
  assert.equal(canFollow(task), true);
  // 空串、大写 'MERGED' 都算还开着（只认全等的小写 merged / closed）
  assert.equal(canFollow(followableTask({ prOutcome: '' })), true);
  assert.equal(canFollow(followableTask({ prOutcome: 'MERGED' })), true);
  assert.equal(canFollow(followableTask({ prOutcome: undefined })), true);
});

test('验收: canFollow：prOutcome 是 merged / closed → false', () => {
  assert.equal(canFollow(followableTask({ prOutcome: 'merged' })), false);
  assert.equal(canFollow(followableTask({ prOutcome: 'closed' })), false);
});

test('验收: canFollow：没有 prUrl、prUrl null、javascript: 伪协议 → false', () => {
  const without = followableTask();
  delete without.prUrl;
  assert.equal(canFollow(without), false);
  assert.equal(canFollow(followableTask({ prUrl: null })), false);
  assert.equal(canFollow(followableTask({ prUrl: 'javascript:alert(1)' })), false);
});

test('验收: canFollow：status 不是 succeeded（queued / running / failed / canceled）→ false', () => {
  for (const status of ['queued', 'running', 'failed', 'canceled']) {
    assert.equal(canFollow(followableTask({ status })), false, status);
  }
});

test('验收: canFollow 不修改入参（对象原样、键序不变）', () => {
  const task = followableTask({ prOutcome: 'open' });
  const snapshot = JSON.parse(JSON.stringify(task));
  canFollow(task);
  canFollow(followableTask({ prOutcome: 'merged' }));
  assert.deepEqual(task, snapshot);
  assert.deepEqual(Object.keys(task), Object.keys(snapshot));
  // null / undefined 入参也不炸（按不可跟进处理）
  assert.equal(canFollow(null), false);
  assert.equal(canFollow(undefined), false);
});
