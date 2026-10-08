// issue #68（详情页「跟进」按钮）的服务端验收：POST /api/tasks/:id/follow。
// 判定必须与命令行 follow <id> 同一份（followTask），不另写一套；手动操作不套调度器
// 自动跟进的「高峰不查」。createServer 收 fakeEnv 的 env（NIGHT_SHIFT_GH_BIN 指向
// test/fixtures/fake-gh.mjs），followTask 的子进程才拿得到 FAKE_GH_* 开关——绝不联网、
// 不碰真实 ~/.glm-night-shift、不改 process.env。
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db.js';
import { isPeak } from '../src/peak.js';
import { createServer } from '../src/server.js';
import { claimTaskById, createTask, finishTask, listTasks } from '../src/tasks.js';
import { fakeEnv, makeTempHome } from './helpers.js';

// ---------- 辅助（与 test/settings.test.js 同款口径，env 走 fakeEnv） ----------

/** 起一个真服务：临时 NIGHT_SHIFT_HOME + fakeEnv（假 gh）；返回基地址与库 / 配置。 */
function startServer(t, envOverrides = {}) {
  const home = makeTempHome(t);
  const env = fakeEnv({ NIGHT_SHIFT_HOME: home, ...envOverrides });
  const db = openDb(path.join(home, 'night-shift.db'));
  const config = loadConfig({ home, env });
  const server = createServer({ db, config, home, env });
  t.after(() => {
    server.close();
    server.closeAllConnections();
    db.close();
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve({ base: `http://127.0.0.1:${server.address().port}`, db, config });
    });
  });
}

/**
 * 在库里造一个「已成功且开了 PR」的父任务：createTask → claimTaskById（queued →
 * running）→ finishTask(succeeded, prUrl, branch)。branch 必须 night-shift/ 开头，
 * 否则 followTask 会 409。prOutcome 缺省不动（null），要用 setPrOutcome 单独改。
 */
function seedSucceeded(db, { prUrl = 'https://github.com/a/b/pull/9', branch = 'night-shift/1-fix' } = {}) {
  const created = createTask(db, { repo: 'a/b', prompt: '做点修改', title: 'fix login bug' });
  claimTaskById(db, created.id);
  finishTask(db, created.id, { status: 'succeeded', prUrl, branch });
  return created.id;
}

/** prOutcome 只能走 SQL（tasks.js 没有对外接口，也不为此改它）。 */
function setPrOutcome(db, id, outcome) {
  db.prepare('UPDATE tasks SET pr_outcome = ? WHERE id = ?').run(outcome, id);
}

/** gh pr view 的标准 JSON（fake gh 原样回吐）；与 test/follow.test.js 的同名帮手同形状。 */
function prViewJson({ reviewDecision = 'CHANGES_REQUESTED', reviews = [], state, mergeable } = {}) {
  return JSON.stringify({
    reviewDecision, reviews, url: 'https://github.com/a/b/pull/9',
    headRefName: 'night-shift/1-fix', state, mergeable,
  });
}

/** POST JSON（按钮发的就是空对象 {}；个别用例给多余键）。 */
async function postJson(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

const countTasks = (db) => db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n;

// ---------- 会创建（201） ----------

test('验收: reviewDecision 是 CHANGES_REQUESTED：POST {} 返回 201，正文与 followTask 一致，库里多一条 queued 跟进任务（autoFollowReviews 保持默认 false）', async (t) => {
  const { base, db, config } = await startServer(t, {
    FAKE_GH_PR_VIEW_JSON: prViewJson({ reviews: [{ id: 7, state: 'CHANGES_REQUESTED', body: '请改登录判断' }] }),
  });
  assert.equal(config.autoFollowReviews, false, '前提：配置保持默认，不靠自动跟进');
  const parentId = seedSucceeded(db);
  const before = countTasks(db);

  const { status, body } = await postJson(`${base}/api/tasks/${parentId}/follow`, {});
  assert.equal(status, 201);

  // 库里多了一条 queued 跟进任务，正文与它对得上（id / branch / source 同源）
  const queued = listTasks(db, { status: 'queued' });
  assert.equal(queued.length, 1, '跟进任务已入队');
  assert.equal(countTasks(db), before + 1);
  assert.equal(queued[0].gitRef, 'night-shift/1-fix', 'gitRef 用父任务分支');
  assert.equal(queued[0].repo, 'a/b');
  assert.deepEqual(body, {
    kind: 'created',
    id: queued[0].id,
    parentId,
    branch: 'night-shift/1-fix',
    source: 'pr-review:a/b#9:7',
  });
});

test('验收: NIGHT_SHIFT_NOW 处于高峰（src/peak.js 判真）时仍 201、仍入队：手动跟进不套「高峰不查」', async (t) => {
  const peakNow = '2026-10-05T06:30:00.000Z'; // 北京时间周一 14:30，在 14:00～18:00 内
  assert.equal(isPeak(new Date(peakNow)), true, '前提：选定的时刻确是高峰');
  const { base, db } = await startServer(t, {
    NIGHT_SHIFT_NOW: peakNow,
    FAKE_GH_PR_VIEW_JSON: prViewJson({ reviews: [{ id: 3, state: 'CHANGES_REQUESTED', body: '' }] }),
  });
  const parentId = seedSucceeded(db);

  const { status, body } = await postJson(`${base}/api/tasks/${parentId}/follow`, {});
  assert.equal(status, 201);
  assert.equal(body.parentId, parentId);
  assert.equal(countTasks(db), 2, '高峰也照样入队');
});

// ---------- 跳过（200） ----------

test('验收: reviewDecision 不是 CHANGES_REQUESTED（APPROVED，reviews 空或只有 APPROVED）→ 200，message 正好是「没有待处理的修改请求」，任务条数不变', async (t) => {
  for (const reviews of [[], [{ id: 5, state: 'APPROVED', body: '没问题' }]]) {
    const { base, db } = await startServer(t, {
      FAKE_GH_PR_VIEW_JSON: prViewJson({ reviewDecision: 'APPROVED', reviews }),
    });
    const parentId = seedSucceeded(db);
    const before = countTasks(db);

    const { status, body } = await postJson(`${base}/api/tasks/${parentId}/follow`, {});
    assert.equal(status, 200, `reviews=${JSON.stringify(reviews)}`);
    assert.deepEqual(body, { kind: 'skipped', parentId, message: '没有待处理的修改请求' });
    assert.equal(countTasks(db), before);
  }
});

test('验收: pr_outcome 已是 merged / closed 且 FAKE_GH_PR_VIEW_FAIL=1 → 200「PR 已合并」/「PR 已关闭」：一次 gh 都没调（调了假 gh 会失败成 502）', async (t) => {
  for (const [outcome, message] of [['merged', 'PR 已合并'], ['closed', 'PR 已关闭']]) {
    const { base, db } = await startServer(t, { FAKE_GH_PR_VIEW_FAIL: '1' });
    const parentId = seedSucceeded(db);
    setPrOutcome(db, parentId, outcome);
    const before = countTasks(db);

    const { status, body } = await postJson(`${base}/api/tasks/${parentId}/follow`, {});
    assert.equal(status, 200, outcome);
    assert.deepEqual(body, { kind: 'skipped', parentId, message });
    assert.equal(countTasks(db), before);
  }
});

test('验收: 已有同 source 的跟进任务 → 200「已经入队 #<id>（queued）」，不再建新任务', async (t) => {
  const { base, db } = await startServer(t, {
    FAKE_GH_PR_VIEW_JSON: prViewJson({ reviews: [{ id: 7, state: 'CHANGES_REQUESTED', body: '请改' }] }),
  });
  const parentId = seedSucceeded(db);
  const first = await postJson(`${base}/api/tasks/${parentId}/follow`, {});
  assert.equal(first.status, 201);

  const second = await postJson(`${base}/api/tasks/${parentId}/follow`, {});
  assert.equal(second.status, 200);
  assert.deepEqual(second.body, {
    kind: 'skipped',
    parentId,
    message: `已经入队 #${first.body.id}（queued）`,
  });
  assert.equal(countTasks(db), 2);
});

// ---------- 失败（400 / 409 / 502 / 404） ----------

test('验收: 状态仍是 queued（不 finish）且 FAIL=1 → 409，error 含「不能跟进」，不是 502，任务条数不变', async (t) => {
  const { base, db } = await startServer(t, { FAKE_GH_PR_VIEW_FAIL: '1' });
  const created = createTask(db, { repo: 'a/b', prompt: '做点修改', title: '还没跑完' });
  const before = countTasks(db);

  const { status, body } = await postJson(`${base}/api/tasks/${created.id}/follow`, {});
  assert.equal(status, 409);
  assert.ok(body.error.includes('不能跟进'), body.error);
  assert.ok(!body.error.includes('gh pr view 失败'), `不是 gh 的错：${body.error}`);
  assert.equal(countTasks(db), before);
});

test('验收: 正文 {"force": true} 且 FAIL=1 → 400 点名 force，不是 502，任务条数不变（一次 gh 都不调、不建任务）', async (t) => {
  const { base, db } = await startServer(t, { FAKE_GH_PR_VIEW_FAIL: '1' });
  const parentId = seedSucceeded(db);
  const before = countTasks(db);

  const { status, body } = await postJson(`${base}/api/tasks/${parentId}/follow`, { force: true });
  assert.equal(status, 400);
  assert.ok(body.error.includes('force'), body.error);
  assert.equal(body.field, 'force');
  assert.equal(countTasks(db), before);
});

test('验收: 已成功、prOutcome 不是 merged/closed、FAIL=1、正文 {} → 502，error 含「gh pr view 失败」，不新建任务', async (t) => {
  const { base, db } = await startServer(t, { FAKE_GH_PR_VIEW_FAIL: '1' });
  const parentId = seedSucceeded(db);
  const before = countTasks(db);

  const { status, body } = await postJson(`${base}/api/tasks/${parentId}/follow`, {});
  assert.equal(status, 502);
  assert.ok(body.error.includes('gh pr view 失败'), body.error);
  assert.ok(body.error.includes(`任务 #${parentId} 的`), `是 followTask 包出来的那句：${body.error}`);
  assert.equal(countTasks(db), before);
});

test('验收: id 不存在 → 404（与 GET 详情同一条 NotFoundError）', async (t) => {
  const { base } = await startServer(t);
  const { status, body } = await postJson(`${base}/api/tasks/999/follow`, {});
  assert.equal(status, 404);
  assert.ok(typeof body.error === 'string' && body.error !== '');
});

// ---------- 与取消 / 重试同一套防护 ----------

test('验收: Content-Type: text/plain → 415；跨站 Origin → 403；都不建任务', async (t) => {
  const { base, db } = await startServer(t);
  const parentId = seedSucceeded(db);
  const before = countTasks(db);

  const plain = await fetch(`${base}/api/tasks/${parentId}/follow`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: '{}',
  });
  assert.equal(plain.status, 415);

  const evil = await fetch(`${base}/api/tasks/${parentId}/follow`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'http://evil.example' },
    body: '{}',
  });
  assert.equal(evil.status, 403);
  assert.equal(countTasks(db), before);
});
