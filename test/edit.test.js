// issue #46（修改排队中的任务）的测试：updateTask 领域层、edit 命令行、PATCH /api/tasks/:id。
// 全放本文件（不并进 tasks.test.js / cli.test.js / server.test.js，减少并行 issue 的合并
// 冲突）。CLI 走真实子进程跑 bin（fakeEnv + makeTempHome，绝不碰真实数据目录，不调用
// 真实 claude/gh）；HTTP 用 createServer 起随机端口 + fetch 直连（同 server.test.js）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.js';
import { systemClock } from '../src/clock.js';
import { openDb } from '../src/db.js';
import { createServer } from '../src/server.js';
import {
  InvalidTransitionError,
  NotFoundError,
  ValidationError,
  cancelTask,
  claimNextTask,
  createTask,
  finishTask,
  getTask,
  updateTask,
} from '../src/tasks.js';
import { fakeEnv, makeTempHome } from './helpers.js';

const binPath = fileURLToPath(new URL('../bin/night-shift.mjs', import.meta.url));

// ---------------------------------------------------------------- 辅助

/** 内存库（领域层测试用）。 */
function openMemory(t) {
  const db = openDb(':memory:');
  t.after(() => db.close());
  return db;
}

/** 作为独立进程跑 bin；TZ 固定 UTC。与 cli-deps.test.js 的同名实现一致。 */
function spawnCli(t, args, { cwd, home, env: envOverrides = {} } = {}) {
  const dir = cwd ?? makeTempHome(t);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [binPath, ...args], {
      cwd: dir,
      env: fakeEnv({ NIGHT_SHIFT_HOME: home ?? dir, TZ: 'UTC', ...envOverrides }),
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

/** 随机端口的看板服务（PATCH 测试用），t.after 里关闭。 */
function startServer(t) {
  const home = makeTempHome(t);
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
      resolve({ db, base: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

async function patchJson(url, body, headers = {}) {
  return fetch(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

// ---------------------------------------------------------------- 领域层：updateTask

test('验收: updateTask 改 title/prompt/priority 等，repo/source/status/attempts/createdAt 不变，updated_at 前进', async (t) => {
  const db = openMemory(t);
  const created = createTask(db, { repo: 'a/b', prompt: '旧提示', source: 'github:a/b#12' });
  await new Promise((resolve) => setTimeout(resolve, 2)); // 隔开毫秒，updated_at 必然前进
  const updated = updateTask(db, created.id, {
    title: '  新说明  ',
    prompt: ' 新提示 ',
    difficulty: 'hard',
    priority: -3,
    testCommand: ' npm test ',
    allowPeak: true,
    maxAttempts: 5,
  });
  assert.equal(updated.title, '新说明'); // trim 后入库
  assert.equal(updated.prompt, '新提示');
  assert.equal(updated.difficulty, 'hard');
  assert.equal(updated.priority, -3); // 负数合法
  assert.equal(updated.testCommand, 'npm test');
  assert.equal(updated.allowPeak, true);
  assert.equal(updated.maxAttempts, 5);
  // 不能改的字段一律不动
  assert.equal(updated.repo, 'a/b');
  assert.equal(updated.source, 'github:a/b#12');
  assert.equal(updated.status, 'queued');
  assert.equal(updated.attempts, 0);
  assert.equal(updated.branch, null);
  assert.equal(updated.prUrl, null);
  assert.equal(updated.id, created.id);
  assert.equal(updated.createdAt, created.createdAt);
  assert.ok(updated.updatedAt > created.updatedAt,
    `updated_at 应前进：${created.updatedAt} → ${updated.updatedAt}`);
  // 领取顺序规则不变：改后的 priority 参与正常排序（0 > -3，先领另一个）
  const other = createTask(db, { repo: 'a/b', prompt: 'zero' });
  assert.equal(claimNextTask(db).id, other.id);
});

test('updateTask 只改给出的字段，其余保持原值', (t) => {
  const db = openMemory(t);
  const created = createTask(db, {
    repo: 'a/b', prompt: 'p', title: '原标题', difficulty: 'easy', priority: 7, maxAttempts: 4,
  });
  const updated = updateTask(db, created.id, { title: '新标题' });
  assert.equal(updated.title, '新标题');
  assert.equal(updated.prompt, 'p'); // 没给的不动
  assert.equal(updated.difficulty, 'easy');
  assert.equal(updated.priority, 7);
  assert.equal(updated.maxAttempts, 4);
  assert.equal(updated.testCommand, null);
});

test('验收: 一个字段都没给 → ValidationError 且 field 正是 patch', (t) => {
  const db = openMemory(t);
  const task = createTask(db, { repo: 'a/b', prompt: 'x' });
  for (const patch of [{}, undefined]) {
    assert.throws(() => updateTask(db, task.id, patch), (err) => {
      assert.ok(err instanceof ValidationError);
      assert.equal(err.field, 'patch');
      assert.ok(err.message.includes('patch'));
      return true;
    });
  }
  assert.equal(getTask(db, task.id).title, 'x', '任务没被写坏');
});

test('验收: 带 repo / source / status / attempts / branch / prUrl / 未知字段 → ValidationError 点名字段，任务原样不动', (t) => {
  const db = openMemory(t);
  const task = createTask(db, { repo: 'a/b', prompt: 'x', source: 'github:a/b#12' });
  const before = JSON.stringify(getTask(db, task.id));
  for (const key of ['repo', 'source', 'status', 'attempts', 'branch', 'prUrl', 'oops', '__proto__']) {
    // JSON.parse 构造：__proto__ 也是自有属性（不走原型链的 setter），与真实请求体一致
    const patch = JSON.parse(`{"title":"不该生效","${key}":"x/y"}`);
    assert.throws(() => updateTask(db, task.id, patch), (err) => {
      assert.ok(err instanceof ValidationError, `${key} 应抛 ValidationError`);
      assert.equal(err.field, key, `错误应点名 ${key}：${err.message}`);
      assert.ok(err.message.includes(key));
      return true;
    }, `${key} 应被拒绝`);
  }
  assert.equal(JSON.stringify(getTask(db, task.id)), before, '任何字段都不能落库');
});

test('字段校验：空 title/prompt、非法 difficulty/priority/allowPeak/maxAttempts/testCommand 各自点名', (t) => {
  const db = openMemory(t);
  const task = createTask(db, { repo: 'a/b', prompt: 'x' });
  const cases = [
    [{ title: '   ' }, 'title'],
    [{ title: null }, 'title'],
    [{ prompt: '' }, 'prompt'],
    [{ prompt: 42 }, 'prompt'],
    [{ difficulty: 'extreme' }, 'difficulty'],
    [{ priority: 1.5 }, 'priority'],
    [{ priority: '3' }, 'priority'],
    [{ allowPeak: 'yes' }, 'allowPeak'],
    [{ maxAttempts: 0 }, 'maxAttempts'],
    [{ maxAttempts: 2.5 }, 'maxAttempts'],
    [{ testCommand: '' }, 'testCommand'],
    [{ testCommand: '   ' }, 'testCommand'],
  ];
  for (const [patch, field] of cases) {
    assert.throws(() => updateTask(db, task.id, patch), (err) => {
      assert.ok(err instanceof ValidationError, `${JSON.stringify(patch)} 应抛 ValidationError`);
      assert.equal(err.field, field);
      return true;
    }, `${JSON.stringify(patch)} 应被拒绝`);
  }
});

test('testCommand: null 清掉；id 非正整数 → ValidationError(field=id)；任务不存在 → NotFoundError', (t) => {
  const db = openMemory(t);
  const task = createTask(db, { repo: 'a/b', prompt: 'x', testCommand: 'npm test' });
  assert.equal(updateTask(db, task.id, { testCommand: null }).testCommand, null);
  assert.throws(() => updateTask(db, 0, { title: 'x' }), ValidationError);
  assert.throws(() => updateTask(db, '1', { title: 'x' }), ValidationError);
  assert.throws(() => updateTask(db, 99, { title: 'x' }), NotFoundError);
});

test('验收: 非 queued（running/succeeded/failed/canceled）→ InvalidTransitionError，message 含「只有排队中的任务可以修改」和当前状态', (t) => {
  const db = openMemory(t);
  const running = createTask(db, { repo: 'a/b', prompt: 'r', title: 'R' });
  claimNextTask(db); // 唯一排队任务被领走 → running
  const succeeded = createTask(db, { repo: 'a/b', prompt: 's', title: 'S' });
  claimNextTask(db);
  finishTask(db, succeeded.id, { status: 'succeeded' });
  const canceled = createTask(db, { repo: 'a/b', prompt: 'c', title: 'C' });
  cancelTask(db, canceled.id);
  const failed = createTask(db, { repo: 'a/b', prompt: 'f', title: 'F' });
  claimNextTask(db);
  finishTask(db, failed.id, { status: 'failed', lastError: 'boom' });

  for (const [task, status] of [
    [running, 'running'], [succeeded, 'succeeded'], [canceled, 'canceled'], [failed, 'failed'],
  ]) {
    assert.throws(() => updateTask(db, task.id, { title: '不该生效' }), (err) => {
      assert.ok(err instanceof InvalidTransitionError, `${status} 应抛 InvalidTransitionError`);
      assert.equal(err.from, status);
      assert.ok(err.message.includes('只有排队中的任务可以修改'), err.message);
      assert.ok(err.message.includes(status), `message 应点名当前状态：${err.message}`);
      return true;
    }, `${status} 应被拒绝`);
    assert.equal(getTask(db, task.id).title, task.title, `${status} 的任务不能被改`);
  }
});

test('dependsOn: 出现就整组替换（去重升序）；不出现则依赖不动；[] 清空', (t) => {
  const db = openMemory(t);
  const a = createTask(db, { repo: 'a/b', prompt: 'a' });
  const b = createTask(db, { repo: 'a/b', prompt: 'b' });
  const c = createTask(db, { repo: 'a/b', prompt: 'c' });
  const task = createTask(db, { repo: 'a/b', prompt: 't', dependsOn: [a.id] });
  // 不出现：只改标题，依赖保持
  assert.deepEqual(updateTask(db, task.id, { title: '只改标题' }).dependsOn, [a.id]);
  // 整组替换 + 去重升序
  const replaced = updateTask(db, task.id, { dependsOn: [c.id, b.id, c.id] });
  assert.deepEqual(replaced.dependsOn, [b.id, c.id]);
  assert.deepEqual(replaced.blockedBy, [b.id, c.id]);
  // [] 清空
  assert.deepEqual(updateTask(db, task.id, { dependsOn: [] }).dependsOn, []);
});

test('dependsOn 校验失败（不存在/自己/failed）→ ValidationError(field=dependsOn)，且其他字段一并回滚', (t) => {
  const db = openMemory(t);
  const a = createTask(db, { repo: 'a/b', prompt: 'a' });
  const task = createTask(db, { repo: 'a/b', prompt: 't', title: '原标题', dependsOn: [a.id] });
  const before = JSON.stringify(getTask(db, task.id));
  for (const ids of [[99], [task.id]]) {
    assert.throws(() => updateTask(db, task.id, { title: '不该生效', dependsOn: ids }), (err) => {
      assert.ok(err instanceof ValidationError);
      assert.equal(err.field, 'dependsOn');
      return true;
    });
    assert.equal(JSON.stringify(getTask(db, task.id)), before,
      `dependsOn=${JSON.stringify(ids)} 失败后任务必须原样（同一事务回滚）`);
  }
  // failed 的目标不能当依赖
  claimNextTask(db); // 领走 a
  finishTask(db, a.id, { status: 'failed', lastError: 'boom' });
  const b = createTask(db, { repo: 'a/b', prompt: 'b' });
  assert.throws(() => updateTask(db, b.id, { dependsOn: [a.id] }), (err) => err.field === 'dependsOn');
});

test('验收: dependsOn 成环 → 沿用环提示（会形成依赖环：#1 → #2 → #1），标题与依赖都保持改之前', (t) => {
  const db = openMemory(t);
  const a = createTask(db, { repo: 'a/b', prompt: 'a', title: 'A' });
  createTask(db, { repo: 'a/b', prompt: 'b', dependsOn: [a.id] }); // #2 → #1
  assert.throws(() => updateTask(db, a.id, { title: '不该生效', dependsOn: [2] }), (err) => {
    assert.ok(err instanceof ValidationError);
    assert.equal(err.field, 'dependsOn');
    assert.ok(err.message.includes('会形成依赖环：#1 → #2 → #1'), err.message);
    return true;
  });
  const after = getTask(db, a.id);
  assert.equal(after.title, 'A', '标题保持改之前');
  assert.deepEqual(after.dependsOn, [], '依赖保持改之前');
});

// ---------------------------------------------------------------- 命令行：edit

test('验收: edit 改标题和优先级后 show --json 看到新值，repo/source 不变；list --status queued 按新优先级排序', async (t) => {
  const home = makeTempHome(t);
  { // 本进程造数据：#1 带 source（CLI 的 add 建不了 source），#2 优先级 1
    const db = openDb(path.join(home, 'night-shift.db'));
    createTask(db, { repo: 'a/b', prompt: 'x', title: '旧说明', source: 'github:a/b#12' });
    createTask(db, { repo: 'c/d', prompt: 'y', priority: 1 });
    db.close();
  }
  const res = await spawnCli(t, ['edit', '1', '--title', '新说明', '--priority', '5'], { cwd: home, home });
  assert.equal(res.code, 0, res.stderr);
  assert.equal(res.stdout, '已更新 #1\n');

  const show = await spawnCli(t, ['show', '1', '--json'], { cwd: home, home });
  assert.equal(show.code, 0, show.stderr);
  const task = JSON.parse(show.stdout);
  assert.equal(task.title, '新说明');
  assert.equal(task.priority, 5);
  assert.equal(task.repo, 'a/b');
  assert.equal(task.source, 'github:a/b#12');

  const list = await spawnCli(t, ['list', '--status', 'queued', '--json'], { cwd: home, home });
  const queued = JSON.parse(list.stdout);
  assert.deepEqual(queued.map((x) => x.id), [1, 2], '#1 优先级 5 应排在 #2（1）前面');
});

test('验收: 把依赖改成会成环的一组时退出码 1，任务的标题和依赖都保持改之前', async (t) => {
  const home = makeTempHome(t);
  await spawnCli(t, ['add', '--repo', 'a/b', '--prompt', 'x'], { cwd: home, home }); // #1
  await spawnCli(t, ['add', '--repo', 'a/b', '--prompt', 'y', '--depends-on', '1'], { cwd: home, home }); // #2 → #1

  const res = await spawnCli(t, ['edit', '1', '--title', '不该生效', '--depends-on', '2'], { cwd: home, home });
  assert.equal(res.code, 1);
  assert.equal(res.stdout, '');
  assert.ok(res.stderr.startsWith('错误：'), res.stderr);
  assert.ok(res.stderr.includes('会形成依赖环：#1 → #2 → #1'), res.stderr);

  const task = JSON.parse((await spawnCli(t, ['show', '1', '--json'], { cwd: home, home })).stdout);
  assert.equal(task.title, 'x', '标题保持改之前');
  assert.deepEqual(task.dependsOn, [], '依赖保持改之前');
});

test('验收: 对 running 的任务 edit 退出码 1，数据库无变化', async (t) => {
  const home = makeTempHome(t);
  const dbPath = path.join(home, 'night-shift.db');
  let before;
  {
    const db = openDb(dbPath);
    createTask(db, { repo: 'a/b', prompt: 'x', title: '原标题', priority: 7 });
    claimNextTask(db); // → running
    before = JSON.stringify(getTask(db, 1));
    db.close();
  }
  const res = await spawnCli(t, ['edit', '1', '--title', '不该生效', '--priority', '9'], { cwd: home, home });
  assert.equal(res.code, 1);
  assert.ok(res.stderr.includes('只有排队中的任务可以修改'), res.stderr);
  assert.ok(res.stderr.includes('running'), res.stderr);

  const db = openDb(dbPath);
  assert.equal(JSON.stringify(getTask(db, 1)), before, '数据库无变化');
  db.close();
});

test('验收: 帮助文本里有 edit', async (t) => {
  const home = makeTempHome(t);
  const res = await spawnCli(t, ['help'], { cwd: home, home });
  assert.equal(res.code, 0, res.stderr);
  // 「命令：」清单里解析出 edit（同 docs.test.js 的解析方式，不靠子串巧合）
  const lines = res.stdout.split('\n');
  const start = lines.indexOf('命令：');
  const names = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === '') break;
    const name = line.trim().split(/\s+/)[0];
    if (!name.startsWith('-')) names.push(name);
  }
  assert.ok(names.includes('edit'), `命令清单应有 edit，实际：${names.join(' ')}`);
  assert.ok(res.stdout.includes('用法：night-shift edit'), '命令详解应有 edit 的用法');
  assert.ok(res.stdout.includes('修改排队中的任务'), '摘要应说明 edit 干什么');
  const cmdHelp = await spawnCli(t, ['edit', '--help'], { cwd: home, home });
  assert.equal(cmdHelp.code, 0, cmdHelp.stderr);
  assert.ok(cmdHelp.stdout.startsWith('用法：night-shift edit'), cmdHelp.stdout);
});

test('edit --json 打整条任务；--prompt-file 文件内容作提示词（只去末尾一个换行）', async (t) => {
  const home = makeTempHome(t);
  await spawnCli(t, ['add', '--repo', 'a/b', '--prompt', 'x'], { cwd: home, home });
  fs.writeFileSync(path.join(home, 'prompt.txt'), '新提示词\n');
  const res = await spawnCli(t, ['edit', '1', '--prompt-file', 'prompt.txt', '--json'], { cwd: home, home });
  assert.equal(res.code, 0, res.stderr);
  const task = JSON.parse(res.stdout);
  assert.equal(task.id, 1);
  assert.equal(task.prompt, '新提示词');
  assert.equal(task.repo, 'a/b');
  assert.equal(task.status, 'queued');
});

test('--no-test 清掉 testCommand、--test 设置；--no-allow-peak / --allow-peak；--no-depends 清空依赖', async (t) => {
  const home = makeTempHome(t);
  await spawnCli(t, ['add', '--repo', 'a/b', '--prompt', 'x', '--test', 'npm test', '--allow-peak'], { cwd: home, home });
  await spawnCli(t, ['add', '--repo', 'a/b', '--prompt', 'y', '--depends-on', '1'], { cwd: home, home });
  const show = (id) => spawnCli(t, ['show', String(id), '--json'], { cwd: home, home })
    .then((r) => JSON.parse(r.stdout));

  const clear = await spawnCli(t, ['edit', '1', '--no-test', '--no-allow-peak'], { cwd: home, home });
  assert.equal(clear.code, 0, clear.stderr);
  assert.equal(clear.stdout, '已更新 #1\n');
  let task = await show(1);
  assert.equal(task.testCommand, null, '--no-test 清掉');
  assert.equal(task.allowPeak, false, '--no-allow-peak 关掉');

  const set = await spawnCli(t, ['edit', '1', '--test', 'npm run check', '--allow-peak'], { cwd: home, home });
  assert.equal(set.code, 0, set.stderr);
  task = await show(1);
  assert.equal(task.testCommand, 'npm run check');
  assert.equal(task.allowPeak, true);

  const noDeps = await spawnCli(t, ['edit', '2', '--no-depends'], { cwd: home, home });
  assert.equal(noDeps.code, 0, noDeps.stderr);
  const second = await show(2);
  assert.deepEqual(second.dependsOn, [], '--no-depends 清空依赖');
  assert.deepEqual(second.blockedBy, []);
});

test('负优先级、--difficulty、--max-attempts、--depends-on 经 edit 生效', async (t) => {
  const home = makeTempHome(t);
  await spawnCli(t, ['add', '--repo', 'a/b', '--prompt', 'x'], { cwd: home, home }); // #1
  await spawnCli(t, ['add', '--repo', 'a/b', '--prompt', 'y'], { cwd: home, home }); // #2
  const res = await spawnCli(t, [
    'edit', '1', '--priority', '-3', '--difficulty', 'hard', '--max-attempts', '6', '--depends-on', '2',
  ], { cwd: home, home });
  assert.equal(res.code, 0, res.stderr);
  const task = JSON.parse((await spawnCli(t, ['show', '1', '--json'], { cwd: home, home })).stdout);
  assert.equal(task.priority, -3, '负优先级合法');
  assert.equal(task.difficulty, 'hard');
  assert.equal(task.maxAttempts, 6);
  assert.deepEqual(task.dependsOn, [2]);
  assert.deepEqual(task.blockedBy, [2]);
});

test('一个修改项都不给 → 退出码 2 并打印 edit 用法（只有 --json 也不算）', async (t) => {
  const home = makeTempHome(t);
  await spawnCli(t, ['add', '--repo', 'a/b', '--prompt', 'x'], { cwd: home, home });
  for (const args of [['edit', '1'], ['edit', '1', '--json']]) {
    const res = await spawnCli(t, args, { cwd: home, home });
    assert.equal(res.code, 2, args.join(' '));
    assert.ok(res.stderr.includes('至少给一个修改项'), res.stderr);
    assert.ok(res.stderr.includes('用法：night-shift edit'), res.stderr);
  }
});

test('互斥对都是用法错误（退出码 2）：--prompt/--prompt-file、--test/--no-test、--allow-peak/--no-allow-peak、--depends-on/--no-depends', async (t) => {
  const home = makeTempHome(t);
  await spawnCli(t, ['add', '--repo', 'a/b', '--prompt', 'x'], { cwd: home, home });
  const pairs = [
    ['--prompt', 'a', '--prompt-file', 'b'],
    ['--test', 'a', '--no-test'],
    ['--allow-peak', '--no-allow-peak'],
    ['--depends-on', '1', '--no-depends'],
  ];
  for (const extra of pairs) {
    const res = await spawnCli(t, ['edit', '1', ...extra], { cwd: home, home });
    assert.equal(res.code, 2, extra.join(' '));
    assert.ok(res.stderr.includes('只能二选一'), res.stderr);
    assert.ok(res.stderr.includes('用法：night-shift edit'), res.stderr);
  }
});

test('用法错误的其余情况：缺 <id>/id 非法/多余参数/非法枚举/非法整数/非法依赖列表/未知选项', async (t) => {
  const home = makeTempHome(t);
  await spawnCli(t, ['add', '--repo', 'a/b', '--prompt', 'x'], { cwd: home, home });
  const cases = [
    [['edit'], '<id>'],
    [['edit', 'abc'], '正整数'],
    [['edit', '1', '2'], '参数过多'],
    [['edit', '1', '--difficulty', 'extreme'], '--difficulty'],
    [['edit', '1', '--priority', 'abc'], '--priority'],
    [['edit', '1', '--priority', '1.5'], '--priority'],
    [['edit', '1', '--max-attempts', '0'], '--max-attempts'],
    [['edit', '1', '--depends-on', 'x'], '--depends-on'],
  ];
  for (const [args, keyword] of cases) {
    const res = await spawnCli(t, args, { cwd: home, home });
    assert.equal(res.code, 2, args.join(' '));
    assert.ok(res.stderr.includes(keyword), `${args.join(' ')}：${res.stderr}`);
    assert.ok(res.stderr.includes('用法：night-shift edit'), res.stderr);
  }
  const unknown = await spawnCli(t, ['edit', '1', '--nope'], { cwd: home, home });
  assert.equal(unknown.code, 2); // parseArgs 的未知选项也映射成该命令的用法错误
});

test('edit 不存在的任务退出 1；--prompt-file 读不到报中文错误', async (t) => {
  const home = makeTempHome(t);
  await spawnCli(t, ['add', '--repo', 'a/b', '--prompt', 'x'], { cwd: home, home });
  const missing = await spawnCli(t, ['edit', '99', '--title', 'x'], { cwd: home, home });
  assert.equal(missing.code, 1);
  assert.ok(missing.stderr.includes('任务 99 不存在'), missing.stderr);

  const badFile = await spawnCli(t, ['edit', '1', '--prompt-file', 'no-such.txt'], { cwd: home, home });
  assert.equal(badFile.code, 1);
  assert.ok(badFile.stderr.includes('无法读取 prompt 文件'), badFile.stderr);
});

// ---------------------------------------------------------------- HTTP：PATCH /api/tasks/:id

test('验收: PATCH 带 repo 返回 400 且点名 repo，任务不变；其他禁改/未知字段同样 400', async (t) => {
  const { db, base } = await startServer(t);
  const task = createTask(db, { repo: 'a/b', prompt: 'x', title: '原标题' });
  for (const key of ['repo', 'source', 'status', 'attempts', 'branch', 'prUrl', 'oops']) {
    const res = await patchJson(`${base}/api/tasks/${task.id}`, { [key]: 'x/y', title: '不该生效' });
    assert.equal(res.status, 400, key);
    const body = await res.json();
    assert.equal(body.field, key, `${key} 应被点名`);
    assert.ok(body.error.includes(key), body.error);
  }
  assert.equal(getTask(db, task.id).title, '原标题', '任务原样不动');
});

test('验收: PATCH 对已成功任务返回 409（信息含「只有排队中的任务可以修改」与 succeeded）；不存在的 id 返回 404', async (t) => {
  const { db, base } = await startServer(t);
  const task = createTask(db, { repo: 'a/b', prompt: 'x' });
  claimNextTask(db);
  finishTask(db, task.id, { status: 'succeeded', prUrl: 'https://example.com/p/1' });

  const res = await patchJson(`${base}/api/tasks/${task.id}`, { title: '新' });
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.ok(body.error.includes('只有排队中的任务可以修改'), body.error);
  assert.ok(body.error.includes('succeeded'), body.error);

  assert.equal((await patchJson(`${base}/api/tasks/999`, { title: 'x' })).status, 404);
  // 非数字 id 没有匹配的路由，与其他任务路由一致按 404 处理
  assert.equal((await patchJson(`${base}/api/tasks/abc`, { title: 'x' })).status, 404);
});

test('验收: PATCH 成功返回更新后的任务 JSON；空对象 {} → 400 field=patch', async (t) => {
  const { db, base } = await startServer(t);
  const task = createTask(db, { repo: 'a/b', prompt: 'x', priority: 0 });

  const res = await patchJson(`${base}/api/tasks/${task.id}`, { title: ' 新说明 ', priority: 2 });
  assert.equal(res.status, 200);
  const updated = await res.json();
  assert.equal(updated.id, task.id);
  assert.equal(updated.title, '新说明');
  assert.equal(updated.priority, 2);
  assert.equal(updated.status, 'queued');
  assert.equal(getTask(db, task.id).title, '新说明');

  const empty = await patchJson(`${base}/api/tasks/${task.id}`, {});
  assert.equal(empty.status, 400);
  assert.equal((await empty.json()).field, 'patch');
});

test('PATCH 与 POST 同一套防护：text/plain / 无 Content-Type → 415；Origin 不一致 → 403；超 1MB → 413；坏 JSON → 400', async (t) => {
  const { db, base } = await startServer(t);
  const task = createTask(db, { repo: 'a/b', prompt: 'x' });
  const url = `${base}/api/tasks/${task.id}`;

  const plain = await fetch(url, {
    method: 'PATCH', headers: { 'Content-Type': 'text/plain' }, body: '{"title":"x"}',
  });
  assert.equal(plain.status, 415);
  const none = await fetch(url, { method: 'PATCH', body: '{"title":"x"}' });
  assert.equal(none.status, 415);

  const evil = await patchJson(url, { title: 'x' }, { Origin: 'http://evil.example' });
  assert.equal(evil.status, 403);
  assert.ok((await evil.json()).error.includes('Origin'));

  const big = await patchJson(url, { prompt: 'x'.repeat(2 * 1024 * 1024) });
  assert.equal(big.status, 413);

  const badJson = await fetch(url, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: '{oops',
  });
  assert.equal(badJson.status, 400);
  assert.equal(getTask(db, task.id).title, 'x', '以上任何一种都不该改到任务');
});
