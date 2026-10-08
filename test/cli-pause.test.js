// pause / resume 子命令（issue #38）的测试：进程内直接调 bin 的 runCli（import bin
// 不会自动执行 main），fakeEnv 隔离环境。两次 runCli 各自开关数据库连接，等于模拟
// 「暂停的进程退出后、另一个进程读」的跨进程持久性（标记在库里，不在内存里）。
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { runCli } from '../bin/night-shift.mjs';
import { openDb } from '../src/db.js';
import { getUserPaused } from '../src/tasks.js';
import { fakeEnv, makeTempHome } from './helpers.js';

/** 收集输出的可写 sink（runCli 的 stdout / stderr 参数）。 */
function sink() {
  const chunks = [];
  return {
    write(chunk) {
      chunks.push(String(chunk));
      return true;
    },
    text: () => chunks.join(''),
  };
}

/** 进程内跑一次 CLI；home 指向全新临时目录。 */
async function run(args, home) {
  const stdout = sink();
  const stderr = sink();
  const code = await runCli(args, { stdout, stderr, env: fakeEnv({ NIGHT_SHIFT_HOME: home }) });
  return { code, stdout: stdout.text(), stderr: stderr.text() };
}

/** 直接读库里的手动暂停标记（模拟调度器进程的视角）。 */
function readPaused(home) {
  const db = openDb(path.join(home, 'night-shift.db'));
  try {
    return getUserPaused(db);
  } finally {
    db.close();
  }
}

test('验收: pause 输出「已暂停…」退出 0 并写库；再 pause 输出「已经是暂停状态」也退出 0', async (t) => {
  const home = makeTempHome(t);
  const first = await run(['pause'], home);
  assert.equal(first.code, 0);
  assert.equal(first.stdout, '已暂停：不再领取新任务（正在跑的会跑完）\n');
  assert.equal(first.stderr, '');
  assert.equal(readPaused(home), true, '库里的 userPaused 应为 1');

  const again = await run(['pause'], home);
  assert.equal(again.code, 0, '重复暂停不是错误');
  assert.equal(again.stdout, '已经是暂停状态\n');
  assert.equal(readPaused(home), true);
});

test('验收: resume 输出「已恢复领取」退出 0；未暂停时 resume 输出「没有暂停」也退出 0', async (t) => {
  const home = makeTempHome(t);
  const noop = await run(['resume'], home);
  assert.equal(noop.code, 0, '没暂停就 resume 不是错误');
  assert.equal(noop.stdout, '没有暂停\n');
  assert.equal(readPaused(home), false);

  await run(['pause'], home);
  const resumed = await run(['resume'], home);
  assert.equal(resumed.code, 0);
  assert.equal(resumed.stdout, '已恢复领取\n');
  assert.equal(resumed.stderr, '');
  assert.equal(readPaused(home), false);
});

test('pause / resume 不接受位置参数：多了是用法错误（退出 2）', async (t) => {
  const home = makeTempHome(t);
  for (const [name, args] of [['pause', ['pause', '1']], ['resume', ['resume', 'now']]]) {
    const res = await run(args, home);
    assert.equal(res.code, 2, name);
    assert.equal(res.stdout, '', name);
    assert.ok(res.stderr.includes('参数过多'), name);
    assert.ok(res.stderr.includes(`night-shift ${name}`), `${name} 的错误应附自己的用法`);
  }
  assert.equal(readPaused(home), false, '用法错误不写库');
});

test('pause / resume 不接受未知选项：退出 2（ERR_PARSE_ARGS 映射为用法错误）', async (t) => {
  const home = makeTempHome(t);
  for (const name of ['pause', 'resume']) {
    const res = await run([name, '--nope'], home);
    assert.equal(res.code, 2, name);
    assert.ok(res.stderr.includes('--nope'), name);
  }
});

test('help 列出 pause / resume；<命令> --help 打印各自用法', async (t) => {
  const home = makeTempHome(t);
  const help = await run(['help'], home);
  assert.equal(help.code, 0);
  assert.ok(help.stdout.includes('night-shift pause'), '帮助应含 pause 的用法行');
  assert.ok(help.stdout.includes('night-shift resume'), '帮助应含 resume 的用法行');

  for (const name of ['pause', 'resume']) {
    const res = await run([name, '--help'], home);
    assert.equal(res.code, 0, name);
    assert.equal(res.stdout, `用法：night-shift ${name}\n`);
    assert.equal(res.stderr, '', name);
  }
});
