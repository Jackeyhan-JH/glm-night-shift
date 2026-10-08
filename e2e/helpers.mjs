// e2e 辅助（issue #19）：给端到端场景搭一套隔离「世界」并提供进程 / 等待 / 只读查询工具。
//
// - makeWorld(t)：一个场景一套环境——os.tmpdir() 下的临时目录当 NIGHT_SHIFT_HOME，
//   `<root>/remotes/demo__app.git` 本地 bare 仓库当远端（做法同 test/git.test.js 的
//   makeBareRemote，绝不联网），`<home>/config.json` 把 remoteUrlTemplate 指到它；
//   假 gh / 假 claude 的日志与序列计数文件也都放在本 world 的临时目录里。t.after 里
//   杀掉本 world 拉起、尚未退出的子进程（SIGKILL 兜底）再递归删目录，保证测试进程
//   退出后 /tmp 无残留、没有假 claude 孤儿。
// - assertSandbox(env, config)：任何子进程 spawn 之前的护栏——NIGHT_SHIFT_CLAUDE_BIN /
//   NIGHT_SHIFT_GH_BIN 经 realpath 必须正是本仓库的假替身，remoteUrlTemplate 不得指向
//   github.com。外层环境把 NIGHT_SHIFT_CLAUDE_BIN=claude 透传进来时（makeWorld 会原样
//   写回），第一个 cli() / startServe() 在 spawn 前就抛错，绝不会碰真实 claude / GitHub。
// - cli(world, ...args)：跑真实 bin/night-shift.mjs（短命令，等到退出）。
// - startServe(world, overrides)：spawn `serve --port 0`，从启动行解析随机端口，
//   返回 { port, stop, … }；stop() 一次 SIGINT 优雅退出并断言退出码 0。
// - waitFor(fn, { timeoutMs, label, onTimeout })：轮询到 fn() 为真；超时错误带 label、
//   最后一次检查看到的状态与 onTimeout() 的补充诊断（调用方拼 `show --json` 的任务
//   JSON 和日志末 20 行）。
// - 小工具：readJsonl / readTail / showTask / addedId / updateConfig / 只读 git 查询 /
//   httpGetJson / fetchTask / readSse（只连 127.0.0.1）。
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fakeEnv } from '../test/helpers.js';

/** 仓库根（e2e/ 的上一级）：cli 的 cwd 与假替身都在它下面。 */
export const REPO_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const BIN = path.join(REPO_ROOT, 'bin', 'night-shift.mjs');
const FAKE_CLAUDE = path.join(REPO_ROOT, 'test', 'fixtures', 'fake-claude.mjs');
const FAKE_GH = path.join(REPO_ROOT, 'test', 'fixtures', 'fake-gh.mjs');

/** 短命令（add/show/logs/cancel）从启动到退出几百毫秒内，20s 是宽限不是预期值。 */
const CLI_TIMEOUT_MS = 20_000;
/** serve 打印启动行（解析随机端口）的宽限。 */
const SERVE_BANNER_TIMEOUT_MS = 15_000;
/** stop()：一次 SIGINT 后等优雅退出的宽限（清 socket、释放调度器锁、关库）。 */
const STOP_TIMEOUT_MS = 10_000;
/** serve 启动行文案（src/cli/serve-run.js）——解析端口的锚点，改文案时同步这里。 */
const BANNER_RE = /^GLM 夜班已启动：看板 http:\/\/127\.0\.0\.1:(\d+)，并发 /m;

// ---------------------------------------------------------------- 世界

/**
 * 建一个 world（见文件头）。测试里需要按场景改配置时，用 updateConfig(world, {...})
 * 改字段再写回（必须在 serve 启动前——serve 启动时读一次 config.json）。
 * @param {import('node:test').TestContext} t 提供 t.after（结束时清理）。
 * @returns {{ home: string, env: object, bare: string, configPath: string,
 *   ghLog: string, argsLog: string, stateFile: string, root: string,
 *   track: (child: import('node:child_process').ChildProcess) => import('node:child_process').ChildProcess,
 *   t: import('node:test').TestContext }}
 */
export function makeWorld(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'night-shift-e2e-'));
  const home = path.join(root, 'home');
  const remotesDir = path.join(root, 'remotes');
  fs.mkdirSync(home);
  fs.mkdirSync(remotesDir);

  // 本地 bare 仓库当远端：默认分支 main、一个含 package.json 的初始提交（scripts.test
  // 就是任务的测试命令要找的文件），照 test/git.test.js 的 makeBareRemote 做，不联网。
  // git 子进程显式给身份与空配置，不读机器的系统 / 全局 git 配置。
  const bare = path.join(remotesDir, 'demo__app.git');
  const seed = path.join(root, 'seed');
  const gitEnv = {
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: path.join(root, 'absent-git-config'), // 不存在 = 空全局配置
    GIT_AUTHOR_NAME: '夜班 e2e',
    GIT_AUTHOR_EMAIL: 'night-shift-e2e@example.com',
    GIT_COMMITTER_NAME: '夜班 e2e',
    GIT_COMMITTER_EMAIL: 'night-shift-e2e@example.com',
    GIT_TERMINAL_PROMPT: '0',
  };
  gitOk(['init', '--bare', '-q', '-b', 'main', bare], root, gitEnv);
  gitOk(['clone', '--quiet', bare, seed], root, gitEnv); // 空仓库克隆只警告不失败
  gitOk(['symbolic-ref', 'HEAD', 'refs/heads/main'], seed, gitEnv);
  fs.writeFileSync(path.join(seed, 'package.json'), `${JSON.stringify({
    name: 'demo-app',
    private: true,
    scripts: { test: 'test -f NIGHT_SHIFT_FAKE.md' },
  }, null, 2)}\n`);
  gitOk(['add', '-A'], seed, gitEnv);
  gitOk(['commit', '--quiet', '-m', 'init'], seed, gitEnv);
  gitOk(['push', '--quiet', 'origin', 'HEAD:refs/heads/main'], seed, gitEnv);

  // config.json：只写场景需要的字段，其余用产品默认值（maxAttempts 2、
  // rateLimitBackoffMinutes 15、autoDiagnose true、timeoutMinutes 60……）。
  const configPath = path.join(home, 'config.json');
  writeJsonFile(configPath, {
    remoteUrlTemplate: path.join(remotesDir, '{owner}__{name}.git'), // 本地绝对路径
    pollSeconds: 0.2,
    killGraceSeconds: 1,
    gitAuthorName: '夜班 e2e',
    gitAuthorEmail: 'night-shift-e2e@example.com',
    concurrency: 2,
  });

  const ghLog = path.join(root, 'gh-log.jsonl');
  const argsLog = path.join(root, 'claude-args.jsonl');
  const stateFile = path.join(root, 'claude-sequence-state.txt');
  // 以 fakeEnv() 为底：剥掉真实 token 与外层 NIGHT_SHIFT_* / FAKE_*，指向假替身；
  // 再固定本 world 的 NIGHT_SHIFT_HOME 与各日志文件。
  const env = fakeEnv({
    NIGHT_SHIFT_HOME: home,
    FAKE_GH_LOG: ghLog,
    FAKE_CLAUDE_ARGS_LOG: argsLog,
    FAKE_CLAUDE_STATE_FILE: stateFile,
    // 隔离 git 配置：不读机器的系统 / 全局配置（提交身份来自 config.json 的
    // gitAuthorName/Email，git.js 会同时给 -c 与环境变量）。
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: path.join(root, 'absent-git-config'),
  });
  // 护栏透传（验收项）：外层 process.env 里显式给了 NIGHT_SHIFT_CLAUDE_BIN /
  // NIGHT_SHIFT_GH_BIN（非空字符串）时，把外层的值写回——这正是「有人把
  // NIGHT_SHIFT_CLAUDE_BIN=claude 再跑 e2e」的场景，第一个 cli()/startServe() 会在
  // spawn 前被 assertSandbox 拦下。未设置时保持 fakeEnv() 给的假替身绝对路径。
  for (const key of ['NIGHT_SHIFT_CLAUDE_BIN', 'NIGHT_SHIFT_GH_BIN']) {
    const outer = process.env[key];
    if (typeof outer === 'string' && outer !== '') env[key] = outer;
  }

  const children = new Set();
  const world = {
    home, env, bare, configPath, ghLog, argsLog, stateFile, root, t,
    /** 登记本 world 拉起的子进程；t.after 兜底击杀用。 */
    track(child) {
      children.add(child);
      child.once('close', () => children.delete(child));
      return child;
    },
  };

  t.after(() => {
    // 1) 还活着的子进程直接 SIGKILL（正常路径里 cli 已退出、serve 已 stop）。
    for (const child of children) {
      try { child.kill('SIGKILL'); } catch { /* 已退出 */ }
    }
    // 2) 被杀的 serve 可能留下 detached 的假 claude（场景 11 对 serve SIGKILL 的现场）：
    //    args log 每次调用都记了 pid，逐个确认还活着就击杀，保证没有假 claude 残留。
    for (const entry of readJsonl(argsLog)) {
      if (typeof entry.pid !== 'number') continue;
      try {
        process.kill(entry.pid, 0); // 探活：ESRCH = 已不在
        process.kill(entry.pid, 'SIGKILL');
      } catch {
        // 进程已退出，正是期望
      }
    }
    // 3) 子进程清干净后删整个临时目录（worktree / 裸仓库 / 日志都在里面）。
    fs.rmSync(root, { recursive: true, force: true });
  });
  return world;
}

/** 读 world 的 config.json。 */
export function readConfig(world) {
  return JSON.parse(fs.readFileSync(world.configPath, 'utf8'));
}

/** 改 world 的 config.json：浅合并 patch 后写回（须在 serve 启动前调用）。 */
export function updateConfig(world, patch) {
  const config = { ...readConfig(world), ...patch };
  writeJsonFile(world.configPath, config);
  return config;
}

// ---------------------------------------------------------------- 护栏

/**
 * 沙箱护栏：在任何子进程 spawn 之前调用（cli / startServe 都先过这一道）。
 * - NIGHT_SHIFT_CLAUDE_BIN 解析（realpath）后必须正是 test/fixtures/fake-claude.mjs；
 * - NIGHT_SHIFT_GH_BIN 同理必须是 test/fixtures/fake-gh.mjs；
 * - config.remoteUrlTemplate 不得是 https://github.com/…，也不得包含 github.com
 *   （本地 bare 目录路径才是合法值）。
 * 任一不满足直接抛错（信息含「护栏」与实际值），子进程一个都不会起。
 */
export function assertSandbox(env, config) {
  assertFakeBin(env, 'NIGHT_SHIFT_CLAUDE_BIN', FAKE_CLAUDE);
  assertFakeBin(env, 'NIGHT_SHIFT_GH_BIN', FAKE_GH);
  const template = config?.remoteUrlTemplate;
  if (typeof template !== 'string'
      || /^https:\/\/github\.com\//.test(template)
      || template.includes('github.com')) {
    throw new Error(
      `护栏：config.remoteUrlTemplate 必须指向本地 bare 仓库，不得是 github.com 地址`
        + `（实际值：${JSON.stringify(template)}）`,
    );
  }
}

/** 单个假替身检查：realpath 相等才算数（basename 是 claude、路径不存在都不行）。 */
function assertFakeBin(env, key, fixture) {
  const raw = env?.[key];
  const expected = fs.realpathSync(fixture);
  let resolved = null;
  if (typeof raw === 'string' && raw.trim() !== '') {
    try {
      resolved = fs.realpathSync(path.resolve(raw));
    } catch {
      resolved = null; // 路径不存在（比如裸命令名 'claude'）
    }
  }
  if (resolved !== expected) {
    throw new Error(
      `护栏：${key} 必须是本仓库的假替身 ${fixture}（realpath：${expected}），`
        + `实际值：${JSON.stringify(raw)}`
        + `${resolved === null ? '（无法解析为存在的路径）' : `（解析到 ${resolved}）`}`
        + '；e2e 绝不调用真实 claude / gh，请检查外层环境变量的透传',
    );
  }
}

// ---------------------------------------------------------------- 子进程

/**
 * 跑一个短命令（add / show / logs / cancel…）：真实 bin/night-shift.mjs 子进程，
 * cwd 是仓库根、env 是 world.env、stdio 管道，等到退出返回 { code, stdout, stderr }。
 * 超过 20s 杀进程并失败。spawn 前先过 assertSandbox。
 */
export async function cli(world, ...args) {
  assertSandbox(world.env, readConfig(world)); // 护栏先于任何 spawn
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      cwd: REPO_ROOT,
      env: world.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    world.track(child);
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(
        `cli ${args.join(' ')} 超过 ${CLI_TIMEOUT_MS}ms 未退出，已击杀`
          + `；stdout 末尾=${tailText(stdout)} stderr 末尾=${tailText(stderr)}`,
      ));
    }, CLI_TIMEOUT_MS);
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.once('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`cli ${args.join(' ')} 启动失败：${err.message}`));
    });
  });
}

/**
 * 起 serve（调度器 + 看板）：spawn `serve --port 0`，轮询 stdout 的启动行
 * `GLM 夜班已启动：看板 http://127.0.0.1:<port>，并发 …`（src/cli/serve-run.js）解析
 * 随机端口；解析不到就失败并带上已有 stdout / stderr。
 *
 * env 默认 world.env；overrides 叠在上面（换假 claude 场景 / 换 NIGHT_SHIFT_NOW），
 * 叠加结果仍要过 assertSandbox，且 NIGHT_SHIFT_HOME 必须还是这个 world。
 *
 * 返回 { port, stop, child, stdout, stderr, exited, exit }：
 * - stop()：发一次 SIGINT、等退出并断言退出码 0（调用方保证此刻没有 running 任务——
 *   有 running 时第一次 SIGINT 是等任务跑完，那不是 stop 的职责）。幂等。
 * - child / exited() / exit()：场景 11 要对 serve 进程 SIGKILL 模拟断电时用。
 * - 同一 world 不要并行两个 serve（scheduler.lock）。SIGKILL 之后锁里是死 pid，
 *   下一个 serve 会接管（#18 的行为），不要手动删锁来「修好」。
 */
export async function startServe(world, overrides = {}) {
  const env = { ...world.env, ...overrides };
  if (env.NIGHT_SHIFT_HOME !== world.home) {
    throw new Error(
      `护栏：startServe 覆盖环境时 NIGHT_SHIFT_HOME 仍必须是本 world 的 ${world.home}`
        + `（实际：${JSON.stringify(env.NIGHT_SHIFT_HOME)}）`,
    );
  }
  assertSandbox(env, readConfig(world)); // 护栏先于任何 spawn

  const child = spawn(process.execPath, [BIN, 'serve', '--port', '0'], {
    cwd: REPO_ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  world.track(child);
  let stdout = '';
  let stderr = '';
  let exitInfo = null; // { code, signal }：close 后有值
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.on('close', (code, signal) => { exitInfo = { code, signal }; });

  const port = await new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(poll);
      child.removeListener('close', onEarlyExit);
      fn(value);
    };
    const timer = setTimeout(
      () => done(reject, new Error(
        `serve 未在 ${SERVE_BANNER_TIMEOUT_MS}ms 内打印启动行`
          + `；stdout 末尾=${tailText(stdout)} stderr 末尾=${tailText(stderr)}`,
      )),
      SERVE_BANNER_TIMEOUT_MS,
    );
    const poll = setInterval(() => {
      const match = BANNER_RE.exec(stdout);
      if (match !== null) done(resolve, Number(match[1]));
    }, 20);
    const onEarlyExit = () => done(reject, new Error(
      `serve 提前退出（没等到启动行）；stdout 末尾=${tailText(stdout)} stderr 末尾=${tailText(stderr)}`,
    ));
    child.on('close', onEarlyExit);
  });

  let stopPromise = null;
  const stop = () => {
    if (stopPromise === null) {
      stopPromise = new Promise((resolve, reject) => {
        const fail = (message) => reject(new Error(
          `stop()：${message}；serve stdout 末尾=${tailText(stdout)} stderr 末尾=${tailText(stderr)}`,
        ));
        if (exitInfo !== null) {
          // stop() 之前进程已经退出了：按退出码判定（正常用例不会走到这里）。
          if (exitInfo.code === 0) resolve();
          else fail(`serve 已退出且退出码是 ${exitInfo.code}`);
          return;
        }
        try {
          child.kill('SIGINT'); // 一次优雅停止：关监听、释放锁、关库，退出码 0
        } catch (err) {
          fail(`SIGINT 发送失败：${err.message}`);
          return;
        }
        const timer = setTimeout(() => {
          try { child.kill('SIGKILL'); } catch { /* 已退出 */ }
          fail(`SIGINT 后 ${STOP_TIMEOUT_MS}ms 未退出，已 SIGKILL 兜底`);
        }, STOP_TIMEOUT_MS);
        child.once('close', (code, signal) => {
          clearTimeout(timer);
          if (code === 0) resolve();
          else fail(`serve 应以退出码 0 结束，实际 code=${code} signal=${signal}`);
        });
      });
    }
    return stopPromise;
  };

  // t.after 兜底（正常路径 stop() 已退出，这里是有 running / 断言失败挂起时的保险）：
  // 还活着就再 SIGINT 一次，等 3s 仍不退就 SIGKILL，避免残留。world 自身的 t.after
  // 还有一层 SIGKILL + 删目录的兜底，两层都幂等。
  if (world.t && typeof world.t.after === 'function') {
    world.t.after(() => new Promise((resolve) => {
      if (exitInfo !== null) {
        resolve();
        return;
      }
      try {
        child.kill('SIGINT');
      } catch {
        resolve(); // 已退出
        return;
      }
      const timer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* 已退出 */ }
        resolve();
      }, 3_000);
      child.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
    }));
  }

  return {
    port,
    stop,
    child,
    stdout: () => stdout,
    stderr: () => stderr,
    exited: () => exitInfo !== null,
    exit: () => exitInfo,
  };
}

// ---------------------------------------------------------------- 等待与查询

/**
 * 轮询直到 fn() 返回真值（真值可以是对象，原样返回）。超时抛错，错误信息包含
 * label、最后一次 fn 看到的状态，以及 onTimeout() 返回的补充诊断（调用方在这里拼
 * `show --json` 的任务 JSON 与日志末 20 行）。不要用写死 sleep 当成功条件。
 */
export async function waitFor(fn, { timeoutMs = 10_000, label = '条件成立', pollMs = 100, onTimeout = null } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastSeen;
  for (;;) {
    lastSeen = await fn();
    if (lastSeen) return lastSeen;
    if (Date.now() >= deadline) {
      let extra = '';
      if (onTimeout !== null) {
        try {
          extra = String(await onTimeout());
        } catch (err) {
          extra = `（超时诊断收集失败：${err.message}）`;
        }
      }
      throw new Error(
        `waitFor 超时：${label}（等了 ${timeoutMs}ms，轮询间隔 ${pollMs}ms）`
          + `；最后一次检查看到：${describeValue(lastSeen)}${extra}`,
      );
    }
    await sleep(pollMs);
  }
}

/**
 * 等任务变成 status 并返回 `show --json` 的 JSON（cli 子进程轮询，~百毫秒一级）。
 * 超时错误里拼上最后一次读到的任务 JSON 和最新一次运行日志的末 20 行。
 */
export async function waitTask(world, id, status, { timeoutMs = 15_000, label } = {}) {
  let lastTask = null;
  return waitFor(
    async () => {
      lastTask = await showTask(world, id);
      return lastTask.status === status ? lastTask : false;
    },
    {
      timeoutMs,
      label: label ?? `任务 #${id} 应变为 ${status}`,
      onTimeout: () => taskDiagnostics(lastTask),
    },
  );
}

/** waitFor 失败路径的诊断：任务 JSON + 最新一次运行（runs[0]，倒序）日志末 20 行。 */
function taskDiagnostics(task) {
  const logPath = task?.runs?.[0]?.logPath;
  return `\nshow --json：${truncateForLog(JSON.stringify(task))}`
    + `\n最新一次运行日志末 20 行：\n${logPath ? readTail(logPath, 20) : '（没有运行记录）'}`;
}

/** `cli show <id> --json` 的解析结果（show 失败直接抛错带 stderr）。 */
export async function showTask(world, id) {
  const res = await cli(world, 'show', String(id), '--json');
  if (res.code !== 0) {
    throw new Error(`show ${id} --json 退出码 ${res.code}；stderr=${tailText(res.stderr)}`);
  }
  return JSON.parse(res.stdout);
}

/** 从 `add` 的输出「已加入队列：#<id> <标题>」解析任务 id。 */
export function addedId(res) {
  const match = /#(\d+)/.exec(res.stdout);
  if (match === null) {
    throw new Error(`无法从 add 输出解析任务 id；stdout=${tailText(res.stdout)} stderr=${tailText(res.stderr)}`);
  }
  return Number(match[1]);
}

// ---------------------------------------------------------------- HTTP（只连 127.0.0.1）

/** GET 一个 JSON 接口（serve 的看板 API），非 2xx 抛错带响应体。 */
export async function httpGetJson(port, pathname) {
  const res = await fetch(`http://127.0.0.1:${port}${pathname}`);
  if (!res.ok) {
    throw new Error(`GET ${pathname} 意外状态码 ${res.status}：${await res.text()}`);
  }
  return res.json();
}

/** GET /api/tasks/<id>：任务 JSON（含 runs）。比 spawn cli 便宜，热轮询用它。 */
export function fetchTask(port, id) {
  return httpGetJson(port, `/api/tasks/${id}`);
}

/**
 * 读一个 SSE 流（GET /api/runs/<id>/stream）到 event: done 为止，返回
 * [{ event, data }]（`event: log` 的 data 是日志行原文，`event: done` 的 data 是
 * JSON 字符串；`: ping` 注释行被丢弃）。timeoutMs 内没等到流结束就失败。
 */
export async function readSse(url, { timeoutMs = 15_000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error(`SSE 流 ${url} 在 ${timeoutMs}ms 内没有结束`)),
    timeoutMs,
  );
  const events = [];
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`GET ${url} 意外状态码 ${res.status}`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      for (;;) {
        const nl = buffer.indexOf('\n\n');
        if (nl === -1) break;
        const parsed = parseSseBlock(buffer.slice(0, nl));
        buffer = buffer.slice(nl + 2);
        if (parsed !== null) events.push(parsed);
      }
      if (events.length > 0 && events[events.length - 1].event === 'done') {
        await reader.cancel();
        break;
      }
    }
  } finally {
    clearTimeout(timer);
  }
  return events;
}

/** 一个 SSE 块 → { event, data }；没有 event 行的（注释等）返回 null。 */
function parseSseBlock(block) {
  let event = null;
  let data = null;
  for (const line of block.split('\n')) {
    if (line.startsWith('event: ')) event = line.slice(7).trim();
    else if (line.startsWith('data: ')) data = line.slice(6);
  }
  return event === null ? null : { event, data };
}

// ---------------------------------------------------------------- 文件与 git 只读查询

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 读 jsonl 文件为一组对象；文件还不存在返回 []（假 claude 一次都没跑过等）。 */
export function readJsonl(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  return text.split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line));
}

/** 读文本文件末尾最多 lines 行（日志诊断用）；文件不存在返回提示文本。 */
export function readTail(file, lines = 20) {
  try {
    const all = fs.readFileSync(file, 'utf8').split('\n');
    if (all.length > 0 && all[all.length - 1] === '') all.pop();
    return all.slice(-lines).join('\n');
  } catch {
    return '（日志文件还不存在）';
  }
}

/** 同步跑只读 git 查询（参数数组、无 shell），失败抛错附 stderr。 */
export function gitOut(args, cwd) {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (res.status !== 0) {
    throw new Error(`git ${args.join(' ')} 失败（cwd=${cwd}）：${res.stderr}`);
  }
  return res.stdout;
}

/** bare 远端上 night-shift/ 命名空间的分支列表（按分支名排序）。 */
export function nightShiftBranches(world) {
  return gitOut(
    ['for-each-ref', '--format=%(refname:short)', '--sort=refname', 'refs/heads/night-shift/'],
    world.bare,
  ).trim().split('\n').filter((name) => name !== '');
}

/** bare 远端某分支上的文件内容；分支或文件不存在返回 null。 */
export function bareFileContent(world, branch, file) {
  const res = spawnSync('git', ['show', `${branch}:${file}`], { cwd: world.bare, encoding: 'utf8' });
  return res.status === 0 ? res.stdout : null;
}

// ---------------------------------------------------------------- 内部

/** makeWorld 建仓用的 git：同步、带显式身份与空配置，失败抛错。 */
function gitOk(args, cwd, env) {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...env } });
  if (res.status !== 0) {
    throw new Error(`git ${args.join(' ')} 失败（cwd=${cwd}）：${res.stderr}`);
  }
  return res.stdout;
}

function writeJsonFile(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

/** 错误信息里截断长文本：留末尾 max 字符。 */
function tailText(text, max = 4000) {
  const s = String(text ?? '');
  return s.length <= max ? s : `…（前略）${s.slice(-max)}`;
}

function truncateForLog(text) {
  return tailText(text, 6000);
}

/** waitFor 超时信息里描述最后一次 fn 的返回值。 */
function describeValue(value) {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (typeof value === 'object') return truncateForLog(JSON.stringify(value));
  return truncateForLog(String(value));
}
