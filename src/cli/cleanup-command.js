// cleanup 子命令（issue #40）：清理已结束任务（succeeded / failed / canceled）遗留的
// worktree 目录与超过保留期的运行日志。只动磁盘：不删任务 / runs 行，不删 repos/ 缓存，
// 不动分支；queued / running 任务的 worktree 与日志一律不碰。
//
// ⚠️ 与 task-commands.js 同理：本文件（及其静态依赖）绝不能 import src/db.js——它是
// 唯一加载 node:sqlite 的模块，静态引入会让入口来不及先装 SQLite 警告过滤（时机说明
// 见 src/warnings.js）。openDb 一律走 run() 里的动态 import。
//
// 删目录的逻辑抽在 src/cleanup.js（#50 起与 POST /api/cleanup 共用；那个模块不 import
// 任何 src/ 模块，这里静态引入没问题），本文件只留参数解析、开库与输出。命令行靠
// 退出码表达「有的路径没删掉」（HTTP 靠响应里的 failed 布尔）。
import path from 'node:path';
import { parseArgs } from 'node:util';
import { resolveHome } from '../config.js';
import { DEFAULT_LOGS_DAYS, runCleanup } from '../cleanup.js';

export const cleanupCommand = {
  summary: '清理已结束任务的 worktree 和过期日志',
  usage: '用法：night-shift cleanup [--dry-run] [--logs-older-than <天数>] [--json]',
  async run(args, ctx) {
    const { values } = parseArgs({
      args,
      options: {
        'dry-run': { type: 'boolean' },
        'logs-older-than': { type: 'string' },
        json: { type: 'boolean' },
      },
    });
    const dryRun = values['dry-run'] === true;
    const jsonOut = values.json === true;
    let logDays = DEFAULT_LOGS_DAYS;
    if (values['logs-older-than'] !== undefined) {
      const raw = values['logs-older-than'];
      // 只接受 ≥0 的整数（负数 / 小数 / 非数字都是用法错误，退出码 2）。
      if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
        throw new ctx.UsageError(`--logs-older-than 必须是不小于 0 的整数（当前值：${raw}）`, {
          usage: cleanupCommand.usage,
        });
      }
      logDays = Number(raw);
    }

    const home = resolveHome(ctx.env);
    const { openDb } = await import('../db.js'); // 动态 import：给警告过滤留出安装时间
    const dbPath = path.join(home, 'night-shift.db');
    let db;
    try {
      db = openDb(dbPath);
    } catch (err) {
      throw new Error(`无法打开数据库 ${dbPath}：${err.message}`);
    }

    let report;
    try {
      report = await runCleanup({
        db,
        home,
        dryRun,
        logsOlderThan: logDays, // 0 = 这次完全不处理日志（不列、不删）
        stderr: ctx.stderr,
      });
    } finally {
      db.close();
    }

    if (jsonOut) {
      ctx.stdout.write(`${JSON.stringify({ worktrees: report.worktrees, logs: report.logs })}\n`);
    } else if (dryRun) {
      for (const p of [...report.worktrees, ...report.logs]) ctx.stdout.write(`${p}\n`);
    } else {
      ctx.stdout.write(`worktree：删除 ${report.worktrees.length} 个\n`);
      ctx.stdout.write(`日志：删除 ${report.logs.length} 个\n`);
    }
    return report.failed ? 1 : 0;
  },
};
