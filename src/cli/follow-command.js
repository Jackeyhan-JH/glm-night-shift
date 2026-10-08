// follow 子命令（issue #48）：任务成功开出 PR 之后，评审要求修改（CHANGES_REQUESTED）
// 时在**原来的 night-shift 分支**上入队一条跟进任务——gitRef 指向父任务的分支，
// createWorktree 会从 origin/<gitRef> 检出，push / 开 PR 沿用现有逻辑推回原分支、
// 复用原来那个 PR（不新开第二个）。判定与入队的规则只有一份，抽在 src/follow.js：
// 除了这里的手动 follow，调度器开了 autoFollowReviews（#49）后在非高峰做的是同一套
// 扫描。本文件只负责参数解析、开库、stdout 与退出码。
//
// ⚠️ 与 task-commands.js / cleanup-command.js 同理：本文件（及其静态依赖）绝不能
// import src/db.js / src/tasks.js / src/follow.js（follow.js 静态依赖 tasks.js）——
// db.js 是唯一加载 node:sqlite 的模块，静态引入会让入口来不及先装 SQLite 警告过滤
// （时机说明见 src/warnings.js）。openDb / tasks.js / follow.js 一律走 run() 的调用
// 链里的动态 import。
import path from 'node:path';
import { parseArgs } from 'node:util';
import { loadConfig, resolveHome } from '../config.js';

export const followCommand = {
  summary: '按 PR 评审在原分支入队跟进任务',
  usage: '用法：night-shift follow <id> | night-shift follow --all [--json]',
  async run(args, ctx) {
    const { values, positionals } = parseArgs({
      args,
      options: {
        all: { type: 'boolean' },
        json: { type: 'boolean' },
      },
      allowPositionals: true,
    });
    const usage = followCommand.usage;
    if (values.json && !values.all) {
      throw new ctx.UsageError('--json 只能与 --all 一起使用', { usage });
    }
    if (values.all) {
      if (positionals.length > 0) {
        throw new ctx.UsageError(`不能同时给 <id> 与 --all（当前参数：${positionals.join(' ')}）`, { usage });
      }
      return runFollowAll(ctx, { jsonOut: values.json === true });
    }
    if (positionals.length === 0) {
      throw new ctx.UsageError('缺少必填参数：<id>（或使用 --all）', { usage });
    }
    if (positionals.length > 1) {
      throw new ctx.UsageError(`参数过多：${positionals.join(' ')}（只需要 <id>）`, { usage });
    }
    const raw = positionals[0];
    if (!/^\d+$/.test(raw) || Number(raw) < 1) {
      throw new ctx.UsageError(`<id> 必须是正整数（当前值：${raw}）`, { usage });
    }
    return runFollowOne(ctx, Number(raw));
  },
};

/** 打开 <home>/night-shift.db（不存在则自动创建）；失败抛中文原因带路径的错。 */
async function openDbAt(ctx) {
  const { openDb } = await import('../db.js'); // 动态 import：给警告过滤留出安装时间
  const dbPath = path.join(resolveHome(ctx.env), 'night-shift.db');
  try {
    return openDb(dbPath);
  } catch (err) {
    throw new Error(`无法打开数据库 ${dbPath}：${err.message}`);
  }
}

/** follow <id>：单条判定。gh 用配置的 ghBin；输出原句，退出码见 JSDoc。 */
async function runFollowOne(ctx, id) {
  const config = loadConfig({ home: resolveHome(ctx.env), env: ctx.env });
  const db = await openDbAt(ctx);
  let result;
  try {
    const { getTask } = await import('../tasks.js');
    const { followTask } = await import('../follow.js'); // 动态：本文件不能静态依赖 tasks.js 链
    const parent = getTask(db, id);
    if (parent === null) throw new Error(`任务 #${id} 不存在`);
    result = await followTask(db, parent, { ghBin: config.ghBin, env: ctx.env, config });
  } finally {
    db.close();
  }
  if (result.kind === 'skipped') {
    ctx.stdout.write(`${result.message}\n`);
    return 0;
  }
  ctx.stdout.write(`已入队 #${result.id}，在分支 ${result.branch} 上改\n`);
  return 0;
}

/**
 * follow --all：对每条 succeeded 且有 prUrl 的任务做与 follow <id> 同一套判定。
 * 单条失败（gh 失败、分支不合法……）记下来继续下一条，已入队的保留；只要有一条
 * 失败退出码就是 1，全部跳过或全部成功是 0。--json 时 stdout 只有一个 JSON 值：
 * { created, skipped, failed }。
 */
async function runFollowAll(ctx, { jsonOut }) {
  const config = loadConfig({ home: resolveHome(ctx.env), env: ctx.env });
  const db = await openDbAt(ctx);
  const created = [];
  const skipped = [];
  const failed = [];
  try {
    const { followTask, listFollowParents } = await import('../follow.js');
    const candidates = listFollowParents(db);
    for (const parent of candidates) {
      // 单条失败不中断：记进 failed 继续；成功 / 跳过的照常收集。
      const result = await followTask(db, parent, {
        ghBin: config.ghBin,
        env: ctx.env,
        config,
        throwOnError: false,
      });
      if (result.kind === 'created') {
        created.push({ id: result.id, parentId: result.parentId, branch: result.branch, source: result.source });
      } else if (result.kind === 'skipped') {
        skipped.push({ parentId: result.parentId, message: result.message });
      } else {
        failed.push({ parentId: result.parentId, message: result.message });
      }
    }
  } finally {
    db.close();
  }
  if (jsonOut) {
    ctx.stdout.write(`${JSON.stringify({ created, skipped, failed })}\n`);
    return failed.length > 0 ? 1 : 0;
  }
  // 每个结果一行，用 follow <id> 的原句（前面带父任务号便于分辨），不另打摘要。
  for (const item of created) {
    ctx.stdout.write(`#${item.parentId} 已入队 #${item.id}，在分支 ${item.branch} 上改\n`);
  }
  for (const item of skipped) {
    ctx.stdout.write(`#${item.parentId} ${item.message}\n`);
  }
  for (const item of failed) {
    ctx.stdout.write(`#${item.parentId} 失败：${item.message}\n`);
  }
  return failed.length > 0 ? 1 : 0;
}
