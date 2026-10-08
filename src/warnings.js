// 只屏蔽 node:sqlite 在 Node 22（22.13～23）上打印的那一条实验性警告：
//   ExperimentalWarning: SQLite is an experimental feature and might change at any time
// 其他警告——包括别的 ExperimentalWarning——一律照常输出。这是产品规格的硬性要求
//（#5 产品评论：只屏蔽这一条），所以不能用 --disable-warning=ExperimentalWarning，
// 那会把所有实验性警告都藏掉。
//
// 时机很关键（在 Node 22.13 上实测）：node:sqlite 在模块求值时就发出这条警告，并且
// 捕获的是「当时」的 process.emitWarning 引用。因此过滤必须在 node:sqlite 第一次
// 求值之前装好：入口（bin/night-shift.mjs）先静态引入本模块并调用
// installSqliteWarningFilter()，而 src/db.js（唯一 import node:sqlite 的模块）只能在
// 使用处动态 import。静态 import db.js 时警告捕获先于任何模块体执行，事后补装过滤
// 已经拦不住。Node 24 不再发这条警告，过滤是无害的空操作。
//
// 单元测试见 test/warnings.test.js；Node 22 下的端到端验证见 test/cli.test.js。

/** 是否为要屏蔽的 SQLite 实验性警告：类型 ExperimentalWarning 且消息提到 SQLite。 */
export function isSqliteExperimentalWarning(message, name) {
  return name === 'ExperimentalWarning' && /sqlite/i.test(message ?? '');
}

const patchedTargets = new WeakSet();

/**
 * 给 target（默认 process）装过滤：把 emitWarning 包一层，SQLite 那条实验性警告直接
 * 吞掉，其余原样转发（参数与返回值都不动）。幂等：同一 target 重复安装无副作用。
 * @param {{emitWarning: Function}} [target=process] 通常是 process；测试里传假对象。
 */
export function installSqliteWarningFilter(target = process) {
  if (target === null || typeof target !== 'object') return;
  if (patchedTargets.has(target)) return;
  const original = target.emitWarning;
  if (typeof original !== 'function') return;
  patchedTargets.add(target);
  target.emitWarning = function emitWarningExceptSqliteExperimental(warning, ...rest) {
    if (isSqliteExperimentalWarning(warningMessage(warning), warningName(warning, rest))) {
      return undefined; // 只吞这一条，别的什么都不改
    }
    return original.call(this, warning, ...rest);
  };
}

// process.emitWarning(warning[, type[, code]][, ctor]) 或 (warning, options)：
// 消息取字符串本身或 Error.message；类型在第二参数是字符串时取它、是对象时取
// options.type、传 Error 时取 error.name，都没有则是普通 'Warning'。
function warningMessage(warning) {
  if (typeof warning === 'string') return warning;
  if (warning !== null && typeof warning === 'object' && typeof warning.message === 'string') {
    return warning.message;
  }
  return '';
}

function warningName(warning, rest) {
  const second = rest[0];
  if (typeof second === 'string') return second;
  if (second !== null && typeof second === 'object' && typeof second.type === 'string') {
    return second.type;
  }
  if (warning instanceof Error && typeof warning.name === 'string') return warning.name;
  return undefined;
}
