// config 子命令：显示生效配置（默认值 < <home>/config.json < 环境变量）与数据目录
// 里的各路径。只读路径不创建任何文件（config.json 不存在也照常显示默认值）；
// `config set <键=值> …`（#81）写看板设置页那七个键：先全部校验，有一个不合法就
// 一个键都不写，落盘复用 patchConfigFile（与 PATCH /api/config 同一套写盘语义）。
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import {
  SETTINGS_KEYS,
  configPath,
  ensureHome,
  loadConfig,
  patchConfigFile,
  resolveHome,
} from '../config.js';

/** 用法第二行的缩进：对齐到「用法：」前缀之后（帮助详解里两行逐行列出）。 */
const USAGE_SET_CONT = ' '.repeat(6);
/** concurrency 的合法原文：十进制正整数的规范写法（无前导零 / 符号 / 小数 / 指数）。 */
const POSITIVE_INT_RE = /^[1-9][0-9]*$/;
/** followPollMinutes / prStatusPollMinutes 的合法原文：非指数的十进制正数写法。 */
const POSITIVE_NUMBER_RE = /^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/;

export const configCommand = {
  summary: '查看生效配置与数据目录',
  usage: [
    '用法：night-shift config [--json]',
    `${USAGE_SET_CONT}night-shift config set <键=值> [<键=值> ...]`,
  ].join('\n'),
  run(args, ctx) {
    const { values, positionals } = parseArgs({
      args,
      options: { json: { type: 'boolean' } },
      allowPositionals: true,
    });
    // 第一个位置参数是 set 才进入写入；其他位置参数维持只读命令的用法错误（退出 2）。
    if (positionals.length > 0) {
      if (positionals[0] === 'set') return runSet(ctx, positionals.slice(1), values);
      throw new ctx.UsageError(`未知参数：${positionals[0]}`, { usage: configCommand.usage });
    }
    const home = resolveHome(ctx.env);
    // JSON 形状（固定，文档化）：{ home, configPath, dbPath, config }。
    // concurrency / port 等配置键在 config 里（嵌套一层），对整个输出 grep 键名仍能命中。
    const info = {
      home,
      configPath: configPath(home),
      dbPath: path.join(home, 'night-shift.db'),
      config: loadConfig({ home, env: ctx.env }),
    };
    if (values.json) {
      ctx.stdout.write(`${JSON.stringify(info, null, 2)}\n`);
      return 0;
    }
    const exists = fs.existsSync(info.configPath) ? '' : '（不存在，用默认值）';
    ctx.stdout.write([
      `数据目录：${info.home}`,
      `配置文件：${info.configPath}${exists}`,
      `数据库：${info.dbPath}`,
      '',
      '生效配置：',
      JSON.stringify(info.config, null, 2),
      '',
    ].join('\n'));
    return 0;
  },
};

/**
 * `config set` 半边（#81）：tokens 是 `set` 之后的键值串。用法错误（--json 冲突、缺
 * 键值、格式不对）抛 ctx.UsageError 退出 2；校验失败（重复 / 未知 / 类型）抛普通
 * Error 退出 1。两条路都在 ensureHome 之前，失败时连数据目录都不建、一个键都不写。
 */
function runSet(ctx, tokens, values) {
  if (values.json) {
    throw new ctx.UsageError('config set 不能与 --json 一起用', { usage: configCommand.usage });
  }
  if (tokens.length === 0) {
    throw new ctx.UsageError('缺少要写入的配置项', { usage: configCommand.usage });
  }
  const patch = buildPatch(ctx, tokens);
  const home = resolveHome(ctx.env);
  ensureHome(home); // 与其他会写盘的命令一样：数据目录与 logs/repos/worktrees（幂等）
  patchConfigFile(home, patch); // 文件不是合法 JSON 等错误原样上抛（退出 1，原字节不动）
  // 写完重读生效配置（默认值 < config.json < 环境变量），七个键按 SETTINGS_KEYS 顺序汇报。
  const config = loadConfig({ home, env: ctx.env });
  const lines = ['已写入配置。正在运行的看板要重启后才按新值运行。'];
  for (const key of SETTINGS_KEYS) lines.push(`${key}=${config[key]}`);
  ctx.stdout.write(`${lines.join('\n')}\n`);
  return 0;
}

/**
 * 键值串 → patch 对象（值已是 boolean / number）。检查分三趟全量做，命中第一类就抛、
 * 绝不部分采纳：格式（键=值）→ 重复 → 未知 → 类型。类型规则与 server.js 的
 * parseSettingsBody 同义（那边收 JSON 值，这里把命令行原文解析成同形状，不接受
 * `1e1` / `01` / `yes` 这类写法）。
 */
function buildPatch(ctx, tokens) {
  const pairs = [];
  for (const token of tokens) {
    const eq = token.indexOf('='); // 按第一个 = 切开，值一侧可以再出现 =
    if (eq < 1) { // 没有 = 或键为空；不 trim，原文什么样就按什么样报错
      throw new ctx.UsageError(`参数格式应为 <键=值>：${token}`, { usage: configCommand.usage });
    }
    pairs.push([token.slice(0, eq), token.slice(eq + 1)]);
  }
  const seen = new Set();
  for (const [key] of pairs) {
    if (seen.has(key)) throw new Error(`配置项重复：${key}`);
    seen.add(key);
  }
  for (const [key] of pairs) {
    if (!SETTINGS_KEYS.includes(key)) {
      throw new Error(`未知配置项：${key}（允许：${SETTINGS_KEYS.join(' | ')}）`);
    }
  }
  const patch = {};
  for (const [key, raw] of pairs) patch[key] = coerceSetting(key, raw);
  return patch;
}

/** 单个键的类型检查与转换：失败抛含键名与原文的中文错误（退出 1，不写盘）。 */
function coerceSetting(key, raw) {
  if (key === 'concurrency') {
    const value = Number(raw);
    // 三道关：规范写法、安全整数、往返无损（拒绝精度丢失的超大整数，如 2^53+1）。
    if (!POSITIVE_INT_RE.test(raw) || !Number.isSafeInteger(value) || String(value) !== raw) {
      throw new Error(`concurrency 必须是正整数，收到：${raw}`);
    }
    return value;
  }
  if (key === 'followPollMinutes' || key === 'prStatusPollMinutes') {
    const value = Number(raw);
    if (!POSITIVE_NUMBER_RE.test(raw) || !Number.isFinite(value) || value <= 0) {
      throw new Error(`${key} 必须是正数，收到：${raw}`);
    }
    return value;
  }
  if (raw === 'true') return true; // 其余四个布尔键：只收单词 true / false（区分大小写）
  if (raw === 'false') return false;
  throw new Error(`${key} 必须是 true 或 false，收到：${raw}`);
}
