// issue #83（详情页「立刻跑」按钮）的页面验收：web/task.js 的 createPage。
// 思路与 test/web-task-detail.test.js 相同：最小 DOM 桩驱动真实 createPage，fetch 按
// URL / 方法分支的桩，confirm 也注入桩（createPage 的 options.confirm）——不碰真
// confirm 弹窗、不发真请求。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPage } from '../web/task.js';

// ---------- DOM 桩（拷自 test/web-task-detail.test.js 的最小面） ----------

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

  dispatch(type, event = { type }) {
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn(event);
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

// ---------- fetch / confirm 桩与页面装配 ----------

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
    status: 'queued',
    attempts: 0,
    maxAttempts: 2,
    branch: null,
    prUrl: null,
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

/**
 * 「立刻跑」版页面装配：GET /api/tasks/1 回 task（可变对象：改它再刷新就是「下一轮
 * 返回了新状态」），queued 时 doRefresh 还会顺带 GET /api/status（#66），POST
 * /api/tasks/1/run-now 回 runNow()（测试给 202 / 40x）。confirm 桩记录每次收到的
 * 文案并返回 decide()。fetch 调用记成 { method, url, body }。
 */
function makeRunNowPage(t, { task, runNow, decide = () => true }) {
  const doc = makeStubDoc();
  const real = globalThis.fetch;
  const calls = [];
  const confirmedWith = [];
  globalThis.fetch = (input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    calls.push({ method, url, body: init?.body });
    if (method === 'POST' && url === '/api/tasks/1/run-now') {
      const { ok, status, body } = runNow();
      return Promise.resolve({ ok, status, text: () => Promise.resolve(JSON.stringify(body)) });
    }
    if (url === '/api/status') {
      return Promise.resolve({
        ok: true,
        status: 200,
        text: () => Promise.resolve(JSON.stringify({ userPaused: false, scheduler: { blocked: null } })),
      });
    }
    return Promise.resolve({
      ok: true,
      status: 200,
      text: () => Promise.resolve(JSON.stringify(task)),
    });
  };
  const confirm = (message) => {
    confirmedWith.push(message);
    return decide(message);
  };
  const page = createPage({ doc, location: { search: '?id=1' }, confirm }).init();
  t.after(() => {
    page.destroy();
    globalThis.fetch = real;
  });
  return { page, doc, calls, confirmedWith };
}

const accepted = () => ({ ok: true, status: 202, body: { id: 1, status: 'running' } });

// ---------- 验收 ----------

test('验收: queued：「立刻跑」文字精确、可见（display 不是 none），取消按钮也在', async (t) => {
  const { page } = makeRunNowPage(t, { task: taskPayload(), runNow: accepted });
  await page.busy;
  assert.equal(page.refs.runNowBtn.textContent, '立刻跑');
  assert.notEqual(page.refs.runNowBtn.style.display, 'none');
  assert.notEqual(page.refs.cancelBtn.style.display, 'none', '排队中取消按钮也在');
});

test('验收: 点击「立刻跑」：confirm 全文匹配那一句（含高峰、额度、暂停、依赖四层意思）；返回 false 不发 POST，返回 true 发 POST /api/tasks/1/run-now、body 是 {}；202 后刷新成 running', async (t) => {
  const task = taskPayload(); // 可变对象：202 后的刷新返回 running
  let allow = false;
  const { page, calls, confirmedWith } = makeRunNowPage(t, {
    task,
    runNow: accepted,
    decide: () => allow,
  });
  await page.busy;

  // confirm 返回 false：一个 POST 都不发
  page.refs.runNowBtn.dispatch('click');
  await page.busy;
  assert.equal(confirmedWith.length, 1, 'confirm 恰好被问了一次');
  const expected = '立刻跑会无视高峰、额度和暂停；依赖没完成的不会跑。确定现在就跑？';
  assert.equal(confirmedWith[0], expected);
  for (const word of ['高峰', '额度', '暂停', '依赖']) {
    assert.ok(confirmedWith[0].includes(word), `confirm 文案应含「${word}」`);
  }
  assert.ok(!calls.some((c) => c.method === 'POST'), 'confirm 拒绝时不能发请求');
  assert.equal(page.refs.headBadge.textContent, '排队中', '状态没被碰');

  // confirm 返回 true：POST 路径与 body 都对，202 后 doRefresh 画成 running
  allow = true;
  task.status = 'running';
  page.refs.runNowBtn.dispatch('click');
  await page.busy;
  const posts = calls.filter((c) => c.method === 'POST');
  assert.equal(posts.length, 1);
  assert.equal(posts[0].url, '/api/tasks/1/run-now');
  assert.equal(posts[0].body, '{}', 'body 必须是空对象 {}');
  assert.equal(page.refs.headBadge.textContent, '执行中', '202 后刷新成 running');
  assert.equal(page.refs.runNowBtn.style.display, 'none', 'running 后按钮收起');
  assert.equal(page.refs.runNowBtn.disabled, false, '按钮不再禁用');
});

test('验收: running / failed / canceled / succeeded：「立刻跑」都是 display none', async (t) => {
  for (const status of ['running', 'failed', 'canceled', 'succeeded']) {
    const { page } = makeRunNowPage(t, { task: taskPayload({ status }), runNow: accepted });
    await page.busy;
    assert.equal(page.refs.runNowBtn.style.display, 'none', `${status} 不该有「立刻跑」`);
  }
});

test('验收: succeeded 且 prUrl 为 https、prOutcome 为 null：跟进可见、立刻跑不可见（跟进按钮逻辑不动）', async (t) => {
  const { page } = makeRunNowPage(t, {
    task: taskPayload({
      status: 'succeeded',
      prUrl: 'https://github.com/a/b/pull/9',
      prOutcome: null,
    }),
    runNow: accepted,
  });
  await page.busy;
  assert.equal(page.refs.followBtn.style.display, '', '已成功且 PR 还开着：跟进在');
  assert.equal(page.refs.runNowBtn.style.display, 'none', '立刻跑不在');
});

test('验收: 桩返回 409 { error: "调度器没在跑" }：actionMsg 含这句，不当成成功', async (t) => {
  const { page } = makeRunNowPage(t, {
    task: taskPayload(),
    runNow: () => ({ ok: false, status: 409, body: { error: '调度器没在跑' } }),
  });
  await page.busy;
  page.refs.runNowBtn.dispatch('click');
  await page.busy;
  assert.ok(page.refs.actionMsg.textContent.includes('调度器没在跑'),
    `actionMsg 应含后端错误，实际：${page.refs.actionMsg.textContent}`);
  assert.equal(page.refs.headBadge.textContent, '排队中', '失败不刷新成成功状态');
  assert.equal(page.refs.runNowBtn.disabled, false, '按钮不再禁用');
});
