// serve 子命令（issue #18）：同一个进程里跑调度器（#9）+ 看板 HTTP 服务（#14），
// 日常使用只需要这一条命令。与 serve-api（只看板、不调度）分开实现，各自保持简单。
//
// 启动顺序（保证端口冲突不会留下「只有调度器在跑」的半启动状态）：
//   拿调度器锁 → 建服务并 listen（此时还不 start 调度器）→ 监听成功才 start 调度器。
// 端口被占用：退出 1、提示换端口，调度器从未启动、任务没被领取。
//
// ⚠️ 本文件（及其静态依赖）不 import src/db.js / src/server.js / src/scheduler.js：
// db.js 是唯一加载 node:sqlite 的模块，必须在入口装好 SQLite 警告过滤之后再动态加载
// （见 src/warnings.js）。config.js / clock.js / scheduler-lock.js / scheduler-log.js
// 不碰 node:sqlite，可以静态引入。
import path from 'node:path';
import { parseArgs } from 'node:util';
import { systemClock } from '../clock.js';
import { ensureHome, loadConfig, resolveHome } from '../config.js';
import { acquireSchedulerLock } from '../scheduler-lock.js';
import { attachSchedulerLog } from './scheduler-log.js';

/** 视为「只听本机」的 host：这些不触发看板无登录的安全警告。 */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);
/** 多行用法里续行的缩进：对齐到「用法：night-shift 」之后的命令名（与其他 cli 模块一致）。 */
const USAGE_CONT = ' '.repeat(15);

export const serveRunCommand = {
  summary: '一键启动调度器与网页看板',
  usage: [
    '用法：night-shift serve [--port <端口>]',
    `${USAGE_CONT}（--port 0 用随机端口；Ctrl-C / SIGTERM 一次优雅停止，再按一次强制停止）`,
  ].join('\n'),
  async run(args, ctx) {
    const usage = serveRunCommand.usage;
    const { values } = parseArgs({ args, options: { port: { type: 'string' } } });
    let port;
    if (values.port !== undefined) {
      // 与 serve-api 同一套规则：只收纯数字（用法错误，退出 2）；0 表示随机端口。
      if (!/^\d+$/.test(values.port)) {
        throw new ctx.UsageError(`--port 必须是 0～65535 的整数（当前值：${values.port}）`, { usage });
      }
      port = Number(values.port);
      if (port > 65535) {
        throw new ctx.UsageError(`--port 必须是 0～65535 的整数（当前值：${values.port}）`, { usage });
      }
    }

    const home = resolveHome(ctx.env);
    const config = loadConfig({ home, env: ctx.env }); // host/port/concurrency/pollSeconds…
    const clock = systemClock(ctx.env); // NIGHT_SHIFT_NOW 非法时这里抛错 → 退出 1
    ensureHome(home); // logs/ 等子目录（幂等）
    const listenPort = port ?? config.port; // --port 优先于配置

    // 1. 调度器锁：一个数据目录同一时刻只允许一个调度器进程（#18 产品评论）。
    //    被别的 serve / start 持有时抛错 → 退出 1，不建 HTTP、不领任务。
    const lock = acquireSchedulerLock(home);
    const say = (line) => ctx.stdout.write(`${line}\n`);
    let db = null;
    let server = null;
    try {
      // 动态 import：给警告过滤留出安装时间（同 serve-command.js）。
      const { openDb } = await import('../db.js');
      const { createServer } = await import('../server.js');
      const { createScheduler } = await import('../scheduler.js');
      const dbPath = path.join(home, 'night-shift.db');
      try {
        db = openDb(dbPath);
      } catch (err) {
        throw new Error(`无法打开数据库 ${dbPath}：${err.message}`);
      }

      const scheduler = createScheduler({ db, config, home, clock, env: ctx.env });
      // 调度事件行与 start 完全一致（同一份实现，见 scheduler-log.js）
      attachSchedulerLog(scheduler, { db, clock, write: (line) => ctx.stdout.write(line) });
      server = createServer({ db, config, home, clock, scheduler });

      let forced = false; // 是否收到过第二次信号（强制停止）
      const code = await new Promise((resolve, reject) => {
        const stop = (exitCode, err) => {
          if (err !== undefined) reject(err);
          else resolve(exitCode);
        };
        server.once('error', (err) => {
          if (err && err.code === 'EADDRINUSE') {
            // 调度器从未 start（顺序保证）：不会有半启动状态；锁与库交给外层 finally 收。
            ctx.stderr.write(`错误：端口 ${listenPort} 被占用，可用 --port 或配置 port 修改\n`);
            stop(1);
            return;
          }
          stop(undefined, err);
        });
        // 2. 先 listen、后 start 调度器（见文件头说明）。
        server.listen(listenPort, config.host, () => {
          try {
            // 信号协议与 start 相同：第一次优雅（先关监听、等运行中任务，存量 SSE 不掐），
            // 第二次强制。两次都在收尾完成后退出 0。处理器先于任何启动输出安装——
            // 启动行一旦被读端看见，紧跟着的 SIGINT 必须已经能走优雅停止（见 start 的说明）。
            let stopRequested = false;
            const finish = () => {
              process.removeListener('SIGINT', onSignal);
              process.removeListener('SIGTERM', onSignal);
              resolve(0);
            };
            const requestStop = (force) => {
              if (force) forced = true;
              // stop() 的 Promise 在全部任务收尾后 resolve；拒绝也按完成处理（同 start）。
              scheduler.stop({ force }).then(finish, finish);
            };
            const onSignal = () => {
              if (stopRequested) {
                say('强制停止…');
                requestStop(true);
                return;
              }
              stopRequested = true;
              server.close(); // 端口不再收新连接；已建立的连接（含 SSE）不主动断
              const running = scheduler.status().running;
              if (running.length === 0) {
                requestStop(false); // 没有运行中的任务：直接收尾退出
                return;
              }
              say(`正在停止：不再领取新任务，等待 ${running.length} 个运行中的任务结束（再按 Ctrl-C 强制停止）`);
              requestStop(false);
            };
            process.on('SIGINT', onSignal);
            process.on('SIGTERM', onSignal);

            const { port: actualPort } = server.address();
            if (!LOOPBACK_HOSTS.has(config.host)) {
              ctx.stderr.write(
                `安全警告：看板正在监听 ${config.host}，而看板没有任何登录保护——`
                  + '任何能访问该地址的人都能提交任务、查看数据。'
                  + '如非必要请把配置 host 改回 127.0.0.1。\n',
              );
            }
            say(`GLM 夜班已启动：看板 http://${bannerHost(config.host)}:${actualPort}，`
              + `并发 ${config.concurrency}，数据目录 ${home}`);
            scheduler.start();
          } catch (err) {
            stop(undefined, err); // 监听回调里的意外（如启动恢复读库失败）走统一错误路径
          }
        });
      });
      if (code !== 0) return code;

      // 3. 正常收尾（优雅与强制都在调度器 stop 之后到这）：清剩余连接、释放锁、关库，
      //    然后显式退出——空闲的 keep-alive 连接 / 还在等的 SSE 会拖住事件循环，
      //    不退的话「Ctrl-C 后 3 秒内退出」就没了保障。
      if (forced) server.closeAllConnections(); // 强制路径：掐掉剩余连接好让进程退干净
      lock.release();
      db.close();
      db = null;
      // 真实入口（stdout 是 process.stdout）才硬退出；进程内调用（runCli + 收集 sink）
      // 返回退出码交给调用方处理。
      if (ctx.stdout === process.stdout) exitAfterDrain(0);
      return 0;
    } finally {
      // 异常路径兜底：监听着的 socket 会拖住事件循环（进程挂着不退），必须关掉；
      // 幂等——正常路径里要么已在信号处理中 close，要么进程即将硬退出。
      if (server !== null && server.listening) server.close();
      lock.release(); // EADDRINUSE / 异常路径：删自己的锁（已是别人的锁则不动）
      if (db !== null) db.close();
    }
  },
};

/** 看板地址里展示的 host：回环统一印 127.0.0.1（issue 原文的写法），其余用配置值。 */
function bannerHost(host) {
  if (host === '::1') return '[::1]';
  if (LOOPBACK_HOSTS.has(host)) return '127.0.0.1';
  return host;
}

/**
 * 以 code 直接退出。process.exit 可能丢弃流缓冲里未写出的数据，先等 stdout 写空再退
 * （serve 是长驻进程的入口，收尾输出必须完整落到终端/管道里）。
 */
function exitAfterDrain(code) {
  const exit = () => process.exit(code);
  const stdout = process.stdout;
  if (stdout !== null && typeof stdout.write === 'function' && !stdout.destroyed) {
    stdout.write('', exit); // 空块排在已有缓冲之后：回调触发时缓冲已冲刷
    return;
  }
  exit();
}
