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
