// 系统时钟（issue #9；#10 命令行、#14 服务也会用）。约定见 #1：需要「现在」的代码
// 一律通过注入的 clock 函数拿时间，端到端/调度测试靠 NIGHT_SHIFT_NOW 模拟高峰等时刻，
// 不用真等墙钟。生产代码用缺省的 systemClock()（即真实当前时间）。

/**
 * 造一个时钟函数（约定：每次调用返回一个**新的** Date，调用方改返回值不影响后续读取）。
 * - `env.NIGHT_SHIFT_NOW` 设了合法时间（ISO 字符串，仅测试用）→ 总是返回该时刻；
 * - 未设置或为空串 → 总是返回 `new Date()`（真实当前时间）。
 * 非法值（Date.parse 解析不了）在**调用 systemClock() 时**立刻抛错，而不是等第一次
 * 取时才在无关代码深处炸出来；错误信息里带变量名和原始值。
 * @param {object} [env=process.env] 读 NIGHT_SHIFT_NOW 的环境变量对象
 * @returns {() => Date} 时钟函数
 * @throws {Error} NIGHT_SHIFT_NOW 设了但不是合法时间
 */
export function systemClock(env = process.env) {
  const raw = env === null || env === undefined ? undefined : env.NIGHT_SHIFT_NOW;
  if (raw === undefined || raw === '') return () => new Date();
  const ts = Date.parse(raw);
  if (Number.isNaN(ts)) {
    throw new Error(`环境变量 NIGHT_SHIFT_NOW 必须是能解析的 ISO 时间，当前值：${JSON.stringify(raw)}`);
  }
  return () => new Date(ts);
}
