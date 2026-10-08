// web/queue-lib.js 的单元测试（issue #15 验收项）：纯函数在 node:test 里直接 import
// （模块不碰 DOM / fetch，只有 queue.js 才动浏览器环境）。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HISTORY_LIMIT,
  depHint,
  escapeHtml,
  firstLine,
  formToBody,
  groupTasks,
  statusBarText,
} from '../web/queue-lib.js';

// ---------- 按状态分组 ----------

test('验收: 按状态分组正确：queued 按领取顺序（priority DESC → createdAt ASC → id ASC）、running 单独、history 只含三个终态', () => {
  const tasks = [
    { id: 5, status: 'queued', priority: 0, createdAt: '2026-10-08T05:00:00.000Z' },
    { id: 2, status: 'queued', priority: 5, createdAt: '2026-10-08T04:00:00.000Z' },
    { id: 1, status: 'queued', priority: 5, createdAt: '2026-10-08T03:00:00.000Z' },
    { id: 3, status: 'running', startedAt: '2026-10-08T06:00:00.000Z', createdAt: '2026-10-08T02:00:00.000Z' },
    { id: 4, status: 'succeeded', finishedAt: '2026-10-08T07:00:00.000Z', createdAt: '2026-10-08T01:00:00.000Z' },
    { id: 6, status: 'failed', lastError: 'boom', createdAt: '2026-10-07T09:00:00.000Z' },
    { id: 7, status: 'canceled', createdAt: '2026-10-07T08:00:00.000Z' },
  ];
  const groups = groupTasks(tasks);
  // 优先级 5 的两个在前（同分按创建时间先后），0 分的 #5 最后。
  assert.deepEqual(groups.queued.map((t) => t.id), [1, 2, 5]);
  assert.deepEqual(groups.running.map((t) => t.id), [3]);
  // 最近完成的在前；queued/running 不进历史。
  assert.deepEqual(groups.history.map((t) => t.id), [4, 6, 7]);
  // 不改动入参
  assert.equal(tasks.length, 7);
  assert.equal(tasks[0].id, 5);
});

test('groupTasks：历史只保留最近 100 条（HISTORY_LIMIT=100），最新的在前', () => {
  assert.equal(HISTORY_LIMIT, 100);
  const tasks = Array.from({ length: 120 }, (_, i) => ({
    id: i + 1,
    status: i % 2 === 0 ? 'failed' : 'succeeded',
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
  }));
  const { history } = groupTasks(tasks);
  assert.equal(history.length, 100);
  assert.equal(history[0].id, 120);
  assert.equal(history[99].id, 21);
});

test('groupTasks：running 按开始时间倒序（startedAt 缺失回退 createdAt）；空输入返回三个空数组', () => {
  const groups = groupTasks([
    { id: 9, status: 'running', startedAt: '2026-10-08T01:00:00.000Z', createdAt: '2026-10-08T00:30:00.000Z' },
    { id: 8, status: 'running', createdAt: '2026-10-08T02:00:00.000Z' },
  ]);
  assert.deepEqual(groups.running.map((t) => t.id), [8, 9]);
  const empty = groupTasks([]);
  assert.deepEqual(empty, { queued: [], running: [], history: [] });
  assert.deepEqual(groupTasks(null), { queued: [], running: [], history: [] });
});

// ---------- 依赖提示 ----------

test('验收: blockedBy [1,2] 生成「等 #1 #2」；单个、空数组、null 的情况', () => {
  assert.equal(depHint([1, 2]), '等 #1 #2');
  assert.equal(depHint([3]), '等 #3');
  assert.equal(depHint([]), '');
  assert.equal(depHint(null), '');
  assert.equal(depHint(undefined), '');
});

// ---------- 状态条文案 ----------

test('statusBarText：高峰/非高峰、5 小时额度百分比（保留 1 位小数）、运行中数量', () => {
  assert.equal(
    statusBarText({ peak: { peak: true }, usage: { fiveHour: { used: 16, limit: 1600 } }, runningCount: 2 }),
    '高峰时段 · 5 小时额度 1.0%（16/1600） · 运行中 2 个',
  );
  assert.equal(
    statusBarText({ peak: { peak: false }, usage: { fiveHour: { used: 0, limit: 80 } }, runningCount: 0 }),
    '非高峰时段 · 5 小时额度 0.0%（0/80） · 运行中 0 个',
  );
});

test('statusBarText：数据残缺不抛错（null / 缺 usage / limit 非法时该段显示 -）', () => {
  assert.equal(statusBarText(null), '');
  assert.equal(statusBarText(undefined), '');
  assert.equal(
    statusBarText({ peak: {}, usage: null, runningCount: 1 }),
    '非高峰时段 · 5 小时额度 - · 运行中 1 个',
  );
  assert.equal(
    statusBarText({ peak: { peak: false }, usage: { fiveHour: { used: 3, limit: 0 } } }),
    '非高峰时段 · 5 小时额度 - · 运行中 0 个',
  );
});

// ---------- 表单数据 → 请求体 ----------

test('验收: 表单数据转请求体（不用模板）：文本 trim、复选框转布尔、依赖多选的字符串 id 转数字', () => {
  assert.deepEqual(formToBody({
    repo: ' a/b ',
    prompt: ' 修复登录\n再跑一遍 ',
    title: '',
    difficulty: 'hard',
    priority: '-2',
    testCommand: ' npm test ',
    allowPeak: true,
    maxAttempts: '3',
    dependsOn: ['1', '3'],
    template: '',
    vars: {},
  }), {
    repo: 'a/b',
    prompt: '修复登录\n再跑一遍', // 首尾空白去掉，中间换行保留
    difficulty: 'hard',
    priority: -2,
    testCommand: 'npm test',
    allowPeak: true,
    maxAttempts: 3,
    dependsOn: [1, 3],
  });
});

test('验收: 表单数据转请求体（选模板）：发 template+vars（空值变量不发）、不带 prompt，显式字段照发', () => {
  assert.deepEqual(formToBody({
    repo: 'a/b',
    template: 'fix-issue',
    vars: { issue: ' 12 ', extra: '' }, // extra 留空 = 不发（与模板默认空串等价）
    prompt: '选了模板，这段被忽略',
    title: '',
    difficulty: 'medium',
    priority: '',
    testCommand: '',
    allowPeak: false,
    maxAttempts: '',
    dependsOn: [],
  }), {
    repo: 'a/b',
    template: 'fix-issue',
    vars: { issue: '12' },
    difficulty: 'medium',
    allowPeak: false,
  });
});

test('formToBody：最小表单只有仓库与提示词；非法数字与无效依赖 id 不进请求体', () => {
  assert.deepEqual(formToBody({
    repo: 'a/b', prompt: 'x', template: '', vars: {}, title: '', difficulty: 'medium',
    priority: '', testCommand: '', allowPeak: false, maxAttempts: '', dependsOn: [],
  }), { repo: 'a/b', prompt: 'x', difficulty: 'medium', allowPeak: false });

  const body = formToBody({
    repo: 'a/b', prompt: 'x', template: '', vars: {}, title: '', difficulty: 'easy',
    priority: 'abc', testCommand: '', allowPeak: false, maxAttempts: '0', dependsOn: ['x', '2'],
  });
  assert.equal('priority' in body, false, '非整数不发');
  assert.equal('maxAttempts' in body, false, '小于 1 不发');
  assert.deepEqual(body.dependsOn, [2], '无效项被过滤');
});

// ---------- 展示辅助 ----------

test('firstLine 取第一行（失败任务展示 lastError 首行用）；null/空串为空字符串', () => {
  assert.equal(firstLine('第一行\n第二行\n第三行'), '第一行');
  assert.equal(firstLine('只有一行'), '只有一行');
  assert.equal(firstLine(''), '');
  assert.equal(firstLine(null), '');
  assert.equal(firstLine(undefined), '');
});

test('escapeHtml：& < > " \' 全部转义（文本与属性值都安全）', () => {
  assert.equal(escapeHtml(`<a href="x">&'`), '&lt;a href=&quot;x&quot;&gt;&amp;&#39;');
  assert.equal(escapeHtml(null), '');
  assert.equal(escapeHtml(undefined), '');
  assert.equal(escapeHtml(42), '42');
});

test('web/queue-lib.js 是 ESM 且可被 Node 直接 import（无 DOM 依赖）', () => {
  assert.equal(typeof groupTasks, 'function');
  assert.equal(typeof formToBody, 'function');
  assert.equal(typeof depHint, 'function');
});
