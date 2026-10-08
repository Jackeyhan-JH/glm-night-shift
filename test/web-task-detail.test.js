// 详情页新增四行（issue #54 验收项）：「来源」「指定分支」「还在等」「暂不开始」。
//
// 思路与 test/web-task.test.js 相同：用最小 DOM 桩驱动 web/task.js 的真实 createPage；
// 区别在于 fetch 直接用桩——GET /api/tasks/1 返回按真 handler 形状（任务字段展开 +
// runs）构造的 JSON。这样能造出库不会写出的数据（gitRef 里夹 `<` / `javascript:`、
// blockedBy 里混字符串和小数），不必为了 notBefore 去搭「running 退回 queued」的繁琐状态。
//
// 安全断言与 web-task.test.js 的 XSS 测试同款：桩元素记录 innerHTML 赋值，除静态导航
// 外全页不得出现第二处；恶意串只进 textContent，不产生元素或链接。
import test from 'node:test';
import assert from 'node:assert/strict';
import { fmtTime } from '../web/common.js';
import { createPage } from '../web/task.js';

// ---------- DOM 桩（拷自 test/web-task.test.js 的最小面） ----------

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

// ---------- fetch 桩与页面装配 ----------

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

/** 起一个真页面：桩 DOM + fetch 桩（api() 底下就是 fetch）。t.after 统一收尾。 */
function makePage(t, payload, search = '?id=1') {
  const doc = makeStubDoc();
  const real = globalThis.fetch;
  const calls = [];
  globalThis.fetch = (input) => {
    calls.push(String(input));
    return Promise.resolve({
      ok: true,
      status: 200,
      text: () => Promise.resolve(JSON.stringify(payload)),
    });
  };
  const page = createPage({ doc, location: { search } }).init();
  t.after(() => {
    page.destroy();
    globalThis.fetch = real;
  });
  return { page, doc, calls };
}

/** fields 里 (dt, dd) 成对取：labels() 给全部标签，ddOf() 按标签取值节点。 */
function labels(page) {
  const kids = page.refs.fields.children;
  const out = [];
  for (let i = 0; i + 1 < kids.length; i += 2) out.push(kids[i].textContent);
  return out;
}

function ddOf(page, label) {
  const kids = page.refs.fields.children;
  for (let i = 0; i + 1 < kids.length; i += 2) {
    if (kids[i].textContent === label) return kids[i + 1];
  }
  assert.fail(`页面上没有「${label}」行，实际：${labels(page).join(' | ')}`);
}

// ---------- #66「还没领」：路由版 fetch 桩 + 可控定时器 ----------

/** 定时器桩（拷自 test/web-task.test.js 的最小面）：不真等 5 秒，测试手动 tick。 */
function fakeTimers() {
  const intervals = new Map();
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
      return id;
    },
    clearTimeout() {},
    tickIntervals() { for (const fn of [...intervals.values()]) fn(); },
    get intervalCount() { return intervals.size; },
  };
}

/** /api/status 响应体的最小形状（这行只读顶层 userPaused 与 scheduler.blocked）。 */
function statusPayload(overrides = {}) {
  return {
    userPaused: false,
    scheduler: { blocked: null, userPaused: false },
    ...overrides,
  };
}

/**
 * 路由版 makePage（#66 用）：GET /api/tasks/:id 与 GET /api/status 各回各的——现有
 * makePage 对所有 URL 返回同一份任务 JSON，分不出两份数据。task 传可变对象：改它再
 * tick 就是「下一轮刷新返回了新状态」。status 传对象或 () => 响应 / 抛错（测失败路径）。
 * #88 增加可选的 config / running（GET /api/config、GET /api/tasks?status=running）：
 * 写法与 status 相同；不传时这两个 URL 走默认分支回任务 JSON（oneTaskPerRepo 不是
 * 严格 true、也不是数组 → 不显示），旧用例的行为一点不变。
 */
function makeRoutedPage(t, { task, status, config, running, search = '?id=1', timers }) {
  const doc = makeStubDoc();
  const real = globalThis.fetch;
  const calls = [];
  const respondWith = (body) => () => Promise.resolve({
    ok: true,
    status: 200,
    text: () => Promise.resolve(JSON.stringify(body)),
  });
  globalThis.fetch = (input) => {
    const url = String(input);
    calls.push(url);
    if (url === '/api/status') {
      return typeof status === 'function' ? status() : respondWith(status)();
    }
    if (config !== undefined && url === '/api/config') {
      return typeof config === 'function' ? config() : respondWith(config)();
    }
    if (running !== undefined && url === '/api/tasks?status=running') {
      return typeof running === 'function' ? running() : respondWith(running)();
    }
    return Promise.resolve({
      ok: true,
      status: 200,
      text: () => Promise.resolve(JSON.stringify(task)),
    });
  };
  const options = timers === undefined
    ? { doc, location: { search } }
    : { doc, location: { search }, timers };
  const page = createPage(options).init();
  t.after(() => {
    page.destroy();
    globalThis.fetch = real;
  });
  return { page, doc, calls };
}

// ---------- 验收 ----------

test('验收: 四个字段都有值：「来源」「指定分支」「还在等」「暂不开始」依次出现在「依赖」后、「最近错误」前；#3 链到 /task.html?id=3', async (t) => {
  const notBefore = '2026-10-09T01:23:00.000Z';
  const { page, doc } = makePage(t, taskPayload({
    source: 'pr-review:owner/name#12:34',
    gitRef: 'night-shift/1-slug',
    blockedBy: [3],
    notBefore,
    dependsOn: [2],
    lastError: '额度不足',
    branch: 'task/1-login',
  }));
  await page.busy;

  // 顺序：现有行不动，四个新行在「依赖」后、「最近错误」前
  assert.deepEqual(labels(page), [
    '仓库', '难度', '优先级', '允许高峰', '尝试次数', '测试命令', '创建时间',
    '开始时间', '结束时间', '分支', 'PR', '依赖', '来源', '指定分支', '还在等',
    '暂不开始', '最近错误',
  ]);

  // 来源：原样文本，不是链接
  assert.equal(ddOf(page, '来源').textContent, 'pr-review:owner/name#12:34');
  assert.equal(findByTag(ddOf(page, '来源'), 'a').length, 0, '来源不做链接');
  // 指定分支：原样文本，不是链接
  assert.equal(ddOf(page, '指定分支').textContent, 'night-shift/1-slug');
  assert.equal(findByTag(ddOf(page, '指定分支'), 'a').length, 0, '指定分支不做链接');
  // 还在等：#3 链到 /task.html?id=3（写法与「依赖」一致）
  const waitLinks = findByTag(ddOf(page, '还在等'), 'a');
  assert.equal(waitLinks.length, 1);
  assert.equal(waitLinks[0].textContent, '#3');
  assert.equal(waitLinks[0].getAttribute('href'), '/task.html?id=3');
  // 暂不开始：直接用页面的 fmtTime，不自己格式化（不依赖时区写死时钟串）
  assert.equal(ddOf(page, '暂不开始').textContent, fmtTime(notBefore));
  // 「分支」仍是 branch（这次运行实际用的），不是 gitRef
  assert.equal(ddOf(page, '分支').textContent, 'task/1-login');
  assert.ok(doc.getElementById('app').textContent.includes('额度不足'), '最近错误仍在');
});

test('验收: 四个字段都空（null / []）：没有这四行，现有行不变（分支仍画 -、PR 仍按 http(s) 规则）；空串与缺字段同样不画', async (t) => {
  const first = makePage(t, taskPayload({ prUrl: 'https://github.com/a/b/pull/7' }));
  await first.page.busy;
  const absent = ({ page, doc }) => {
    const text = doc.getElementById('app').textContent;
    for (const label of ['来源', '指定分支', '还在等', '暂不开始']) {
      assert.ok(!text.includes(label), `空数据不该画出「${label}」`);
      assert.ok(!labels(page).includes(label), `空数据不该有「${label}」行（也不画 -）`);
    }
  };
  absent(first);
  assert.deepEqual(labels(first.page), [
    '仓库', '难度', '优先级', '允许高峰', '尝试次数', '测试命令', '创建时间',
    '开始时间', '结束时间', '分支', 'PR',
  ]);
  assert.equal(ddOf(first.page, '分支').textContent, '-', 'branch 为 null 时「分支」仍显示 -');
  const prLinks = findByTag(ddOf(first.page, 'PR'), 'a');
  assert.equal(prLinks.length, 1, 'http(s) 的 prUrl 仍做成链接');
  assert.equal(prLinks[0].getAttribute('href'), 'https://github.com/a/b/pull/7');

  // 空字符串：与 null 同样省略
  const empty = makePage(t, taskPayload({ source: '', gitRef: '', notBefore: '' }));
  await empty.page.busy;
  absent(empty);

  // 字段整个缺失（老数据 / 老缓存）：同样省略
  const missingPayload = taskPayload();
  delete missingPayload.source;
  delete missingPayload.gitRef;
  delete missingPayload.blockedBy;
  delete missingPayload.notBefore;
  const missing = makePage(t, missingPayload);
  await missing.page.busy;
  absent(missing);
});

test('验收: source 夹 <img>、gitRef 是 javascript: 伪协议：按纯文本显示，不产生元素或链接，innerHTML 仍只有静态导航', async (t) => {
  const evilSource = '<img src=x onerror=alert(1)>';
  const evilRef = 'javascript:alert(1)';
  const { page, doc } = makePage(t, taskPayload({ source: evilSource, gitRef: evilRef }));
  await page.busy;
  const app = doc.getElementById('app');

  assert.ok(app.textContent.includes(evilSource), '来源原样显示为文本');
  assert.ok(app.textContent.includes(evilRef), '指定分支原样显示为文本');
  assert.equal(findByTag(app, 'img').length, 0, '不产生 img 元素');
  // 恶意串不进 href：伪协议当链接点了就执行，和 innerHTML 是同一类注入面
  const badHrefs = findAll(app, (n) => n.attributes.has('href')
    && (n.attributes.get('href') === evilRef || n.attributes.get('href').includes('<')));
  assert.equal(badHrefs.length, 0, 'javascript: 或含 < 的串不得出现在任何 href 里');
  // 全页只有导航（navHtml 静态串）用过 innerHTML
  const htmlUsers = [...findAll(doc.getElementById('nav'), (n) => n._innerHTML !== ''),
    ...findAll(app, (n) => n._innerHTML !== '')];
  assert.equal(htmlUsers.length, 1);
  assert.equal(htmlUsers[0], doc.getElementById('nav'));
});

test('验收: blockedBy 混非正整数：[3, "nope", -1, 0, 1.5, "3"] 只有 3 是链接（/task.html?id=3），其余按原顺序做文本、不进 href', async (t) => {
  const { page, doc } = makePage(t, taskPayload({ blockedBy: [3, 'nope', -1, 0, 1.5, '3'] }));
  await page.busy;
  const app = doc.getElementById('app');

  const dd = ddOf(page, '还在等');
  const links = findByTag(dd, 'a');
  assert.equal(links.length, 1, '只有正整数 3 成为链接（"3" 不算）');
  assert.equal(links[0].textContent, '#3');
  assert.equal(links[0].getAttribute('href'), '/task.html?id=3');
  // 其余项按原顺序做纯文本
  const texts = dd.children.filter((c) => c.tagName !== 'A').map((c) => c.textContent);
  assert.deepEqual(texts, ['nope', '-1', '0', '1.5', '3']);
  // 全页范围：唯一的 href 就是那条链接——没有任何非正整数被拼进 href
  const hrefs = findAll(app, (n) => n.attributes.has('href'))
    .map((n) => n.attributes.get('href'));
  assert.deepEqual(hrefs, ['/task.html?id=3']);
});

// ---------- #66「还没领」验收 ----------

test('验收: 排队中 scheduler === null：画出「还没领：调度器没在跑」；「还在等」「暂不开始」仍在，全页仍只有导航用 innerHTML', async (t) => {
  const { page, doc } = makeRoutedPage(t, {
    task: taskPayload({
      blockedBy: [3],
      notBefore: '2026-10-09T01:23:00.000Z',
      lastError: '上次失败',
    }),
    status: statusPayload({ scheduler: null }),
  });
  await page.busy;
  const app = doc.getElementById('app');

  // 任务信息照常画：仓库、状态徽章（排队中）、提示词
  assert.equal(ddOf(page, '仓库').textContent, 'a/b');
  assert.equal(page.refs.headBadge.textContent, '排队中');
  assert.ok(app.textContent.includes('做点事'), '提示词仍在');
  // 「还没领」这行：dt/dd 都是 textContent
  assert.equal(ddOf(page, '还没领').textContent, '调度器没在跑');
  assert.equal(ddOf(page, '还没领').children.length, 0, '不产生子元素');
  // 「还在等」「暂不开始」没被取代：三行同时在，顺序在「暂不开始」后、「最近错误」前
  const order = labels(page);
  assert.ok(order.includes('还在等'));
  assert.ok(order.includes('暂不开始'));
  assert.ok(order.indexOf('暂不开始') < order.indexOf('还没领'), '「还没领」在「暂不开始」之后');
  assert.ok(order.indexOf('还没领') < order.indexOf('最近错误'), '「还没领」在「最近错误」之前');
  // 全页只有导航（navHtml 静态串）用过 innerHTML
  const htmlUsers = [...findAll(doc.getElementById('nav'), (n) => n._innerHTML !== ''),
    ...findAll(app, (n) => n._innerHTML !== '')];
  assert.equal(htmlUsers.length, 1);
  assert.equal(htmlUsers[0], doc.getElementById('nav'));
});

test('验收: 顶层 userPaused === true 且 blocked five-hour：只有「已暂停领任务」，不出现「5 小时额度」', async (t) => {
  const { page, doc } = makeRoutedPage(t, {
    task: taskPayload(),
    status: statusPayload({
      userPaused: true,
      scheduler: { blocked: { reason: 'five-hour', retryAt: '2026-10-08T09:00:00.000Z' }, userPaused: false },
    }),
  });
  await page.busy;
  assert.equal(ddOf(page, '还没领').textContent, '已暂停领任务');
  assert.ok(!doc.getElementById('app').textContent.includes('5 小时额度'), '不显示上一轮留下的 blocked');
});

test('验收: 未暂停、five-hour 带 retryAt：看得到「5 小时额度已达安全阈值」和 fmtTime 的恢复时间', async (t) => {
  const retryAt = '2026-10-08T09:05:00.000Z';
  const { page } = makeRoutedPage(t, {
    task: taskPayload(),
    status: statusPayload({
      scheduler: { blocked: { reason: 'five-hour', retryAt }, userPaused: false },
    }),
  });
  await page.busy;
  assert.equal(ddOf(page, '还没领').textContent, `5 小时额度已达安全阈值；预计 ${fmtTime(retryAt)} 恢复`);
});

test('验收: peak 且任务 allowPeak false：看得到「高峰期，暂不领新任务」', async (t) => {
  const { page } = makeRoutedPage(t, {
    task: taskPayload({ allowPeak: false }),
    status: statusPayload({
      scheduler: { blocked: { reason: 'peak', retryAt: '2026-10-08T13:00:00.000Z' }, userPaused: false },
    }),
  });
  await page.busy;
  assert.equal(
    ddOf(page, '还没领').textContent,
    `高峰期，暂不领新任务；预计 ${fmtTime('2026-10-08T13:00:00.000Z')} 恢复`,
  );
});

test('验收: peak 且 allowPeak true：labels 里没有「还没领」（这条允许高峰，整行不出现）', async (t) => {
  const { page, doc } = makeRoutedPage(t, {
    task: taskPayload({ allowPeak: true }),
    status: statusPayload({
      scheduler: { blocked: { reason: 'peak' }, userPaused: false },
    }),
  });
  await page.busy;
  assert.ok(!labels(page).includes('还没领'));
  assert.ok(!doc.getElementById('app').textContent.includes('高峰期'));
});

test('验收: scheduler 是对象、blocked null、未暂停：没有「还没领」', async (t) => {
  const { page, doc } = makeRoutedPage(t, {
    task: taskPayload(),
    status: statusPayload(),
  });
  await page.busy;
  assert.ok(!labels(page).includes('还没领'));
  assert.ok(!doc.getElementById('app').textContent.includes('还没领'));
});

test('验收: running 的任务：没有「还没领」，fetch 记录里没有 /api/status', async (t) => {
  const { page, doc, calls } = makeRoutedPage(t, {
    task: taskPayload({ status: 'running', startedAt: '2026-10-08T07:00:00.000Z' }),
    status: statusPayload({ scheduler: null }),
  });
  await page.busy;
  assert.ok(!labels(page).includes('还没领'));
  assert.ok(!doc.getElementById('app').textContent.includes('调度器没在跑'));
  assert.ok(!calls.includes('/api/status'), `running 不打 /api/status，实际：${calls.join(', ')}`);
});

test('验收: /api/status 失败（非 2xx / 网络错误）：仓库、状态徽章、提示词仍在，没有「还没领」，页面不是「加载任务失败」', async (t) => {
  const notOk = () => Promise.resolve({
    ok: false,
    status: 503,
    text: () => Promise.resolve(JSON.stringify({ error: 'unavailable' })),
  });
  const rejected = () => Promise.reject(new Error('network down'));
  for (const failing of [notOk, rejected]) {
    const { page, doc } = makeRoutedPage(t, { task: taskPayload(), status: failing });
    await page.busy;
    const app = doc.getElementById('app');
    assert.equal(ddOf(page, '仓库').textContent, 'a/b');
    assert.equal(page.refs.headBadge.textContent, '排队中');
    assert.ok(app.textContent.includes('做点事'), '提示词仍在');
    assert.ok(!labels(page).includes('还没领'), '没有可依据的 status，不画这行');
    assert.ok(!app.textContent.includes('加载任务失败'), '状态请求失败不拖垮任务信息');
  }
});

test('验收: queued 复用 running 的同一个刷新定时器（intervalCount === 1）；tick 再拉 /api/status；变成 succeeded 后停表且不再拉', async (t) => {
  const timers = fakeTimers();
  const task = taskPayload(); // 可变对象：第二轮刷新改成 succeeded
  const { page, calls } = makeRoutedPage(t, {
    task,
    status: statusPayload({ scheduler: null }),
    timers,
  });
  await page.busy;

  assert.equal(timers.intervalCount, 1, 'queued 装上与 running 同一个定时器（不是两个）');
  assert.equal(calls.filter((c) => c === '/api/status').length, 1, '首屏就拉过一次 /api/status');

  timers.tickIntervals();
  await page.busy;
  assert.equal(calls.filter((c) => c === '/api/status').length, 2, 'tick 后仍是 queued：再拉 /api/status');
  assert.equal(ddOf(page, '还没领').textContent, '调度器没在跑');

  // 下一轮刷新任务变成 succeeded：定时器停掉、不再碰 /api/status，上一轮原因清掉
  task.status = 'succeeded';
  timers.tickIntervals();
  await page.busy;
  assert.equal(page.refs.headBadge.textContent, '成功');
  assert.equal(timers.intervalCount, 0, '离开 queued：刷新定时器已停');
  assert.ok(!labels(page).includes('还没领'), '非 queued 的页面上没有上一轮的原因');
  const after = calls.filter((c) => c === '/api/status').length;
  timers.tickIntervals(); // 定时器已停：不会再触发任何请求
  await page.busy;
  assert.equal(calls.filter((c) => c === '/api/status').length, after, '停表后不再请求 /api/status');
});

// ---------- #88「等这个仓库」验收 ----------

/** /api/config 响应体的最小形状（这行只读 oneTaskPerRepo）。 */
function repoConfig(overrides = {}) {
  return { oneTaskPerRepo: true, ...overrides };
}

/** running 列表里的另一条任务（缺省：id 2、同仓库 a/b、在跑）。 */
function otherRunning(overrides = {}) {
  return { id: 2, status: 'running', repo: 'a/b', ...overrides };
}

test('验收: 排队、oneTaskPerRepo true、同仓库另有一条 running：出现「等这个仓库」，dd 是空串且无子元素；状态徽章、仓库、提示词仍在；innerHTML 仍只有导航', async (t) => {
  const { page, doc, calls } = makeRoutedPage(t, {
    task: taskPayload({ notBefore: '2026-10-09T01:23:00.000Z', lastError: '上次失败' }),
    status: statusPayload(),
    config: repoConfig(),
    running: [otherRunning()],
  });
  await page.busy;
  const app = doc.getElementById('app');

  // dt 精确是这四个字、dd 是空串（不画 -、不包别的字、没有子元素）
  assert.equal(ddOf(page, '等这个仓库').textContent, '');
  assert.equal(ddOf(page, '等这个仓库').children.length, 0);
  assert.ok(app.textContent.includes('等这个仓库'), '四个字出现在页面上');
  // 任务信息照常画：仓库、状态徽章（排队中）、提示词
  assert.equal(ddOf(page, '仓库').textContent, 'a/b');
  assert.equal(page.refs.headBadge.textContent, '排队中');
  assert.ok(app.textContent.includes('做点事'), '提示词仍在');
  // 位置：与「还没领」同一处——「暂不开始」后、「最近错误」前（这条没有「还没领」）
  const order = labels(page);
  assert.ok(order.indexOf('暂不开始') < order.indexOf('等这个仓库'), '在「暂不开始」之后');
  assert.ok(order.indexOf('等这个仓库') < order.indexOf('最近错误'), '在「最近错误」之前');
  // 两个新请求确实发出去了
  assert.ok(calls.includes('/api/config'), '排队时拉了 /api/config');
  assert.ok(calls.includes('/api/tasks?status=running'), '排队时拉了 running 列表');
  // 全页只有导航（navHtml 静态串）用过 innerHTML
  const htmlUsers = [...findAll(doc.getElementById('nav'), (n) => n._innerHTML !== ''),
    ...findAll(app, (n) => n._innerHTML !== '')];
  assert.equal(htmlUsers.length, 1);
  assert.equal(htmlUsers[0], doc.getElementById('nav'));
});

test('验收: 同时 userPaused true：ddOf「还没领」仍是「已暂停领任务」，「等这个仓库」也在（两行同时在，新行紧随其后）', async (t) => {
  const { page } = makeRoutedPage(t, {
    task: taskPayload(),
    status: statusPayload({
      userPaused: true,
      scheduler: { blocked: { reason: 'five-hour', retryAt: '2026-10-08T09:00:00.000Z' }, userPaused: false },
    }),
    config: repoConfig(),
    running: [otherRunning()],
  });
  await page.busy;
  assert.equal(ddOf(page, '还没领').textContent, '已暂停领任务', '「还没领」没被替换');
  assert.equal(ddOf(page, '等这个仓库').textContent, '');
  const order = labels(page);
  assert.ok(order.includes('还没领') && order.includes('等这个仓库'));
  assert.ok(order.indexOf('还没领') < order.indexOf('等这个仓库'), '新行紧挨在「还没领」后面');
});

test('验收: GET /api/config 失败、或 GET /api/tasks?status=running 失败：不出现「等这个仓库」；「还没领」原句还在；页面不是「加载任务失败」', async (t) => {
  const notOk = () => Promise.resolve({
    ok: false,
    status: 503,
    text: () => Promise.resolve(JSON.stringify({ error: 'unavailable' })),
  });
  const rejected = () => Promise.reject(new Error('network down'));
  for (const failing of [notOk, rejected]) {
    // /api/status 正常（scheduler null → 调度器没在跑）：这句不能被新请求的失败清掉
    const configDown = makeRoutedPage(t, {
      task: taskPayload(),
      status: statusPayload({ scheduler: null }),
      config: failing,
      running: [otherRunning()],
    });
    await configDown.page.busy;
    assert.ok(!labels(configDown.page).includes('等这个仓库'), 'config 失败：不显示');
    assert.equal(ddOf(configDown.page, '还没领').textContent, '调度器没在跑', '「还没领」句子还在');
    assert.ok(!configDown.doc.getElementById('app').textContent.includes('加载任务失败'));

    const runningDown = makeRoutedPage(t, {
      task: taskPayload(),
      status: statusPayload({ scheduler: null }),
      config: repoConfig(),
      running: failing,
    });
    await runningDown.page.busy;
    assert.ok(!labels(runningDown.page).includes('等这个仓库'), 'running 列表失败：不显示');
    assert.equal(ddOf(runningDown.page, '还没领').textContent, '调度器没在跑', '「还没领」句子还在');
    assert.ok(!runningDown.doc.getElementById('app').textContent.includes('加载任务失败'));
  }
});

test('验收: oneTaskPerRepo 不是 true（false / 字段缺失）：不出现这四个字', async (t) => {
  for (const config of [repoConfig({ oneTaskPerRepo: false }), {}]) {
    const { page, doc } = makeRoutedPage(t, {
      task: taskPayload(),
      status: statusPayload(),
      config,
      running: [otherRunning()],
    });
    await page.busy;
    assert.ok(!labels(page).includes('等这个仓库'),
      `oneTaskPerRepo=${JSON.stringify(config.oneTaskPerRepo)} 不该显示`);
    assert.ok(!doc.getElementById('app').textContent.includes('等这个仓库'));
  }
});

test('验收: 同仓库没有 running（列表空 / 只有别的仓库 / 同仓库只有 queued）：不出现', async (t) => {
  const lists = [
    [],
    [otherRunning({ repo: 'c/d' })],
    [otherRunning({ status: 'queued' })],
  ];
  for (const running of lists) {
    const { page } = makeRoutedPage(t, {
      task: taskPayload(),
      status: statusPayload(),
      config: repoConfig(),
      running,
    });
    await page.busy;
    assert.ok(!labels(page).includes('等这个仓库'), `running=${JSON.stringify(running)} 不该显示`);
  }
});

test('验收: 任务不是 queued（running）：不出现这四个字，fetch 记录里没有 /api/config 也没有 /api/tasks?status=running', async (t) => {
  const { page, doc, calls } = makeRoutedPage(t, {
    task: taskPayload({ status: 'running', startedAt: '2026-10-08T07:00:00.000Z' }),
    status: statusPayload({ scheduler: null }),
    config: repoConfig(),
    running: [otherRunning()],
  });
  await page.busy;
  assert.ok(!labels(page).includes('等这个仓库'));
  assert.ok(!doc.getElementById('app').textContent.includes('等这个仓库'));
  assert.ok(!calls.includes('/api/config'), `running 不打 /api/config，实际：${calls.join(', ')}`);
  assert.ok(!calls.includes('/api/tasks?status=running'), `running 不打 running 列表，实际：${calls.join(', ')}`);
  assert.ok(!calls.includes('/api/status'), 'running 不打 /api/status（原有行为不变）');
});

test('验收: 排队时 tick 再拉这两个请求；变成 running 后这行清掉、不再发', async (t) => {
  const timers = fakeTimers();
  const task = taskPayload(); // 可变对象：第二轮刷新改成 running
  const { page, calls } = makeRoutedPage(t, {
    task,
    status: statusPayload(),
    config: repoConfig(),
    running: [otherRunning()],
    timers,
  });
  await page.busy;
  assert.ok(labels(page).includes('等这个仓库'), '排队时显示');
  assert.equal(calls.filter((c) => c === '/api/config').length, 1, '首屏拉过一次 /api/config');
  assert.equal(calls.filter((c) => c === '/api/tasks?status=running').length, 1, '首屏拉过一次 running 列表');

  timers.tickIntervals();
  await page.busy;
  assert.equal(calls.filter((c) => c === '/api/config').length, 2, 'tick 后仍是 queued：再拉');
  assert.equal(calls.filter((c) => c === '/api/tasks?status=running').length, 2, 'tick 后仍是 queued：再拉');
  assert.ok(labels(page).includes('等这个仓库'));

  task.status = 'running';
  task.startedAt = '2026-10-08T07:30:00.000Z';
  timers.tickIntervals();
  await page.busy;
  assert.equal(page.refs.headBadge.textContent, '执行中');
  assert.ok(!labels(page).includes('等这个仓库'), '非 queued：上一轮为这行存的数据清掉了');
  assert.equal(calls.filter((c) => c === '/api/config').length, 2, '非 queued 不再发 /api/config');
  assert.equal(calls.filter((c) => c === '/api/tasks?status=running').length, 2, '非 queued 不再发 running 列表');
});

// ---------- #68「跟进」按钮：按 URL / 方法分支的 fetch 桩 ----------

/**
 * 「跟进」版页面装配：GET /api/tasks/1 永远回 task（刷新后仍是已成功、PR 开着），
 * POST /api/tasks/1/follow 回 follow()（测试给 201 / 200 / 40x）。现有 makePage 的
 * 「所有 URL 同一 payload」行为不动，新测试自己按 URL 分支。
 */
function makeFollowPage(t, { task, follow }) {
  const doc = makeStubDoc();
  const real = globalThis.fetch;
  const calls = [];
  globalThis.fetch = (input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    calls.push(`${method} ${url}`);
    if (method === 'POST' && url === '/api/tasks/1/follow') {
      const { ok, status, body } = follow();
      return Promise.resolve({ ok, status, text: () => Promise.resolve(JSON.stringify(body)) });
    }
    return Promise.resolve({
      ok: true,
      status: 200,
      text: () => Promise.resolve(JSON.stringify(task)),
    });
  };
  const page = createPage({ doc, location: { search: '?id=1' } }).init();
  t.after(() => {
    page.destroy();
    globalThis.fetch = real;
  });
  return { page, doc, calls };
}

/** 已成功、PR 开着的任务载荷（canFollow 为 true 的典型形状）。 */
function followablePayload(overrides = {}) {
  return taskPayload({
    status: 'succeeded',
    prUrl: 'https://github.com/a/b/pull/9',
    branch: 'night-shift/1-fix',
    prOutcome: 'open',
    finishedAt: '2026-10-08T08:00:00.000Z',
    ...overrides,
  });
}

const created = (overrides = {}) => ({
  ok: true,
  status: 201,
  body: {
    kind: 'created', id: 2, parentId: 1, branch: 'night-shift/1-fix',
    source: 'pr-review:a/b#9:1', ...overrides,
  },
});

test('验收: 已成功、prUrl 是 https、prOutcome 为 open：看得到「跟进」（display 不是 none），文字就是「跟进」', async (t) => {
  const { page } = makeFollowPage(t, {
    task: followablePayload(),
    follow: () => created(),
  });
  await page.busy;
  assert.equal(page.refs.followBtn.textContent, '跟进');
  assert.equal(page.refs.followBtn.style.display, '');
});

test('验收: prOutcome 缺失（老数据）：同样有「跟进」', async (t) => {
  const task = followablePayload();
  delete task.prOutcome;
  const { page } = makeFollowPage(t, { task, follow: () => created() });
  await page.busy;
  assert.equal(page.refs.followBtn.style.display, '');
});

test('验收: merged、closed、没有 prUrl、状态不是成功：没有「跟进」按钮（display none）', async (t) => {
  const cases = [
    followablePayload({ prOutcome: 'merged' }),
    followablePayload({ prOutcome: 'closed' }),
    followablePayload({ prUrl: null }),
    followablePayload({ status: 'failed' }),
    followablePayload({ status: 'running' }),
  ];
  for (const task of cases) {
    const { page } = makeFollowPage(t, { task, follow: () => created() });
    await page.busy;
    assert.equal(page.refs.followBtn.style.display, 'none',
      `${task.status} / prUrl=${task.prUrl} / prOutcome=${task.prOutcome} 不该有按钮`);
  }
});

test('验收: 201 created：点击后 actionMsg 含「已入队 #2」「，在分支 night-shift/1-fix 上改」，#2 是 <a href="/task.html?id=2">，没有指向 github 的链接；按钮还在、文字仍是「跟进」', async (t) => {
  const { page, doc, calls } = makeFollowPage(t, {
    task: followablePayload(),
    follow: () => created(),
  });
  await page.busy;
  page.refs.followBtn.dispatch('click');
  await page.busy;

  const msg = page.refs.actionMsg;
  assert.ok(msg.textContent.includes('已入队 #2'), msg.textContent);
  assert.ok(msg.textContent.includes('，在分支 night-shift/1-fix 上改'), msg.textContent);
  // #2 是站内详情页链接；不指向 github、不开 _blank 到 prUrl
  const links = findByTag(msg, 'a');
  assert.equal(links.length, 1);
  assert.equal(links[0].textContent, '#2');
  assert.equal(links[0].getAttribute('href'), '/task.html?id=2');
  assert.equal(links[0].attributes.has('target'), false, '不 target=_blank 到 prUrl');
  // 成功提示里不出现 github 外链（信息卡里那条 PR 链接是另一回事，不在此节点内）
  const hrefs = links.map((n) => n.getAttribute('href'));
  assert.ok(!hrefs.some((href) => href.startsWith('http')), `不该有外链：${hrefs.join(' | ')}`);
  // 前后两段是单独元素的 textContent
  assert.deepEqual(msg.children.map((c) => c.tagName), ['SPAN', 'A', 'SPAN']);
  assert.equal(msg.children[0].textContent, '已入队 ');
  assert.equal(msg.children[2].textContent, '，在分支 night-shift/1-fix 上改');
  // 成功提示在 doRefresh 之后才写：GET 任务详情发生在 POST 之后
  assert.ok(calls.indexOf('POST /api/tasks/1/follow') < calls.lastIndexOf('GET /api/tasks/1'),
    `先刷新后写提示，实际顺序：${calls.join(' -> ')}`);
  // 按钮没被拿掉也没隐藏
  assert.equal(page.refs.followBtn.textContent, '跟进');
  assert.equal(page.refs.followBtn.style.display, '');
  assert.equal(page.refs.followBtn.disabled, false);
});

test('验收: 201 但 branch 含 <img：不产生 img 元素，除导航外没有新的 innerHTML', async (t) => {
  const { page, doc } = makeFollowPage(t, {
    task: followablePayload(),
    follow: () => created({ branch: 'night-shift/1-<img src=x onerror=alert(1)>' }),
  });
  await page.busy;
  page.refs.followBtn.dispatch('click');
  await page.busy;
  const app = doc.getElementById('app');

  assert.equal(findByTag(app, 'img').length, 0, '不产生 img 元素');
  assert.ok(page.refs.actionMsg.textContent.includes('<img'), '恶意串按文本原样显示');
  const badHrefs = findAll(app, (n) => n.attributes.has('href') && n.attributes.get('href').includes('<'));
  assert.equal(badHrefs.length, 0, '含 < 的串不得出现在任何 href 里');
  const htmlUsers = [...findAll(doc.getElementById('nav'), (n) => n._innerHTML !== ''),
    ...findAll(app, (n) => n._innerHTML !== '')];
  assert.equal(htmlUsers.length, 1, '全页仍只有导航用 innerHTML');
  assert.equal(htmlUsers[0], doc.getElementById('nav'));
});

test('验收: 200 skipped：按钮旁 textContent 就是 followTask 的 message 原文，不做链接、不再包一句', async (t) => {
  const { page } = makeFollowPage(t, {
    task: followablePayload(),
    follow: () => ({ ok: true, status: 200, body: { kind: 'skipped', parentId: 1, message: '没有待处理的修改请求' } }),
  });
  await page.busy;
  page.refs.followBtn.dispatch('click');
  await page.busy;

  assert.equal(page.refs.actionMsg.textContent, '没有待处理的修改请求');
  assert.equal(findByTag(page.refs.actionMsg, 'a').length, 0, 'skipped 不做链接');
  assert.equal(page.refs.followBtn.style.display, '', '按钮还在');
});

test('验收: 409：按钮旁显示后端的 error 原文，与取消 / 重试失败是同一节点（refs.actionMsg）', async (t) => {
  const { page } = makeFollowPage(t, {
    task: followablePayload(),
    follow: () => ({ ok: false, status: 409, body: { error: '任务 #1 不能跟进：状态是 queued' } }),
  });
  await page.busy;
  page.refs.followBtn.dispatch('click');
  await page.busy;

  assert.equal(page.refs.actionMsg.textContent, '任务 #1 不能跟进：状态是 queued');
  assert.equal(page.refs.followBtn.textContent, '跟进');
  assert.equal(page.refs.followBtn.disabled, false);
});

// ---------- #106 重试的连带重新排队：按 URL / 方法分支的重试桩 ----------

/**
 * 重试版页面装配（写法对齐 makeFollowPage）：GET /api/tasks/1 永远回 task（任务对象
 * 本来就没有 requeued 字段），POST /api/tasks/1/retry 与 POST /api/tasks/1/cancel 各回
 * 测试给的 { ok, status, body }（retry() / cancel() 每次调用时取）。task 缺省给
 * canceled——重试按钮只对 failed / canceled 露出。
 */
function makeRetryPage(t, { task = taskPayload({ status: 'canceled' }), retry, cancel } = {}) {
  const doc = makeStubDoc();
  const real = globalThis.fetch;
  const calls = [];
  globalThis.fetch = (input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    calls.push(`${method} ${url}`);
    const post = (stub) => {
      const { ok, status, body } = stub();
      return Promise.resolve({ ok, status, text: () => Promise.resolve(JSON.stringify(body)) });
    };
    if (method === 'POST' && url === '/api/tasks/1/retry') return post(retry);
    if (method === 'POST' && url === '/api/tasks/1/cancel') return post(cancel);
    return Promise.resolve({
      ok: true,
      status: 200,
      text: () => Promise.resolve(JSON.stringify(task)),
    });
  };
  const page = createPage({ doc, location: { search: '?id=1' } }).init();
  t.after(() => {
    page.destroy();
    globalThis.fetch = real;
  });
  return { page, doc, calls };
}

test('验收: 重试响应 requeued [3, 2]：actionMsg 精确是「连带 #2、#3 重新排队」且无子元素；POST 在最后一次 GET 之前（先刷新后写句子）', async (t) => {
  const { page, calls } = makeRetryPage(t, {
    retry: () => ({ ok: true, status: 200, body: { id: 1, status: 'queued', requeued: [3, 2] } }),
  });
  await page.busy;
  assert.equal(page.refs.retryBtn.style.display, '', '已取消：重试按钮可见');

  page.refs.retryBtn.dispatch('click');
  await page.busy;

  assert.equal(page.refs.actionMsg.textContent, '连带 #2、#3 重新排队');
  assert.equal(page.refs.actionMsg.children.length, 0, '整句一个 textContent，没有子元素');
  assert.ok(calls.indexOf('POST /api/tasks/1/retry') < calls.lastIndexOf('GET /api/tasks/1'),
    `先刷新后写句子，实际顺序：${calls.join(' -> ')}`);
  assert.equal(page.refs.retryBtn.disabled, false, '按钮恢复可用');
});

test('验收: requeued [10, 2]：显示「连带 #2、#10 重新排队」（数字升序，不是字符串序）', async (t) => {
  const { page } = makeRetryPage(t, {
    retry: () => ({ ok: true, status: 200, body: { requeued: [10, 2] } }),
  });
  await page.busy;
  page.refs.retryBtn.dispatch('click');
  await page.busy;
  assert.equal(page.refs.actionMsg.textContent, '连带 #2、#10 重新排队');
});

test('验收: requeued 只有一个 id：「连带 #2 重新排队」，不多一个顿号', async (t) => {
  const { page } = makeRetryPage(t, {
    retry: () => ({ ok: true, status: 200, body: { requeued: [2] } }),
  });
  await page.busy;
  page.refs.retryBtn.dispatch('click');
  await page.busy;
  assert.equal(page.refs.actionMsg.textContent, '连带 #2 重新排队');
});

test('验收: requeued 是空数组：不写句子也不另做成功提示，actionMsg 是空串', async (t) => {
  const { page } = makeRetryPage(t, {
    retry: () => ({ ok: true, status: 200, body: { id: 1, status: 'queued', requeued: [] } }),
  });
  await page.busy;
  page.refs.retryBtn.dispatch('click');
  await page.busy;
  assert.equal(page.refs.actionMsg.textContent, '');
  assert.ok(!page.refs.actionMsg.textContent.includes('连带'));
  assert.ok(!page.refs.actionMsg.textContent.includes('重新排队'));
});

test('验收: 响应没有 requeued 字段（只有 id / status）：同样不写，actionMsg 为空', async (t) => {
  const { page } = makeRetryPage(t, {
    retry: () => ({ ok: true, status: 200, body: { id: 1, status: 'queued' } }),
  });
  await page.busy;
  page.refs.retryBtn.dispatch('click');
  await page.busy;
  assert.equal(page.refs.actionMsg.textContent, '');
  assert.ok(!page.refs.actionMsg.textContent.includes('连带'));
  assert.ok(!page.refs.actionMsg.textContent.includes('重新排队'));
});

test('验收: requeued 不是数组（字符串 / 对象 / null / 数字）：同样不写这句', async (t) => {
  const bodies = [
    { requeued: '3,2' },
    { requeued: { 2: 2, 3: 3 } },
    { requeued: null },
    { requeued: 3 },
  ];
  for (const body of bodies) {
    const { page } = makeRetryPage(t, {
      retry: () => ({ ok: true, status: 200, body }),
    });
    await page.busy;
    page.refs.retryBtn.dispatch('click');
    await page.busy;
    assert.equal(page.refs.actionMsg.textContent, '',
      `requeued=${JSON.stringify(body.requeued)} 不该写句子`);
    assert.ok(!page.refs.actionMsg.textContent.includes('连带'));
    assert.ok(!page.refs.actionMsg.textContent.includes('重新排队'));
  }
});

test('验收: 取消的响应即使带 requeued [3, 2]：actionMsg 也不含「连带」「重新排队」（句子只属于重试路径）', async (t) => {
  const { page } = makeRetryPage(t, {
    task: taskPayload(), // queued：取消按钮可见
    cancel: () => ({ ok: true, status: 200, body: { id: 1, status: 'canceled', requeued: [3, 2] } }),
  });
  await page.busy;
  assert.equal(page.refs.cancelBtn.style.display, '', '排队中：取消按钮可见');
  page.refs.cancelBtn.dispatch('click');
  await page.busy;
  assert.ok(!page.refs.actionMsg.textContent.includes('连带'));
  assert.ok(!page.refs.actionMsg.textContent.includes('重新排队'));
  assert.equal(page.refs.actionMsg.textContent, '', '取消成功路径上 actionMsg 保持空');
});

test('验收: 重试非 2xx：actionMsg 是后端 error 原文、不含「连带」；失败不当成功刷新（POST 后没有再 GET）', async (t) => {
  const { page, calls } = makeRetryPage(t, {
    retry: () => ({ ok: false, status: 409, body: { error: '不能从 canceled 重试' } }),
  });
  await page.busy;
  page.refs.retryBtn.dispatch('click');
  await page.busy;
  assert.equal(page.refs.actionMsg.textContent, '不能从 canceled 重试');
  assert.ok(!page.refs.actionMsg.textContent.includes('连带'));
  assert.ok(calls.indexOf('POST /api/tasks/1/retry') > calls.lastIndexOf('GET /api/tasks/1'),
    `失败后不该再刷新，实际顺序：${calls.join(' -> ')}`);
});
