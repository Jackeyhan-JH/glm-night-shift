// serve-api 子命令（issue #14）：只起看板 HTTP 服务、不跑调度器（方便测试和单独看数据）。
// 命令对象形状见 bin/night-shift.mjs 的 COMMANDS 表：{ summary, usage, run(args, ctx) }。
//
// ⚠️ 本文件（及其静态依赖）不 import src/db.js / src/server.js：db.js 是唯一加载
// node:sqlite 的模块，必须在入口装好 SQLite 警告过滤之后再动态加载（见 src/warnings.js）。
import path from 'node:path';
import { parseArgs } from 'node:util';
import { systemClock } from '../clock.js';
import { ensureHome, loadConfig, resolveHome } from '../config.js';

export const serveCommand = {
  summary: '启动看板 HTTP 服务（不跑调度器）',
  usage: '用法：night-shift serve-api [--port <端口>]\n（--port 0 用随机端口；SIGINT/SIGTERM 正常退出 0）',
  async run(args, ctx) {
    const usage = serveCommand.usage;
    const { values } = parseArgs({ args, options: { port: { type: 'string' } } });
    let port;
    if (values.port !== undefined) {
      // 只收纯数字（用法错误，退出 2）；0 表示随机端口，其余须在 1～65535。
      if (!/^\d+$/.test(values.port)) {
        throw new ctx.UsageError(`--port 必须是 0～65535 的整数（当前值：${values.port}）`, { usage });
      }
      port = Number(values.port);
      if (port > 65535) {
        throw new ctx.UsageError(`--port 必须是 0～65535 的整数（当前值：${values.port}）`, { usage });
      }
    }

    const home = resolveHome(ctx.env);
    const config = loadConfig({ home, env: ctx.env }); // host/port/plan/weekStart/maxAttempts
    const clock = systemClock(ctx.env); // NIGHT_SHIFT_NOW 非法时这里抛错 → 退出 1
    ensureHome(home); // logs/ 等子目录（幂等）
    const listenPort = port ?? config.port; // --port 优先于配置

    // 动态 import：给警告过滤留出安装时间（同 task-commands.js 的 withDb）。
    const { openDb } = await import('../db.js');
    const { createServer } = await import('../server.js');
    const dbPath = path.join(home, 'night-shift.db');
    let db;
    try {
      db = openDb(dbPath);
    } catch (err) {
      throw new Error(`无法打开数据库 ${dbPath}：${err.message}`);
    }

    const server = createServer({ db, config, home, clock });
    return await new Promise((resolve, reject) => {
      const stop = (code, err) => {
        server.close();
        server.closeAllConnections(); // SSE 长连接不主动断，close() 的回调永远等不到
        db.close();
        if (err === undefined) resolve(code);
        else reject(err);
      };
      server.once('error', (err) => {
        if (err && err.code === 'EADDRINUSE') {
          ctx.stderr.write(`错误：端口 ${listenPort} 已被占用，请用 --port <端口> 换一个再试\n`);
          stop(1);
        } else {
          stop(undefined, err);
        }
      });
      server.listen(listenPort, config.host, () => {
        const { address, port: actual } = server.address();
        ctx.stdout.write(`看板 API：http://${address}:${actual}\n`);
      });
      // SIGINT/SIGTERM：关服务与数据库，正常退出 0；触发一次后摘掉监听，重复信号交给默认行为。
      const shutdown = () => {
        process.removeListener('SIGINT', shutdown);
        process.removeListener('SIGTERM', shutdown);
        stop(0);
      };
      process.once('SIGINT', shutdown);
      process.once('SIGTERM', shutdown);
    });
  },
};
