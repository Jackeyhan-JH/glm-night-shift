#!/usr/bin/env node
// night-shift 命令行入口。目前只有 --version 和 help；后续 issue 在 COMMANDS 表里加子命令。
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

// 通过 import.meta.url 相对路径读 package.json，任意 cwd / npm link 下都能找到。
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

/** 用法错误：中文短信息 + 用法说明，退出码 2。绝不打印堆栈。 */
class UsageError extends Error {}

// 子命令表：后续 issue 只需在这里加条目（summary 进 help，run(args, ctx) 里自己用 parseArgs）。
const COMMANDS = {
  help: {
    summary: '显示帮助',
    usage: 'night-shift help',
    run() {
      process.stdout.write(usageText());
      return 0;
    },
  },
};

const TOP_OPTIONS = new Set(['--version', '-v', '--help', '-h']);

function usageText() {
  const commandLines = Object.entries(COMMANDS).map(([name, cmd]) => `  ${name.padEnd(10)}${cmd.summary}`);
  return [
    'GLM 夜班：把编码任务排进队列，在 GLM 非高峰时段交给 Claude Code 自动完成并开 PR',
    '',
    '用法：night-shift <命令> [选项]',
    '',
    '命令：',
    ...commandLines,
    '  --version  显示版本号（-v）',
    '  --help     显示本帮助（-h）',
    '',
    '更多命令（add/list/show/cancel/retry/config、调度器与日志、网页看板）将在后续版本加入。',
    '',
  ].join('\n');
}

// 把 argv 拆成：命令前的全局选项 / 第一个位置参数（命令）/ 其后交给子命令的参数。
function splitTopLevel(argv) {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') {
      return { flags: argv.slice(0, i), command: argv[i + 1] ?? null, rest: argv.slice(i + 2) };
    }
    if (!arg.startsWith('-')) {
      return { flags: argv.slice(0, i), command: arg, rest: argv.slice(i + 1) };
    }
  }
  return { flags: argv, command: null, rest: [] };
}

function parseTopFlags(flags) {
  for (const flag of flags) {
    if (!TOP_OPTIONS.has(flag)) throw new UsageError(`未知选项：${flag}`);
  }
  return parseArgs({
    args: flags,
    options: {
      version: { type: 'boolean', short: 'v' },
      help: { type: 'boolean', short: 'h' },
    },
  }).values;
}

function runMain(argv) {
  const { flags, command, rest } = splitTopLevel(argv);
  const values = parseTopFlags(flags);
  if (values.version) {
    process.stdout.write(`${pkg.version}\n`);
    return 0;
  }
  if (values.help || command === null) {
    process.stdout.write(usageText());
    return 0;
  }
  const cmd = COMMANDS[command];
  if (!cmd) throw new UsageError(`未知命令：${command}`);
  return cmd.run(rest, { pkg, usageText });
}

function main(argv = process.argv.slice(2)) {
  try {
    const code = runMain(argv);
    if (code !== 0) process.exitCode = code;
    return code;
  } catch (err) {
    if (err instanceof UsageError) {
      process.stderr.write(`错误：${err.message}\n`);
      process.stderr.write(usageText());
      process.exitCode = 2;
      return 2;
    }
    process.stderr.write(`错误：${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
    return 1;
  }
}

main();
