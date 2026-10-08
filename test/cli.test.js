import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { fakeEnv, makeTempHome } from './helpers.js';

const binPath = fileURLToPath(new URL('../bin/night-shift.mjs', import.meta.url));
const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

function runCli(t, args, { cwd } = {}) {
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
    const res = await runCli(t, [flag]);
    assert.equal(res.code, 0, flag);
    assert.equal(res.stdout, `${pkg.version}\n`, flag);
    assert.equal(res.stderr, '', flag);
  }
});

test('--version 在别的 cwd 下也能读到版本号', async (t) => {
  const res = await runCli(t, ['--version'], { cwd: os.tmpdir() });
  assert.equal(res.code, 0);
  assert.equal(res.stdout, `${pkg.version}\n`);
});

test('help / --help / -h / 无参数：stdout 列出用法，退出 0', async (t) => {
  for (const args of [['help'], ['--help'], ['-h'], []]) {
    const res = await runCli(t, args);
    assert.equal(res.code, 0, JSON.stringify(args));
    assert.ok(res.stdout.includes('用法'), JSON.stringify(args));
    assert.ok(res.stdout.includes('help'), JSON.stringify(args));
    assert.equal(res.stderr, '', JSON.stringify(args));
  }
});

test('未知命令：stderr 报中文错误并附用法，退出 2', async (t) => {
  const res = await runCli(t, ['frobnicate']);
  assert.equal(res.code, 2);
  assert.equal(res.stdout, '');
  assert.ok(res.stderr.includes('未知命令：frobnicate'));
  assert.ok(res.stderr.includes('用法'));
});

test('未知选项：stderr 报中文错误并附用法，退出 2', async (t) => {
  const res = await runCli(t, ['--nope']);
  assert.equal(res.code, 2);
  assert.equal(res.stdout, '');
  assert.ok(res.stderr.includes('未知选项：--nope'));
  assert.ok(res.stderr.includes('用法'));
  assert.ok(!res.stderr.includes('at '), '不应打印堆栈');
});
