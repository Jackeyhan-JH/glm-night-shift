// deps 命令与 add --depends-on 的命令行测试（issue #11 验收项）。#11 起依赖相关命令的
// 用例放本文件（不并进 cli.test.js，减少并行 issue 的合并冲突）；spawnCli 与 cli.test.js
// 里的同名实现一致。真实子进程跑 bin，NIGHT_SHIFT_HOME 指向临时目录，绝不碰真实数据目录。
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fakeEnv, makeTempHome } from './helpers.js';
import { displayWidth } from '../src/format.js';

const binPath = fileURLToPath(new URL('../bin/night-shift.mjs', import.meta.url));

// 作为独立进程跑 bin；TZ 固定 UTC 让时间输出可断言。
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

// ---------------------------------------------------------------- 验收主链路

test('验收: add --depends-on 1 输出「已加入队列：#2 y」；show --json 的 dependsOn [1] / blockedBy [1]；list 显示 等 #1', async (t) => {
  const home = makeTempHome(t);
  const first = await spawnCli(t, ['add', '--repo', 'a/b', '--prompt', 'x'], { cwd: home });
  assert.equal(first.code, 0, first.stderr);
  assert.equal(first.stdout, '已加入队列：#1 x\n');

  const second = await spawnCli(t, ['add', '--repo', 'a/b', '--prompt', 'y', '--depends-on', '1'], { cwd: home });
  assert.equal(second.code, 0, second.stderr);
  assert.equal(second.stdout, '已加入队列：#2 y\n');
  assert.equal(second.stderr, '');

  const show = await spawnCli(t, ['show', '2', '--json'], { cwd: home });
  assert.equal(show.code, 0, show.stderr);
  const task = JSON.parse(show.stdout);
  assert.deepEqual(task.dependsOn, [1]);
  assert.deepEqual(task.blockedBy, [1]);
  assert.equal(task.status, 'queued');

  const list = await spawnCli(t, ['list'], { cwd: home });
  assert.equal(list.code, 0, list.stderr);
  const lines = list.stdout.trimEnd().split('\n');
  assert.equal(lines.length, 3, '表头 + 两行');
  const row2 = lines.find((line) => line.startsWith('2 '));
  assert.ok(row2.includes('queued（等 #1）'), `#2 的状态应标注在等谁：${row2}`);
  // 状态列变宽后，两行数据的创建时间列起始「显示列」仍须一致（对齐不被破坏）
  const timeStart = (line) => displayWidth(line.slice(0, line.indexOf('2026-')));
  assert.equal(timeStart(lines[1]), timeStart(lines[2]));
});

test('验收: 多个依赖显示为 等 #1,#2；依赖全成功后变回 queued', async (t) => {
  const home = makeTempHome(t);
  for (const prompt of ['x', 'y', 'z']) {
    await spawnCli(t, ['add', '--repo', 'a/b', '--prompt', prompt], { cwd: home });
  }
  const res = await spawnCli(t, ['add', '--repo', 'a/b', '--prompt', 'w', '--depends-on', '1,2'], { cwd: home });
  assert.equal(res.code, 0, res.stderr);
  const list = await spawnCli(t, ['list'], { cwd: home });
  const row4 = list.stdout.trimEnd().split('\n').find((line) => line.startsWith('4 '));
  assert.ok(row4.includes('queued（等 #1,#2）'), `多个依赖逗号分隔：${row4}`);

  const listJson = await spawnCli(t, ['list', '--json'], { cwd: home });
  const arr = JSON.parse(listJson.stdout);
  const w = arr.find((task) => task.id === 4);
  assert.deepEqual(w.dependsOn, [1, 2]);
  assert.deepEqual(w.blockedBy, [1, 2]);
});

test('show（人类可读）：依赖行「依赖：#1 queued」/「依赖：无」', async (t) => {
  const home = makeTempHome(t);
  await spawnCli(t, ['add', '--repo', 'a/b', '--prompt', 'x'], { cwd: home });
  const plain = await spawnCli(t, ['show', '1'], { cwd: home });
  assert.equal(plain.code, 0, plain.stderr);
  assert.ok(plain.stdout.includes('依赖：无'), plain.stdout);

  await spawnCli(t, ['add', '--repo', 'a/b', '--prompt', 'y', '--depends-on', '1'], { cwd: home });
  const withDeps = await spawnCli(t, ['show', '2'], { cwd: home });
  assert.equal(withDeps.code, 0, withDeps.stderr);
  assert.ok(withDeps.stdout.includes('依赖：#1 queued'), withDeps.stdout);
});

// ---------------------------------------------------------------- deps 命令

test('deps <id>：显示依赖与各自状态；无依赖说「无」', async (t) => {
  const home = makeTempHome(t);
  await spawnCli(t, ['add', '--repo', 'a/b', '--prompt', 'x'], { cwd: home });
  await spawnCli(t, ['add', '--repo', 'a/b', '--prompt', 'y', '--depends-on', '1'], { cwd: home });

  const none = await spawnCli(t, ['deps', '1'], { cwd: home });
  assert.equal(none.code, 0, none.stderr);
  assert.equal(none.stdout, '任务 #1 的依赖：无\n');

  const has = await spawnCli(t, ['deps', '2'], { cwd: home });
  assert.equal(has.code, 0, has.stderr);
  assert.equal(has.stdout, '任务 #2 的依赖：#1 queued\n');
});

test('deps <id> --set：设置 / 清空依赖，容忍空格；任务不存在退出 1', async (t) => {
  const home = makeTempHome(t);
  for (const prompt of ['x', 'y', 'z']) {
    await spawnCli(t, ['add', '--repo', 'a/b', '--prompt', prompt], { cwd: home });
  }

  const set = await spawnCli(t, ['deps', '1', '--set', '2, 3'], { cwd: home }); // 逗号后空格容忍
  assert.equal(set.code, 0, set.stderr);
  assert.equal(set.stdout, '#1 依赖已更新：#2 queued，#3 queued\n');
  assert.deepEqual(JSON.parse((await spawnCli(t, ['show', '1', '--json'], { cwd: home })).stdout).dependsOn, [2, 3]);

  const clear = await spawnCli(t, ['deps', '1', '--set', ''], { cwd: home });
  assert.equal(clear.code, 0, clear.stderr);
  assert.equal(clear.stdout, '#1 依赖已清空\n');
  assert.deepEqual(JSON.parse((await spawnCli(t, ['show', '1', '--json'], { cwd: home })).stdout).dependsOn, []);

  const missing = await spawnCli(t, ['deps', '99'], { cwd: home });
  assert.equal(missing.code, 1);
  assert.ok(missing.stderr.includes('任务 99 不存在'), missing.stderr);
});

test('验收: deps 1 --set 2 退出码 1 且提示环（信息含 # 与 →）', async (t) => {
  const home = makeTempHome(t);
  await spawnCli(t, ['add', '--repo', 'a/b', '--prompt', 'x'], { cwd: home });
  await spawnCli(t, ['add', '--repo', 'a/b', '--prompt', 'y', '--depends-on', '1'], { cwd: home }); // #2 → #1

  const res = await spawnCli(t, ['deps', '1', '--set', '2'], { cwd: home }); // #1 → #2 成环
  assert.equal(res.code, 1);
  assert.equal(res.stdout, '');
  assert.ok(res.stderr.includes('环'), res.stderr);
  assert.ok(res.stderr.includes('#1 → #2 → #1'), `应列出环路径：${res.stderr}`);
  // 被拒后依赖没变
  const after = await spawnCli(t, ['show', '1', '--json'], { cwd: home });
  assert.deepEqual(JSON.parse(after.stdout).dependsOn, []);
});

test('deps 给非 queued 任务改依赖：退出 1（非法状态转换）；deps 自己也退出 1', async (t) => {
  const home = makeTempHome(t);
  await spawnCli(t, ['add', '--repo', 'a/b', '--prompt', 'x'], { cwd: home });
  await spawnCli(t, ['add', '--repo', 'a/b', '--prompt', 'y'], { cwd: home });
  await spawnCli(t, ['cancel', '1'], { cwd: home }); // canceled 的任务不能改依赖
  const res = await spawnCli(t, ['deps', '1', '--set', '2'], { cwd: home });
  assert.equal(res.code, 1);
  assert.ok(res.stderr.includes('不能从 canceled'), res.stderr);

  const self = await spawnCli(t, ['deps', '2', '--set', '2'], { cwd: home });
  assert.equal(self.code, 1);
  assert.ok(self.stderr.includes('不能依赖自己'), self.stderr);
});

// ---------------------------------------------------------------- 退出码

test('验收: add … --depends-on 99 退出码 1（依赖的任务不存在）', async (t) => {
  const home = makeTempHome(t);
  await spawnCli(t, ['add', '--repo', 'a/b', '--prompt', 'x'], { cwd: home });
  const res = await spawnCli(t, ['add', '--repo', 'a/b', '--prompt', 'y', '--depends-on', '99'], { cwd: home });
  assert.equal(res.code, 1);
  assert.equal(res.stdout, '');
  assert.ok(res.stderr.includes('#99 不存在'), res.stderr);
  assert.ok(res.stderr.includes('dependsOn'), res.stderr);
});

test('验收: --depends-on 格式错误（abc、1,,x、0、负数、小数）退出码 2 并附 add 用法', async (t) => {
  const home = makeTempHome(t);
  await spawnCli(t, ['add', '--repo', 'a/b', '--prompt', 'x'], { cwd: home });
  const bad = ['abc', '1,,x', '0', '-1', '1.5', '1,x,2', ' ', '99999999999999999999'];
  const results = await Promise.all(bad.map((raw) => spawnCli(t, [
    'add', '--repo', 'a/b', '--prompt', 'y', '--depends-on', raw,
  ], { cwd: home })));
  for (const [i, res] of results.entries()) {
    assert.equal(res.code, 2, `--depends-on ${JSON.stringify(bad[i])} 应退出 2（实际 ${res.code}，stderr：${res.stderr}）`);
    assert.equal(res.stdout, '', bad[i]);
    assert.ok(res.stderr.startsWith('错误：'), bad[i]);
    assert.ok(res.stderr.includes('--depends-on'), `stderr 应点名选项：${res.stderr}`);
    assert.ok(res.stderr.includes('用法：night-shift add'), `应附 add 用法：${res.stderr}`);
  }
  // 任务没被建出来
  const list = await spawnCli(t, ['list', '--json'], { cwd: home });
  assert.equal(JSON.parse(list.stdout).length, 1);
});

test('deps --set 格式错误同样退出码 2；deps 缺 <id> / 多参数也退出 2', async (t) => {
  const home = makeTempHome(t);
  await spawnCli(t, ['add', '--repo', 'a/b', '--prompt', 'x'], { cwd: home });

  const badSet = await spawnCli(t, ['deps', '1', '--set', 'abc'], { cwd: home });
  assert.equal(badSet.code, 2);
  assert.ok(badSet.stderr.includes('--set'), badSet.stderr);
  assert.ok(badSet.stderr.includes('用法：night-shift deps'), badSet.stderr);

  const zero = await spawnCli(t, ['deps', '1', '--set', '0'], { cwd: home });
  assert.equal(zero.code, 2);

  const missingId = await spawnCli(t, ['deps'], { cwd: home });
  assert.equal(missingId.code, 2);
  assert.ok(missingId.stderr.includes('<id>'), missingId.stderr);

  const extra = await spawnCli(t, ['deps', '1', '2'], { cwd: home });
  assert.equal(extra.code, 2);
  assert.ok(extra.stderr.includes('参数过多'), extra.stderr);
});

test('add --depends-on "" 等于无依赖；--depends-on 1,1 重复 id 去重', async (t) => {
  const home = makeTempHome(t);
  await spawnCli(t, ['add', '--repo', 'a/b', '--prompt', 'x'], { cwd: home });
  const empty = await spawnCli(t, ['add', '--repo', 'a/b', '--prompt', 'y', '--depends-on', ''], { cwd: home });
  assert.equal(empty.code, 0, empty.stderr);
  assert.deepEqual(JSON.parse((await spawnCli(t, ['show', '2', '--json'], { cwd: home })).stdout).dependsOn, []);

  const dup = await spawnCli(t, ['add', '--repo', 'a/b', '--prompt', 'z', '--depends-on', '1,1'], { cwd: home });
  assert.equal(dup.code, 0, dup.stderr);
  const task = JSON.parse((await spawnCli(t, ['show', '3', '--json'], { cwd: home })).stdout);
  assert.deepEqual(task.dependsOn, [1]);
  assert.deepEqual(task.blockedBy, [1]);
});

// ---------------------------------------------------------------- retry 与依赖（CLI 层）

test('retry 经 CLI：依赖仍失败时退出 1 并提示先重试上游；上游重试后成功', async (t) => {
  const home = makeTempHome(t);
  // 本进程造数据（bin 已在别处 import；这里动态 import db.js，装好警告过滤的顺序不受影响）
  const { openDb } = await import('../src/db.js');
  const { createTask, claimNextTask, finishTask } = await import('../src/tasks.js');
  {
    const db = openDb(path.join(home, 'night-shift.db'));
    const a = createTask(db, { repo: 'a/b', prompt: 'A' });
    createTask(db, { repo: 'a/b', prompt: 'B', dependsOn: [a.id] });
    claimNextTask(db);
    finishTask(db, a.id, { status: 'failed', lastError: 'boom' }); // B 被级联标 failed
    db.close();
  }

  const blocked = await spawnCli(t, ['retry', '2'], { cwd: home });
  assert.equal(blocked.code, 1);
  assert.ok(blocked.stderr.includes('依赖 #1 仍是 failed，请先重试它'), blocked.stderr);

  const upstream = await spawnCli(t, ['retry', '1'], { cwd: home });
  assert.equal(upstream.code, 0, upstream.stderr);
  const downstream = await spawnCli(t, ['retry', '2'], { cwd: home });
  assert.equal(downstream.code, 0, downstream.stderr);
  assert.equal(downstream.stdout, '#2 已重新排队（queued）\n');
});

// ---------------------------------------------------------------- help

test('help 与 deps --help：列出 deps 命令与 --depends-on 选项', async (t) => {
  const home = makeTempHome(t);
  const res = await spawnCli(t, ['help'], { cwd: home });
  assert.equal(res.code, 0, res.stderr);
  assert.ok(res.stdout.includes('deps'), '帮助应提到 deps 命令');
  assert.ok(res.stdout.includes('--depends-on'), '帮助应提到 --depends-on');
  assert.ok(res.stdout.includes('night-shift deps'), '帮助应含 deps 的用法行');

  const cmdHelp = await spawnCli(t, ['deps', '--help'], { cwd: home });
  assert.equal(cmdHelp.code, 0, cmdHelp.stderr);
  assert.ok(cmdHelp.stdout.startsWith('用法：night-shift deps'), cmdHelp.stdout);
  assert.ok(cmdHelp.stdout.includes('--set'));

  const addHelp = await spawnCli(t, ['add', '--help'], { cwd: home });
  assert.ok(addHelp.stdout.includes('--depends-on'), 'add 的用法应含 --depends-on');
});
