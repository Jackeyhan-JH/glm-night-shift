// issue #15 给 src/server.js 新增的 API 的端到端测试：GET /api/templates、POST /api/tasks
// 的模板渲染（走假 gh）与 dependsOn。通用的路由 / 防护行为在 test/server.test.js，这里
// 只测 #15 新增的部分。gh 替身与 fakeEnv 的说明见 test/helpers.js。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { systemClock } from '../src/clock.js';
import { openDb } from '../src/db.js';
import { createServer } from '../src/server.js';
import { fakeEnv, makeTempHome } from './helpers.js';

const JSON_HEADERS = { 'Content-Type': 'application/json' };

/** 起一个带指定 FAKE_GH_* 环境的服务（env 同时喂给 loadConfig 与 gh 子进程）。 */
function startServer(t, envOverrides = {}) {
  const home = makeTempHome(t);
  fs.mkdirSync(path.join(home, 'logs'), { recursive: true });
  const env = fakeEnv(envOverrides); // NIGHT_SHIFT_GH_BIN 已指向仓库里的假 gh
  const db = openDb(path.join(home, 'night-shift.db'));
  const config = loadConfig({ home, env });
  const server = createServer({ db, config, home, clock: systemClock(env), env });
  t.after(() => {
    server.close();
    server.closeAllConnections();
    db.close();
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve({ db, home, base: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

function postTask(base, body) {
  return fetch(`${base}/api/tasks`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body) });
}

// ---------- GET /api/templates ----------

test('验收: GET /api/templates 含 fix-issue：issue 必填、extra 可选，难度为模板的 medium，不泄漏服务端文件路径', async (t) => {
  const { base } = await startServer(t);
  const res = await fetch(`${base}/api/templates`);
  assert.equal(res.status, 200);
  const templates = await res.json();
  assert.ok(Array.isArray(templates) && templates.length > 0);
  const fix = templates.find((tpl) => tpl.name === 'fix-issue');
  assert.ok(fix !== undefined, '列表里有 fix-issue');
  assert.equal(fix.source, 'builtin');
  assert.equal(fix.difficulty, 'medium');
  const issue = fix.vars.find((v) => v.name === 'issue');
  assert.equal(issue.required, true);
  assert.equal(issue.default, null);
  const extra = fix.vars.find((v) => v.name === 'extra');
  assert.equal(extra.required, false);
  assert.ok(!('path' in fix), '不返回服务端文件绝对路径');
});

test('GET /api/templates 包含 <home>/templates 下的自定义模板（source=user）', async (t) => {
  const { base, home } = await startServer(t);
  fs.mkdirSync(path.join(home, 'templates'), { recursive: true });
  fs.writeFileSync(
    path.join(home, 'templates', 'my-tpl.md'),
    '---\ndescription: 自测模板\nvars: name\n---\n你好 {{name}}\n',
  );
  const templates = await (await fetch(`${base}/api/templates`)).json();
  const mine = templates.find((tpl) => tpl.name === 'my-tpl');
  assert.ok(mine !== undefined);
  assert.equal(mine.source, 'user');
  assert.equal(mine.description, '自测模板');
});

// ---------- POST /api/tasks：模板渲染 ----------

test('验收: POST /api/tasks 用 fix-issue 模板（FAKE_GH_ISSUE_JSON 设好）→ 201，标题为「修复 #12：…」，难度取模板默认', async (t) => {
  const { base } = await startServer(t, {
    FAKE_GH_ISSUE_JSON: '{"title":"登录报错","body":"点击登录返回 500"}',
  });
  const res = await postTask(base, { repo: 'a/b', template: 'fix-issue', vars: { issue: '12' } });
  assert.equal(res.status, 201);
  const task = await res.json();
  assert.equal(task.status, 'queued');
  assert.equal(task.title, '修复 #12：登录报错');
  assert.equal(task.difficulty, 'medium', '难度默认取模板的');
  assert.equal(task.testCommand, null, '模板未设置 testCommand');
  assert.ok(task.prompt.includes('点击登录返回 500'), 'prompt 里代入 issue 正文');
  assert.ok(task.prompt.includes('#12'), 'prompt 里代入 issue 编号');
});

test('验收: 模板缺必填变量 issue → 400 且 field 为 vars', async (t) => {
  const { base } = await startServer(t);
  const res = await postTask(base, { repo: 'a/b', template: 'fix-issue' });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.field, 'vars');
  assert.ok(body.error.includes('issue'), '报错点名缺失的变量');
});

test('验收: template 和 prompt 同时给 → 400（field 为 template）', async (t) => {
  const { base } = await startServer(t);
  const res = await postTask(base, { repo: 'a/b', template: 'fix-issue', vars: { issue: '1' }, prompt: 'y' });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.field, 'template');
  assert.ok(body.error.includes('prompt'));
});

test('验收: 模板渲染时 gh 失败（FAKE_GH_ISSUE_FAIL=1）→ 400 且 field 为 template', async (t) => {
  const { base } = await startServer(t, { FAKE_GH_ISSUE_FAIL: '1' });
  const res = await postTask(base, { repo: 'a/b', template: 'fix-issue', vars: { issue: '3' } });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.field, 'template');
  assert.ok(body.error.includes('渲染失败'));
  assert.ok(body.error.includes('gh'), '带 gh 的报错原因');
  // 渲染失败不应留下半个任务
  const tasks = await (await fetch(`${base}/api/tasks`)).json();
  assert.equal(tasks.length, 0);
});

test('显式字段覆盖模板默认值：title / difficulty / testCommand', async (t) => {
  const { base } = await startServer(t, {
    FAKE_GH_ISSUE_JSON: '{"title":"模板标题","body":"正文"}',
  });
  const res = await postTask(base, {
    repo: 'a/b',
    template: 'fix-issue',
    vars: { issue: '7' },
    title: '自定义标题',
    difficulty: 'hard',
    testCommand: 'npm test',
  });
  assert.equal(res.status, 201);
  const task = await res.json();
  assert.equal(task.title, '自定义标题');
  assert.equal(task.difficulty, 'hard');
  assert.equal(task.testCommand, 'npm test');
  assert.ok(task.prompt.includes('正文'), 'prompt 仍由模板渲染');
});

test('模板名不存在 → 400 field=template；vars 不是对象 → 400 field=vars；fetchIssue 模板缺 repo → 400 field=repo', async (t) => {
  const { base } = await startServer(t);

  const nope = await postTask(base, { repo: 'a/b', template: 'no-such', vars: {} });
  assert.equal(nope.status, 400);
  assert.equal((await nope.json()).field, 'template');

  const badVars = await postTask(base, { repo: 'a/b', template: 'fix-issue', vars: ['issue'] });
  assert.equal(badVars.status, 400);
  assert.equal((await badVars.json()).field, 'vars');

  const noRepo = await postTask(base, { template: 'fix-issue', vars: { issue: '1' } });
  assert.equal(noRepo.status, 400);
  assert.equal((await noRepo.json()).field, 'repo');
});

// ---------- POST /api/tasks：dependsOn ----------

test('验收: {"repo":"a/b","prompt":"y","dependsOn":[1]} 返回的任务 dependsOn 为 [1]；blockedBy 原样返回；dependsOn:[99] → 400', async (t) => {
  const { base } = await startServer(t);
  const first = await postTask(base, { repo: 'a/b', prompt: '先做这个' });
  assert.equal(first.status, 201);
  const firstId = (await first.json()).id;

  const res = await postTask(base, { repo: 'a/b', prompt: 'y', dependsOn: [firstId] });
  assert.equal(res.status, 201);
  const task = await res.json();
  assert.deepEqual(task.dependsOn, [firstId]);
  assert.deepEqual(task.blockedBy, [firstId], '依赖未成功时 blockedBy 原样返回');

  // 详情接口同样带依赖字段
  const detail = await (await fetch(`${base}/api/tasks/${task.id}`)).json();
  assert.deepEqual(detail.dependsOn, [firstId]);

  const missing = await postTask(base, { repo: 'a/b', prompt: 'z', dependsOn: [99] });
  assert.equal(missing.status, 400);
  assert.equal((await missing.json()).field, 'dependsOn');
});
