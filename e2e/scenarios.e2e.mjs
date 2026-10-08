// 端到端测试（issue #19）：spawn 真实 `bin/night-shift.mjs` 子进程——cli 建任务、
// serve 跑调度器 + 看板，远端是本地 bare 仓库、claude / gh 都是 test/fixtures 的假替身，
// 绝不联网、不碰 GitHub、不消耗额度。十一个场景各自一套 world（见 e2e/helpers.mjs），
// 互不共享状态；describe 的 concurrency: 1 保证同一时刻只有一个场景在跑（npm 脚本里的
// --test-concurrency=1 只限制文件进程数），假 claude 的序列计数不是原子的，串行才可靠。
// 等待一律轮询 + 截止时间（waitFor），不用写死 sleep 当成功条件；等待任务状态的失败
// 路径会带上 `show --json` 的任务 JSON 和日志末 20 行。
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  addedId,
  bareFileContent,
  cli,
  fetchTask,
  httpGetJson,
  makeWorld,
  nightShiftBranches,
  readJsonl,
  readSse,
  showTask,
  sleep,
  startServe,
  updateConfig,
  waitFor,
  waitTask,
} from './helpers.mjs';

/** 假 claude 调用记录里取 prompt / 模型（argv 形如 ['-p', <prompt>, '--model', <m>, …]）。 */
const promptOf = (call) => call.argv[call.argv.indexOf('-p') + 1];
const modelOf = (call) => call.argv[call.argv.indexOf('--model') + 1];

/** 加一条能通过测试命令的任务，返回其 id（各场景最常见的前置）。 */
async function addPassingTask(world, extraArgs = []) {
  const res = await cli(world, 'add', '--repo', 'demo/app', '--prompt', '加一行',
    '--test', 'test -f NIGHT_SHIFT_FAKE.md', ...extraArgs);
  assert.equal(res.code, 0, res.stderr);
  return addedId(res);
}

/**
 * 真实时钟场景的 world：这些场景不能固定 NIGHT_SHIFT_NOW（场景 6 的退避要等真实
 * 时间到期、场景 8 的 startedAt 排序要时间戳前进），高峰闸门又是「默认拦截」——
 * 工作日北京时间 14:00–18:00 跑 e2e 会把任务全部挂住。这些场景不测高峰（高峰
 * 拦截是场景 7 的事，那个 world 用产品默认 allowPeak=false + 固定时间），所以把
 * allowPeak 打开，让套件任何时刻都能跑。
 */
function realClockWorld(t, patch = {}) {
  const world = makeWorld(t);
  updateConfig(world, { allowPeak: true, ...patch });
  return world;
}

/** 等任务进入 running 且假 claude 已记下 pid（取第一条调用记录）。 */
async function waitRunningWithPid(world, id) {
  const call = await waitFor(async () => {
    const calls = readJsonl(world.argsLog);
    if (calls.length < 1) return false;
    const task = await showTask(world, id);
    return task.status === 'running' ? calls[0] : false;
  }, {
    timeoutMs: 15_000,
    label: `任务 #${id} 应进入 running 且假 claude 已启动`,
    onTimeout: async () => `\nargsLog=${JSON.stringify(readJsonl(world.argsLog))}\n任务=${JSON.stringify(await showTask(world, id))}`,
  });
  return call;
}

/** 进程是否已消失（process.kill(pid, 0) 抛 ESRCH 才算不在了）。 */
function pidGone(pid) {
  try {
    process.kill(pid, 0);
    return false;
  } catch (err) {
    return err.code === 'ESRCH';
  }
}

/** FAKE_GH_LOG 里 pr create 的调用次数。 */
function prCreateCalls(world) {
  return readJsonl(world.ghLog).filter((argv) => argv[0] === 'pr' && argv[1] === 'create');
}

describe('e2e：serve 端到端（issue #19）', { concurrency: 1 }, () => {
  test('1. 成功开 PR：succeeded + bare 分支含文件 + 假 gh 开 PR + worktree 清理 + logs 有内容', { timeout: 30_000 }, async (t) => {
    const world = realClockWorld(t);
    const id = await addPassingTask(world); // 「加一行」的 slug 是 task → night-shift/1-task
    const serve = await startServe(world);

    const task = await waitTask(world, id, 'succeeded');
    assert.match(task.prUrl, /^https:\/\/github\.com\/demo\/app\/pull\/\d+$/, 'prUrl 应是假 gh 开出的 PR 地址');
    assert.equal(task.branch, 'night-shift/1-task', '中文标题的 slug 应退化为 task');
    assert.deepEqual(nightShiftBranches(world), [task.branch], 'bare 上应有且仅有该任务分支');
    const blob = bareFileContent(world, task.branch, 'NIGHT_SHIFT_FAKE.md');
    assert.ok(blob !== null && blob.includes('加一行'), `bare 的 ${task.branch} 上应有 NIGHT_SHIFT_FAKE.md`);

    const prCreates = prCreateCalls(world);
    assert.equal(prCreates.length, 1, '应恰好开一次 PR');
    const argv = prCreates[0];
    const baseIndex = argv.indexOf('--base');
    assert.ok(baseIndex !== -1, `pr create 参数应含 --base：${JSON.stringify(argv)}`);
    assert.equal(argv[baseIndex + 1], 'main');

    assert.equal(
      fs.existsSync(path.join(world.home, 'worktrees', `task-${id}`)),
      false,
      '成功后 worktree 目录应已删除',
    );

    const logs = await cli(world, 'logs', String(id));
    assert.equal(logs.code, 0, logs.stderr);
    assert.ok(logs.stdout.trim() !== '', 'logs 应能读到运行日志');

    await serve.stop();
  });

  test('2. 失败重试后成功：fail,success,success → 诊断一次，第二次执行的 prompt 带上诊断', { timeout: 30_000 }, async (t) => {
    const world = realClockWorld(t);
    // 序列计数（FAKE_CLAUDE_STATE_FILE 的读-改-写）不是原子的，串行调用才可靠；
    // 诊断也会占用序列里的一个号，所以序列是三步：执行失败、诊断成功、再次执行成功。
    updateConfig(world, { concurrency: 1 });
    const id = await addPassingTask(world, ['--max-attempts', '2']);
    const serve = await startServe(world, { FAKE_CLAUDE_SEQUENCE: 'fail,success,success' });

    const task = await waitTask(world, id, 'succeeded');
    const taskRuns = task.runs.filter((run) => run.kind === 'task');
    const diagRuns = task.runs.filter((run) => run.kind === 'diagnosis');
    assert.equal(taskRuns.length, 2, '执行（kind=task）恰好 2 条');
    assert.equal(diagRuns.length, 1, '诊断（kind=diagnosis）恰好 1 条');
    assert.equal(diagRuns[0].model, 'glm-5.3-flash', '诊断用便宜的 flash 模型');

    // 第二次执行（kind=task 里 startedAt 较晚的那条）对应的 args log 调用：
    // 任务执行用 glm-5.3、诊断用 glm-5.3-flash，按模型过滤后第 2 个就是重跑，
    // 其 prompt 应含「## 上次失败的诊断」（附默认结果文本 done）。
    const calls = readJsonl(world.argsLog);
    const taskCalls = calls.filter((call) => modelOf(call) === 'glm-5.3');
    assert.equal(taskCalls.length, 2, `应恰好 2 次 glm-5.3 执行调用：${JSON.stringify(calls.map(modelOf))}`);
    assert.ok(!promptOf(taskCalls[0]).includes('## 上次失败的诊断'), '第一次执行不该带诊断');
    assert.ok(promptOf(taskCalls[1]).includes('## 上次失败的诊断'), '重跑的 prompt 应附上诊断');
    assert.ok(promptOf(taskCalls[1]).includes('done'), '诊断文本默认是 done');

    await serve.stop();
  });

  test('3. 重试用尽：fail + maxAttempts 2 → failed，lastError 非空，无 PR，bare 无 night-shift/ 分支', { timeout: 30_000 }, async (t) => {
    const world = realClockWorld(t);
    const id = await addPassingTask(world, ['--max-attempts', '2']);
    const serve = await startServe(world, { FAKE_CLAUDE_SCENARIO: 'fail' });

    const task = await waitTask(world, id, 'failed');
    assert.ok(typeof task.lastError === 'string' && task.lastError !== '', 'lastError 应非空');
    assert.ok(!task.prUrl, '不应有 prUrl');
    assert.deepEqual(nightShiftBranches(world), [], 'bare 不应有 night-shift/ 分支');
    assert.equal(prCreateCalls(world).length, 0, '假 gh 不应收到 pr create');

    await serve.stop();
  });

  test('4. 超时：hang + timeoutMinutes 0.02 → run=timeout、任务 failed、假 claude 进程已消失', { timeout: 30_000 }, async (t) => {
    const world = realClockWorld(t);
    updateConfig(world, { timeoutMinutes: 0.02 }); // 0.02 分钟 ≈ 1.2s
    const id = await addPassingTask(world, ['--max-attempts', '1']); // 用尽即败，不再诊断
    const serve = await startServe(world, { FAKE_CLAUDE_SCENARIO: 'hang' });

    const task = await waitTask(world, id, 'failed');
    assert.equal(task.runs.length, 1, 'maxAttempts 1 只有这一次运行');
    assert.equal(task.runs[0].status, 'timeout');
    const calls = readJsonl(world.argsLog);
    assert.equal(calls.length, 1, '只应调用一次假 claude');
    assert.ok(pidGone(calls[0].pid), `超时击杀后 pid ${calls[0].pid} 应已不存在`);

    await serve.stop();
  });

  test('5. 无改动：noop → failed「没有改动」不重试，1 条 run，bare 无分支', { timeout: 30_000 }, async (t) => {
    const world = realClockWorld(t);
    // 不带 --test：noop 不写文件，带「文件存在」类测试命令会在测试阶段就失败，
    // 走不到提交阶段；无测试命令才到达 commit → 没有改动。
    const res = await cli(world, 'add', '--repo', 'demo/app', '--prompt', '加一行');
    assert.equal(res.code, 0, res.stderr);
    const id = addedId(res);
    const serve = await startServe(world, { FAKE_CLAUDE_SCENARIO: 'noop' });

    const task = await waitTask(world, id, 'failed');
    assert.equal(task.lastError, '没有改动');
    assert.equal(task.runs.length, 1, '没有改动不重试，只有 1 条 run');
    assert.deepEqual(nightShiftBranches(world), []);

    await serve.stop();
  });

  test('6. 限流退避：rate-limit 后回 queued 退次数，暂停期内不再领取，退避结束重领并成功', { timeout: 30_000 }, async (t) => {
    const world = realClockWorld(t, { rateLimitBackoffMinutes: 0.05, concurrency: 1 });
    // 正文写「pausedUntil 约为 15 分钟」指的是默认 rateLimitBackoffMinutes=15；本场景
    // 把它配成 0.05 分钟（3 秒）才可能在 2 分钟总预算里验证「暂停期间不领取、结束后
    // 领取并成功」。默认值 15 分钟已有单测（test/scheduler-integration.test.js），这里
    // 不重复等 15 分钟。序列两步：先被限流，退避后重跑用 success。
    const id = await addPassingTask(world);
    const serve = await startServe(world, { FAKE_CLAUDE_SEQUENCE: 'rate-limit,success' });
    const backoffMs = 0.05 * 60_000;

    // 第一次被限流：任务回到 queued、次数退回 0、lastError 含「限流」。
    // 条件里必须带上 lastError——新建任务的初始态就是 queued + attempts 0。
    // 这里用 HTTP 轮询（毫秒级）：退避窗口只有 3 秒，cli 轮询（百毫秒级）太慢。
    const afterLimit = await waitFor(() => fetchTask(serve.port, id).then((task) => (
      task.status === 'queued' && task.attempts === 0
        && typeof task.lastError === 'string' && task.lastError.includes('限流') ? task : false
    )), {
      timeoutMs: 15_000,
      label: `任务 #${id} 被限流后应回到 queued、attempts 退回 0、lastError 含「限流」`,
    });
    assert.ok(afterLimit.lastError.includes('限流'), afterLimit.lastError);
    assert.ok(afterLimit.notBefore, 'notBefore 应写进库里');

    // 进程内 pausedUntil：/api/status 的 scheduler.pausedUntil 约为现在起 0.05 分钟。
    const status = await httpGetJson(serve.port, '/api/status');
    const pausedUntil = new Date(status.scheduler.pausedUntil).getTime();
    const delta = pausedUntil - Date.now();
    assert.ok(delta > 0 && delta < 2 * 60_000, `pausedUntil 应在 0～2 分钟内，实际差 ${delta}ms`);
    assert.ok(Math.abs(delta - backoffMs) <= 15_000, `pausedUntil 应约为 +${backoffMs}ms（±15s），实际差 ${delta}ms`);

    // 暂停结束前再轮询几次：假 claude 仍只有 1 次调用、任务仍是 queued。
    // 截止时间取 min(现在+1.5s, pausedUntil-400ms)，保证检查都落在窗口内。
    const stableDeadline = Math.min(Date.now() + 1_500, pausedUntil - 400);
    while (Date.now() < stableDeadline) {
      assert.equal(readJsonl(world.argsLog).length, 1, '暂停期间不应再调用假 claude');
      const current = await fetchTask(serve.port, id);
      assert.equal(current.status, 'queued', `暂停期间任务应仍是 queued（实际 ${current.status}）`);
      await sleep(150);
    }

    // 暂停结束后被重新领取并最终成功。
    await waitTask(world, id, 'succeeded', { timeoutMs: 20_000, label: '退避结束后应重新领取并成功' });

    await serve.stop();
  });

  test('7. 高峰拦截：高峰期只跑 --allow-peak，5 秒后普通任务仍 queued；换非高峰重启后成功', { timeout: 30_000 }, async (t) => {
    const world = makeWorld(t);
    // 2026-10-08 是周四：07:00:00Z = 北京 15:00（高峰），10:30:00Z = 北京 18:30（非高峰）。
    // NIGHT_SHIFT_NOW 在进程启动时读入，改时间必须重启 serve。
    const PEAK_NOW = '2026-10-08T07:00:00Z';
    const OFF_PEAK_NOW = '2026-10-08T10:30:00Z';
    const normalId = await addPassingTask(world); // 先普通任务
    const peakId = await addPassingTask(world, ['--allow-peak']); // 再 --allow-peak 任务

    const peakServe = await startServe(world, { NIGHT_SHIFT_NOW: PEAK_NOW });
    const status = await httpGetJson(peakServe.port, '/api/status');
    assert.equal(status.peak.peak, true, '07:00Z（北京 15:00 周四）应是高峰');

    await waitTask(world, peakId, 'succeeded', { label: '高峰期 --allow-peak 任务应被执行并成功' });

    // 至少 5 秒内普通任务每一轮检查都必须仍是 queued（负面条件连续成立）。
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const current = await fetchTask(peakServe.port, normalId);
      assert.equal(current.status, 'queued', `高峰期间普通任务不应被领取（实际 ${current.status}）`);
      await sleep(200);
    }
    await peakServe.stop();

    // 同一 home 换非高峰时间重启：普通任务最终成功（场景仍是默认 success）。
    const offPeakServe = await startServe(world, { NIGHT_SHIFT_NOW: OFF_PEAK_NOW });
    await waitTask(world, normalId, 'succeeded', { timeoutMs: 20_000, label: '非高峰重启后普通任务应成功' });
    await offPeakServe.stop();
  });

  test('8. 依赖链：成功链 A→B→C 按序执行；失败链上游用尽后 B/C 级联失败且从未被领取', { timeout: 30_000 }, async (t) => {
    // 两个 world：成功链与失败链各自一套假 claude（序列计数按文件计，不共享）。
    const good = realClockWorld(t, { concurrency: 1 }); // 保证执行顺序只由依赖关系决定
    const goodA = await addPassingTask(good, ['--title', 'step a']);
    const goodB = await addPassingTask(good, ['--title', 'step b', '--depends-on', String(goodA)]);
    const goodC = await addPassingTask(good, ['--title', 'step c', '--depends-on', String(goodB)]);
    const goodServe = await startServe(good);
    for (const depId of [goodA, goodB, goodC]) {
      await waitTask(good, depId, 'succeeded', { timeoutMs: 20_000, label: `依赖链任务 #${depId} 应成功` });
    }
    // 执行顺序看各自 kind=task 的 run 的 startedAt：A 然后 B 然后 C。
    const startedAtOf = async (depId) => {
      const task = await showTask(good, depId);
      const run = task.runs.find((entry) => entry.kind === 'task');
      assert.ok(run, `任务 #${depId} 应有 kind=task 的运行`);
      return run.startedAt;
    };
    const atA = await startedAtOf(goodA);
    const atB = await startedAtOf(goodB);
    const atC = await startedAtOf(goodC);
    assert.ok(atA < atB && atB < atC, `应按 A→B→C 执行，实际 startedAt：A=${atA} B=${atB} C=${atC}`);
    await goodServe.stop();

    const bad = realClockWorld(t);
    const badA = await addPassingTask(bad, ['--title', 'upstream', '--max-attempts', '1']);
    const badB = await addPassingTask(bad, ['--title', 'mid', '--depends-on', String(badA)]);
    const badC = await addPassingTask(bad, ['--title', 'leaf', '--depends-on', String(badB)]);
    const badServe = await startServe(bad, { FAKE_CLAUDE_SCENARIO: 'fail' });

    await waitTask(bad, badA, 'failed', { label: '上游用尽次数后应 failed' });
    const failedB = await waitTask(bad, badB, 'failed');
    const failedC = await waitTask(bad, badC, 'failed');
    assert.equal(failedB.lastError, `依赖 #${badA} 失败`);
    assert.equal(failedC.lastError, `依赖 #${badB} 失败`);
    assert.deepEqual(failedB.runs, [], '级联失败的 B 不应有任何 runs');
    assert.deepEqual(failedC.runs, [], '级联失败的 C 不应有任何 runs');

    await badServe.stop();
  });

  test('9. 取消运行中任务：cancel 后 3 秒内 canceled、run=canceled、进程消失、不开 PR', { timeout: 30_000 }, async (t) => {
    const world = realClockWorld(t);
    const id = await addPassingTask(world);
    const serve = await startServe(world, { FAKE_CLAUDE_SCENARIO: 'hang' });

    const call = await waitRunningWithPid(world, id);
    // cancel 命令立刻把任务置为 canceled，但 run 要等调度器的取消轮询（约 1s）+
    // killGraceSeconds 1 才落 canceled——两个都得到位，且总共在 3 秒内。
    const canceledAt = Date.now();
    const cancel = await cli(world, 'cancel', String(id));
    assert.equal(cancel.code, 0, cancel.stderr);

    let lastSeen = null;
    const task = await waitFor(async () => {
      lastSeen = await showTask(world, id);
      const run = lastSeen.runs.find((entry) => entry.kind === 'task');
      return lastSeen.status === 'canceled' && run !== undefined && run.status === 'canceled'
        ? lastSeen
        : false;
    }, {
      timeoutMs: Math.max(500, 3_000 - (Date.now() - canceledAt)),
      label: '取消应在 3 秒内让任务与 run 都变为 canceled',
      onTimeout: () => `\n任务 JSON：${JSON.stringify(lastSeen)}`,
    });
    assert.ok(Date.now() - canceledAt <= 3_000, `取消到终态应 ≤3s，实际 ${Date.now() - canceledAt}ms`);
    const run = task.runs.find((entry) => entry.kind === 'task');
    assert.equal(run.status, 'canceled');
    assert.ok(pidGone(call.pid), `被杀的假 claude pid ${call.pid} 应已不存在`);
    assert.equal(prCreateCalls(world).length, 0, '不应开 PR');
    assert.deepEqual(nightShiftBranches(world), [], 'bare 不应有 night-shift/ 分支');

    await serve.stop(); // 此刻已无 running 任务，stop 一次 SIGINT 即退
  });

  test('10. HTTP + SSE：POST /api/tasks 建任务，/api/runs/<id>/stream 实时日志到 done', { timeout: 30_000 }, async (t) => {
    const world = realClockWorld(t);
    const serve = await startServe(world, { FAKE_CLAUDE_SCENARIO: 'slow', FAKE_CLAUDE_DELAY_MS: '1500' });

    const created = await fetch(`http://127.0.0.1:${serve.port}/api/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repo: 'demo/app', prompt: '慢工出细活', testCommand: 'test -f NIGHT_SHIFT_FAKE.md' }),
    });
    if (!created.ok) throw new Error(`POST /api/tasks 意外状态码 ${created.status}：${await created.text()}`);
    assert.equal(created.status, 201);
    const { id } = await created.json();

    // 轮询到该任务已有 run（HTTP 建的任务 id 不必是 1，以响应为准），再订阅它的流。
    const withRun = await waitFor(() => fetchTask(serve.port, id)
      .then((task) => task.runs.length >= 1 ? task : false), {
      timeoutMs: 10_000,
      label: `任务 #${id} 应产生运行记录`,
    });
    const runId = withRun.runs[0].id;

    const events = await readSse(`http://127.0.0.1:${serve.port}/api/runs/${runId}/stream`);
    const logEvents = events.filter((event) => event.event === 'log');
    assert.ok(logEvents.length >= 3, `log 事件应至少 3 个，实际 ${logEvents.length}：${JSON.stringify(events.map((e) => e.event))}`);
    const last = events[events.length - 1];
    assert.equal(last.event, 'done', `最后一个事件应是 done，实际 ${JSON.stringify(events.slice(-3))}`);
    assert.equal(JSON.parse(last.data).status, 'succeeded');

    const task = await waitTask(world, id, 'succeeded', { timeoutMs: 15_000 });
    assert.ok(task.prUrl, '成功后 prUrl 应非空');

    await serve.stop();
  });

  test('11. 重启恢复：对 serve SIGKILL 模拟断电，新进程接管后任务重跑成功，旧 run=interrupted', { timeout: 30_000 }, async (t) => {
    const world = realClockWorld(t);
    const id = await addPassingTask(world);
    // hang 场景把任务卡在 running，制造「进程崩了、任务没跑完」的现场。
    const serve = await startServe(world, { FAKE_CLAUDE_SCENARIO: 'hang' });
    await waitRunningWithPid(world, id);
    const oldRunId = (await showTask(world, id)).runs[0].id;

    // SIGKILL 模拟断电（不要 stop()/SIGINT——那是优雅停止，interrupted 会被写在
    // 调度器自己的收尾里；崩溃恢复走的是下一个进程的 recoverStaleRunning）。
    serve.child.kill('SIGKILL');
    await waitFor(() => serve.exited() || false, { timeoutMs: 5_000, label: '被 SIGKILL 的 serve 应已退出' });

    // 场景换回 success（新 env，不留 hang）；锁里是死 pid，下一个 serve 直接接管（#18）。
    const revived = await startServe(world);
    const task = await waitTask(world, id, 'succeeded', { timeoutMs: 20_000, label: '重启恢复后任务应重新执行并成功' });
    assert.equal(task.runs.length, 2, '旧 run + 重新执行的 run');

    const stale = task.runs.find((run) => run.id === oldRunId);
    assert.ok(stale, `应保留崩溃前的 run #${oldRunId}`);
    assert.equal(stale.status, 'failed');
    assert.equal(stale.error, 'interrupted');

    const fresh = task.runs.find((run) => run.id !== oldRunId);
    assert.equal(fresh.kind, 'task', '新执行是另一条 run');
    assert.equal(fresh.status, 'succeeded');

    await revived.stop();
  });
});
