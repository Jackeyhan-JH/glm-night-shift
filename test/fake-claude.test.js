import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fixturePath, fakeEnv, makeTempHome } from './helpers.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function withTimeout(promise, ms, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

function collect(child) {
  return new Promise((resolve, reject) => {
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

// 用 node 直接跑假 claude；cwd 默认是全新临时目录（绝不在仓库根目录里跑）。
function runFakeClaude(t, args, { env = {}, input = '', cwd } = {}) {
  const dir = cwd ?? makeTempHome(t);
  const child = spawn(process.execPath, [fixturePath('fake-claude.mjs'), ...args], {
    cwd: dir,
    env: fakeEnv(env),
  });
  const done = collect(child);
  if (input !== undefined) child.stdin.end(input);
  return done.then((res) => ({ ...res, dir }));
}

function stdoutLines(res) {
  return res.stdout.split('\n').filter((line) => line !== '').map((line) => JSON.parse(line));
}

test('验收：-p hi --model … --output-format stream-json --verbose', async (t) => {
  const dir = makeTempHome(t);
  const argsLog = path.join(dir, 'a.log');
  const res = await runFakeClaude(
    t,
    ['-p', 'hi', '--model', 'glm-5.3', '--output-format', 'stream-json', '--verbose'],
    { env: { FAKE_CLAUDE_ARGS_LOG: argsLog, MAX_THINKING_TOKENS: '8000' }, cwd: dir },
  );
  assert.equal(res.code, 0);
  assert.equal(res.stderr, '');

  const lines = stdoutLines(res); // 每行都能被 JSON.parse
  assert.equal(lines.length, 3);
  assert.equal(lines[0].type, 'system');
  assert.equal(lines[0].subtype, 'init');
  assert.equal(lines[0].model, 'glm-5.3');
  assert.equal(lines[0].cwd, dir);
  assert.equal(typeof lines[0].session_id, 'string');
  assert.equal(lines[1].type, 'assistant');
  assert.equal(lines[1].message.content[0].text, '(fake) working on: hi');
  assert.equal(lines[1].session_id, lines[0].session_id);
  const result = lines[2];
  assert.equal(result.type, 'result');
  assert.equal(result.subtype, 'success');
  assert.equal(result.is_error, false);
  assert.equal(result.num_turns, 3);
  assert.equal(result.result, 'done');
  assert.equal(result.total_cost_usd, 0);
  assert.ok(Number.isInteger(result.duration_ms) && result.duration_ms >= 0);

  assert.equal(fs.readFileSync(path.join(res.dir, 'NIGHT_SHIFT_FAKE.md'), 'utf8'), 'hi\n');

  const logged = fs.readFileSync(argsLog, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(logged, [{
    argv: ['-p', 'hi', '--model', 'glm-5.3', '--output-format', 'stream-json', '--verbose'],
    cwd: res.dir,
    env: { MAX_THINKING_TOKENS: '8000' },
  }]);
});

test('未传 --model 时 init 行 model 为 null；未设 MAX_THINKING_TOKENS 时日志记 null', async (t) => {
  const dir = makeTempHome(t);
  const argsLog = path.join(dir, 'a.log');
  const res = await runFakeClaude(t, ['-p', 'hi'], { env: { FAKE_CLAUDE_ARGS_LOG: argsLog }, cwd: dir });
  assert.equal(res.code, 0);
  assert.equal(stdoutLines(res)[0].model, null);
  const logged = JSON.parse(fs.readFileSync(argsLog, 'utf8').trim());
  assert.equal(logged.env.MAX_THINKING_TOKENS, null);
});

test('多行 prompt 写进 NIGHT_SHIFT_FAKE.md 时压成一行', async (t) => {
  const res = await runFakeClaude(t, ['-p', '第一行\n第二行\n\n第三行', '--dangerously-skip-permissions'], {});
  assert.equal(res.code, 0);
  assert.equal(fs.readFileSync(path.join(res.dir, 'NIGHT_SHIFT_FAKE.md'), 'utf8'), '第一行 第二行 第三行\n');
});

test('fail：退出码 1，最后一行 is_error 为 true，stderr 有一行错误', async (t) => {
  const res = await runFakeClaude(t, ['-p', 'hi'], { env: { FAKE_CLAUDE_SCENARIO: 'fail' } });
  assert.equal(res.code, 1);
  assert.notEqual(res.stderr.trim(), '');
  const lines = stdoutLines(res);
  const result = lines[lines.length - 1];
  assert.equal(result.type, 'result');
  assert.equal(result.subtype, 'error_during_execution');
  assert.equal(result.is_error, true);
  assert.equal(result.result, 'fake failure');
  assert.equal(fs.existsSync(path.join(res.dir, 'NIGHT_SHIFT_FAKE.md')), false);
});

test('hang：3 秒后仍存活，SIGTERM 后 1 秒内以 143 退出', async (t) => {
  const dir = makeTempHome(t);
  const child = spawn(process.execPath, [fixturePath('fake-claude.mjs'), '-p', 'hang'], {
    cwd: dir,
    env: fakeEnv({ FAKE_CLAUDE_SCENARIO: 'hang' }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const firstLine = withTimeout(new Promise((resolve, reject) => {
    child.stdout.setEncoding('utf8');
    child.stdout.once('data', resolve);
    child.once('error', reject);
  }), 5000, '没有等到 init 行');
  const parsed = JSON.parse((await firstLine).toString().split('\n')[0]);
  assert.equal(parsed.type, 'system');

  await sleep(3000);
  assert.equal(child.exitCode, null, '3 秒后进程应仍在运行');
  assert.equal(child.killed, false);

  const closed = new Promise((resolve) => child.on('close', (code, signal) => resolve({ code, signal })));
  child.kill('SIGTERM');
  const outcome = await Promise.race([closed, sleep(1000).then(() => ({ timeout: true }))]);
  assert.ok(!outcome.timeout, 'SIGTERM 后 1 秒内应退出');
  assert.equal(outcome.code, 143);
});

test('slow：FAKE_CLAUDE_DELAY_MS=600，约 0.6 秒后成功退出，期间输出多行 assistant', async (t) => {
  const startedAt = Date.now();
  const res = await runFakeClaude(t, ['-p', 'slow'], { env: { FAKE_CLAUDE_SCENARIO: 'slow', FAKE_CLAUDE_DELAY_MS: '600' } });
  const elapsed = Date.now() - startedAt;
  assert.equal(res.code, 0);
  assert.ok(elapsed >= 550 && elapsed <= 1500, `耗时应在 550～1500ms，实际 ${elapsed}ms`);
  const lines = stdoutLines(res);
  assert.ok(lines.filter((line) => line.type === 'assistant').length >= 2, '至少 2 行 assistant');
  const result = lines[lines.length - 1];
  assert.equal(result.type, 'result');
  assert.equal(result.is_error, false);
  assert.equal(fs.readFileSync(path.join(res.dir, 'NIGHT_SHIFT_FAKE.md'), 'utf8'), 'slow\n');
});

test('noop：输出与 success 相同但不写任何文件', async (t) => {
  const dir = makeTempHome(t);
  const res = await runFakeClaude(t, ['-p', 'quiet'], { env: { FAKE_CLAUDE_SCENARIO: 'noop' }, cwd: dir });
  assert.equal(res.code, 0);
  const lines = stdoutLines(res);
  assert.equal(lines.length, 3);
  assert.equal(lines[2].is_error, false);
  assert.equal(fs.existsSync(path.join(res.dir, 'NIGHT_SHIFT_FAKE.md')), false);
});

test('带 -p 但没有 prompt 参数时，从 stdin 读 prompt', async (t) => {
  const res = await runFakeClaude(
    t,
    ['-p', '--output-format', 'stream-json', '--verbose'],
    { input: '从 stdin 来的提示词' },
  );
  assert.equal(res.code, 0);
  const lines = stdoutLines(res);
  assert.equal(lines[1].message.content[0].text, '(fake) working on: 从 stdin 来的提示词');
  assert.equal(fs.readFileSync(path.join(res.dir, 'NIGHT_SHIFT_FAKE.md'), 'utf8'), '从 stdin 来的提示词\n');
});

test('无参数运行：立即退出 0，无输出、无文件（node --test 误跑时无副作用）', async (t) => {
  const dir = makeTempHome(t);
  const child = spawn(process.execPath, [fixturePath('fake-claude.mjs')], {
    cwd: dir,
    env: fakeEnv(), // 故意不关闭 stdin：如果实现等待 stdin 就会超时
  });
  const outcome = await Promise.race([
    collect(child),
    sleep(3000).then(() => ({ timeout: true })),
  ]);
  if (outcome.timeout) {
    child.kill('SIGKILL');
    assert.fail('无参数时不应等待 stdin，应立即退出');
  }
  assert.equal(outcome.code, 0);
  assert.equal(outcome.stdout, '');
  assert.equal(outcome.stderr, '');
  assert.equal(fs.existsSync(path.join(dir, 'NIGHT_SHIFT_FAKE.md')), false);
});

test('未知 FAKE_CLAUDE_SCENARIO：stderr 提示并退出 2', async (t) => {
  const res = await runFakeClaude(t, ['-p', 'hi'], { env: { FAKE_CLAUDE_SCENARIO: 'bogus' } });
  assert.equal(res.code, 2);
  assert.ok(res.stderr.includes('FAKE_CLAUDE_SCENARIO'));
  assert.equal(fs.existsSync(path.join(res.dir, 'NIGHT_SHIFT_FAKE.md')), false);
});

test('fakeEnv 的 PATH shim：裸 claude 命令也命中假替身', (t) => {
  const dir = makeTempHome(t);
  const res = spawnSync('claude', ['-p', 'via-shim'], { cwd: dir, env: fakeEnv(), encoding: 'utf8' });
  assert.ok(!res.error, `应通过 PATH 找到 claude shim：${res.error}`);
  assert.equal(res.status, 0);
  const lines = res.stdout.trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(lines.length, 3);
  assert.equal(lines[2].type, 'result');
  assert.equal(lines[2].is_error, false);
  assert.equal(fs.readFileSync(path.join(dir, 'NIGHT_SHIFT_FAKE.md'), 'utf8'), 'via-shim\n');
});
