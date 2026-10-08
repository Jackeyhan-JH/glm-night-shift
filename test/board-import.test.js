// 看板导入与清理（issue #50）的测试：POST /api/import / POST /api/cleanup 的端到端
// 行为，加上队列页新纯函数（仓库筛选、预览/确认请求体、结果文案）。起服务的方式照
// test/server-templates.test.js（createServer 的 env 注入 FAKE_GH_*，config.ghBin 指到
// 仓库里的假 gh）；cleanup 的目录造数照 test/cleanup.test.js（本地 bare 仓库当远端，
// 不联网）。queue.js 在 import 时就碰 document，不从这里 import——页面行为靠纯函数 +
// 真实后端串起来断言。
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { systemClock } from '../src/clock.js';
import { openDb } from '../src/db.js';
import { createServer } from '../src/server.js';
import {
  claimNextTask,
  cancelTask,
  createTask,
  finishTask,
  listTasks,
} from '../src/tasks.js';
import { createWorktree, ensureRepoCache } from '../src/git.js';
import {
  REPO_FILTER_ALL,
  filterTasksByRepo,
  importBody,
  importPreviewText,
  repoFilterOptions,
  taskRowActions,
} from '../web/queue-lib.js';
import { fakeEnv, fixturePath, makeTempHome } from './helpers.js';

// 隔离 git 配置（node:test 每个文件独立进程）：不读机器的系统/全局配置；提交身份用
// 环境变量显式给（照 test/cleanup.test.js）。fakeEnv() 基于 process.env 复制，server
// 里 cleanup 跑的 git 也会带上。
process.env.GIT_CONFIG_NOSYSTEM = '1';
process.env.GIT_CONFIG_GLOBAL = path.join(os.tmpdir(), 'night-shift-board-test-absent-global-config');
process.env.GIT_AUTHOR_NAME = '夜班测试';
process.env.GIT_AUTHOR_EMAIL = 'night-shift-test@example.com';
process.env.GIT_COMMITTER_NAME = '夜班测试';
process.env.GIT_COMMITTER_EMAIL = 'night-shift-test@example.com';

const DAY_MS = 86_400_000;
const JSON_HEADERS = { 'Content-Type': 'application/json' };
const wtPath = (home, id) => path.join(home, 'worktrees', `task-${id}`);

/** POST JSON（可带额外请求头，如恶意 Origin）。 */
function postJson(url, body, extraHeaders = {}) {
  return fetch(url, {
    method: 'POST',
    headers: { ...JSON_HEADERS, ...extraHeaders },
    body: JSON.stringify(body),
  });
}

/** 起一个带指定 FAKE_GH_* 环境的服务（env 同时喂给 loadConfig 与 gh 子进程）。 */
function startServer(t, { env: envOverrides = {}, home: homeOverride } = {}) {
  const home = homeOverride ?? makeTempHome(t);
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

// ---------------------------------------------------------------- cleanup 造数（照 test/cleanup.test.js）

/** 同步跑 git（参数数组，无 shell），失败即断言失败并附 stderr。 */
function git(args, cwd) {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.ok(res.status === 0, `git ${args.join(' ')} 失败（cwd=${cwd}）：${res.stderr}`);
  return res.stdout;
}

/** 建一个本地 bare 仓库当远端（main 分支 + 一个提交）。 */
function makeBareRemote(t) {
  const dir = makeTempHome(t);
  const bare = path.join(dir, 'a__b.git');
  git(['init', '--bare', '-q', '-b', 'main', bare]);
  const seed = path.join(dir, 'seed');
  git(['clone', '--quiet', bare, seed]);
  git(['symbolic-ref', 'HEAD', 'refs/heads/main'], seed);
  fs.writeFileSync(path.join(seed, 'README.md'), '# a/b\n');
  git(['add', '-A'], seed);
  git(['commit', '--quiet', '-m', 'init'], seed);
  git(['push', '--quiet', 'origin', 'HEAD:refs/heads/main'], seed);
  return { dir, bare };
}

/**
 * cleanup 测试的常用前置：bare 远端 + 数据目录 + 仓库缓存 + 打开的服务（config 的
 * remoteUrlTemplate 指向本地 bare 仓库）。测试结束自动关连接、停服务。
 */
async function startCleanupServer(t, { env: envOverrides = {} } = {}) {
  const remote = makeBareRemote(t);
  const home = makeTempHome(t);
  const config = { remoteUrlTemplate: path.join(remote.dir, '{owner}__{name}.git') };
  await ensureRepoCache({ home, repo: 'a/b', config });
  const { db, base } = await startServer(t, { home, env: envOverrides });
  return { db, home, base };
}

/** 建任务并配好 worktree，状态随意（queued / running / succeeded / failed / canceled）。 */
async function makeTask({ db, home, status }) {
  const task = createTask(db, { repo: 'a/b', prompt: `提示词 ${status}`, title: `${status} 任务` });
  if (status === 'canceled') {
    cancelTask(db, task.id); // queued → canceled，从未被领取
  } else if (status !== 'queued') {
    const claimed = claimNextTask(db);
    assert.ok(claimed !== null && claimed.id === task.id, '刚建的任务应被立刻领到');
    if (status !== 'running') finishTask(db, task.id, { status });
  }
  assert.equal(listTasks(db).find((t) => t.id === task.id).status, status);
  await createWorktree({ home, repo: 'a/b', task, baseBranch: 'main' });
  assert.ok(fs.existsSync(wtPath(home, task.id)), 'worktree 应建在 worktrees/task-<id>');
  return task;
}

/** 在 <home>/logs/<rel> 写一个文件并把 mtime 设到 days 天前。 */
function writeAgedFile(home, rel, days) {
  const file = path.join(home, 'logs', rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'log content\n');
  const when = new Date(Date.now() - days * DAY_MS);
  fs.utimesSync(file, when, when);
  return file;
}

// ---------------------------------------------------------------- POST /api/import

test('验收: POST /api/import 用假的 issue 列表入队（#7），source 为 github:a/b#7；再调一次同一条进 skipped，任务总数仍是 1', async (t) => {
  const { base, db } = await startServer(t, {
    env: { FAKE_GH_ISSUE_LIST_JSON: '[{"number":7,"title":"登录报错","body":"点击登录返回 500"}]' },
  });
  const res = await postJson(`${base}/api/import`, { repo: 'a/b' });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.added.length, 1);
  assert.equal(body.added[0].source, 'github:a/b#7');
  assert.equal(body.added[0].title, '修复 #7：登录报错');
  assert.equal(body.added[0].status, 'queued');
  assert.deepEqual(body.skipped, []);
  const firstId = body.added[0].id;

  // 再调一次：同一条 issue 已有任务，进 skipped（taskId 是第一次的 id），不产生第二个任务
  const again = await postJson(`${base}/api/import`, { repo: 'a/b' });
  assert.equal(again.status, 200);
  const second = await again.json();
  assert.deepEqual(second.added, []);
  assert.deepEqual(second.skipped, [{ issue: 7, taskId: firstId, status: 'queued' }]);
  assert.equal(listTasks(db).length, 1);
});

test('验收: POST /api/import dryRun: true 时任务数不变，响应 added 的长度看得出将新增几条，listTasks 条数不变', async (t) => {
  const { base, db } = await startServer(t, {
    env: {
      FAKE_GH_ISSUE_LIST_JSON: '[{"number":7,"title":"甲","body":"x"},{"number":8,"title":"乙"}]',
    },
  });
  const res = await postJson(`${base}/api/import`, { repo: 'a/b', dryRun: true });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.added.length, 2, '将新增 2 条');
  assert.equal(body.added[0].issue, 7);
  assert.equal('id' in body.added[0], false, 'dry-run 的 added 是预览对象，没有任务 id');
  assert.equal(listTasks(db).length, 0, 'dry-run 不写任务');
});

test('验收: 队列页「预览 → 确认导入」：预览体 dryRun 为 true、确认体为 false 且 repo 相同；两次 POST 后任务在排队里', async (t) => {
  // 页面侧纯函数：预览与确认是同一组 repo/label/difficulty，只有 dryRun 不同
  const form = { repo: 'a/b', label: '', difficulty: 'medium' };
  const previewBody = importBody(form, true);
  const confirmBody = importBody(form, false);
  assert.equal(previewBody.dryRun, true);
  assert.equal(confirmBody.dryRun, false);
  assert.equal(confirmBody.repo, previewBody.repo);
  assert.equal(previewBody.repo, 'a/b');
  assert.equal('label' in previewBody, false, '空标签不进请求体（gh 参数里不带 --label）');
  assert.equal(importPreviewText({ added: [{}, {}], skipped: [{}] }), '将新增 2 个，跳过 1 个');

  // 与页面相同的两次 POST 打到真实服务上
  const { base } = await startServer(t, {
    env: { FAKE_GH_ISSUE_LIST_JSON: '[{"number":9,"title":"九号问题","body":"正文"}]' },
  });
  const preview = await postJson(`${base}/api/import`, previewBody);
  assert.equal(preview.status, 200);
  assert.equal((await preview.json()).added.length, 1, '预览响应看得出将新增 1 条');

  const confirm = await postJson(`${base}/api/import`, confirmBody);
  assert.equal(confirm.status, 200);
  assert.equal((await confirm.json()).added.length, 1);

  // 完成后走 refresh() 拉到的排队表格里有它
  const tasks = await (await fetch(`${base}/api/tasks`)).json();
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].status, 'queued');
  assert.equal(tasks[0].source, 'github:a/b#9');
});

// ---------------------------------------------------------------- POST /api/cleanup

test('验收: POST /api/cleanup 的 dryRun: true 不删目录；正式调用后已结束任务的 worktree 没了、排队和运行中的还在；HTTP 200', async (t) => {
  const { base, home, db } = await startCleanupServer(t);
  // running 先于 queued 建：claimNextTask 领最老的排队任务，顺序反了会领错行
  const done = await makeTask({ db, home, status: 'succeeded' });
  const bad = await makeTask({ db, home, status: 'failed' });
  const canceled = await makeTask({ db, home, status: 'canceled' });
  const running = await makeTask({ db, home, status: 'running' });
  const queued = await makeTask({ db, home, status: 'queued' });
  const paths = {
    done: wtPath(home, done.id), bad: wtPath(home, bad.id), canceled: wtPath(home, canceled.id),
    queued: wtPath(home, queued.id), running: wtPath(home, running.id),
  };

  const dry = await postJson(`${base}/api/cleanup`, { dryRun: true });
  assert.equal(dry.status, 200);
  const dryBody = await dry.json();
  assert.deepEqual(dryBody.worktrees, [paths.done, paths.bad, paths.canceled]
    .map((p) => fs.realpathSync(p)));
  assert.deepEqual(dryBody.logs, []);
  for (const p of Object.values(paths)) assert.ok(fs.existsSync(p), `dry-run 不删目录：${p}`);

  const real = await postJson(`${base}/api/cleanup`, { dryRun: false });
  assert.equal(real.status, 200);
  const realBody = await real.json();
  assert.equal(realBody.failed, false);
  assert.ok(!fs.existsSync(paths.done) && !fs.existsSync(paths.bad) && !fs.existsSync(paths.canceled),
    '已结束任务的 worktree 应被删');
  assert.ok(fs.existsSync(paths.queued), '排队中的 worktree 必须留下');
  assert.ok(fs.existsSync(paths.running), '运行中的 worktree 必须留下');
  assert.equal(listTasks(db).length, 5, '不删数据库里的任务行');
});

test('验收: cleanup 在删不掉的路径上 failed === true 且 HTTP 仍是 200，其余照删', async (t) => {
  const { base, home, db } = await startCleanupServer(t);
  // 任务 1：已结束，但 worktrees/task-1 是普通目录（不是 git worktree）→ git 会失败
  const plain = createTask(db, { repo: 'a/b', prompt: 'x', title: '普通目录任务' });
  claimNextTask(db);
  finishTask(db, plain.id, { status: 'succeeded' });
  const plainDir = wtPath(home, plain.id);
  fs.mkdirSync(plainDir, { recursive: true });
  fs.writeFileSync(path.join(plainDir, 'not-a-worktree.txt'), 'x\n');
  // 任务 2：正常的 succeeded worktree，应照常删掉（证明失败后继续）
  const good = await makeTask({ db, home, status: 'succeeded' });
  const goodReal = fs.realpathSync(wtPath(home, good.id)); // 删掉之后 realpath 就没了，先取

  const res = await postJson(`${base}/api/cleanup`, { dryRun: false });
  assert.equal(res.status, 200, '删不掉也是 200，失败语义靠 failed 布尔');
  const body = await res.json();
  assert.equal(body.failed, true);
  assert.deepEqual(body.worktrees, [goodReal], '其余照删');
  assert.ok(fs.existsSync(plainDir), '删不掉的目录还在');
  assert.ok(fs.existsSync(path.join(plainDir, 'not-a-worktree.txt')));
});

test('验收: logsOlderThan: 0 的正式清理不把日志路径放进 logs、也不删日志文件', async (t) => {
  const { base, home, db } = await startCleanupServer(t);
  await makeTask({ db, home, status: 'succeeded' });
  const old = writeAgedFile(home, 'orphan-old.log', 15); // 15 天前，默认保留期早已到龄

  const res = await postJson(`${base}/api/cleanup`, { logsOlderThan: 0 });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.logs, [], '0 = 完全不列日志');
  assert.ok(fs.existsSync(old), '0 = 完全不删日志文件');
  assert.ok(!fs.existsSync(wtPath(home, 1)), 'worktree 照常清理（与日志开关无关）');
});

// ---------------------------------------------------------------- 仓库筛选（浏览器内）

test('验收: 仓库筛选纯函数：选 owner/a 后没有 owner/b 的行，「全部」恢复；选项含「全部」与两个仓库；服务端不按仓库过滤', async (t) => {
  const tasks = [
    { id: 1, repo: 'owner/a', status: 'queued' },
    { id: 2, repo: 'owner/b', status: 'queued' },
    { id: 3, repo: 'owner/a', status: 'succeeded' },
  ];
  assert.deepEqual(repoFilterOptions(tasks), [REPO_FILTER_ALL, 'owner/a', 'owner/b']);

  const onlyA = filterTasksByRepo(tasks, 'owner/a');
  assert.equal(onlyA.some((task) => task.repo === 'owner/b'), false, '其他仓库的行看不见');
  assert.deepEqual(onlyA.map((task) => task.id), [1, 3]);
  assert.equal(filterTasksByRepo(tasks, REPO_FILTER_ALL).length, 3, '「全部」恢复两条仓库');

  // 服务端没有按仓库过滤：库里两个仓库时 GET /api/tasks（不带 repo）两条都返回
  const { base, db } = await startServer(t);
  createTask(db, { repo: 'owner/a', prompt: 'a' });
  createTask(db, { repo: 'owner/b', prompt: 'b' });
  const all = await (await fetch(`${base}/api/tasks`)).json();
  assert.deepEqual(all.map((task) => task.repo).sort(), ['owner/a', 'owner/b']);
});

// ---------------------------------------------------------------- 假 gh 的默认行为

test('验收: 没设 FAKE_GH_ISSUE_LIST_* 时假 gh 原有行为不变：issue list 退出 0、stdout 为 []\\n', async (t) => {
  // 直接 spawn 仓库里的假 gh（干净环境，没设 FAKE_GH_ISSUE_LIST_JSON / FILE / FAIL）
  const res = spawnSync(process.execPath, [
    fixturePath('fake-gh.mjs'),
    'issue', 'list', '--repo', 'a/b', '--state', 'open', '--json', 'number,title,body', '--limit', '50',
  ], { encoding: 'utf8', env: fakeEnv() });
  assert.equal(res.status, 0);
  assert.equal(res.stdout, '[]\n');

  // 经 POST /api/import 走一遍：空列表 → 200，added / skipped 都是空数组
  const { base, db } = await startServer(t);
  const http = await postJson(`${base}/api/import`, { repo: 'a/b' });
  assert.equal(http.status, 200);
  assert.deepEqual(await http.json(), { added: [], skipped: [] });
  assert.equal(listTasks(db).length, 0);
});

// ---------------------------------------------------------------- 校验与防护

test('验收: import 与 cleanup 的多余键（follow）→ 400，错误文本含字段名，不建任务、不删目录', async (t) => {
  const ghLog = path.join(makeTempHome(t), 'gh.log');
  const { base, home, db } = await startCleanupServer(t, {
    env: { FAKE_GH_ISSUE_LIST_JSON: '[{"number":7,"title":"x"}]', FAKE_GH_LOG: ghLog },
  });
  const done = await makeTask({ db, home, status: 'succeeded' });
  const doneWt = wtPath(home, done.id);

  const badImport = await postJson(`${base}/api/import`, { repo: 'a/b', follow: true });
  assert.equal(badImport.status, 400);
  const errBody = await badImport.json();
  assert.equal(errBody.field, 'follow');
  assert.ok(errBody.error.includes('follow'), `错误文本要点名字段：${errBody.error}`);
  assert.equal(listTasks(db).length, 1, '不建任务（只有造数那一条）');
  assert.ok(!fs.existsSync(ghLog), '不调用 gh（FAKE_GH_LOG 没有被写入）');

  const badCleanup = await postJson(`${base}/api/cleanup`, { dryRun: true, follow: 1 });
  assert.equal(badCleanup.status, 400);
  assert.ok((await badCleanup.json()).error.includes('follow'));
  assert.ok(fs.existsSync(doneWt), '不删目录');
});

test('验收: import 缺 repo / 形状与类型不对 → 400，不调 gh、不建任务', async (t) => {
  const ghLog = path.join(makeTempHome(t), 'gh.log');
  const { base, db } = await startServer(t, {
    env: { FAKE_GH_ISSUE_LIST_JSON: '[{"number":7,"title":"x"}]', FAKE_GH_LOG: ghLog },
  });
  const cases = [
    [{}, 'repo'],
    [{ repo: 7 }, 'repo'],
    [{ repo: 'bad repo' }, 'repo'],
    [{ repo: 'a/b', label: 5 }, 'label'],
    [{ repo: 'a/b', state: 'opened' }, 'state'],
    [{ repo: 'a/b', limit: 0 }, 'limit'],
    [{ repo: 'a/b', limit: 1.5 }, 'limit'],
    [{ repo: 'a/b', limit: '50' }, 'limit'],
    [{ repo: 'a/b', difficulty: 'extreme' }, 'difficulty'],
    [{ repo: 'a/b', dryRun: 'true' }, 'dryRun'], // 字符串 "true" 不当成 true
  ];
  for (const [body, field] of cases) {
    const res = await postJson(`${base}/api/import`, body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.equal((await res.json()).field, field, JSON.stringify(body));
  }
  assert.equal(listTasks(db).length, 0, '一个任务都不写');
  assert.ok(!fs.existsSync(ghLog), '一次 gh 都不调');
});

test('验收: FAKE_GH_ISSUE_LIST_FAIL=1 → 502，error 含「gh issue list 失败」，任务数不变', async (t) => {
  const { base, db } = await startServer(t, { env: { FAKE_GH_ISSUE_LIST_FAIL: '1' } });
  const res = await postJson(`${base}/api/import`, { repo: 'a/b' });
  assert.equal(res.status, 502);
  const body = await res.json();
  assert.ok(body.error.includes('gh issue list 失败（退出码 1）'), body.error);
  assert.ok(body.error.includes('fake gh issue list failure'), body.error);
  assert.equal(listTasks(db).length, 0, '不建任务');
});

test('验收: Origin 与 Host 不一致 → 403；Content-Type 不是 application/json → 415（两个新接口同一套防护）', async (t) => {
  const { base } = await startServer(t);
  for (const path of ['/api/import', '/api/cleanup']) {
    const evil = await postJson(`${base}${path}`, {}, { Origin: 'http://evil.example' });
    assert.equal(evil.status, 403, path);
    const plain = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: '{}',
    });
    assert.equal(plain.status, 415, path);
  }
});

// ---------------------------------------------------------------- 既有行为不回退

test('验收: 排队中任务的操作 HTML 仍含「修改」（taskRowActions 未改）', () => {
  const html = taskRowActions({ id: 3, status: 'queued' });
  assert.ok(html.includes('修改'));
  assert.ok(html.includes('data-action="edit"'));
  assert.ok(html.includes('取消'));
  assert.equal(taskRowActions({ id: 4, status: 'running' }).includes('修改'), false);
});
