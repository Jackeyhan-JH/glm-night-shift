// 执行器（issue #7）：在一个目录里无人值守地跑一次 Claude Code，把输出逐行记进日志，
// 按规则判定本次运行的状态，并写进 runs 表。只管执行单个任务；git / 排队 / 重试 /
// 诊断由 #8、#9、#12 负责。
//
// 进程控制：spawn 用 detached（子进程自成进程组），超时与取消时先
// process.kill(-pid, 'SIGTERM')，killGrace 后仍存活再 SIGKILL，把 Claude Code 自己
// 起的孙进程一起带走。子进程退出后进程组也不许活过本次运行：exit 时组里若还有成员
// （claude 起的后台进程等遗留者）立即 SIGTERM 清场；若它们抱着 stdout/stderr 导致
// close 迟迟不来，短宽限（min(2000, killGraceMs)）后升到 SIGKILL，再不行（fd 被组外
// 进程持有）就按 exit 时的退出码兜底结算——总之 runTask 不会因为孤儿进程挂住。
// 子进程退出即清掉全部定时器、摘掉 abort 监听，保证事件循环不被残留句柄拖住；日志
// 流落盘（close）之后才 resolve。
//
// 内存：stdout / stderr 逐行流式处理，不整段驻留；内存里只留判定要用的少东西
// （最后一个 result 对象、最后一条非空 stderr、第一条限流行），且各自截断
// （RETAIN_MAX_CHARS / LINE_BUFFER_MAX_CHARS），与输出总量无关。日志文件始终写完整行。
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { isPeak } from './peak.js';
import { runCost } from './quota.js';
import { startRun, setRunLogPath, finishRun } from './tasks.js';

/**
 * 运行事件总线（给 #14 的 SSE 和 #10 的命令行用）。事件：
 * - `start`  {taskId, runId, logPath}          子进程启动前发出
 * - `log`    {taskId, runId, stream, line, ts}  每往日志写一行发一次
 *   （stream 为 'stdout' | 'stderr' | 'meta'，line 是不含时间戳前缀的原始行，ts 为 UTC ISO）
 * - `finish` {taskId, runId, status, error}     结果写库、日志落盘之后发出
 */
export const runEvents = new EventEmitter();

// 限流特征（判定规则 2）：429 / rate limit（含 rate_limit、rate-limit）/ too many requests
const RATE_LIMIT_PATTERN = /\b429\b|rate[ _-]?limit|too many requests/i;
const SUMMARY_MAX_CHARS = 2000;
const RATE_LINE_MAX_CHARS = 200;
const ERROR_MAX_CHARS = 500;
// 单条输出在内存里保留的上限（判定与错误信息最多用到 2000/500 字符，日志文件照写完整行）：
// 一条超长行不会让运行器的内存随输出量无限增长
const RETAIN_MAX_CHARS = 64 * 1024;
// 子进程 exit 后等 close 的宽限上限（实际取 min(本值, killGraceMs)）；SIGKILL 清场后
// 仍等不到 close（fd 被组外进程持有等极端情况）时的最终兜底等待
const STDIO_GRACE_MAX_MS = 2000;
const STUCK_DRAIN_MS = 250;
// 无换行的超长输出：行缓冲到顶就强制按一行切出（日志里表现为拆行），防内存无限增长
const LINE_BUFFER_MAX_CHARS = 4 * 1024 * 1024;

const CLAUDE_ARGS = ['--dangerously-skip-permissions', '--output-format', 'stream-json', '--verbose'];

/**
 * 组装发给 claude 的 prompt（导出供测试）。结构：
 * 任务 prompt + 工作副本说明（仓库、只改当前目录、跑测试、不要 git push / 开 PR）；
 * 有 extraPrompt（#12 的失败诊断）时再追加「上次失败的诊断」一段。
 * @param {{prompt: string, repo: string, testCommand?: ?string}} task
 * @param {{extraPrompt?: ?string}} [options]
 * @returns {string}
 */
export function buildPrompt(task, { extraPrompt = null } = {}) {
  const lines = [
    task.prompt,
    '',
    '---',
    `你正在仓库 ${task.repo} 的一个独立工作副本里工作（就是当前目录）。要求：`,
    '- 只修改当前目录里的文件，完成上面的任务。',
    task.testCommand
      ? `- 完成后运行测试命令：${task.testCommand}，确保通过。`
      : '- 如果仓库有现成的测试，运行并确保通过。',
    '- 不要 git push，不要切换或新建分支，不要开 PR；提交和开 PR 由外部流程完成。',
  ];
  const diagnosis = extraPrompt ?? null;
  if (diagnosis !== null && String(diagnosis).trim() !== '') {
    lines.push('', '## 上次失败的诊断', diagnosis);
  }
  return lines.join('\n');
}

/**
 * 跑一次任务。流程：解析难度 → 建日志与 run 行 → spawn claude → 逐行记日志 →
 * 子进程结束后按规则判定状态、finishRun 写库 → 日志落盘后 resolve。
 *
 * 自身不因运行失败抛异常（spawn ENOENT / 超时 / 取消都算一次正常的 failed /
 * timeout / canceled 结果）；只有参数错误才 reject（缺 task / workdir / db / home /
 * config，或它们明显不可用，如 workdir 不存在、难度没配模型）。
 *
 * @param {object} options
 * @param {object} options.task 任务对象（至少要有 id / prompt / repo / difficulty；
 *   attempt 缺省取 task.attempts，调度器领取后 ≥ 1）
 * @param {string} options.workdir 工作目录（须已存在；子进程的 cwd）
 * @param {object} options.config 配置（loadConfig 的结果；用 difficulty /
 *   effortThinkingTokens / timeoutMinutes / killGraceSeconds / claudeBin）
 * @param {import('node:sqlite').DatabaseSync} options.db
 * @param {string} options.home 数据目录，日志写到 `<home>/logs/task-<taskId>/run-<runId>.log`
 * @param {AbortSignal} [options.signal] 触发即取消（SIGTERM → SIGKILL）；调用时已
 *   aborted 则不启动子进程，直接按取消规则记录
 * @param {number} [options.attempt=task.attempts] 本次是第几次尝试（写进 runs.attempt）
 * @param {?string} [options.extraPrompt=null] 上次失败的诊断（#12 用来追加进 prompt）
 * @param {number} [options.timeoutMs=config.timeoutMinutes × 60000] 超时毫秒数
 * @param {number} [options.killGraceMs=config.killGraceSeconds × 1000] SIGTERM 后等多少
 *   毫秒再 SIGKILL
 * @param {() => Date} [options.clock=() => new Date()] 取「现在」（高峰判断、额度倍率、
 *   日志时间戳都用它；测试注入固定时钟）
 * @param {object} [options.env=process.env] 子进程环境变量的基底（**测试接缝**：测试用
 *   fakeEnv() 构造、按用例传 FAKE_CLAUDE_* / MAX_THINKING_TOKENS）。会先浅拷贝，再按
 *   effort 设 / 删 MAX_THINKING_TOKENS，绝不改动调用方传入的对象
 * @returns {Promise<{runId: number, status: 'succeeded'|'failed'|'timeout'|'canceled',
 *   exitCode: ?number, signal: ?string, numTurns: ?number, isError: ?boolean,
 *   summary: ?string, error: ?string, rateLimited: boolean, model: string, effort: string,
 *   peak: boolean, quotaUnits: number, durationMs: number, logPath: string}>}
 *   durationMs 与 runs 表里的 duration_ms 一致（finishRun 算出，至少 1ms）。
 */
export async function runTask({
  task, workdir, config, db, home,
  signal, attempt = task?.attempts, extraPrompt = null,
  timeoutMs, killGraceMs, clock = () => new Date(), env = process.env,
} = {}) {
  assertArguments({ task, workdir, config, db, home, signal, extraPrompt, clock, env });

  const difficulty = config.difficulty?.[task.difficulty];
  if (difficulty === null || typeof difficulty !== 'object'
    || typeof difficulty.model !== 'string' || difficulty.model.trim() === ''
    || typeof difficulty.effort !== 'string' || difficulty.effort.trim() === '') {
    throw new TypeError(`config.difficulty[${String(task.difficulty)}] 缺少可用的 { model, effort } 配置`);
  }
  const { model, effort } = difficulty;
  const thinkingTokens = Number(config.effortThinkingTokens?.[effort] ?? 0);
  const theTimeoutMs = timeoutMs ?? config.timeoutMinutes * 60_000;
  if (typeof theTimeoutMs !== 'number' || !Number.isFinite(theTimeoutMs) || theTimeoutMs <= 0) {
    throw new TypeError(`timeoutMs 必须是正的有限数字，当前值：${String(timeoutMs)}`);
  }
  const theKillGraceMs = killGraceMs ?? config.killGraceSeconds * 1000;
  if (typeof theKillGraceMs !== 'number' || !Number.isFinite(theKillGraceMs) || theKillGraceMs < 0) {
    throw new TypeError(`killGraceMs 必须是不小于 0 的有限数字，当前值：${String(killGraceMs)}`);
  }
  // 子进程 exit 后等 close 的宽限：短于击杀宽限（正常 close 只差几毫秒），防止孤儿
  // 进程抱着管道把 runTask 拖到超时。
  const stdioGraceMs = Math.min(STDIO_GRACE_MAX_MS, theKillGraceMs);

  const startedAt = clock();
  if (!(startedAt instanceof Date) || Number.isNaN(startedAt.getTime())) {
    throw new TypeError('clock() 必须返回合法的 Date');
  }
  const peak = isPeak(startedAt);
  const quotaUnits = runCost({ model, startedAt }); // 非限流运行的扣减量（倍率取开始时刻）
  const prompt = buildPrompt(task, { extraPrompt });

  // 子进程环境：拷贝基底再设 / 删思考预算。为 0 时必须删掉——外层环境里若真设了
  // MAX_THINKING_TOKENS，不删就会被 claude 继承，等于偷偷给 easy 任务开思考。
  const childEnv = { ...env };
  if (Number.isFinite(thinkingTokens) && thinkingTokens > 0) {
    childEnv.MAX_THINKING_TOKENS = String(thinkingTokens);
  } else {
    delete childEnv.MAX_THINKING_TOKENS;
  }

  // 先建 run 行拿到 id（日志路径里要用它），再补写真实日志路径（见 setRunLogPath）。
  const run = startRun(db, { taskId: task.id, attempt, model, effort, peak, logPath: '' });
  const logDir = path.join(home, 'logs', `task-${task.id}`);
  let logStream;
  let logPath;
  try {
    fs.mkdirSync(logDir, { recursive: true });
    logPath = path.join(logDir, `run-${run.id}.log`);
    setRunLogPath(db, run.id, logPath);
    logStream = fs.createWriteStream(logPath, { flags: 'w' });
  } catch (err) {
    try {
      finishRun(db, run.id, { status: 'failed', error: `运行准备失败：${err.message}` });
    } catch {
      // 连 finishRun 都失败（库已坏等）：尽力而为，把原始错误抛给调用方
    }
    throw err;
  }
  logStream.on('error', () => { /* 写日志失败不影响运行结果；流销毁后 endLog 也能返回 */ });

  const taskId = task.id;
  const runId = run.id;
  // 日志写不进去（磁盘满 / 权限等，流已 destroyed）时跳过写入、事件照发——实时日志
  // 的消费者（SSE）不该跟着断流，运行结果更不该受影响。
  const writeRaw = (stream, line, ts) => {
    if (logStream.destroyed) return;
    logStream.write(`${ts} [${stream}] ${line}\n`);
  };
  // runEvents 的监听器抛错只影响它自己：记一行 meta（尽力而为），绝不打断运行或写库。
  const emitEvent = (name, payload) => {
    try {
      runEvents.emit(name, payload);
    } catch (err) {
      try {
        writeRaw('meta', `事件 ${name} 的监听器抛错：${err.message}`, clock().toISOString());
      } catch {
        // 日志流也写不进去：忽略，别让监听器的错误以另一种方式炸出来
      }
    }
  };
  const writeLine = (stream, line) => {
    const ts = clock().toISOString();
    writeRaw(stream, line, ts);
    emitEvent('log', { taskId, runId, stream, line, ts });
  };

  // ---------------------------------------------------------------- 运行状态
  const state = {
    exitCode: null,     // 'close' 的 code（被信号杀死时为 null）
    closeSignal: null,  // 'close' 的 signal（'SIGTERM' / 'SIGKILL' / null）
    timeout: false,     // 超时定时器已触发（先于取消触发时，状态按超时记）
    aborted: false,     // signal 已触发（先于超时触发时，状态按取消 / 停机记）
    abortReason: undefined,
    spawnError: null,   // spawn 'error'（ENOENT / EACCES 等）
    stuckStdio: false,  // SIGKILL 清场后 stdio 仍未关闭，按 exit 信息兜底结算
    result: null,       // stdout 里最后一个 type === 'result' 的解析结果
    rateStderrLine: null, // stderr 里第一条命中限流特征的行
    lastStderrLine: null, // stderr 最后一条非空行
  };

  const stdoutSink = makeLineSink((line) => {
    writeLine('stdout', line);
    try {
      noteResult(state, JSON.parse(line));
    } catch {
      // 非 JSON 行（进度、空行等）：只记日志，不参与判定
    }
  });
  const stderrSink = makeLineSink((line) => {
    writeLine('stderr', line); // 日志文件写完整行；下面只留截断后的（见 RETAIN_MAX_CHARS）
    if (state.rateStderrLine === null && RATE_LIMIT_PATTERN.test(line)) {
      state.rateStderrLine = truncateByCodePoints(line, RETAIN_MAX_CHARS);
    }
    if (line.trim() !== '') {
      state.lastStderrLine = truncateByCodePoints(line, RETAIN_MAX_CHARS);
    }
  });

  let child = null;
  let termTimer = null;  // 超时定时器（到点发 SIGTERM）
  let graceTimer = null; // SIGTERM 后的 SIGKILL 兜底
  let stdioTimer = null; // 子进程 exit 后等 close 的定时器（孤儿进程清场）
  let stuckTimer = null; // SIGKILL 清场后仍无 close 的最终兜底
  let settled = false;
  let resolveCompletion;
  let rejectCompletion;
  const completion = new Promise((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });

  const killGroup = (sig) => {
    if (child === null || child.pid === undefined) return;
    try {
      process.kill(-child.pid, sig); // 负 pid = 整个进程组（detached 的收益）
    } catch (err) {
      // ESRCH：组已不在（子进程恰好先退了），无害；其余（如 EPERM）记进日志别吞掉
      if (err.code !== 'ESRCH') writeLine('meta', `kill ${sig} 失败：${err.message}`);
    }
  };

  // 任务的进程组里是否还有存活成员。kill(-pgid, 0) 在组空时抛 ESRCH；EPERM 说明组里
  // 有我们没权限杀的进程，也算「有成员」。
  const groupHasMembers = () => {
    if (child === null || child.pid === undefined) return false;
    try {
      process.kill(-child.pid, 0);
      return true;
    } catch (err) {
      return err.code !== 'ESRCH';
    }
  };

  const onAbort = () => {
    // 运行已结束，或子进程赶在取消到来之前已经退出（close 可能还在路上——孤儿进程
    // 抱着管道）：取消改变不了已定的结果，别把 succeeded 改写成 canceled，也别白挂
    // 一个 graceTimer 拖住事件循环。
    if (settled || state.exitCode !== null) return;
    // 取消先于超时发生时，超时定时器作废（否则晚到的超时会改写取消语义）
    if (termTimer !== null) clearTimeout(termTimer);
    termTimer = null;
    state.aborted = true;
    state.abortReason = signal.reason;
    writeLine('meta', `收到中止信号（reason=${describeReason(signal.reason)}），对进程组发 SIGTERM`);
    killGroup('SIGTERM');
    graceTimer = setTimeout(() => killGroup('SIGKILL'), theKillGraceMs);
  };

  // 子进程退出 / spawn 失败 / 未启动，殊途同归到这里：判状态 → 写库 → 补结尾日志 →
  // 等日志落盘 → finish 事件 → resolve。settled 保证只执行一次。
  const finalize = () => {
    if (settled) return;
    settled = true;
    if (termTimer !== null) clearTimeout(termTimer);
    if (graceTimer !== null) clearTimeout(graceTimer);
    if (stdioTimer !== null) clearTimeout(stdioTimer);
    if (stuckTimer !== null) clearTimeout(stuckTimer);
    termTimer = null;
    graceTimer = null;
    stdioTimer = null;
    stuckTimer = null;
    if (signal !== undefined && signal !== null) signal.removeEventListener('abort', onAbort);
    try {
      stdoutSink.flush(); // 不完整的最后一行在进程结束时补写
      stderrSink.flush();
      const outcome = recordOutcome();
      endLogStream().then(() => {
        emitEvent('finish', { taskId, runId, status: outcome.status, error: outcome.error });
        resolveCompletion(outcome);
      });
    } catch (err) {
      // 判定或写库途中的意外错误（如 finishRun 撞上并发状态冲突）：拒绝，让调用方看到
      endLogStream().then(() => rejectCompletion(err));
    }
  };

  // 判定 + finishRun + 结尾 meta 行；返回给调用方的结果对象。
  const recordOutcome = () => {
    const judged = judge(state, theTimeoutMs);
    const numTurns = state.result !== null && Number.isInteger(state.result.numTurns)
      && state.result.numTurns >= 0 ? state.result.numTurns : null;
    const row = finishRun(db, runId, {
      status: judged.status,
      exitCode: state.exitCode,
      numTurns,
      prompts: judged.rateLimited ? 0 : 1, // 限流 = 请求被拒，不算额度
      quotaUnits: judged.rateLimited ? 0 : quotaUnits,
      error: judged.error,
    });
    const outcome = {
      runId,
      status: judged.status,
      exitCode: state.exitCode,
      signal: state.closeSignal,
      numTurns,
      isError: state.result !== null ? (state.result.isError ?? null) : null,
      summary: state.result !== null && state.result.text !== null
        ? truncateByCodePoints(state.result.text, SUMMARY_MAX_CHARS)
        : null,
      error: judged.error,
      rateLimited: judged.rateLimited,
      model,
      effort,
      peak,
      quotaUnits: judged.rateLimited ? 0 : quotaUnits,
      durationMs: row.durationMs,
      logPath,
    };
    writeLine('meta', `结束 status=${outcome.status} exit=${state.exitCode ?? 'null'}`
      + ` durationMs=${outcome.durationMs} quotaUnits=${outcome.quotaUnits}`);
    return outcome;
  };

  emitEvent('start', { taskId, runId, logPath });
  writeLine('meta', `开始 model=${model} effort=${effort} thinking=${thinkingTokens}`
    + ` peak=${peak} cwd=${workdir}`);

  // 调用前 signal 已中止：不启动子进程，按取消 / 停机规则记录（run 行与日志照常产生）。
  if (signal !== undefined && signal !== null && signal.aborted) {
    state.aborted = true;
    state.abortReason = signal.reason;
    writeLine('meta', '调用时 signal 已中止，未启动子进程');
    finalize();
    return completion;
  }

  child = spawn(config.claudeBin, ['-p', prompt, '--model', model, ...CLAUDE_ARGS], {
    cwd: workdir,
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  child.stdout.on('data', (chunk) => stdoutSink.push(chunk));
  child.stderr.on('data', (chunk) => stderrSink.push(chunk));
  child.on('error', (err) => {
    state.spawnError = `无法启动 claude（${config.claudeBin}）：${err.message}`;
    if (child.pid === undefined) finalize(); // 根本没起来：不会有 close 事件
  });
  // 孤儿进程清场：任务的进程组不应活过本次运行。子进程已退（此刻已被 reap，组里若
  // 还有成员只能是 claude 起的后台进程等遗留者），立即 SIGTERM 清场；若它们抱着
  // stdout/stderr 不放导致 close 迟迟不来，短宽限后升到 SIGKILL。正常路径（组已空、
  // close 立刻到）不多杀任何进程。
  child.on('exit', (code, exitSignal) => {
    state.exitCode = code;
    state.closeSignal = exitSignal;
    if (groupHasMembers()) {
      writeLine('meta', '子进程已退出但进程组仍有成员，对进程组发 SIGTERM 清场');
      killGroup('SIGTERM');
    }
    stdioTimer = setTimeout(() => {
      writeLine('meta', '子进程退出后 stdio 仍未关闭，对进程组发 SIGKILL');
      if (groupHasMembers()) killGroup('SIGKILL');
      // SIGKILL 后仍无 close：fd 被组外进程持有等极端情况。给一小段排空时间（管道里
      // 已有但未送达的数据仍要读出来），到点按 exit 时的退出码 / 信号结算。
      stuckTimer = setTimeout(() => {
        state.stuckStdio = true;
        writeLine('meta', 'SIGKILL 清场后 stdio 仍未关闭（fd 被组外进程持有？），按已退出的子进程结算');
        finalize();
      }, STUCK_DRAIN_MS);
    }, stdioGraceMs);
  });
  child.on('close', (code, closeSignal) => {
    state.exitCode = code;
    state.closeSignal = closeSignal;
    finalize();
  });
  if (signal !== undefined && signal !== null) signal.addEventListener('abort', onAbort, { once: true });
  termTimer = setTimeout(() => {
    // 已按取消处理，或子进程赶在超时前已退出（close 可能还在路上）：都不再改写状态
    if (state.aborted || state.exitCode !== null) return;
    state.timeout = true;
    writeLine('meta', `超时 ${minutesLabel(theTimeoutMs)} 分钟，对进程组发 SIGTERM`);
    killGroup('SIGTERM');
    graceTimer = setTimeout(() => killGroup('SIGKILL'), theKillGraceMs);
  }, theTimeoutMs);

  return completion;

  // ---------------------------------------------------------------- 内部函数
  function endLogStream() {
    return new Promise((resolve) => {
      if (logStream.closed || logStream.destroyed) {
        resolve(undefined);
        return;
      }
      logStream.once('close', () => resolve(undefined));
      logStream.end();
    });
  }
}

// ---------------------------------------------------------------- 判定与解析

/**
 * 按 issue #7 列出的顺序判定：
 * 1. 超时 / 取消（含停机）；2. 限流；3. 没有 result 行；4. 退出码 0 且 is_error 为
 * false；5. 其他失败。超时与取消同时发生时，先触发者定状态（超时先发 SIGTERM 后又
 * 收到停机中止，任务其实已超时，按超时记更诚实）。
 */
function judge(state, timeoutMs) {
  if (state.timeout) {
    return { status: 'timeout', error: `超时（${minutesLabel(timeoutMs)} 分钟）`, rateLimited: false };
  }
  if (state.aborted) {
    // 停机：记 failed + interrupted，调度器（#9）据此把任务放回队列
    if (state.abortReason === 'shutdown') {
      return { status: 'failed', error: 'interrupted', rateLimited: false };
    }
    return { status: 'canceled', error: null, rateLimited: false };
  }
  if (state.spawnError !== null) {
    return { status: 'failed', error: state.spawnError, rateLimited: false };
  }
  const exitNonZero = state.exitCode !== 0; // null（被信号杀死）也按非 0 处理
  const isErrorTrue = state.result !== null && state.result.isError === true;
  if (exitNonZero || isErrorTrue) {
    if (state.rateStderrLine !== null) return rateLimitResult(state.rateStderrLine);
    if (state.result !== null && state.result.text !== null
      && RATE_LIMIT_PATTERN.test(state.result.text)) {
      return rateLimitResult(state.result.text);
    }
  }
  if (state.result === null) {
    return { status: 'failed', error: `truncated: 输出中没有 result 行（exit ${state.exitCode}）`, rateLimited: false };
  }
  if (state.exitCode === 0 && state.result.isError === false) {
    return { status: 'succeeded', error: null, rateLimited: false };
  }
  const fallback = state.lastStderrLine ?? state.result.text ?? '';
  return {
    status: 'failed',
    error: fallback !== '' ? truncateByCodePoints(fallback, ERROR_MAX_CHARS) : `exit ${state.exitCode}`,
    rateLimited: false,
  };
}

function rateLimitResult(line) {
  return { status: 'failed', rateLimited: true, error: `rate_limit: ${truncateByCodePoints(line, RATE_LINE_MAX_CHARS)}` };
}

/**
 * stdout 里出现的 result 对象：取 num_turns / is_error / result（result 字段统一成
 * 字符串，超过 RETAIN_MAX_CHARS 先截断——判定与 summary 最多用 2000 字符，不值得为
 * 一条超长 result 把整段留在内存里）。
 */
function noteResult(state, obj) {
  if (obj === null || typeof obj !== 'object' || obj.type !== 'result') return;
  const rawResult = obj.result;
  const text = typeof rawResult === 'string' ? rawResult
    : rawResult === undefined || rawResult === null ? null : String(rawResult);
  state.result = {
    numTurns: obj.num_turns,
    isError: obj.is_error,
    text: text === null ? null : truncateByCodePoints(text, RETAIN_MAX_CHARS),
  };
}

/**
 * 字节流 → 行：按 \n 切（\r\n 也归一成一行），StringDecoder 兜住跨 chunk 的 UTF-8
 * 半字符。flush 在流结束时补写没有换行符的最后一行。缓冲只保存当前未完的一行，且到
 * LINE_BUFFER_MAX_CHARS 就强制切出——内存占用与输出总量无关。
 */
function makeLineSink(onLine) {
  const decoder = new StringDecoder('utf8');
  let buffer = '';
  const emit = (raw) => {
    onLine(raw.endsWith('\r') ? raw.slice(0, -1) : raw);
  };
  return {
    push(chunk) {
      buffer += decoder.write(chunk);
      let nl;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        emit(line);
      }
      if (buffer.length > LINE_BUFFER_MAX_CHARS) {
        const forced = buffer; // 无尽长行的极端情况：按一行切出，日志里表现为拆行
        buffer = '';
        emit(forced);
      }
    },
    flush() {
      const tail = buffer + decoder.end();
      buffer = '';
      if (tail !== '') emit(tail);
    },
  };
}

// ---------------------------------------------------------------- 小工具

function assertArguments({ task, workdir, config, db, home, signal, extraPrompt, clock, env }) {
  if (task === null || typeof task !== 'object') {
    throw new TypeError(`runTask 缺 task 参数（任务对象），收到：${describe(task)}`);
  }
  if (!Number.isInteger(task.id) || task.id < 1) {
    throw new TypeError(`task.id 必须是正整数，收到：${describe(task.id)}`);
  }
  if (typeof workdir !== 'string' || workdir.trim() === '') {
    throw new TypeError(`runTask 缺 workdir 参数（工作目录），收到：${describe(workdir)}`);
  }
  if (!fs.existsSync(workdir) || !fs.statSync(workdir).isDirectory()) {
    throw new TypeError(`workdir 必须是已存在的目录：${workdir}`);
  }
  if (config === null || typeof config !== 'object') {
    throw new TypeError(`runTask 缺 config 参数（配置对象），收到：${describe(config)}`);
  }
  if (typeof config.claudeBin !== 'string' || config.claudeBin.trim() === '') {
    throw new TypeError(`config.claudeBin 必须是非空字符串，收到：${describe(config.claudeBin)}`);
  }
  if (db === null || typeof db !== 'object') {
    throw new TypeError(`runTask 缺 db 参数（node:sqlite DatabaseSync），收到：${describe(db)}`);
  }
  if (typeof home !== 'string' || home.trim() === '') {
    throw new TypeError(`runTask 缺 home 参数（数据目录），收到：${describe(home)}`);
  }
  if (signal !== undefined && signal !== null
    && (typeof signal !== 'object' || typeof signal.addEventListener !== 'function')) {
    throw new TypeError(`signal 必须是 AbortSignal，收到：${describe(signal)}`);
  }
  if (extraPrompt !== null && extraPrompt !== undefined && typeof extraPrompt !== 'string') {
    throw new TypeError(`extraPrompt 必须是字符串或 null，收到：${describe(extraPrompt)}`);
  }
  if (typeof clock !== 'function') {
    throw new TypeError(`clock 必须是函数，收到：${describe(clock)}`);
  }
  if (env === null || typeof env !== 'object') {
    throw new TypeError(`env 必须是环境变量对象，收到：${describe(env)}`);
  }
}

/** 超时分钟数用于错误信息与日志：最多两位小数、去掉尾零（3600000 → "60"，30000 → "0.5"）。 */
function minutesLabel(ms) {
  return String(Number((ms / 60_000).toFixed(2)));
}

/** abort 的 reason 展示：字符串原样，Error 取名字，其他 String()。 */
function describeReason(reason) {
  if (reason instanceof Error) return reason.name;
  return String(reason);
}

/** 按 Unicode 码点截断（不把 emoji / 中文切半个），仅在超长时才复制。 */
function truncateByCodePoints(text, maxChars) {
  const value = String(text);
  if ([...value].length <= maxChars) return value;
  return [...value].slice(0, maxChars).join('');
}

function describe(value) {
  try {
    const json = JSON.stringify(value);
    if (json !== undefined) return json;
  } catch {
    // 循环引用等，落到 String() 兜底
  }
  return String(value);
}
