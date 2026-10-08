#!/usr/bin/env node
// night-shift 命令行入口。子命令（issue #5）：add / list / show / cancel / retry / config；
// start / peak / logs / serve 等命令留给后续 issue 在 COMMANDS 表里继续加。
// 子命令签名：run(args, ctx)，可以返回数字退出码（或 Promise<number>）；
// 用法错误抛 ctx.UsageError（可带该命令的 usage），或直接让 util.parseArgs 抛
// （ERR_PARSE_ARGS_* 会被映射成该命令的用法错误，退出码 2）；运行时错误（校验失败、
// 任务不存在、非法状态转换）→ 中文原因到 stderr，退出码 1。
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
// 顺序关键：先静态引入警告模块，装好过滤再（间接）碰 node:sqlite——src/cli/* 只动态
// import src/db.js，本身不加载 sqlite，所以这里的静态引入是安全的（见 src/warnings.js）。
import { installSqliteWarningFilter } from '../src/warnings.js';
import {
  addCommand,
  cancelCommand,
  listCommand,
  retryCommand,
  showCommand,
} from '../src/cli/task-commands.js';
import { depsCommand } from '../src/cli/deps-command.js';
import { configCommand } from '../src/cli/config-command.js';
import { templatesCommand } from '../src/cli/template-commands.js';
import { serveCommand } from '../src/cli/serve-command.js';
import { serveRunCommand } from '../src/cli/serve-run.js';
import { installServiceCommand, uninstallServiceCommand } from '../src/cli/service-command.js';
import {
  logsCommand,
  peakCommand,
  runNowCommand,
  startCommand,
  usageCommand,
} from '../src/cli/run-commands.js';

// 通过 import.meta.url 相对路径读 package.json，任意 cwd / npm link 下都能找到。
const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

// 必须在 node:sqlite 第一次加载之前执行（它模块求值时就发警告并捕获当时的
// process.emitWarning 引用；Node 24 无此警告，本调用是无害的空操作）。
installSqliteWarningFilter();

/** 用法错误：中文短信息 +（可选）该命令自己的用法，退出码 2。绝不打印堆栈。 */
class UsageError extends Error {
  constructor(message, { usage } = {}) {
    super(message);
    this.name = 'UsageError';
    this.usage = usage ?? null;
  }
}

// 子命令表：后续 issue 只需在这里加条目（summary 进 help，run(args, ctx) 里自己用 parseArgs）。
const COMMANDS = {
  add: addCommand,
  list: listCommand,
  show: showCommand,
  cancel: cancelCommand,
  retry: retryCommand,
  start: startCommand,
  peak: peakCommand,
  usage: usageCommand,
  logs: logsCommand,
  'run-now': runNowCommand,
  deps: depsCommand,
  config: configCommand,
  templates: templatesCommand,
  'serve-api': serveCommand,
  serve: serveRunCommand,
  'install-service': installServiceCommand,
  'uninstall-service': uninstallServiceCommand,
  help: {
    summary: '显示帮助',
    usage: 'night-shift help',
    run(_args, ctx) {
      ctx.stdout.write(ctx.usageText());
      return 0;
    },
  },
};

const TOP_OPTIONS = new Set(['--version', '-v', '--help', '-h']);

// 任何 usage/帮助文本写出前都过这一道：保证以且仅以一个换行结尾（缺则补、
// 多则裁），免得 shell 提示符粘在用法后面，也不用给每条 usage 字符串手工配换行。
function withTrailingNewline(text) {
  return `${String(text).replace(/\n+$/, '')}\n`;
}

function usageText() {
  // 命令名列宽按最长的命令名（uninstall-service）放宽到 18，保证摘要列对齐。
  const commandLines = Object.entries(COMMANDS).map(([name, cmd]) => `  ${name.padEnd(18)}${cmd.summary}`);
  // 各命令的 usage 单一来源：帮助里原样列出（help 自身显而易见，不重复）。
  const details = Object.entries(COMMANDS)
    .filter(([name]) => name !== 'help')
    .flatMap(([, cmd]) => cmd.usage.split('\n').map((line) => `  ${line}`));
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
    '命令详解：',
    ...details,
    '',
    '--prompt-file 的文件内容原样作为提示词（只去掉末尾一个换行符）；--max-attempts 缺省',
    '取配置的 maxAttempts；list / show 的时间按本地时区显示到分钟。--depends-on 与',
    'deps --set 的 id 列表逗号分隔、容忍空格，空串表示无依赖（--set "" 即清空）。',
    '数据目录：$NIGHT_SHIFT_HOME（默认 ~/.glm-night-shift）。',
    '',
    '日常一条命令：serve 同时跑调度器与看板；install-service 把它装成 systemd 用户',
    '服务（开机自启，uninstall-service 卸载）。只看数据不调度时用 serve-api。',
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

async function runMain(argv, ctx) {
  const { flags, command, rest } = splitTopLevel(argv);
  const values = parseTopFlags(flags);
  if (values.version) {
    ctx.stdout.write(`${ctx.pkg.version}\n`);
    return 0;
  }
  if (values.help || command === null) {
    ctx.stdout.write(ctx.usageText());
    return 0;
  }
  const cmd = COMMANDS[command];
  if (!cmd) throw new UsageError(`未知命令：${command}`);
  // `night-shift <命令> --help` / `-h`：打印该命令自己的用法（顶层 --help 在前面已处理）。
  if (rest.length === 1 && (rest[0] === '--help' || rest[0] === '-h')) {
    ctx.stdout.write(withTrailingNewline(cmd.usage));
    return 0;
  }
  try {
    return await cmd.run(rest, ctx);
  } catch (err) {
    // 命令内部 util.parseArgs 抛出的用法错误（缺必填参数、非法值……）：按该命令的用法错误处理。
    if (!(err instanceof UsageError)
        && typeof err?.code === 'string'
        && err.code.startsWith('ERR_PARSE_ARGS_')) {
      throw new UsageError(err.message, { usage: cmd.usage });
    }
    throw err;
  }
}

/**
 * 执行 CLI，返回退出码；输出写到 options.stdout/stderr（默认 process 的），
 * 不改 process.exitCode，方便测试里直接调用。
 */
async function runCli(argv, {
  stdout = process.stdout,
  stderr = process.stderr,
  env = process.env,
  cwd = process.cwd(),
} = {}) {
  const ctx = { pkg, usageText, UsageError, stdout, stderr, env, cwd };
  try {
    return await runMain(argv, ctx);
  } catch (err) {
    if (err instanceof UsageError) {
      stderr.write(`错误：${err.message}\n`);
      // 所有用法错误都汇到这里：统一保证 usage 以且仅以一个换行结尾。
      stderr.write(withTrailingNewline(err.usage ?? usageText()));
      return 2;
    }
    stderr.write(`错误：${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}

/** 入口用：执行 CLI 并把退出码写回 process.exitCode。 */
async function main(argv = process.argv.slice(2), options) {
  if (!options) suppressPipeErrors(); // 真实入口才处理管道；测试传的是收集输出的 sink
  const code = await runCli(argv, options);
  if (code !== 0) process.exitCode = code;
  return code;
}

// `night-shift list | head -1` 这类用法里读者提前退出，后续 write 抛 EPIPE，Node 默认
// 会打印堆栈崩溃——这里挂上监听把 EPIPE 静默吞掉（进程随后带着 CLI 的退出码正常结束），
// 其他错误照常抛。只在真实入口安装；测试里 runCli 的 stdout 是普通 sink，没有 .on。
function suppressPipeErrors() {
  for (const stream of [process.stdout, process.stderr]) {
    if (stream && typeof stream.on === 'function') {
      stream.on('error', (err) => {
        if (err?.code !== 'EPIPE') throw err;
      });
    }
  }
}

// 只有本文件就是入口脚本时才自动执行（npm link 的符号链接也能正确识别），被 import 时不跑。
function isEntryScript() {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryScript()) main();

export { main, runCli, COMMANDS, UsageError };
