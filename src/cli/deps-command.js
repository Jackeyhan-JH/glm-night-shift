// deps 子命令（issue #11）：查看 / 修改任务依赖。命令对象形状见 bin/night-shift.mjs
// 的 COMMANDS 表：{ summary, usage, run(args, ctx) }。add 的 --depends-on 也复用这里
// 导出的 parseIdListOption——「逗号分隔的 id 列表怎么解析、什么算格式错误」属于依赖
// 功能自己的事，放在本模块；task-commands.js 单向依赖本文件，避免互相 import。
//
// ⚠️ 与 task-commands.js 同理：本文件（及其静态依赖）绝不能 import src/db.js——它是
// 唯一加载 node:sqlite 的模块，静态引入会让入口来不及先装 SQLite 警告过滤（时机说明
// 见 src/warnings.js）。openDb 一律走下面 withDb() 里的动态 import。tasks.js /
// config.js 不碰 node:sqlite，静态引入没问题。
import path from 'node:path';
import { parseArgs } from 'node:util';
import { resolveHome } from '../config.js';
import { NotFoundError, getTask, listDependencies, setDependencies } from '../tasks.js';

/** 多行用法里续行的缩进：对齐到「用法：night-shift 」之后的命令名。 */
const USAGE_CONT = ' '.repeat(15);

// withDb / parseIdPositional 与 task-commands.js 里的同名实现保持一致；不抽公共模块
// 是有意为之：并行的 issue（#13 模板等）各自加命令时互不牵连，共享件留给以后收敛。
/** 打开 <home>/night-shift.db 执行 fn，用完无论成败都关闭连接（同 task-commands.js）。 */
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

/** <id> 位置参数：恰好一个且为正整数，否则用法错误（同 task-commands.js）。 */
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
 * 解析 --depends-on / --set 的值：逗号分隔的任务 id，容忍空格（"1, 2"），空串 = 无依赖。
 * 任何一段不是正整数（abc、1,,x、0、-1）都是该命令的用法错误（退出码 2）；
 * id 是否存在 / 能不能依赖（退出码 1）留给存储层判断。
 * @returns {number[]} id 数组（保留原顺序，去重由存储层负责）
 */
export function parseIdListOption(ctx, raw, label, usage) {
  if (raw === '') return []; // 空串显式表示「无依赖」（--set "" 清空）
  const ids = [];
  for (const part of String(raw).split(',')) {
    const piece = part.trim();
    // Number.isSafeInteger 兜住超长数字串（1e20 级别的「id」直接算格式错误）
    if (!/^\d+$/.test(piece) || !Number.isSafeInteger(Number(piece)) || Number(piece) < 1) {
      throw new ctx.UsageError(
        `${label} 必须是逗号分隔的正整数 id（当前值：${raw}）`,
        { usage },
      );
    }
    ids.push(Number(piece));
  }
  return ids;
}

/** 依赖清单的展示串：`#1 queued，#3 succeeded`；无依赖返回 null（调用方给「无」）。 */
function formatDeps(deps) {
  return deps.length === 0 ? null : deps.map((d) => `#${d.id} ${d.status}`).join('，');
}

export const depsCommand = {
  summary: '查看或修改任务依赖',
  usage: [
    '用法：night-shift deps <id> [--set <id,id,…>]',
    `${USAGE_CONT}--set "" 清空依赖；不加 --set 只显示依赖和各自状态`,
  ].join('\n'),
  async run(args, ctx) {
    const { values, positionals } = parseArgs({
      args,
      options: { set: { type: 'string' } },
      allowPositionals: true,
    });
    const id = parseIdPositional(ctx, positionals, depsCommand.usage);
    // 不带 --set：只读展示（任务不存在是运行时错误，退出码 1）。
    if (values.set === undefined) {
      const deps = await withDb(ctx, (db) => {
        if (getTask(db, id) === null) throw new NotFoundError(id);
        return listDependencies(db, id);
      });
      ctx.stdout.write(`任务 #${id} 的依赖：${formatDeps(deps) ?? '无'}\n`);
      return 0;
    }
    const ids = parseIdListOption(ctx, values.set, '--set', depsCommand.usage);
    const deps = await withDb(ctx, (db) => {
      setDependencies(db, id, ids); // 校验失败 / 环 / 非 queued → 抛错，退出码 1
      return listDependencies(db, id); // 成功后读回新依赖与各自状态
    });
    const text = formatDeps(deps);
    ctx.stdout.write(text === null ? `#${id} 依赖已清空\n` : `#${id} 依赖已更新：${text}\n`);
    return 0;
  },
};
