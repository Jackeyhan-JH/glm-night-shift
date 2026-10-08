// serve-api 子命令的端到端测试（issue #14）：spawn 真实 CLI 进程（fakeEnv 隔离环境），
// 读启动行「看板 API：http://127.0.0.1:<port>」拿端口，用 fetch 探活，再发 SIGTERM /
// SIGINT 验证正常退出；端口被占用 → 退出 1 并提示换端口。
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fakeEnv, makeTempHome } from './helpers.js';

const binPath = fileURLToPath(new URL('../bin/night-shift.mjs', import.meta.url));

/**
 * 起 serve-api（或任意 args）：返回 { child, base, exit }。
 * base - Promise<string>，启动行打印后 resolve 成 http://127.0.0.1:<port>；
 * exit - Promise<{code, signal}>，进程退出时 resolve；t.after 兜底 SIGKILL 防止泄漏进程。
 */
function spawnServe(t, args, home) {
  const child = spawn(process.execPath, [binPath, ...args], {
    env: fakeEnv({ NIGHT_SHIFT_HOME: home, TZ: 'UTC' }),
  });
  t.after(() => { child.kill('SIGKILL'); }); // 断言中途失败也别留下进程

  let stdout = '';
  let stderr = '';
  const exit = new Promise((resolve) => {
    child.on('close', (code, signal) => resolve({ code, signal }));
  });
  const base = new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`serve-api 未在 10s 内打印启动行；stdout=${stdout} stderr=${stderr}`)),
      10_000,
    );
    let pending = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      pending += chunk;
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) {
        const match = line.match(/^看板 API：http:\/\/(127\.0\.0\.1):(\d+)$/);
        if (match) {
          clearTimeout(timer);
          resolve(`http://${match[1]}:${match[2]}`);
        }
      }
    });
    exit.then(({ code, signal }) => {
      clearTimeout(timer);
      reject(new Error(`serve-api 提前退出：code=${code} signal=${signal} stderr=${stderr}`));
    });
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  // stderr 通过闭包读取；为断言方便挂在进程上
  child.__stderr = () => stderr;
  return { child, base, exit };
}

test('验收: serve-api --port 0 起服务，/api/status 可访问，SIGTERM 退出码 0', async (t) => {
  const home = makeTempHome(t);
  const { child, base, exit } = spawnServe(t, ['serve-api', '--port', '0'], home);
  const url = await base;
  assert.ok(url.startsWith('http://127.0.0.1:'), `启动行端口应随机：${url}`);

  const res = await fetch(`${url}/api/status`);
  assert.equal(res.status, 200);
  const status = await res.json();
  assert.ok(typeof status.now === 'string');
  assert.equal(status.runningCount, 0);
  assert.equal(status.queuedCount, 0);
  assert.equal(status.scheduler, null);

  child.kill('SIGTERM');
  const closed = await exit;
  assert.equal(closed.code, 0, `SIGTERM 后应退出 0（stderr：${child.__stderr()}）`);
  assert.equal(closed.signal, null);
});

test('验收: serve-api 端口被占用时退出码 1，提示换端口', async (t) => {
  // 先占住一个真实端口
  const blocker = spawn(process.execPath, ['--input-type=module', '-e', `
    const http = await import('node:http');
    const server = http.createServer(() => {});
    server.listen(0, '127.0.0.1', () => process.stdout.write(String(server.address().port)));
  `]);
  t.after(() => { blocker.kill('SIGKILL'); });
  const port = await new Promise((resolve, reject) => {
    let text = '';
    blocker.stdout.setEncoding('utf8');
    blocker.stdout.on('data', (chunk) => {
      text += chunk;
      if (/^\d+$/.test(text)) resolve(Number(text));
    });
    setTimeout(() => reject(new Error(`占位服务未启动：${text}`)), 10_000);
  });

  const home = makeTempHome(t);
  const res = await spawnPlain(['serve-api', '--port', String(port)], home);
  assert.equal(res.code, 1, '端口被占用应退出 1');
  assert.ok(res.stderr.includes('占用'), res.stderr);
  assert.ok(res.stderr.includes('--port'), res.stderr);
  assert.ok(res.stderr.includes(String(port)), res.stderr);
});

/** 无启动行等待的朴素 spawn（给预期立刻退出的用例）。 */
function spawnPlain(args, home) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [binPath, ...args], {
      env: fakeEnv({ NIGHT_SHIFT_HOME: home, TZ: 'UTC' }),
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

test('serve-api --port 非法值：用法错误退出 2 并附该命令用法', async (t) => {
  const home = makeTempHome(t);
  for (const bad of ['abc', '-1', '70000', '1.5']) {
    const res = await spawnPlain(['serve-api', '--port', bad], home);
    assert.equal(res.code, 2, `${bad}：${res.stderr}`);
    assert.ok(res.stderr.includes('--port'), `${bad}：${res.stderr}`);
    assert.ok(res.stderr.includes('用法：night-shift serve-api'), `${bad}：${res.stderr}`);
  }
});

test('serve-api 创建数据库与子目录，SIGINT 也正常退出 0，首页可访问', async (t) => {
  const home = makeTempHome(t);
  const { child, base, exit } = spawnServe(t, ['serve-api', '--port', '0'], home);
  const url = await base;

  assert.ok(fs.existsSync(path.join(home, 'night-shift.db')), '应创建 night-shift.db');
  for (const dir of ['logs', 'repos', 'worktrees']) {
    assert.ok(fs.statSync(path.join(home, dir)).isDirectory(), `应创建 ${dir}/`);
  }

  const root = await fetch(`${url}/`);
  assert.equal(root.status, 200);
  assert.ok(root.headers.get('content-type').startsWith('text/html'));

  child.kill('SIGINT');
  const closed = await exit;
  assert.equal(closed.code, 0, `SIGINT 后应退出 0（stderr：${child.__stderr()}）`);
});

test('serve-api 不给 --port 时用配置端口（config.json 里的 port）', async (t) => {
  const home = makeTempHome(t);
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ port: 0 })); // 配置 0 = 随机
  const { base } = spawnServe(t, ['serve-api'], home);
  const url = await base;
  const res = await fetch(`${url}/api/tasks`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), []);
});
