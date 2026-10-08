// 队列页「修改排队中的任务」的测试（issue #46 验收项）：编辑相关的纯函数在
// web/queue-lib.js（不碰 DOM / fetch，node:test 直接 import）；queue.js 在 import 时就
// 碰 document，不从这里 import——它的行为靠纯函数 + 真实后端串起来断言（起随机端口
// 的 createServer，与 server.test.js 同一条代码路径）。
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { systemClock } from '../src/clock.js';
import { openDb } from '../src/db.js';
import { createServer } from '../src/server.js';
import { claimNextTask, createTask } from '../src/tasks.js';
import { editBody, formModeView, groupTasks, taskRowActions, taskToForm } from '../web/queue-lib.js';
import { makeTempHome } from './helpers.js';

// ---------- 行操作按钮（#46：排队中的行在「取消」旁边加「修改」） ----------

test('验收: 排队中的行操作 = 取消 + 修改（data-action="edit"）；运行中只有取消；历史仍是重试', () => {
  const button = (action, label, id) =>
    `<button type="button" class="row-action" data-action="${action}" data-id="${id}">${label}</button>`;
  assert.equal(taskRowActions({ id: 3, status: 'queued' }),
    `${button('cancel', '取消', 3)}${button('edit', '修改', 3)}`);
  assert.equal(taskRowActions({ id: 4, status: 'running' }), button('cancel', '取消', 4));
  assert.equal(taskRowActions({ id: 5, status: 'succeeded' }), button('retry', '重试', 5));
  assert.equal(taskRowActions({ id: 6, status: 'failed' }), button('retry', '重试', 6));
  assert.equal(taskRowActions({ id: 7, status: 'canceled' }), button('retry', '重试', 7));
});

// ---------- 表单模式视图（编辑 ↔ 新增） ----------

test('验收: 编辑模式：标题「修改任务 #3」、提交按钮「保存修改」、「取消编辑」可见；null = 新增模式', () => {
  assert.deepEqual(formModeView({ id: 3 }), {
    editing: true,
    heading: '修改任务 #3',
    submitLabel: '保存修改',
    cancelEditVisible: true,
  });
  assert.deepEqual(formModeView(null), {
    editing: false,
    heading: '新增任务',
    submitLabel: '新增任务',
    cancelEditVisible: false,
  });
  // 保存成功 / 取消编辑都回到同一视图：标题与按钮都变回「新增任务」
  const back = formModeView(null);
  assert.ok(!back.heading.includes('修改'));
  assert.ok(!back.submitLabel.includes('保存'));
});

// ---------- 任务 → 表单值 ----------

test('验收: taskToForm 把任务值装进表单（提示词/标题/难度/优先级/测试命令/高峰/尝试次数/依赖），编辑不用模板', () => {
  assert.deepEqual(taskToForm({
    id: 2, repo: 'a/b', prompt: '提示', title: '标题', difficulty: 'easy', priority: -1,
    testCommand: 'npm test', allowPeak: true, maxAttempts: 5, dependsOn: [1, 3], status: 'queued',
  }), {
    repo: 'a/b',
    template: '', // 编辑不用模板（模板是建任务时渲染提示词用的）
    vars: {},
    prompt: '提示',
    title: '标题',
    difficulty: 'easy',
    priority: -1,
    testCommand: 'npm test',
    allowPeak: true,
    maxAttempts: 5,
    dependsOn: ['1', '3'], // 与 <option value> 一致的字符串
  });
  const blank = taskToForm({
    id: 3, repo: 'c/d', prompt: 'p', title: 't', priority: 0, testCommand: null,
    allowPeak: false, maxAttempts: 2, dependsOn: [],
  });
  assert.equal(blank.testCommand, '', 'null 转空串');
  assert.equal(blank.allowPeak, false);
  assert.deepEqual(blank.dependsOn, []);
});

// ---------- 表单 → PATCH 请求体 ----------

/** updateTask 允许的 PATCH 字段（与 src/server.js 的白名单一致）。 */
const EDITABLE = new Set([
  'title', 'prompt', 'difficulty', 'priority', 'testCommand', 'allowPeak', 'maxAttempts', 'dependsOn',
]);

test('验收: editBody 绝不带 repo（及任何禁改/未知键），键全部在 PATCH 白名单内', () => {
  const form = taskToForm({
    id: 1, repo: 'a/b', prompt: 'p', title: 't', difficulty: 'hard', priority: 3,
    testCommand: 'npm test', allowPeak: true, maxAttempts: 4, dependsOn: [2], status: 'queued',
  });
  form.repo = 'x/y'; // 新增表单的 formToBody 总是发 repo；编辑绝不能发
  const body = editBody(form);
  for (const key of Object.keys(body)) {
    assert.ok(EDITABLE.has(key), `请求体不应出现 ${key}`);
  }
  assert.equal('repo' in body, false);
  assert.equal('template' in body, false);
  assert.equal('vars' in body, false);
  assert.deepEqual(body, {
    prompt: 'p', title: 't', difficulty: 'hard', priority: 3,
    testCommand: 'npm test', allowPeak: true, maxAttempts: 4,
  });
});

test('editBody：文本 trim、空可选字段不发（= 保持原值）、非法数字不发、allowPeak 恒发', () => {
  assert.deepEqual(editBody({
    repo: 'a/b', prompt: '  p  ', title: ' t ', difficulty: 'hard', priority: '2',
    testCommand: ' cmd ', allowPeak: true, maxAttempts: '3', template: '', vars: {}, dependsOn: [],
  }), { prompt: 'p', title: 't', difficulty: 'hard', priority: 2, testCommand: 'cmd', allowPeak: true, maxAttempts: 3 });

  assert.deepEqual(editBody({
    repo: 'a/b', prompt: ' ', title: '', difficulty: 'medium', priority: 'abc',
    testCommand: '', allowPeak: false, maxAttempts: '0', template: 'tpl', vars: { issue: '1' }, dependsOn: ['1'],
  }), { difficulty: 'medium', allowPeak: false }, '空/非法的可选字段不进请求体，模板相关字段丢弃');
});

// ---------- 页面主链路（纯函数 + 真实后端，无浏览器） ----------

test('验收: 队列页点「修改」、改一句说明保存：那一行变成新说明，表单回到新增', async (t) => {
  const home = makeTempHome(t);
  const db = openDb(path.join(home, 'night-shift.db'));
  const config = loadConfig({ home, env: {} });
  const server = createServer({ db, config, home, clock: systemClock({}) });
  t.after(() => {
    server.close();
    server.closeAllConnections();
    db.close();
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const task = createTask(db, { repo: 'a/b', prompt: '修一下登录', title: '旧说明' });

  // 排队中的行有「修改」按钮
  assert.ok(taskRowActions(task).includes('data-action="edit"'));
  // 点「修改」：现有表单装进任务值，切到编辑模式（标题/按钮文案）
  const form = taskToForm(task);
  const mode = formModeView(task);
  assert.equal(mode.heading, `修改任务 #${task.id}`);
  assert.equal(mode.submitLabel, '保存修改');
  // 用户改一句说明后保存：提交 PATCH（不带 repo），按钮是「保存修改」
  form.title = '新说明：排队时补了一句';
  const res = await fetch(`${base}/api/tasks/${task.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(editBody(form)),
  });
  assert.equal(res.status, 200);
  // 表格重绘（排队中标签的行数据来自 groupTasks）后那一行是新说明
  const tasks = await (await fetch(`${base}/api/tasks`)).json();
  const queued = groupTasks(tasks).queued;
  assert.equal(queued.length, 1);
  assert.equal(queued[0].id, task.id);
  assert.equal(queued[0].title, '新说明：排队时补了一句');
  // 保存成功后表单回到新增模式
  const back = formModeView(null);
  assert.equal(back.heading, '新增任务');
  assert.equal(back.submitLabel, '新增任务');
  assert.equal(back.cancelEditVisible, false);
});

test('修改失败（任务已被领取）走 409，页面会拿到错误文本而不是静默', async (t) => {
  const home = makeTempHome(t);
  const db = openDb(path.join(home, 'night-shift.db'));
  const config = loadConfig({ home, env: {} });
  const server = createServer({ db, config, home, clock: systemClock({}) });
  t.after(() => {
    server.close();
    server.closeAllConnections();
    db.close();
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const task = createTask(db, { repo: 'a/b', prompt: 'x', title: '旧' });
  claimNextTask(db); // 轮询间隙被调度器领走 → running

  // 页面侧：表单还停在编辑模式，提交 PATCH → 409，错误文本进现有错误条（err.message）
  const body = editBody({ ...taskToForm(task), title: '不该生效' });
  const res = await fetch(`${base}/api/tasks/${task.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  assert.equal(res.status, 409);
  const payload = await res.json();
  assert.ok(payload.error.includes('只有排队中的任务可以修改'), payload.error);
  assert.ok(payload.error.includes('running'), payload.error);
});
