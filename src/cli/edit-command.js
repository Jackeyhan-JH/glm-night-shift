// edit 子命令（issue #46）：修改排队中的任务。领域规则全在 src/tasks.js 的 updateTask
// （只允许 queued、字段白名单、依赖整组替换同 deps --set）；本文件只做参数解析与
// 用法级校验（枚举、整数格式、id 列表格式 → 退出码 2），命令对象形状见
// bin/night-shift.mjs 的 COMMANDS 表：{ summary, usage, run(args, ctx) }。
//
// ⚠️ 与 task-commands.js / deps-command.js 同理：本文件（及其静态依赖）绝不能
// import src/db.js——它是唯一加载 node:sqlite 的模块，静态引入会让入口来不及先装
// SQLite 警告过滤（时机说明见 src/warnings.js）。openDb 一律走下面 withDb() 里的
// 动态 import；tasks.js 不碰 node:sqlite，静态引入没问题。
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { resolveHome } from '../config.js';
import { DIFFICULTIES, updateTask } from '../tasks.js';
import { parseIdListOption } from './deps-command.js';

/** 多行用法里续行的缩进：对齐到「用法：night-shift 」之后的命令名。 */
const USAGE_CONT = ' '.repeat(15);

// withDb / parseIdPositional / normalizeNumericOptions / parseIntStrict 与
// task-commands.js 里的同名实现保持一致；不抽公共模块是有意为之（见 deps-command.js
// 的说明）：并行的 issue 各自加命令时互不牵连，共享件留给以后收敛。
/** 打开 <home>/night-shift.db（不存在则自动创建）执行 fn，用完无论成败都关闭连接。 */
async function withDb(ctx, fn) {
  const { openDb } = await import('../db.js'); // 动态 import：给警告过滤留出安装时间
  const dbPath = path.join(resolveHome(ctx.env), 'night-shift.db');
  let db;
  try {
    db = openDb(dbPath);
  } catch (err) {
    throw new Error(`无法打开数据库 ${dbPath}：${err.message}`);
  }
  try {
    return await fn(db);
  } finally {
    db.close();
  }
}

/** <id> 位置参数：恰好一个且为正整数，否则用法错误。 */
function parseIdPositional(ctx, positionals, usage) {
  if (positionals.length === 0) throw new ctx.UsageError('缺少必填参数：<id>', { usage });
  if (positionals.length > 1) {
    throw new ctx.UsageError(`参数过多：${positionals.join(' ')}（只需要 <id>）`, { usage });
  }
  const raw = positionals[0];
  if (!/^\d+$/.test(raw) || Number(raw) < 1) {
    throw new ctx.UsageError(`<id> 必须是正整数（当前值：${raw}）`, { usage });
  }
  return Number(raw);
}

/** util.parseArgs 把 `--priority -2` 里的负数当未知选项：解析前合并成 `--priority=-2`。 */
const NUMBER_VALUE_OPTIONS = new Set(['priority', 'max-attempts']);

function normalizeNumericOptions(args) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') { // 其后全是位置参数，不再改写
      out.push(...args.slice(i));
      break;
    }
    const name = arg.startsWith('--') && !arg.includes('=') ? arg.slice(2) : null;
    if (name !== null && NUMBER_VALUE_OPTIONS.has(name)
        && i + 1 < args.length && /^[+-]?\d+$/.test(args[i + 1])) {
      out.push(`${arg}=${args[i + 1]}`);
      i += 1;
    } else {
      out.push(arg);
    }
  }
  return out;
}

/** 用法级整数校验（同 add）：只接受可选正负号 + 纯数字，可要求下限。 */
function parseIntStrict(ctx, raw, label, usage, { min } = {}) {
  const constraint = min === undefined ? '整数' : `不小于 ${min} 的整数`;
  const fail = () => new ctx.UsageError(`${label} 必须是${constraint}（当前值：${raw}）`, { usage });
  if (typeof raw !== 'string' || !/^[+-]?\d+$/.test(raw)) throw fail();
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || (min !== undefined && value < min)) throw fail();
  return value;
}

export const editCommand = {
  summary: '修改排队中的任务',
  usage: [
    '用法：night-shift edit <id> [--title <文字>] [--prompt <文字> | --prompt-file <路径>]',
    `${USAGE_CONT}[--difficulty easy|medium|hard] [--priority <整数>] [--test <命令> | --no-test]`,
    `${USAGE_CONT}[--allow-peak | --no-allow-peak] [--max-attempts <正整数>]`,
    `${USAGE_CONT}[--depends-on <id,id,…> | --no-depends] [--json]`,
    `${USAGE_CONT}至少一个修改项；只允许排队中的任务`,
  ].join('\n'),
  async run(args, ctx) {
    const { values, positionals } = parseArgs({
      args: normalizeNumericOptions(args),
      options: {
        title: { type: 'string' },
        prompt: { type: 'string' },
        'prompt-file': { type: 'string' },
        difficulty: { type: 'string' },
        priority: { type: 'string' },
        test: { type: 'string' },
        'no-test': { type: 'boolean' },
        'allow-peak': { type: 'boolean' },
        'no-allow-peak': { type: 'boolean' },
        'max-attempts': { type: 'string' },
        'depends-on': { type: 'string' },
        'no-depends': { type: 'boolean' },
        json: { type: 'boolean' },
      },
      allowPositionals: true,
    });
    const usage = editCommand.usage;
    const id = parseIdPositional(ctx, positionals, usage);
    // 互斥对：给了两个的用法错误（退出码 2）。
    if (values.prompt !== undefined && values['prompt-file'] !== undefined) {
      throw new ctx.UsageError('--prompt 与 --prompt-file 只能二选一', { usage });
    }
    if (values.test !== undefined && values['no-test'] !== undefined) {
      throw new ctx.UsageError('--test 与 --no-test 只能二选一', { usage });
    }
    if (values['allow-peak'] !== undefined && values['no-allow-peak'] !== undefined) {
      throw new ctx.UsageError('--allow-peak 与 --no-allow-peak 只能二选一', { usage });
    }
    if (values['depends-on'] !== undefined && values['no-depends'] !== undefined) {
      throw new ctx.UsageError('--depends-on 与 --no-depends 只能二选一', { usage });
    }
    let difficulty;
    if (values.difficulty !== undefined) {
      // 枚举在 CLI 层判（用法错误，退出码 2）；字段值合法性留给 store 判（退出码 1）。
      if (!DIFFICULTIES.includes(values.difficulty)) {
        throw new ctx.UsageError(
          `--difficulty 必须是 ${DIFFICULTIES.join(' | ')} 之一（当前值：${values.difficulty}）`,
          { usage },
        );
      }
      difficulty = values.difficulty;
    }
    const priority = values.priority === undefined
      ? undefined
      : parseIntStrict(ctx, values.priority, '--priority', usage); // 负数合法，不给下限
    const maxAttempts = values['max-attempts'] === undefined
      ? undefined
      : parseIntStrict(ctx, values['max-attempts'], '--max-attempts', usage, { min: 1 });
    const dependsOn = values['depends-on'] === undefined
      ? undefined
      : parseIdListOption(ctx, values['depends-on'], '--depends-on', usage);

    // --prompt-file 与 add 同一套语义：文件内容原样作为提示词，只去掉末尾一个换行
    // （\n 或 \r\n）；读取失败是运行时错误，报错带路径。
    let prompt = values.prompt;
    if (values['prompt-file'] !== undefined) {
      const file = path.resolve(ctx.cwd, values['prompt-file']);
      let content;
      try {
        content = fs.readFileSync(file, 'utf8');
      } catch (err) {
        throw new Error(`无法读取 prompt 文件 ${file}：${err.message}`);
      }
      prompt = content.endsWith('\n') ? content.replace(/\r?\n$/, '') : content;
    }

    // 出现才进 patch（updateTask：不出现 = 保持原值）。
    const patch = {};
    if (values.title !== undefined) patch.title = values.title;
    if (prompt !== undefined) patch.prompt = prompt;
    if (difficulty !== undefined) patch.difficulty = difficulty;
    if (priority !== undefined) patch.priority = priority;
    if (values.test !== undefined) patch.testCommand = values.test;
    else if (values['no-test'] !== undefined) patch.testCommand = null; // 清掉
    if (values['allow-peak'] !== undefined) patch.allowPeak = true;
    else if (values['no-allow-peak'] !== undefined) patch.allowPeak = false;
    if (maxAttempts !== undefined) patch.maxAttempts = maxAttempts;
    if (values['no-depends'] !== undefined) patch.dependsOn = []; // 清空依赖
    else if (dependsOn !== undefined) patch.dependsOn = dependsOn; // '' 解析为 []，同为清空
    if (Object.keys(patch).length === 0) {
      throw new ctx.UsageError('至少给一个修改项（--title / --prompt / --priority / …）', { usage });
    }

    const task = await withDb(ctx, (db) => updateTask(db, id, patch));
    if (values.json) {
      ctx.stdout.write(`${JSON.stringify(task, null, 2)}\n`);
    } else {
      ctx.stdout.write(`已更新 #${task.id}\n`);
    }
    return 0;
  },
};
