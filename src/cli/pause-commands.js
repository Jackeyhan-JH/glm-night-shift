// pause / resume 两个子命令（issue #38）：把「人要不要暂停领取新任务」写进库里的
// meta.userPaused。调度器每轮领取前读它（见 src/scheduler.js 的 doTick），所以任何
// 进程写都立即生效、重启也还在。只动这一行——内存里的限流退避（pausedUntil）与
// 任务各自的 not_before 都不受影响。命令对象形状见 bin/night-shift.mjs 的 COMMANDS 表。
//
// ⚠️ 与 task-commands.js 同理：本文件（及其静态依赖）绝不能 import src/db.js——它是
// 唯一加载 node:sqlite 的模块，静态引入会让入口来不及先装 SQLite 警告过滤。openDb
// 一律走下面 openDbAt() 里的动态 import；tasks.js / config.js 不碰 node:sqlite。
import path from 'node:path';
import { parseArgs } from 'node:util';
import { resolveHome } from '../config.js';
import { getUserPaused, setUserPaused } from '../tasks.js';

/**
 * 打开 <home>/night-shift.db（不存在则自动创建）。打开失败抛中文原因带路径的错。
 * 与 run-commands.js 的 openDbAt 同款：连接交给调用方，由调用方负责 close。
 */
async function openDbAt(ctx) {
  const { openDb } = await import('../db.js'); // 动态 import：给警告过滤留出安装时间
  const dbPath = path.join(resolveHome(ctx.env), 'night-shift.db');
  try {
    return openDb(dbPath);
  } catch (err) {
    throw new Error(`无法打开数据库 ${dbPath}：${err.message}`);
  }
}

/**
 * pause / resume 共用骨架：不接受任何位置参数（多了是用法错误，退出 2），读旧值
 * 决定文案（重复操作也是退出 0），写新值后关库。
 */
function pauseToggleCommand({ name, summary, pausedTo, actMessage, noopMessage }) {
  const usage = `用法：night-shift ${name}`;
  return {
    summary,
    usage,
    async run(args, ctx) {
      const { positionals } = parseArgs({ args, options: {}, allowPositionals: true });
      if (positionals.length > 0) {
        throw new ctx.UsageError(`参数过多：${positionals.join(' ')}（本命令不接受参数）`, { usage });
      }
      const db = await openDbAt(ctx);
      let message;
      try {
        const was = getUserPaused(db);
        setUserPaused(db, pausedTo);
        message = was === pausedTo ? noopMessage : actMessage;
      } finally {
        db.close();
      }
      ctx.stdout.write(`${message}\n`);
      return 0;
    },
  };
}

export const pauseCommand = pauseToggleCommand({
  name: 'pause',
  summary: '暂停领取新任务（正在跑的会跑完）',
  pausedTo: true,
  actMessage: '已暂停：不再领取新任务（正在跑的会跑完）',
  noopMessage: '已经是暂停状态',
});

export const resumeCommand = pauseToggleCommand({
  name: 'resume',
  summary: '恢复领取新任务',
  pausedTo: false,
  actMessage: '已恢复领取',
  noopMessage: '没有暂停',
});
