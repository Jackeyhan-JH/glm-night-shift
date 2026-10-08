// start / peak / usage / logs / run-now 五个子命令（issue #10）：把调度器（#9）跑起来，
// 并在终端里看高峰状态、额度用量、运行日志，手动立刻跑一个任务做测试。
// 命令对象形状见 bin/night-shift.mjs 的 COMMANDS 表：{ summary, usage, run(args, ctx) }。
//
// ⚠️ 与 task-commands.js 同理：本文件（及其静态依赖）绝不能 import src/db.js——它是
// 唯一加载 node:sqlite 的模块，静态引入会让入口来不及先装 SQLite 警告过滤（时机说明
// 见 src/warnings.js）。openDb / createScheduler / runEvents 一律走动态 import；
// tasks.js / config.js / clock.js / format.js / peak.js / quota.js / scheduler-lock.js
// 不碰 node:sqlite。
//
// 时间约定（#1 / #9）：所有「现在」都取 systemClock(env)（测试用 NIGHT_SHIFT_NOW 固定），
// 显示按进程本地时区到分钟（测试设 TZ=Asia/Shanghai 保证输出稳定）。
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { systemClock } from '../clock.js';
import { ensureHome, loadConfig, resolveHome } from '../config.js';
import { formatLocalMinute } from '../format.js';
import { RULES, getStatus } from '../peak.js';
import { MODEL_MULTIPLIERS, multiplierFor, usage as quotaUsage } from '../quota.js';
import { acquireSchedulerLock } from '../scheduler-lock.js';
import { attachSchedulerLog } from './scheduler-log.js';
import {
  DependencyBlockedError,
  InvalidTransitionError,
  NotFoundError,
  getRun,
  getTask,
  listRuns,
} from '../tasks.js';

/** 北京时间的星期标签（getDay 取值：周日为 0）。 */
const WEEKDAY_LABELS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
/** logs --follow 轮询新日志 / 查运行是否结束的间隔。 */
const FOLLOW_POLL_MS = 100;
/** 多行用法里续行的缩进：对齐到「用法：night-shift 」之后的命令名（与其他 cli 模块一致）。 */
const USAGE_CONT = ' '.repeat(15);

const p2 = (n) => String(n).padStart(2, '0');

/** 北京日历时刻（固定 UTC+8，无夏令时）：周几 + HH:MM。 */
function beijingWeekdayHM(date) {
  const bj = new Date(date.getTime() + RULES.tzOffsetMinutes * 60_000);
  return `${WEEKDAY_LABELS[bj.getUTCDay()]} ${p2(bj.getUTCHours())}:${p2(bj.getUTCMinutes())}`;
}

/** <id> 位置参数：恰好一个且为正整数，否则用法错误（与 task-commands.js 的同名实现一致）。 */
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

/**
 * 打开 <home>/night-shift.db（不存在则自动创建）。打开失败抛中文原因带路径的错。
 * 与 task-commands.js 的 withDb 不同：这里把连接交给调用方（start / run-now / logs
 * --follow 要持着它等调度器跑完 / 轮询结束），由调用方负责 close。
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

// ---------------------------------------------------------------- start

export const startCommand = {
  summary: '前台运行调度器',
  usage: [
    '用法：night-shift start',
    `${USAGE_CONT}（Ctrl-C / SIGTERM 一次优雅停止；再来一次强制停止）`,
  ].join('\n'),
  async run(args, ctx) {
    parseArgs({ args, options: {} }); // 不收任何选项；未知选项 → 用法错误（退出 2）
    const home = resolveHome(ctx.env);
    const config = loadConfig({ home, env: ctx.env }); // NIGHT_SHIFT_NOW 非法时 systemClock 抛错 → 退出 1
    const clock = systemClock(ctx.env);
    ensureHome(home); // logs/ / repos/ / worktrees/ 子目录（幂等）
    // 一个数据目录同一时刻只允许一个调度器进程（#18 产品评论）：被别的 serve / start
    // 持有时 acquireSchedulerLock 抛错 → 退出 1，不领任务。
    const lock = acquireSchedulerLock(home);
    const say = (line) => ctx.stdout.write(`${line}\n`);
    let db = null;
    try {
      db = await openDbAt(ctx);
      const { createScheduler } = await import('../scheduler.js');
      const scheduler = createScheduler({ db, config, home, clock, env: ctx.env });
      // 调度器事件 → 一行一条（与 serve 完全相同的格式，见 scheduler-log.js）
      attachSchedulerLog(scheduler, { db, clock, write: (line) => ctx.stdout.write(line) });

      // 信号协议（issue 规定）：第一次 SIGINT / SIGTERM 优雅停止（没有运行中任务就直接
      // 退出）；第二次（再按 Ctrl-C）强制停止。两种都等收尾完成后以退出码 0 结束。
      // 处理器必须先于启动行安装：管道写一旦落进内核，读端立刻可见，紧跟着的 SIGINT
      // 可能赶在 process.on 之前到达（默认行为直接把进程打死——启动行与安装在同一段
      // 同步代码里也不够，顺序得是先装再打印）。
      const code = await new Promise((resolve) => {
        let stopRequested = false;
        let settled = false;
        const finish = (exitCode) => {
          if (settled) return;
          settled = true;
          process.removeListener('SIGINT', onSignal);
          process.removeListener('SIGTERM', onSignal);
          resolve(exitCode);
        };
        const requestStop = (force) => {
          // stop() 的 Promise 在全部任务收尾后 resolve；拒绝按 0 处理（收尾异常已各自
          // 记录进任务，别让调度器的实现失误变成非零退出码）。
          scheduler.stop({ force }).then(() => finish(0), () => finish(0));
        };
        const onSignal = () => {
          if (stopRequested) {
            say('强制停止…');
            requestStop(true);
            return;
          }
          stopRequested = true;
          const running = scheduler.status().running;
          if (running.length === 0) {
            requestStop(false); // 没有运行中的任务：直接退出
            return;
          }
          say(`正在停止：不再领取新任务，等待 ${running.length} 个运行中的任务结束（再来一次 Ctrl-C 或 SIGTERM 强制停止）`);
          requestStop(false);
        };
        process.on('SIGINT', onSignal);
        process.on('SIGTERM', onSignal);

        say(`GLM 夜班已启动：并发 ${config.concurrency}，每 ${config.pollSeconds} 秒检查一次，数据目录 ${home}`);
        scheduler.start();
      });
      db.close();
      db = null;
      return code;
    } finally {
      lock.release(); // 正常退出与异常路径都删自己的锁（内容已被后继者换掉时不动）
      if (db !== null) db.close();
    }
  },
};

// ---------------------------------------------------------------- peak

export const peakCommand = {
  summary: '查看当前是否高峰与各模型倍率',
  usage: '用法：night-shift peak [--json]',
  async run(args, ctx) {
    const { values } = parseArgs({ args, options: { json: { type: 'boolean' } } });
    const now = systemClock(ctx.env)();
    const status = getStatus(now);
    // 各模型当前倍率：高峰取 peak、非高峰取 offPeak（MODEL_MULTIPLIERS 的键序即输出序）
    const multipliers = {};
    for (const [model, rates] of Object.entries(MODEL_MULTIPLIERS)) {
      multipliers[model] = status.peak ? rates.peak : rates.offPeak;
    }
    if (values.json) {
      ctx.stdout.write(`${JSON.stringify({
        peak: status.peak,
        now: now.toISOString(),
        nextChange: status.nextSwitch.toISOString(),
        multipliers,
      }, null, 2)}\n`);
      return 0;
    }
    const hours = Math.floor(status.msUntilSwitch / 3_600_000);
    const minutes = Math.floor((status.msUntilSwitch % 3_600_000) / 60_000);
    ctx.stdout.write([
      `现在：${status.peak ? '高峰' : '非高峰'}（北京时间 ${beijingWeekdayHM(now)}）`,
      `下次切换：${formatLocalMinute(status.nextSwitch.toISOString())} `
        + `变为${status.peak ? '非高峰' : '高峰'}（还有 ${hours} 小时 ${minutes} 分）`,
      `当前倍率：${Object.entries(multipliers).map(([model, x]) => `${model} ×${x}`).join('，')}`,
      '',
    ].join('\n'));
    return 0;
  },
};

// ---------------------------------------------------------------- usage

export const usageCommand = {
  summary: '查看额度用量（5 小时 / 每周）',
  usage: '用法：night-shift usage [--json]',
  async run(args, ctx) {
    const { values } = parseArgs({ args, options: { json: { type: 'boolean' } } });
    const now = systemClock(ctx.env)();
    const config = loadConfig({ home: resolveHome(ctx.env), env: ctx.env });
    const db = await openDbAt(ctx);
    let result;
    try {
      // 与调度器同口径：回看 7 天（周期窗口的左端点至多在 7 天前，够覆盖），上限 1 万条
      const runs = listRuns(db, {
        since: new Date(now.getTime() - 7 * 24 * 3_600_000),
        limit: 10_000,
      });
      result = quotaUsage(runs, now, { plan: config.plan, weekStart: config.weekStart });
    } finally {
      db.close();
    }
    if (values.json) {
      ctx.stdout.write(`${JSON.stringify({ plan: config.plan, ...result }, null, 2)}\n`);
      return 0;
    }
    const percent = (window) => `${(window.ratio * 100).toFixed(1)}%`;
    // 与调度器领任务前同一口径的预检（#82）：下一笔按 glm-5.3 当前时刻的倍率计
    // （调度器预检也固定用 glm-5.3，这里跟它同款），安全阈值用本次读到的
    // safetyRatio。不调 canStart——它五小时放不下就直接返回，看不见每周也放不下的
    // 情形；这里逐窗口独立判（比较与 quota.js 同款 1e-9 容差，恰好等于仍算放得下）。
    const nextCost = multiplierFor('glm-5.3', now);
    const overThreshold = (window) =>
      window.used + nextCost > window.limit * config.safetyRatio + 1e-9;
    // 五小时窗口里有运行才谈得上「最早的一笔恢复」；周期周额度总有重置时刻，
    // 滚动 7 天窗口（没配 weekStart）没有——按 issue 的两种文案区分。
    const fiveHourTail = result.fiveHour.resetsAt === null
      ? ''
      : `，最早的一笔在 ${formatLocalMinute(result.fiveHour.resetsAt.toISOString())} 恢复`;
    const weeklyTail = result.weekly.resetsAt === null
      ? '，滚动 7 天统计'
      : `，${formatLocalMinute(result.weekly.resetsAt.toISOString())} 重置`;
    ctx.stdout.write([
      `套餐：${config.plan}`,
      '额度是本地估算，不是官方账单。一次运行算 1 次 prompt，再乘模型倍率。',
      `5 小时：已用 ${result.fiveHour.used} / ${result.fiveHour.limit}（${percent(result.fiveHour)}）${fiveHourTail}`,
      `本周：已用 ${result.weekly.used} / ${result.weekly.limit}（${percent(result.weekly)}）${weeklyTail}`,
      ...(overThreshold(result.fiveHour) ? ['5 小时额度已达安全阈值'] : []),
      ...(overThreshold(result.weekly) ? ['每周额度已达安全阈值'] : []),
      '',
    ].join('\n'));
    return 0;
  },
};

// ---------------------------------------------------------------- logs

export const logsCommand = {
  summary: '查看任务某次运行的日志',
  usage: [
    '用法：night-shift logs <id> [--run <n>] [--follow]',
    `${USAGE_CONT}（--run 按开始时间数第 n 次，缺省最新一次；--follow 跟踪到该次运行结束）`,
  ].join('\n'),
  async run(args, ctx) {
    const { values, positionals } = parseArgs({
      args,
      options: { run: { type: 'string' }, follow: { type: 'boolean' } },
      allowPositionals: true,
    });
    const id = parseIdPositional(ctx, positionals, logsCommand.usage);
    let runNo; // 1 起，按开始时间数第几次运行；缺省最新一次
    if (values.run !== undefined) {
      if (!/^\d+$/.test(values.run) || Number(values.run) < 1) {
        throw new ctx.UsageError(`--run 必须是不小于 1 的整数（当前值：${values.run}）`, {
          usage: logsCommand.usage,
        });
      }
      runNo = Number(values.run);
    }

    const db = await openDbAt(ctx);
    try {
      if (getTask(db, id) === null) throw new NotFoundError(id);
      // listRuns 按开始时间倒序（新的在前）；反转成时间正序后第 n 项即第 n 次运行
      const ascending = [...listRuns(db, { taskId: id, limit: 1000 })].reverse();
      if (ascending.length === 0) {
        throw new Error(`任务 #${id} 还没有运行记录`);
      }
      const run = runNo === undefined ? ascending[ascending.length - 1] : ascending[runNo - 1];
      if (run === undefined) {
        throw new Error(`任务 #${id} 只有 ${ascending.length} 次运行，没有第 ${runNo} 次`);
      }
      if (run.logPath === '') {
        throw new Error(`任务 #${id} 第 ${(runNo ?? ascending.length)} 次运行没有日志文件路径`);
      }
      if (!values.follow) {
        let content;
        try {
          content = fs.readFileSync(run.logPath, 'utf8');
        } catch (err) {
          throw new Error(`无法读取日志文件 ${run.logPath}：${err.message}`);
        }
        ctx.stdout.write(content);
        return 0;
      }
      return await followLog(ctx, db, run);
    } finally {
      db.close();
    }
  },
};

/**
 * 跟踪一个 run 的日志文件：先打印已有内容，然后轮询文件新增字节并打印，直到该次
 * 运行在库里结束（finished_at 有值）且文件至少安静了一个轮询周期（收尾的「结束」
 * meta 行写在 finished_at 之后，只看 finished_at 会漏掉最后一两行）才退出 0。
 * 文件还没建出来（run 行先于日志文件产生）也不报错，等它出现即可。
 */
async function followLog(ctx, db, run) {
  let offset = 0; // 已打印到的字节位置
  const drain = () => {
    let size;
    try {
      size = fs.statSync(run.logPath).size;
    } catch {
      return; // 文件还没建出来
    }
    if (size < offset) offset = 0; // 文件被截断/轮转：从头重放
    if (size === offset) return;
    const fd = fs.openSync(run.logPath, 'r');
    try {
      const length = size - offset;
      const buffer = Buffer.alloc(length);
      fs.readSync(fd, buffer, 0, length, offset);
      ctx.stdout.write(buffer.toString('utf8'));
      offset = size;
    } finally {
      fs.closeSync(fd);
    }
  };
  drain();
  let finished = false;
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, FOLLOW_POLL_MS));
    const before = offset;
    drain();
    if (finished && offset === before) return 0; // 运行已结束且文件读完（安静了一个周期）
    try {
      if (getRun(db, run.id)?.finishedAt != null) finished = true;
    } catch {
      // 读库瞬时失败（别的一直在写）：下一轮再看，绝不因此提前退出
    }
  }
}

// ---------------------------------------------------------------- run-now

export const runNowCommand = {
  summary: '立刻执行一次任务（无视高峰与额度）',
  usage: '用法：night-shift run-now <id>',
  async run(args, ctx) {
    const { positionals } = parseArgs({ args, options: {}, allowPositionals: true });
    const id = parseIdPositional(ctx, positionals, runNowCommand.usage);
    const home = resolveHome(ctx.env);
    const config = loadConfig({ home, env: ctx.env });
    const clock = systemClock(ctx.env);
    ensureHome(home);
    const db = await openDbAt(ctx);
    const { createScheduler } = await import('../scheduler.js');
    const { runEvents } = await import('../runner.js');
    const scheduler = createScheduler({ db, config, home, clock, env: ctx.env });

    // 实时日志行：runner 的 runEvents 与调度器同进程，逐行打到终端（不带 ISO 时间戳，
    // 终端里 [stdout]/[meta] 前缀已够定位；完整时间戳看 `night-shift logs <id>`）。
    const onLog = ({ taskId, stream, line }) => {
      if (taskId !== id) return;
      ctx.stdout.write(`[${stream}] ${line}\n`);
    };
    runEvents.on('log', onLog);
    let task;
    try {
      task = await scheduler.runNow(id);
    } catch (err) {
      // 非 queued 的点名单独说明当前状态（issue 要求）；依赖未满足
      // （DependencyBlockedError，from 也是 queued）与任务不存在保留原始信息
      if (err instanceof InvalidTransitionError && !(err instanceof DependencyBlockedError)) {
        throw new Error(
          `任务 #${id} 当前状态是 ${err.from}，不是 queued；run-now 只执行排队中的任务`
          + '（失败/已取消的任务先用 retry 放回队列）',
        );
      }
      throw err;
    } finally {
      runEvents.off('log', onLog);
      db.close();
    }
    if (task.status === 'succeeded') {
      ctx.stdout.write(`#${id} 成功：${task.prUrl}\n`);
      return 0;
    }
    if (task.status === 'queued') {
      // 这次执行失败但还有尝试次数：任务已放回队列，交给 start 继续调度
      ctx.stdout.write(`#${id} 失败：${task.lastError ?? ''}（已放回队列）\n`);
      return 1;
    }
    if (task.status === 'canceled') {
      ctx.stdout.write(`#${id} 已取消${task.lastError === null ? '' : `：${task.lastError}`}\n`);
      return 1;
    }
    ctx.stdout.write(`#${id} 失败：${task.lastError ?? ''}\n`);
    return 1;
  },
};
