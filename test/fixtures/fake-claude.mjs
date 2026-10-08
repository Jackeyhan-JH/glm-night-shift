#!/usr/bin/env node
// 假 claude：模拟 `claude -p "<prompt>" --model <m> ...` 的无人值守输出，供测试使用。
// 绝不联网、绝不调用真实的 claude。行为由环境变量控制：
//   FAKE_CLAUDE_ARGS_LOG   若设置，把本次调用追加为一行 JSON（argv / cwd / MAX_THINKING_TOKENS）
//   FAKE_CLAUDE_SCENARIO   success（默认）| fail | hang | slow | noop
//   FAKE_CLAUDE_DELAY_MS   slow 场景的等待毫秒数（默认 2000，非法值按 2000）
// 重要：不带 -p/--print 被调用时（例如被 `node --test` 误当测试文件执行）什么都不做，
// 不写文件、不输出，直接退出 0，保证 `node --test` 无副作用地扫过本文件。
import { appendFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

const VALUE_FLAGS = new Set([
  '--model',
  '--output-format',
  '--max-turns',
  '--append-system-prompt',
  '--permission-mode',
]);
const SCENARIOS = new Set(['success', 'fail', 'hang', 'slow', 'noop']);
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
    env: { MAX_THINKING_TOKENS: process.env.MAX_THINKING_TOKENS ?? null },
  })}\n`);
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

  const scenario = process.env.FAKE_CLAUDE_SCENARIO ?? 'success';
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

  if (scenario === 'hang') {
    process.stdout.write(initLine());
    process.on('SIGTERM', () => process.exit(143));
    process.on('SIGINT', () => process.exit(130));
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
    process.stdout.write(resultLine('success', false, 3, 'done'));
    return 0;
  }

  // success 与 noop：输出相同的三行 JSON；区别只在 noop 不写任何文件。
  if (scenario === 'success') appendFakeMd();
  process.stdout.write(initLine());
  process.stdout.write(assistantLine());
  process.stdout.write(resultLine('success', false, 3, 'done'));
  return 0;
}

main().then(
  (code) => { if (code !== 0) process.exitCode = code; },
  (err) => {
    process.stderr.write(`fake-claude 内部错误：${err && err.stack ? err.stack : String(err)}\n`);
    process.exitCode = 1;
  },
);
