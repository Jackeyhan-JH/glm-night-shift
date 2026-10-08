import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { fakeEnv, makeTempHome } from './helpers.js';
// 直接 import bin 不会自动执行 main（入口脚本守卫），所以可以在进程内测子命令机制。
import { main, runCli, COMMANDS } from '../bin/night-shift.mjs';

const binPath = fileURLToPath(new URL('../bin/night-shift.mjs', import.meta.url));
const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

// 作为独立进程跑 bin（端到端）；进程内直接调用 bin 的 runCli/main 见文件后半部分。
function spawnCli(t, args, { cwd } = {}) {
  const dir = cwd ?? makeTempHome(t);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [binPath, ...args], { cwd: dir, env: fakeEnv() });
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

test('--version / -v 输出 package.json 的版本号', async (t) => {
  for (const flag of ['--version', '-v']) {
    const res = await spawnCli(t, [flag]);
    assert.equal(res.code, 0, flag);
    assert.equal(res.stdout, `${pkg.version}\n`, flag);
    assert.equal(res.stderr, '', flag);
  }
});

test('--version 在别的 cwd 下也能读到版本号', async (t) => {
  const res = await spawnCli(t, ['--version'], { cwd: os.tmpdir() });
  assert.equal(res.code, 0);
  assert.equal(res.stdout, `${pkg.version}\n`);
});

test('help / --help / -h / 无参数：stdout 列出用法，退出 0', async (t) => {
  for (const args of [['help'], ['--help'], ['-h'], []]) {
    const res = await spawnCli(t, args);
    assert.equal(res.code, 0, JSON.stringify(args));
    assert.ok(res.stdout.includes('用法'), JSON.stringify(args));
    assert.ok(res.stdout.includes('help'), JSON.stringify(args));
    assert.equal(res.stderr, '', JSON.stringify(args));
  }
});

test('未知命令：stderr 报中文错误并附用法，退出 2', async (t) => {
  const res = await spawnCli(t, ['frobnicate']);
  assert.equal(res.code, 2);
  assert.equal(res.stdout, '');
  assert.ok(res.stderr.includes('未知命令：frobnicate'));
  assert.ok(res.stderr.includes('用法'));
});

test('未知选项：stderr 报中文错误并附用法，退出 2', async (t) => {
  const res = await spawnCli(t, ['--nope']);
  assert.equal(res.code, 2);
  assert.equal(res.stdout, '');
  assert.ok(res.stderr.includes('未知选项：--nope'));
  assert.ok(res.stderr.includes('用法'));
  assert.ok(!res.stderr.includes('at '), '不应打印堆栈');
});

// —— 以下在进程内测子命令机制（临时注入测试命令，测试结束删掉） ——

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

function injectCommand(t, name, def) {
  COMMANDS[name] = def;
  t.after(() => { delete COMMANDS[name]; });
}

test('异步子命令 resolve 的数字成为退出码，main 会写 process.exitCode', async (t) => {
  injectCommand(t, '__test_async', {
    summary: '测试用',
    usage: 'night-shift __test_async',
    run: async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return 3;
    },
  });
  const out = sink();
  const err = sink();
  const prevExitCode = process.exitCode;
  const code = await main(['__test_async'], { stdout: out, stderr: err });
  assert.equal(code, 3);
  assert.equal(process.exitCode, 3);
  assert.equal(out.text(), '');
  process.exitCode = prevExitCode; // 恢复，避免污染本测试进程的退出码
});

test('异步子命令抛出的异常走同一条错误映射（退出 1，不打印堆栈）', async (t) => {
  injectCommand(t, '__test_boom', {
    summary: '测试用',
    usage: 'night-shift __test_boom',
    run: async () => {
      throw new Error('异步爆炸');
    },
  });
  const err = sink();
  const code = await runCli(['__test_boom'], { stdout: sink(), stderr: err });
  assert.equal(code, 1);
  assert.ok(err.text().includes('错误：异步爆炸'));
  assert.ok(!err.text().includes('at '), '不应打印堆栈');
});

test('UsageError 带该命令自己的 usage：退出 2，只打印该命令用法', async (t) => {
  const usage = '用法：night-shift __test_usage --repo <owner/name>\n';
  injectCommand(t, '__test_usage', {
    summary: '测试用',
    usage,
    run(_args, ctx) {
      throw new ctx.UsageError('缺少必填参数：--repo', { usage });
    },
  });
  const err = sink();
  const code = await runCli(['__test_usage'], { stdout: sink(), stderr: err });
  assert.equal(code, 2);
  assert.ok(err.text().includes('错误：缺少必填参数：--repo'));
  assert.ok(err.text().includes('__test_usage --repo'));
  assert.ok(!err.text().includes('GLM 夜班'), '不应回退到全局用法');
});

test('命令内 util.parseArgs 的 ERR_PARSE_ARGS_* 映射为该命令的用法错误（退出 2）', async (t) => {
  const usage = '用法：night-shift __test_parse [--title <标题>]\n';
  injectCommand(t, '__test_parse', {
    summary: '测试用',
    usage,
    run(args) {
      parseArgs({ args, options: { title: { type: 'string' } } }); // 未知选项会抛 ERR_PARSE_ARGS_*
      return 0;
    },
  });
  const err = sink();
  const code = await runCli(['__test_parse', '--nope'], { stdout: sink(), stderr: err });
  assert.equal(code, 2);
  assert.ok(err.text().includes('--nope'));
  assert.ok(err.text().includes('__test_parse'));
});
