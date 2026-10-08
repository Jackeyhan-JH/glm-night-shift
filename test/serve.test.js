// serve 子命令与调度器锁的端到端测试（issue #18）：spawn 真实 CLI 进程（fakeEnv 隔离
// 环境），本地 bare 仓库 + 假 claude / 假 gh，用 fetch 打真实 HTTP 接口，绝不联网、
// 不碰 GitHub、不消耗额度。时间用 NIGHT_SHIFT_NOW 固定（周六非高峰 / 周四高峰各一处），
// TZ 固定 Asia/Shanghai，事件行的 [HH:MM] 前缀因此可断言。等待一律轮询 + 截止时间。
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../src/db.js';
import { getTask } from '../src/tasks.js';
import {
  SchedulerLockHeldError,
  acquireSchedulerLock,
  isLiveNightShift,
  schedulerLockPath,
} from '../src/scheduler-lock.js';
import { fakeEnv, makeTempHome } from './helpers.js';

// 隔离 git 配置（同 test/cli-run.test.js）：不读机器配置，提交身份显式给；
// 这些变量经 fakeEnv 复制进每个子进程。
process.env.GIT_CONFIG_NOSYSTEM = '1';
process.env.GIT_CONFIG_GLOBAL = path.join(os.tmpdir(), 'night-shift-serve-test-absent-global-config');
process.env.GIT_AUTHOR_NAME = '夜班服务测试';
process.env.GIT_AUTHOR_EMAIL = 'night-shift-serve-test@example.com';
process.env.GIT_COMMITTER_NAME = '夜班服务测试';
process.env.GIT_COMMITTER_EMAIL = 'night-shift-serve-test@example.com';

const binPath = fileURLToPath(new URL('../bin/night-shift.mjs', import.meta.url));
/** 周六北京 15:00，非高峰：任务能被领取的时间基准。 */
const OFF_PEAK_NOW = '2026-10-10T07:00:00Z';
/** 周四北京 15:00，高峰：serve 只打印「暂停领取：高峰期」，队列不被领走。 */
const PEAK_NOW = '2026-10-08T07:00:00Z';

/** 同步跑 git（参数数组，无 shell），失败即断言失败并附 stderr。 */
function git(args, cwd) {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.ok(res.status === 0, `git ${args.join(' ')} 失败（cwd=${cwd}）：${res.stderr}`);
  return res.stdout;
}

/** 建一个默认分支 main、含 README 的本地 bare 仓库当远端。 */
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

/** 一套环境：bare 远端 + 临时 home + config.json（remoteUrlTemplate 指向本地 bare、pollSeconds 0.2、killGraceSeconds 1）。 */
function setup(t, { config = {} } = {}) {
  const remote = makeBareRemote(t);
  const home = makeTempHome(t);
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({
    remoteUrlTemplate: path.join(remote.dir, '{owner}__{name}.git'),
    pollSeconds: 0.2,
    killGraceSeconds: 1,
    ...config,
  }));
  return { remote, home };
}

/** spawn 一个 CLI 子进程（TZ 固定 Asia/Shanghai），增量收集 stdout / stderr；close 为退出信息 Promise。 */
function spawnCliProc(args, { home, env: envOverrides = {} } = {}) {
  const child = spawn(process.execPath, [binPath, ...args], {
    env: fakeEnv({ NIGHT_SHIFT_HOME: home, TZ: 'Asia/Shanghai', ...envOverrides }),
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const close = new Promise((resolve) => {
    child.on('close', (code, signal) => resolve({ code, signal }));
  });
  return { child, close, stdout: () => stdout, stderr: () => stderr };
}

/** 跑一个预期会退出的 CLI 命令，等它结束并带上全部输出。 */
async function runCli(args, options) {
  const proc = spawnCliProc(args, options);
  const { code, signal } = await proc.close;
  return { code, signal, stdout: proc.stdout(), stderr: proc.stderr() };
}

/**
 * 起 serve 并等启动行：`GLM 夜班已启动：看板 http://<host>:<port>，…`。
 * 返回 { child, close, base, stdout, stderr }；base 是 { host, port } 的 Promise。
 */
function spawnServe(t, args, { home, env: envOverrides = {} } = {}) {
  const proc = spawnCliProc(['serve', ...args], { home, env: envOverrides });
  t.after(() => { proc.child.kill('SIGKILL'); }); // 断言中途失败也别留下进程
  const base = new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`serve 未在 15 秒内打印启动行；stdout=${proc.stdout()} stderr=${proc.stderr()}`)),
      15_000,
    );
    const poll = setInterval(() => {
      const match = proc.stdout().match(/^GLM 夜班已启动：看板 http:\/\/(\[[^\]]+\]|[^\s:，]+):(\d+)/m);
      if (match) {
        clearTimeout(timer);
        clearInterval(poll);
        resolve({ host: match[1], port: Number(match[2]) });
      }
    }, 20);
    proc.close.then(({ code, signal }) => {
      clearTimeout(timer);
      clearInterval(poll);
      reject(new Error(`serve 提前退出：code=${code} signal=${signal} stdout=${proc.stdout()} stderr=${proc.stderr()}`));
    });
  });
  return { ...proc, base };
}

/** 轮询等待 fn() 为真，到点仍未真则断言失败。 */
async function waitUntil(fn, { timeoutMs = 5000, message = '条件在超时内未满足' } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await fn()) return;
    if (Date.now() >= deadline) assert.fail(message);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** Promise 限时：超时断言失败（给「X 秒内退出」类验收用）。 */
async function withTimeout(promise, timeoutMs, message) {
  let timer;
  await Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
  return promise;
}

/** 从测试进程读某个任务（WAL 支持与 CLI 子进程同时读写同一文件库）。 */
function readTask(home, id) {
  const db = openDb(path.join(home, 'night-shift.db'));
  try {
    return getTask(db, id);
  } finally {
    db.close();
  }
}

/** 锁文件第一行的 pid（测试造/查过期锁用）。 */
function lockPid(home) {
  return fs.readFileSync(schedulerLockPath(home), 'utf8').split('\n')[0];
}

/** 新建一条 TCP 连接是否被拒绝（ECONNREFUSED）；连上或超时都算「未被拒绝」。 */
function connectRefused(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host });
    socket.setTimeout(1500, () => { socket.destroy(); resolve(false); });
    socket.on('error', (err) => resolve(err.code === 'ECONNREFUSED'));
    socket.on('connect', () => { socket.destroy(); resolve(false); });
  });
}

/** 起一个占住 127.0.0.1 随机端口的服务，resolve 端口号；测试结束自动清理。 */
async function occupyPort(t) {
  const blocker = spawn(process.execPath, ['--input-type=module', '-e', `
    const http = await import('node:http');
    const server = http.createServer(() => {});
    server.listen(0, '127.0.0.1', () => process.stdout.write(String(server.address().port)));
  `]);
  t.after(() => { blocker.kill('SIGKILL'); });
  return await new Promise((resolve, reject) => {
    let text = '';
    const timer = setTimeout(() => reject(new Error(`占位服务未启动：${text}`)), 10_000);
    blocker.stdout.setEncoding('utf8');
    blocker.stdout.on('data', (chunk) => {
      text += chunk;
      if (/^\d+$/.test(text)) {
        clearTimeout(timer);
        resolve(Number(text));
      }
    });
  });
}

// ---------------------------------------------------------------- serve 主流程

test('验收: serve --port 0：/api/status.scheduler 非 null，POST 任务 15 秒内 succeeded 带 prUrl，SIGINT 3 秒内退出 0', async (t) => {
  const { home } = setup(t);
  const proc = spawnServe(t, ['--port', '0'], { home, env: { NIGHT_SHIFT_NOW: OFF_PEAK_NOW } });
  const { host, port } = await proc.base;
  assert.equal(host, '127.0.0.1');

  const status = await (await fetch(`http://127.0.0.1:${port}/api/status`)).json();
  assert.notEqual(status.scheduler, null, '/api/status 的 scheduler 应有值');
  assert.deepEqual(status.scheduler.running, []);
  assert.equal(status.queuedCount, 0);

  const created = await fetch(`http://127.0.0.1:${port}/api/tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ repo: 'a/b', prompt: '做点修改', testCommand: 'test -f NIGHT_SHIFT_FAKE.md' }),
  });
  assert.equal(created.status, 201);
  assert.equal((await created.json()).status, 'queued');

  // 等成功行本身（done 事件在 worktree 清理之后才发，比库里的 succeeded 晚一拍，
  // 直接等库状态再断言 stdout 会有竞态——同 test/cli-run.test.js 的 start 测试）
  await waitUntil(() => proc.stdout().includes('#1 成功：'),
    { timeoutMs: 15_000, message: '任务应在 15 秒内跑成并打印成功行' });
  const task = readTask(home, 1);
  assert.ok(task.prUrl.startsWith('https://github.com/a/b/pull/'), task.prUrl);
  const shown = await (await fetch(`http://127.0.0.1:${port}/api/tasks/1`)).json();
  assert.equal(shown.status, 'succeeded');
  assert.ok(shown.prUrl.startsWith('https://github.com/a/b/pull/'), shown.prUrl);

  // 启动行与调度事件行：事件行格式与 start 完全一致（同一份 scheduler-log.js）
  const out = proc.stdout();
  assert.ok(out.includes(`GLM 夜班已启动：看板 http://127.0.0.1:${port}，并发 1，数据目录 ${home}`), out);
  assert.ok(out.includes('[15:00] 领取 #1 做点修改'), out);
  assert.ok(out.includes('[15:00] #1 成功：https://github.com/a/b/pull/'), out);

  proc.child.kill('SIGINT');
  const closed = await withTimeout(proc.close, 3000, 'SIGINT 后 3 秒内应退出');
  assert.equal(closed.code, 0);
  assert.equal(closed.signal, null);
  assert.equal(fs.existsSync(schedulerLockPath(home)), false, '正常退出应删掉自己的锁');
});

test('验收: serve hang 任务：第一次 SIGINT 不退出、新 TCP 连接被拒；第二次 SIGINT 3 秒内退出 0、任务回 queued', async (t) => {
  const { home } = setup(t);
  const add = await runCli(['add', '--repo', 'a/b', '--prompt', '挂起任务'], { home });
  assert.equal(add.code, 0, add.stderr);

  const proc = spawnServe(t, ['--port', '0'], {
    home,
    env: { NIGHT_SHIFT_NOW: OFF_PEAK_NOW, FAKE_CLAUDE_SCENARIO: 'hang' },
  });
  const { port } = await proc.base;
  await waitUntil(() => readTask(home, 1)?.status === 'running',
    { timeoutMs: 10_000, message: '任务应被领取并处于 running' });

  proc.child.kill('SIGINT');
  await waitUntil(() => proc.stdout().includes('再按 Ctrl-C 强制停止'),
    { timeoutMs: 2000, message: '第一次 SIGINT 应打印优雅停止提示' });
  assert.ok(proc.stdout().includes('正在停止：不再领取新任务，等待 1 个运行中的任务结束'), proc.stdout());
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(proc.child.exitCode, null, '优雅停止期间进程不应退出');
  assert.equal(readTask(home, 1).status, 'running');
  assert.equal(await connectRefused(port), true, 'HTTP 端口应不再接受新连接');

  proc.child.kill('SIGINT');
  await waitUntil(() => proc.stdout().includes('强制停止'),
    { timeoutMs: 2000, message: '第二次 SIGINT 应打印强制停止' });
  const closed = await withTimeout(proc.close, 3000, '第二次 SIGINT 后 3 秒内应退出');
  assert.equal(closed.code, 0);
  assert.equal(closed.signal, null);
  const task = readTask(home, 1);
  assert.equal(task.status, 'queued');
  assert.equal(task.attempts, 0, '停机中断退还这次尝试');
  assert.equal(fs.existsSync(schedulerLockPath(home)), false, '强制退出也应删掉自己的锁');
});

test('serve 优雅停止不掐已建立的 SSE：第一次 SIGINT 后流仍开着，第二次强制退出时才断', async (t) => {
  const { home } = setup(t);
  const add = await runCli(['add', '--repo', 'a/b', '--prompt', '挂起并观察'], { home });
  assert.equal(add.code, 0, add.stderr);

  const proc = spawnServe(t, ['--port', '0'], {
    home,
    env: { NIGHT_SHIFT_NOW: OFF_PEAK_NOW, FAKE_CLAUDE_SCENARIO: 'hang' },
  });
  const { port } = await proc.base;
  let runId;
  // 整套并行时偶发一次 fetch 卡住十几秒，deadline 要等它返回才检查，10 秒预算就被吃光。
  // 单次请求 2 秒到点就放弃，下一轮再问，总预算放到 20 秒。
  await waitUntil(async () => {
    let res;
    try {
      res = await fetch(`http://127.0.0.1:${port}/api/tasks/1`, { signal: AbortSignal.timeout(2000) });
    } catch {
      return false;
    }
    if (!res.ok) return false;
    const task = await res.json();
    if (task.runs.length > 0) {
      runId = task.runs[0].id;
      return true;
    }
    return false;
  }, { timeoutMs: 20_000, message: 'run 行应已创建' });

  const controller = new AbortController();
  t.after(() => controller.abort());
  const res = await fetch(`http://127.0.0.1:${port}/api/runs/${runId}/stream`, { signal: controller.signal });
  assert.equal(res.status, 200);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let sse = '';
  /** 读一块 SSE 数据；返回 'open'（还有流）、'closed'（对端结束/出错）。 */
  const readMore = async () => {
    try {
      const { value, done } = await reader.read();
      if (done) return 'closed';
      sse += decoder.decode(value, { stream: true });
      return 'open';
    } catch {
      return 'closed'; // 连接被对端销毁（reset）
    }
  };

  proc.child.kill('SIGINT'); // 任务运行中：进入优雅等待
  await waitUntil(() => proc.stdout().includes('再按 Ctrl-C 强制停止'),
    { timeoutMs: 2000, message: '第一次 SIGINT 应打印优雅停止提示' });

  // 第一次信号后的 600ms 里，SSE 连接不应被掐：read 要么等到新数据（open），
  // 要么一直挂着直到超时（仍是 open）；只有被销毁才会立刻 closed。
  const survived = await Promise.race([
    readMore().then((state) => state === 'open'),
    new Promise((resolve) => setTimeout(() => resolve(true), 600)),
  ]);
  assert.equal(survived, true, '第一次 SIGINT 不应销毁已建立的 SSE 连接');

  proc.child.kill('SIGINT'); // 强制停止：进程退出，连接随之结束
  const closed = await withTimeout(proc.close, 3000, '第二次 SIGINT 后 3 秒内应退出');
  assert.equal(closed.code, 0);
  assert.equal(readTask(home, 1).status, 'queued');
});

test('验收: 端口被占用：退出 1、提示含 被占用 与可用 --port、预置任务保持 queued（未领取）', async (t) => {
  const { home } = setup(t);
  const add = await runCli(['add', '--repo', 'a/b', '--prompt', '排队任务'], { home, env: { NIGHT_SHIFT_NOW: OFF_PEAK_NOW } });
  assert.equal(add.code, 0, add.stderr);

  const port = await occupyPort(t);
  const res = await runCli(['serve', '--port', String(port)], { home, env: { NIGHT_SHIFT_NOW: OFF_PEAK_NOW } });
  assert.equal(res.code, 1, '端口被占用应退出 1');
  assert.ok(res.stderr.includes(`端口 ${port} 被占用，可用 --port 或配置 port 修改`), res.stderr);
  assert.equal(res.stdout.includes('GLM 夜班已启动'), false, '不应打印启动行');

  await new Promise((resolve) => setTimeout(resolve, 600)); // 万一调度器被启动了，这里给它时间露馅
  assert.equal(readTask(home, 1).status, 'queued', '任务不应被领取（不能出现只有调度器在跑的半启动）');
  assert.equal(fs.existsSync(schedulerLockPath(home)), false, '启动失败的 serve 应释放锁');
});

test('验收: config.json host 0.0.0.0：stderr 有无登录保护的安全警告（含 host）', async (t) => {
  const { home } = setup(t, { config: { host: '0.0.0.0' } });
  const proc = spawnServe(t, ['--port', '0'], { home, env: { NIGHT_SHIFT_NOW: OFF_PEAK_NOW } });
  const { host } = await proc.base;
  assert.equal(host, '0.0.0.0', '非回环 host 的启动行印配置的 host');
  const err = proc.stderr();
  assert.ok(err.includes('安全警告'), err);
  assert.ok(err.includes('0.0.0.0'), err);
  assert.ok(err.includes('登录'), err);

  proc.child.kill('SIGINT');
  const closed = await withTimeout(proc.close, 3000, 'SIGINT 后 3 秒内应退出');
  assert.equal(closed.code, 0);
});

test('serve 不给 --port 时用配置端口（config.json 的 port）', async (t) => {
  const { home } = setup(t, { config: { port: 0 } }); // 配置 0 = 随机
  const proc = spawnServe(t, [], { home, env: { NIGHT_SHIFT_NOW: OFF_PEAK_NOW } });
  const { port } = await proc.base;
  const res = await fetch(`http://127.0.0.1:${port}/api/tasks`);
  assert.equal(res.status, 200);
  proc.child.kill('SIGINT');
  const closed = await withTimeout(proc.close, 3000, 'SIGINT 后 3 秒内应退出');
  assert.equal(closed.code, 0);
});

test('serve --port 非法值：用法错误退出 2 并附该命令用法', async (t) => {
  const home = makeTempHome(t);
  for (const bad of ['abc', '-1', '70000', '1.5']) {
    const res = await runCli(['serve', '--port', bad], { home });
    assert.equal(res.code, 2, `${bad}：${res.stderr}`);
    assert.ok(res.stderr.includes('--port'), `${bad}：${res.stderr}`);
    assert.ok(res.stderr.includes('用法：night-shift serve'), `${bad}：${res.stderr}`);
  }
});

// ---------------------------------------------------------------- 调度器锁（端到端）

test('验收: 锁：同一 home 的第二个 serve 立即退出 1 且 stderr 含第一个 pid；杀掉第一个后第三个能启动', async (t) => {
  const { home } = setup(t);
  const first = spawnServe(t, ['--port', '0'], { home, env: { NIGHT_SHIFT_NOW: OFF_PEAK_NOW } });
  await first.base;
  assert.equal(lockPid(home), String(first.child.pid), '锁文件应写着第一个进程的 pid');

  const second = await runCli(['serve', '--port', '0'], { home, env: { NIGHT_SHIFT_NOW: OFF_PEAK_NOW } });
  assert.equal(second.code, 1, `第二个 serve 应退出 1（stderr：${second.stderr}）`);
  assert.ok(second.stderr.includes(`已有调度器在运行（pid ${first.child.pid}`), second.stderr);
  assert.equal(second.stdout, '');
  assert.equal(lockPid(home), String(first.child.pid), '第二个进程不应动第一个的锁');

  first.child.kill('SIGKILL'); // 模拟崩溃：来不及删锁，留下过期锁
  await first.close;
  assert.equal(fs.existsSync(schedulerLockPath(home)), true, '被杀进程留下过期锁');

  const third = spawnServe(t, ['--port', '0'], { home, env: { NIGHT_SHIFT_NOW: OFF_PEAK_NOW } });
  const { port } = await third.base; // 接管过期锁并完成监听
  assert.equal(lockPid(home), String(third.child.pid));
  const status = await (await fetch(`http://127.0.0.1:${port}/api/status`)).json();
  assert.notEqual(status.scheduler, null);
  third.child.kill('SIGINT');
  const closed = await withTimeout(third.close, 3000, 'SIGINT 后 3 秒内应退出');
  assert.equal(closed.code, 0);
});

test('验收: start 遇到运行中的 serve：同样被锁挡住（退出 1、提示 pid），排队任务不被领取', async (t) => {
  const { home } = setup(t);
  const add = await runCli(['add', '--repo', 'a/b', '--prompt', '高峰排队'], { home });
  assert.equal(add.code, 0, add.stderr);

  // 高峰时段起 serve：队列里的任务不会被领取，方便断言 start 也没领
  const proc = spawnServe(t, ['--port', '0'], { home, env: { NIGHT_SHIFT_NOW: PEAK_NOW } });
  await proc.base;
  await waitUntil(() => proc.stdout().includes('暂停领取：高峰期'),
    { timeoutMs: 5000, message: '高峰时段 serve 应打印暂停领取' });

  const res = await runCli(['start'], { home, env: { NIGHT_SHIFT_NOW: PEAK_NOW } });
  assert.equal(res.code, 1, `start 应被锁挡住（stderr：${res.stderr}）`);
  assert.ok(res.stderr.includes(`已有调度器在运行（pid ${proc.child.pid}`), res.stderr);
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(readTask(home, 1).status, 'queued', 'start 不应领取任务');

  proc.child.kill('SIGINT');
  const closed = await withTimeout(proc.close, 3000, 'SIGINT 后 3 秒内应退出');
  assert.equal(closed.code, 0);
  assert.equal(fs.existsSync(schedulerLockPath(home)), false);
});

// ---------------------------------------------------------------- 调度器锁（单元）

test('锁·单元：pid 已死 → 接管过期锁；release 删除自己的锁且幂等', (t) => {
  const home = makeTempHome(t);
  const dead = spawnSync(process.execPath, ['-e', '']); // 立即退出的子进程：留一个已死的 pid
  assert.equal(dead.status, 0, dead.stderr);
  fs.writeFileSync(schedulerLockPath(home), `${dead.pid}\n`);
  const lock = acquireSchedulerLock(home); // 不抛：死 pid 视为过期
  assert.equal(lockPid(home), String(process.pid), '接管后锁里应是自己');
  assert.equal(lock.release(), true);
  assert.equal(fs.existsSync(schedulerLockPath(home)), false);
  assert.equal(lock.release(), false, 'release 幂等');
});

test('锁·单元：pid 活着但不是 night-shift（如 pid 1）→ 视为过期，接管', (t) => {
  const home = makeTempHome(t);
  assert.equal(isLiveNightShift(1), false, 'pid 1 的 cmdline 不含 night-shift');
  fs.writeFileSync(schedulerLockPath(home), '1\n');
  const lock = acquireSchedulerLock(home);
  assert.equal(lockPid(home), String(process.pid));
  lock.release();
});

test('锁·单元：活着的 night-shift 进程持锁 → 抛 SchedulerLockHeldError（信息含 pid）；release 不删别人的锁', async (t) => {
  const home = makeTempHome(t);
  // 一个 cmdline 含 night-shift 的活进程（参数名进 /proc/<pid>/cmdline）
  const holder = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', 'night-shift-holder']);
  t.after(() => { holder.kill('SIGKILL'); });
  await waitUntil(() => isLiveNightShift(holder.pid),
    { timeoutMs: 5000, message: '占位进程应已启动且被识别为 night-shift' });

  fs.writeFileSync(schedulerLockPath(home), `${holder.pid}\n`);
  assert.throws(
    () => acquireSchedulerLock(home),
    (err) => err instanceof SchedulerLockHeldError && err.pid === holder.pid
      && err.message.includes(`已有调度器在运行（pid ${holder.pid}`),
    '活着的 night-shift 持锁时应抛 SchedulerLockHeldError',
  );
  assert.equal(lockPid(home), String(holder.pid), '失败的获取不应改写锁');

  // 自己的锁被后继者接管后：release 不能删掉后继者的锁
  fs.rmSync(schedulerLockPath(home));
  const lock = acquireSchedulerLock(home);
  fs.writeFileSync(schedulerLockPath(home), `${holder.pid}\n`); // 模拟后继者已接管
  assert.equal(lock.release(), false);
  assert.equal(lockPid(home), String(holder.pid), '后继者的锁应原样保留');
});

// ---------------------------------------------------------------- 帮助与命令注册

test('help 列出 serve / install-service / uninstall-service（含各自用法行），尾注不再说 serve 未实现', async (t) => {
  const home = makeTempHome(t);
  const res = await runCli(['help'], { home });
  assert.equal(res.code, 0, res.stderr);
  for (const name of ['serve', 'install-service', 'uninstall-service']) {
    assert.ok(res.stdout.includes(`night-shift ${name}`), `帮助应含 ${name} 的用法行：\n${res.stdout}`);
  }
  assert.equal(res.stdout.includes('后续版本'), false, '帮助尾注不应再说命令未实现');
});

test('serve / install-service / uninstall-service 的 <命令> --help：退出 0，打印各自用法', async (t) => {
  const home = makeTempHome(t);
  for (const name of ['serve', 'install-service', 'uninstall-service']) {
    const res = await runCli([name, '--help'], { home });
    assert.equal(res.code, 0, `${name}：${res.stderr}`);
    assert.ok(res.stdout.startsWith('用法：night-shift '), `${name}：${res.stdout}`);
  }
});
