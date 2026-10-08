// add / list / show / cancel / retry 五个子命令（issue #5）。命令对象形状见
// bin/night-shift.mjs 的 COMMANDS 表：{ summary, usage, run(args, ctx) }。
//
// ⚠️ 本文件（及其静态依赖）绝不能 import src/db.js：db.js 是唯一加载 node:sqlite
// 的模块，静态引入会让入口来不及先装 SQLite 警告过滤（时机说明见 src/warnings.js，
// 已在 Node 22.13 上实测）。openDb 一律走下面 withDb() 里的动态 import。
// tasks.js / config.js / render.js 不碰 node:sqlite，静态引入没问题。
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { loadConfig, resolveHome } from '../config.js';
import {
  DIFFICULTIES,
  TASK_STATUSES,
  NotFoundError,
  cancelTask,
  createTask,
  getTask,
  listRuns,
  listTasks,
  retryTask,
} from '../tasks.js';
import { renderTaskDetail, renderTasksTable } from './render.js';

/** 多行用法里续行的缩进：对齐到「用法：night-shift 」之后的命令名。 */
const USAGE_CONT = ' '.repeat(15);

/**
 * 打开 <home>/night-shift.db（不存在则自动创建）执行 fn，用完无论成败都关闭连接。
 */
async function withDb(ctx, fn) {
  const { openDb } = await import('../db.js'); // 动态 import：给警告过滤留出安装时间
  const db = openDb(path.join(resolveHome(ctx.env), 'night-shift.db'));
  try {
    return await fn(db);
  } finally {
    db.close();
  }
}

/** 入口视角的生效配置：默认值 < <home>/config.json < 环境变量。 */
function effectiveConfig(ctx) {
  return loadConfig({ home: resolveHome(ctx.env), env: ctx.env });
}

/** --json 时输出缩进 JSON，否则输出人类可读的一行。 */
function writeOut(ctx, json, value, humanLine) {
  ctx.stdout.write(json ? `${JSON.stringify(value, null, 2)}\n` : `${humanLine}\n`);
}

/**
 * 用法级整数校验：只接受可选正负号 + 纯数字（''、' 3'、'1.5'、'1e3' 都算非法），
 * 可要求下限（limit ≥ 1、max-attempts ≥ 1）。不合法抛该命令的 UsageError（退出码 2）。
 */
function parseIntStrict(ctx, raw, label, usage, { min } = {}) {
  const constraint = min === undefined ? '整数' : `不小于 ${min} 的整数`;
  const fail = () => new ctx.UsageError(`${label} 必须是${constraint}（当前值：${raw}）`, { usage });
  if (typeof raw !== 'string' || !/^[+-]?\d+$/.test(raw)) throw fail();
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || (min !== undefined && value < min)) throw fail();
  return value;
}

/** show/cancel/retry 的 <id>：恰好一个位置参数且为正整数，否则用法错误。 */
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

export const addCommand = {
  summary: '添加任务到队列',
  usage: [
    '用法：night-shift add --repo <owner/name> (--prompt <文字> | --prompt-file <路径>)',
    `${USAGE_CONT}[--title <标题>] [--difficulty easy|medium|hard] [--priority <整数>]`,
    `${USAGE_CONT}[--test "<测试命令>"] [--allow-peak] [--max-attempts <次数>] [--json]`,
  ].join('\n'),
  async run(args, ctx) {
    const { values } = parseArgs({
      args,
      options: {
        repo: { type: 'string' },
        prompt: { type: 'string' },
        'prompt-file': { type: 'string' },
        title: { type: 'string' },
        difficulty: { type: 'string' },
        priority: { type: 'string' },
        test: { type: 'string' },
        'allow-peak': { type: 'boolean' },
        'max-attempts': { type: 'string' },
        json: { type: 'boolean' },
      },
    });
    if (values.repo === undefined) {
      throw new ctx.UsageError('缺少必填参数：--repo <owner/name>', { usage: addCommand.usage });
    }
    if (values.prompt !== undefined && values['prompt-file'] !== undefined) {
      throw new ctx.UsageError('--prompt 与 --prompt-file 只能二选一', { usage: addCommand.usage });
    }
    if (values.prompt === undefined && values['prompt-file'] === undefined) {
      throw new ctx.UsageError('缺少必填参数：--prompt <文字> 或 --prompt-file <路径>', {
        usage: addCommand.usage,
      });
    }
    let difficulty;
    if (values.difficulty !== undefined) {
      // 枚举在 CLI 层判（用法错误，退出码 2）；repo 格式等留给 store 判（运行时错误，退出码 1）。
      if (!DIFFICULTIES.includes(values.difficulty)) {
        throw new ctx.UsageError(
          `--difficulty 必须是 ${DIFFICULTIES.join(' | ')} 之一（当前值：${values.difficulty}）`,
          { usage: addCommand.usage },
        );
      }
      difficulty = values.difficulty;
    }
    const priority = values.priority === undefined
      ? undefined
      : parseIntStrict(ctx, values.priority, '--priority', addCommand.usage);
    const maxAttempts = values['max-attempts'] === undefined
      ? undefined
      : parseIntStrict(ctx, values['max-attempts'], '--max-attempts', addCommand.usage, { min: 1 });

    // --prompt-file：文件内容原样作为提示词，只去掉末尾一个换行（\n 或 \r\n）；
    // 读取失败是运行时错误（文件不存在等），报错带路径。
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

    const config = effectiveConfig(ctx);
    const task = await withDb(ctx, (db) => createTask(db, {
      repo: values.repo,
      prompt,
      title: values.title, // 未给时 store 取 prompt 前 60 个码点
      difficulty,
      priority,
      testCommand: values.test,
      allowPeak: values['allow-peak'] ?? false,
      maxAttempts: maxAttempts ?? config.maxAttempts, // 缺省取配置 maxAttempts
    }));
    writeOut(ctx, values.json, task, `已加入队列：#${task.id} ${task.title}`);
    return 0;
  },
};

export const listCommand = {
  summary: '列出任务',
  usage: '用法：night-shift list [--status <queued|running|succeeded|failed|canceled>] [--limit <条数>] [--json]',
  async run(args, ctx) {
    const { values } = parseArgs({
      args,
      options: {
        status: { type: 'string' },
        limit: { type: 'string' },
        json: { type: 'boolean' },
      },
    });
    let status;
    if (values.status !== undefined) {
      if (!TASK_STATUSES.includes(values.status)) {
        throw new ctx.UsageError(
          `--status 必须是 ${TASK_STATUSES.join(' | ')} 之一（当前值：${values.status}）`,
          { usage: listCommand.usage },
        );
      }
      status = values.status;
    }
    const limit = values.limit === undefined
      ? undefined // 缺省用 store 的默认（当前 100）
      : parseIntStrict(ctx, values.limit, '--limit', listCommand.usage, { min: 1 });
    const tasks = await withDb(ctx, (db) => listTasks(db, { status, limit }));
    if (values.json) {
      ctx.stdout.write(`${JSON.stringify(tasks, null, 2)}\n`); // 空列表输出 []，不是「队列是空的」
      return 0;
    }
    ctx.stdout.write(tasks.length === 0 ? '队列是空的\n' : renderTasksTable(tasks));
    return 0;
  },
};

export const showCommand = {
  summary: '查看任务详情与运行记录',
  usage: '用法：night-shift show <id> [--json]',
  async run(args, ctx) {
    const { values, positionals } = parseArgs({
      args,
      options: { json: { type: 'boolean' } },
      allowPositionals: true,
    });
    const id = parseIdPositional(ctx, positionals, showCommand.usage);
    const { task, runs } = await withDb(ctx, (db) => {
      const found = getTask(db, id);
      if (found === null) throw new NotFoundError(id); // 运行时错误：中文原因，退出码 1
      return { task: found, runs: listRuns(db, { taskId: id, limit: 1000 }) };
    });
    // JSON 形状：任务字段全在顶层（含 status），runs 挂在 runs 键下。
    writeOut(ctx, values.json, { ...task, runs }, renderTaskDetail(task, runs));
    return 0;
  },
};

/** cancel / retry 共用骨架：解析 <id>、执行动作、输出「#<id> 中文说明（新状态）」。 */
function statusChangeCommand({ name, summary, action, label }) {
  const usage = `用法：night-shift ${name} <id>`;
  return {
    summary,
    usage,
    async run(args, ctx) {
      const { positionals } = parseArgs({ args, options: {}, allowPositionals: true });
      const id = parseIdPositional(ctx, positionals, usage);
      const task = await withDb(ctx, (db) => action(db, id));
      ctx.stdout.write(`#${task.id} ${label}（${task.status}）\n`);
      return 0;
    },
  };
}

export const cancelCommand = statusChangeCommand({
  name: 'cancel',
  summary: '取消排队/执行中的任务',
  action: cancelTask, // (db, id) => TaskRow
  label: '已取消',
});

export const retryCommand = statusChangeCommand({
  name: 'retry',
  summary: '把失败/已取消的任务重新排队',
  action: retryTask, // (db, id) => TaskRow
  label: '已重新排队',
});
