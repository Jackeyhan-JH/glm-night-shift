#!/usr/bin/env node
// 假 claude：模拟 `claude -p "<prompt>" --model <m> ...` 的无人值守输出，供测试使用。
// 绝不联网、绝不调用真实的 claude。行为由环境变量控制：
//   FAKE_CLAUDE_ARGS_LOG    若设置，把本次调用追加为一行 JSON（argv / cwd / pid / MAX_THINKING_TOKENS）。
//                           pid 供测试验证进程组击杀后子进程确实不在了（process.kill(pid, 0) 抛 ESRCH）。
//   FAKE_CLAUDE_SCENARIO    success（默认）| fail | hang | slow | noop | rate-limit | truncated | stubborn
//                             - rate-limit：stdout 只有 init 行，stderr 写 429 rate limit，
//                               没有 result 行，退出 1（模拟请求被限流拒绝）
//                             - truncated：init + 2 行 assistant 后退出 1，没有 result 行，
//                               stderr 不含 429 / rate limit 字样（模拟输出被截断）
//                             - stubborn：忽略 SIGTERM / SIGINT，只能被 SIGKILL 结束
//                               （测执行器的 SIGKILL 兜底）
//                             就绪约定：hang / stubborn 等信号敏感场景都在输出 init 行
//                             「之前」装好信号处理器——init 行一到，之后任意时刻发信号，
//                             行为都是确定的（hang 被 SIGTERM 杀出 143；stubborn 无视）。
//   FAKE_CLAUDE_DELAY_MS    slow 场景的等待毫秒数（默认 2000，非法值按 2000）
//   FAKE_CLAUDE_RESULT_TEXT 设了时 success（含 slow）场景 result 行的 result 用这个值
//                           （默认仍是 'done'；#12 的失败诊断测试用它模拟诊断文本）
//   FAKE_CLAUDE_SEQUENCE    逗号分隔的场景序列（如 fail,success）：第 N 次调用用第 N 个场景，
//                           用完后一直用最后一个；优先于 FAKE_CLAUDE_SCENARIO（调度器 /
//                           端到端测试用它模拟「先失败后成功」）。需同时设置
//                           FAKE_CLAUDE_STATE_FILE。
//   FAKE_CLAUDE_STATE_FILE  场景序列的计数文件路径。计数是简单的读-改-写（先取号再执行），
//                           不是原子操作：并发调用共用同一个状态文件会互相覆盖计数。
//                           测试与调度器场景都是串行调用，够用；真要并发时请每路一个文件。
// 重要：不带 -p/--print 被调用时（例如被 `node --test` 误当测试文件执行）什么都不做，
// 不写文件、不输出，直接退出 0，保证 `node --test` 无副作用地扫过本文件。
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

const VALUE_FLAGS = new Set([
  '--model',
  '--output-format',
  '--max-turns',
  '--append-system-prompt',
  '--permission-mode',
]);
const SCENARIOS = new Set(['success', 'fail', 'hang', 'slow', 'noop', 'rate-limit', 'truncated', 'stubborn']);
const FAKE_MD = 'NIGHT_SHIFT_FAKE.md';

function parseArgv(argv) {
  const out = { printSeen: false, prompt: null, model: null, positionals: [] };
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === '-p' || arg === '--print') {
      out.printSeen = true;
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        out.prompt = next;
        i += 2;
      } else {
        i += 1; // -p 后面没有 prompt，稍后从位置参数或 stdin 取
      }
      continue;
    }
    const eq = arg.startsWith('--') ? arg.indexOf('=') : -1;
    if (eq !== -1) {
      const name = arg.slice(0, eq);
      const value = arg.slice(eq + 1);
      if (name === '--print') {
        out.printSeen = true;
        if (value !== '') out.prompt = value;
      } else if (name === '--model') {
        out.model = value;
      }
      i += 1;
      continue;
    }
    if (VALUE_FLAGS.has(arg)) {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        if (arg === '--model') out.model = next;
        i += 2;
      } else {
        i += 1;
      }
      continue;
    }
    if (arg.startsWith('-') && arg.length > 1) {
      i += 1; // 未知旗标（--dangerously-skip-permissions、--verbose 等）：忽略
      continue;
    }
    out.positionals.push(arg);
    i += 1;
  }
  return out;
}

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(data));
  });
}

function writeArgsLog() {
  const target = process.env.FAKE_CLAUDE_ARGS_LOG;
  if (!target) return;
  appendFileSync(target, `${JSON.stringify({
    argv: process.argv.slice(2),
    cwd: process.cwd(),
    pid: process.pid,
    env: { MAX_THINKING_TOKENS: process.env.MAX_THINKING_TOKENS ?? null },
  })}\n`);
}

/**
 * 按状态文件里的计数取序列中的下一个场景，并把计数 +1 落盘。
 * 读-改-写不是原子的（见文件头注释）：并发调用同一状态文件不安全。
 */
function pickFromSequence(names, stateFile) {
  let count = 0;
  try {
    const parsed = Number.parseInt(readFileSync(stateFile, 'utf8').trim(), 10);
    if (Number.isInteger(parsed) && parsed >= 0) count = parsed; // 内容不合法：从 0 重新计数
  } catch {
    // 文件不存在 / 不可读：从 0 开始（首次调用）
  }
  writeFileSync(stateFile, String(count + 1));
  return names[Math.min(count, names.length - 1)]; // 用完后一直用最后一个
}

function parseDelayMs(raw) {
  const ms = Number.parseInt(raw, 10);
  return Number.isInteger(ms) && ms >= 0 ? ms : 2000;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const argv = process.argv.slice(2);
  const parsed = parseArgv(argv);
  if (!parsed.printSeen) return 0; // 无 -p：什么都不做（防误跑副作用）
  writeArgsLog();

  // 场景序列优先于单个场景（见文件头）：先从状态文件取号，再决定本次行为。
  let scenario = process.env.FAKE_CLAUDE_SCENARIO ?? 'success';
  const sequenceRaw = process.env.FAKE_CLAUDE_SEQUENCE;
  if (sequenceRaw !== undefined && sequenceRaw !== '') {
    const stateFile = process.env.FAKE_CLAUDE_STATE_FILE;
    if (!stateFile) {
      process.stderr.write('设置了 FAKE_CLAUDE_SEQUENCE 就必须同时设置 FAKE_CLAUDE_STATE_FILE（计数存哪）\n');
      return 2;
    }
    const names = sequenceRaw.split(',').map((name) => name.trim()).filter((name) => name !== '');
    const unknown = names.filter((name) => !SCENARIOS.has(name));
    if (unknown.length > 0) {
      process.stderr.write(`FAKE_CLAUDE_SEQUENCE 里有未知场景：${unknown.join(',')}（可选：${[...SCENARIOS].join('|')}）\n`);
      return 2;
    }
    scenario = pickFromSequence(names, stateFile);
  }
  if (!SCENARIOS.has(scenario)) {
    process.stderr.write(`FAKE_CLAUDE_SCENARIO 未知：${scenario}（可选：${[...SCENARIOS].join('|')}）\n`);
    return 2;
  }

  let prompt = parsed.prompt;
  if (prompt === null && parsed.positionals.length > 0) prompt = parsed.positionals[0];
  if (prompt === null && !process.stdin.isTTY) prompt = await readStdin();
  const promptText = String(prompt ?? '');

  const sessionId = randomUUID();
  const startedAt = Date.now();
  const jsonLine = (obj) => `${JSON.stringify(obj)}\n`;
  const initLine = () => jsonLine({
    type: 'system',
    subtype: 'init',
    session_id: sessionId,
    model: parsed.model,
    cwd: process.cwd(),
    tools: [],
  });
  const assistantLine = () => jsonLine({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: `(fake) working on: ${promptText.slice(0, 80)}` }],
    },
    session_id: sessionId,
  });
  const resultLine = (subtype, isError, numTurns, resultText) => jsonLine({
    type: 'result',
    subtype,
    is_error: isError,
    num_turns: numTurns,
    duration_ms: Math.max(0, Date.now() - startedAt),
    result: resultText,
    session_id: sessionId,
    ...(isError ? {} : { total_cost_usd: 0 }),
  });
  const appendFakeMd = () => {
    appendFileSync(path.join(process.cwd(), FAKE_MD), `${promptText.replace(/[\r\n]+/g, ' ')}\n`);
  };

  if (scenario === 'fail') {
    process.stdout.write(initLine());
    process.stderr.write('fake failure (FAKE_CLAUDE_SCENARIO=fail)\n');
    process.stdout.write(resultLine('error_during_execution', true, 1, 'fake failure'));
    return 1;
  }

  if (scenario === 'rate-limit') {
    process.stdout.write(initLine());
    process.stderr.write('API Error: 429 Too Many Requests - rate limit exceeded\n');
    return 1; // 没有 result 行：请求被拒，连对话都没开始
  }

  if (scenario === 'truncated') {
    process.stdout.write(initLine());
    process.stdout.write(assistantLine());
    process.stdout.write(assistantLine());
    process.stderr.write('fake truncated output (stream ended, no result line)\n');
    return 1;
  }

  if (scenario === 'stubborn') {
    // 先装信号处理器、再输出 init 行：init 行是调用方的「就绪」信号，看到它之后发的
    // SIGTERM 必须已被无视——顺序反了的话，看到 init 就发信号的测试会赶在处理器注册
    // 之前把本进程按默认动作杀死（signal SIGTERM 而不是活到 SIGKILL）。
    process.on('SIGTERM', () => process.stderr.write('stubborn: SIGTERM ignored\n'));
    process.on('SIGINT', () => process.stderr.write('stubborn: SIGINT ignored\n'));
    process.stdout.write(initLine());
    setInterval(() => {}, 60_000); // 保持进程存活
    return 0; // 不会真正到达（interval 挡住事件循环）
  }

  if (scenario === 'hang') {
    // 同 stubborn：先装处理器再报就绪，收到 SIGTERM 恰好落在 init 行之后也能退出 143
    process.on('SIGTERM', () => process.exit(143));
    process.on('SIGINT', () => process.exit(130));
    process.stdout.write(initLine());
    setInterval(() => {}, 60_000); // 保持进程存活，直到收到信号
    return 0; // 不会真正到达（interval 挡住事件循环）
  }

  if (scenario === 'slow') {
    const delayMs = parseDelayMs(process.env.FAKE_CLAUDE_DELAY_MS);
    process.stdout.write(initLine());
    const ticker = setInterval(() => process.stdout.write(assistantLine()), 200);
    await sleep(delayMs);
    clearInterval(ticker);
    appendFakeMd();
    process.stdout.write(assistantLine());
    process.stdout.write(resultLine('success', false, 3, successResultText()));
    return 0;
  }

  // success 与 noop：输出相同的三行 JSON；区别只在 noop 不写任何文件。
  if (scenario === 'success') appendFakeMd();
  process.stdout.write(initLine());
  process.stdout.write(assistantLine());
  process.stdout.write(resultLine('success', false, 3, successResultText()));
  return 0;
}

/** success（含 slow）场景 result 行的 result 文本：FAKE_CLAUDE_RESULT_TEXT 覆盖，默认 'done'。 */
function successResultText() {
  return process.env.FAKE_CLAUDE_RESULT_TEXT ?? 'done';
}

main().then(
  (code) => { if (code !== 0) process.exitCode = code; },
  (err) => {
    process.stderr.write(`fake-claude 内部错误：${err && err.stack ? err.stack : String(err)}\n`);
    process.exitCode = 1;
  },
);
