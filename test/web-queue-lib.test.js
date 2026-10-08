// web/queue-lib.js 的单元测试（issue #15 验收项）：纯函数在 node:test 里直接 import
// （模块不碰 DOM / fetch，只有 queue.js 才动浏览器环境）。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HISTORY_LIMIT,
  blockedHint,
  depHint,
  escapeHtml,
  firstLine,
  formToBody,
  groupTasks,
  pauseToggleView,
  prOutcomeLabel,
  repoWaitLabel,
  statusBarText,
} from '../web/queue-lib.js';
import { fmtTime } from '../web/common.js';

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

// ---------- 手动暂停的展示（#38） ----------

test('验收: pauseToggleView：userPaused true → 按钮「恢复领任务」、状态条带「已暂停领取」', () => {
  const view = pauseToggleView({ userPaused: true });
  assert.deepEqual(view, { paused: true, buttonLabel: '恢复领任务', pausedText: '已暂停领取' });
  // 按钮文案与暂停短语是两段不同的文字（不靠按钮本身展示暂停状态）
  assert.notEqual(view.buttonLabel, view.pausedText);
});

test('验收: userPaused false / 缺字段 / status 为 null → 按钮「暂停领任务」、不出现「已暂停领取」', () => {
  for (const status of [{ userPaused: false }, {}, null, undefined]) {
    const view = pauseToggleView(status);
    assert.deepEqual(view, { paused: false, buttonLabel: '暂停领任务', pausedText: '' }, JSON.stringify(status));
    assert.ok(!view.buttonLabel.includes('已暂停领取'), '未暂停时按钮文案不含暂停短语');
    assert.equal(view.pausedText, '', '未暂停时状态条不追加「已暂停领取」');
  }
});

test('pauseToggleView 与 statusBarText 组合：暂停时状态条文案 = 常规文案 · 已暂停领取', () => {
  const status = { peak: { peak: false }, usage: { fiveHour: { used: 16, limit: 1600 } }, runningCount: 2, userPaused: true };
  const view = pauseToggleView(status);
  const rendered = view.pausedText === ''
    ? statusBarText(status)
    : `${statusBarText(status)} · ${view.pausedText}`;
  assert.equal(rendered, '非高峰时段 · 5 小时额度 1.0%（16/1600） · 运行中 2 个 · 已暂停领取');
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

// ---------- 队列行的 PR 结果标签（#62） ----------

test('验收: prOutcome 为 merged 的成功任务 → 「已合并」，且 task.status 仍是 succeeded（函数不改状态）', () => {
  const task = { id: 4, status: 'succeeded', prOutcome: 'merged' };
  assert.equal(prOutcomeLabel(task), '已合并');
  assert.equal(task.status, 'succeeded', '任务状态不被改');
});

test('验收: prOutcome 为 closed → 「已关闭」', () => {
  const task = { id: 5, status: 'succeeded', prOutcome: 'closed' };
  assert.equal(prOutcomeLabel(task), '已关闭');
  assert.equal(task.status, 'succeeded');
});

test('验收: open / null / 缺字段 / 空串 → 空串，返回值里既没有「已合并」也没有「已关闭」', () => {
  const cases = [
    { id: 1, status: 'succeeded', prOutcome: 'open' },
    { id: 2, status: 'succeeded', prOutcome: null },
    { id: 3, status: 'succeeded' }, // 不带 prOutcome 字段
    { id: 4, status: 'succeeded', prOutcome: '' },
    { id: 5, status: 'succeeded', prOutcome: undefined },
  ];
  for (const task of cases) {
    const label = prOutcomeLabel(task);
    assert.equal(label, '', `prOutcome=${String(task.prOutcome)} 不显示`);
    assert.ok(!label.includes('已合并'), '不出现「已合并」');
    assert.ok(!label.includes('已关闭'), '不出现「已关闭」');
  }
});

test('验收: 大小写不同或带空白的值（MERGED / closed ）→ 空串（只认全等）', () => {
  for (const value of ['MERGED', 'CLOSED', 'merged ', 'closed ', 'Merged', 1, true]) {
    const label = prOutcomeLabel({ status: 'succeeded', prOutcome: value });
    assert.equal(label, '', `prOutcome=${JSON.stringify(value)} 不显示`);
  }
});

test('验收: 函数不修改入参对象（含 task 为 null / undefined 不抛错）', () => {
  const task = { id: 9, status: 'succeeded', prOutcome: 'merged', title: '标题' };
  const before = structuredClone(task);
  prOutcomeLabel(task);
  assert.deepEqual(task, before);
  assert.equal(prOutcomeLabel(null), '');
  assert.equal(prOutcomeLabel(undefined), '');
});

// ---------- 状态条的「为什么还没领」（#74） ----------

/** 与 queue.js 的 renderStatusBar 相同的拼接（顺序写清楚：常规文案 → 拦截一句 →
 * 已暂停领取，' · ' 分隔；空段不接）。 */
function statusLine(status) {
  const parts = [statusBarText(status)];
  const hint = blockedHint(status);
  if (hint !== '') parts.push(hint);
  const { pausedText } = pauseToggleView(status);
  if (pausedText !== '') parts.push(pausedText);
  return parts.join(' · ');
}

test('验收: blocked.reason=five-hour 且 retryAt 为 ISO：整句 + 「；预计 <本地时间到分钟> 恢复」；与 statusBarText 拼接后额度百分比还在', () => {
  const retryAt = '2026-10-08T16:30:00.000Z';
  const status = {
    peak: { peak: false },
    usage: { fiveHour: { used: 16, limit: 1600 } },
    runningCount: 2,
    scheduler: { blocked: { reason: 'five-hour', retryAt } },
  };
  assert.equal(blockedHint(status), `5 小时额度已达安全阈值；预计 ${fmtTime(retryAt)} 恢复`);
  const line = statusLine(status);
  assert.ok(line.includes('5 小时额度 1.0%（16/1600）'), '原有的额度百分比那段还在');
  assert.ok(line.includes('5 小时额度已达安全阈值；预计 '), '拦截句接在常规文案后面');
});

test('验收: five-hour 没有 retryAt：正好「5 小时额度已达安全阈值」，不含「预计」', () => {
  assert.equal(
    blockedHint({ scheduler: { blocked: { reason: 'five-hour', retryAt: null } } }),
    '5 小时额度已达安全阈值',
  );
  // retryAt 字段整个缺失也一样
  assert.equal(
    blockedHint({ scheduler: { blocked: { reason: 'five-hour' } } }),
    '5 小时额度已达安全阈值',
  );
  assert.ok(!blockedHint({ scheduler: { blocked: { reason: 'five-hour' } } }).includes('预计'));
});

test('验收: weekly 带 retryAt：「每周额度已达安全阈值」加同样的「；预计 … 恢复」后缀', () => {
  const retryAt = '2026-10-09T01:05:00.000Z';
  assert.equal(
    blockedHint({ scheduler: { blocked: { reason: 'weekly', retryAt } } }),
    `每周额度已达安全阈值；预计 ${fmtTime(retryAt)} 恢复`,
  );
});

test('验收: rate-limit 带 retryAt：「触发限流，全局退避中」加同样的后缀', () => {
  const retryAt = '2026-10-08T18:00:00.000Z';
  assert.equal(
    blockedHint({ scheduler: { blocked: { reason: 'rate-limit', retryAt } } }),
    `触发限流，全局退避中；预计 ${fmtTime(retryAt)} 恢复`,
  );
});

test('验收: blocked 为 null：空串（调用方一个字都不接）', () => {
  assert.equal(blockedHint({ scheduler: { blocked: null } }), '');
  assert.equal(blockedHint({ scheduler: { blocked: null }, userPaused: true }), '');
});

test('验收: scheduler 为 null / 缺 scheduler / status 为 null：空串', () => {
  assert.equal(blockedHint({ scheduler: null }), '');
  assert.equal(blockedHint({}), '');
  assert.equal(blockedHint(null), '');
  assert.equal(blockedHint(undefined), '');
});

test('验收: reason 为 peak（即使带 retryAt）：空串，返回值不含「暂不领新任务」', () => {
  for (const blocked of [
    { reason: 'peak', retryAt: '2026-10-08T16:30:00.000Z' },
    { reason: 'peak', retryAt: null },
    { reason: 'no-such-reason', retryAt: '2026-10-08T16:30:00.000Z' },
    { reason: 'FIVE-HOUR', retryAt: '2026-10-08T16:30:00.000Z' },
  ]) {
    const hint = blockedHint({ scheduler: { blocked } });
    assert.equal(hint, '', JSON.stringify(blocked));
    assert.ok(!hint.includes('暂不领新任务'), '不出现「暂不领新任务」');
    assert.ok(!hint.includes('高峰期，暂不领新任务'), '也不出现「高峰期，暂不领新任务」');
  }
});

test('验收: 非法 retryAt：不接「预计」（也不写出「预计 - 恢复」）', () => {
  for (const retryAt of ['not-a-time', '']) {
    const hint = blockedHint({ scheduler: { blocked: { reason: 'weekly', retryAt } } });
    assert.equal(hint, '每周额度已达安全阈值', `retryAt=${JSON.stringify(retryAt)}`);
    assert.ok(!hint.includes('预计'), '不接「预计」半句');
  }
});

test('验收: 暂停视图与 blockedHint 同时非空：拼出的状态条同时有额度那句、拦截句和「已暂停领取」', () => {
  const retryAt = '2026-10-08T16:30:00.000Z';
  const status = {
    peak: { peak: false },
    usage: { fiveHour: { used: 16, limit: 1600 } },
    runningCount: 2,
    userPaused: true,
    scheduler: { blocked: { reason: 'rate-limit', retryAt } },
  };
  // 与 renderStatusBar 相同的拼接：常规文案 · 拦截一句 · 已暂停领取
  assert.equal(
    statusLine(status),
    `非高峰时段 · 5 小时额度 1.0%（16/1600） · 运行中 2 个`
      + ` · 触发限流，全局退避中；预计 ${fmtTime(retryAt)} 恢复 · 已暂停领取`,
  );
});

test('验收: blockedHint 不修改入参', () => {
  const status = {
    peak: { peak: true },
    scheduler: { blocked: { reason: 'rate-limit', retryAt: '2026-10-08T16:30:00.000Z' } },
    userPaused: false,
  };
  const before = structuredClone(status);
  blockedHint(status);
  assert.deepEqual(status, before);
});

// ---------- 排队行的「等这个仓库」（#74） ----------

test('验收: oneTaskPerRepo=true，#1 running、#2 queued 且 repo 相同：#2 得「等这个仓库」，#1 空串', () => {
  const tasks = [
    { id: 1, status: 'running', repo: 'a/b' },
    { id: 2, status: 'queued', repo: 'a/b' },
  ];
  const config = { oneTaskPerRepo: true };
  assert.equal(repoWaitLabel(tasks[1], tasks, config), '等这个仓库');
  assert.equal(repoWaitLabel(tasks[0], tasks, config), '');
});

test('验收: oneTaskPerRepo=false：空串', () => {
  const tasks = [
    { id: 1, status: 'running', repo: 'a/b' },
    { id: 2, status: 'queued', repo: 'a/b' },
  ];
  assert.equal(repoWaitLabel(tasks[1], tasks, { oneTaskPerRepo: false }), '');
});

test('验收: config 为 null、缺 oneTaskPerRepo、值为字符串 "true"：空串（不假设默认开）', () => {
  const tasks = [
    { id: 1, status: 'running', repo: 'a/b' },
    { id: 2, status: 'queued', repo: 'a/b' },
  ];
  const queued = tasks[1];
  assert.equal(repoWaitLabel(queued, tasks, null), '');
  assert.equal(repoWaitLabel(queued, tasks, undefined), '');
  assert.equal(repoWaitLabel(queued, tasks, {}), '');
  assert.equal(repoWaitLabel(queued, tasks, { oneTaskPerRepo: 'true' }), '');
  assert.equal(repoWaitLabel(queued, tasks, { oneTaskPerRepo: 1 }), '');
});

test('验收: 同一 repo 两条都是 queued、没有 running：空串；running 的是别的 repo：空串（严格全等，不折叠大小写、不 trim）', () => {
  const config = { oneTaskPerRepo: true };
  const bothQueued = [
    { id: 1, status: 'queued', repo: 'a/b' },
    { id: 2, status: 'queued', repo: 'a/b' },
  ];
  assert.equal(repoWaitLabel(bothQueued[1], bothQueued, config), '');
  const otherRepo = [
    { id: 1, status: 'running', repo: 'c/d' },
    { id: 2, status: 'queued', repo: 'a/b' },
  ];
  assert.equal(repoWaitLabel(otherRepo[1], otherRepo, config), '');
  // 大小写不同 / 带空白：不算同仓库
  assert.equal(
    repoWaitLabel({ id: 2, status: 'queued', repo: 'a/b' },
      [{ id: 1, status: 'running', repo: 'A/B' }], config),
    '',
  );
  assert.equal(
    repoWaitLabel({ id: 2, status: 'queued', repo: 'a/b' },
      [{ id: 1, status: 'running', repo: ' a/b' }], config),
    '',
  );
  // 终态任务（成功/失败/取消）也不挡领取，不显示
  for (const status of ['succeeded', 'failed', 'canceled']) {
    assert.equal(
      repoWaitLabel({ id: 2, status: 'queued', repo: 'a/b' },
        [{ id: 1, status, repo: 'a/b' }], config),
      '',
      `status=${status}`,
    );
  }
});

test('验收: repoWaitLabel 不修改入参；task / tasks / config 残缺不抛错', () => {
  const task = { id: 2, status: 'queued', repo: 'a/b' };
  const tasks = [{ id: 1, status: 'running', repo: 'a/b' }];
  const config = { oneTaskPerRepo: true };
  const snapshot = structuredClone({ task, tasks, config });
  repoWaitLabel(task, tasks, config);
  assert.deepEqual({ task, tasks, config }, snapshot);
  assert.doesNotThrow(() => repoWaitLabel(null, tasks, config));
  assert.doesNotThrow(() => repoWaitLabel(undefined, tasks, config));
  assert.doesNotThrow(() => repoWaitLabel(task, null, config));
  assert.doesNotThrow(() => repoWaitLabel(task, undefined, config));
  assert.doesNotThrow(() => repoWaitLabel(null, null, null));
});
