// 测试用时钟（约定见 #9 / #1 评论）：所有读「当前时间」的代码（CLI、服务、调度器、
// e2e）都从这里取，测试用环境变量 NIGHT_SHIFT_NOW 把时间固定住来模拟高峰 / 跨天。
//
// 约定：
// - systemClock(env) 返回一个函数（下称 clock），每次调用返回「当前时刻」的 Date。
// - env.NIGHT_SHIFT_NOW 设置了（非空字符串）时，clock 恒返回那个时刻——但每次调用
//   都 new 一个新的 Date（调用方改其中一个不会污染后续读取）。
// - 没设置时，clock 每次返回 new Date()（真实系统时间）。
// - NIGHT_SHIFT_NOW 给了却不是合法时间：抛带变量名的中文错误，绝不悄悄回退到
//   真实时间（那是测试想要固定时间却写错格式的 bug，必须当场暴露）。

/**
 * 造一个时钟函数。NIGHT_SHIFT_NOW 固定时间，否则跟随系统时间。
 * @param {object} [env=process.env] 读 NIGHT_SHIFT_NOW 的环境对象（测试可注入）。
 * @returns {() => Date} 每次调用返回当前时刻（或 NIGHT_SHIFT_NOW 指定的时刻）的新 Date。
 */
export function systemClock(env = process.env) {
  const fixedRaw = env === null || typeof env !== 'object' ? undefined : env.NIGHT_SHIFT_NOW;
  if (fixedRaw === undefined || fixedRaw === '') {
    return () => new Date();
  }
  const fixedMs = Date.parse(fixedRaw);
  if (Number.isNaN(fixedMs)) {
    throw new Error(
      `环境变量 NIGHT_SHIFT_NOW 必须是合法的时间字符串（当前值：${fixedRaw}），`
        + '例如 2026-10-08T07:00:00Z',
    );
  }
  return () => new Date(fixedMs);
}
