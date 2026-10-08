import { isPeak } from './peak.js';

/** 各模型每次 prompt 的额度消耗系数（非高峰 / 高峰）。深层冻结，只能整表替换。 */
export const MODEL_MULTIPLIERS = deepFreeze({
  'glm-5.3': { offPeak: 1, peak: 3 },
  'glm-5.3-flash': { offPeak: 0.4, peak: 1.2 },
});

/** V2 套餐限额（单位：prompt，一次 `claude -p` 运行算 1 次 prompt）。深层冻结。 */
export const PLAN_LIMITS = deepFreeze({
  'v2-lite': { fiveHour: 80, weekly: 400 },
  'v2-pro': { fiveHour: 400, weekly: 2000 },
  'v2-max': { fiveHour: 1600, weekly: 8000 },
});

const MS_PER_HOUR = 60 * 60_000;
const MS_PER_WEEK = 7 * 24 * MS_PER_HOUR;
// 未知 / 缺失的模型名一律按 glm-5.3 的系数计（不抛错）
const DEFAULT_MODEL = 'glm-5.3';
// used + nextCost 与 limit × safetyRatio 比较时的浮点容差，防 0.4 × 3 这类噪声误判
const EPSILON = 1e-9;

/**
 * 某模型在某时刻每次 prompt 的额度系数。
 * 模型名去首尾空白、不区分大小写；未知或缺失的模型按 glm-5.3 计，不抛错。
 * @param {string} model
 * @param {Date|string|number} at - Date / ISO 字符串 / epoch 毫秒；缺失或无法解析抛 TypeError。
 * @returns {number}
 */
export function multiplierFor(model, at) {
  const key = typeof model === 'string' ? model.trim().toLowerCase() : '';
  const rates = MODEL_MULTIPLIERS[key] ?? MODEL_MULTIPLIERS[DEFAULT_MODEL];
  return isPeak(new Date(toTime(at, 'at'))) ? rates.peak : rates.offPeak;
}

/**
 * 一次运行要扣的额度：prompts × multiplierFor(model, startedAt)。
 * @param {{ model?: string, startedAt: Date|string|number, prompts?: number }} run
 * @returns {number}
 * @throws {TypeError} prompts 不是不小于 0 的有限数字（缺省按 1），或 startedAt 非法。
 */
export function runCost(run) {
  if (run === null || typeof run !== 'object') {
    throw new TypeError(`runCost 的参数必须是 { model, startedAt, prompts } 对象，收到：${describe(run)}`);
  }
  const prompts = run.prompts === undefined ? 1 : run.prompts;
  if (typeof prompts !== 'number' || !Number.isFinite(prompts) || prompts < 0) {
    throw new TypeError(`prompts 必须是不小于 0 的有限数字，收到：${describe(prompts)}`);
  }
  return prompts * multiplierFor(run.model, run.startedAt);
}

/**
 * 汇总一段运行记录在两个额度窗口内的用量。
 *
 * 时间入参（now、每条 run 的 startedAt、weekStart）都接受 Date、ISO 字符串
 * （数据库里存的就是 UTC ISO 字符串）或 epoch 毫秒；缺失或无法解析抛 TypeError，
 * 绝不悄悄当成「现在」或 NaN。
 *
 * 窗口口径（两项都不计 startedAt 晚于 now 的运行）：
 * - 五小时：startedAt 落在 (now − 5h, now] 内才计入；resetsAt = 窗口内最早一条的
 *   startedAt + 5h，窗口内没有运行时为 null。
 * - 每周：给了 weekStart（下单时间）就按它起每 7 天一个周期，当前周期为
 *   [cycleStart, now]（cycleStart 含边界），resetsAt = 当前周期结束时刻
 *   （cycleStart + 7d，与窗口内有没有运行无关）；now 早于 weekStart 时周期数 k
 *   为负，同样按 k = floor((now − weekStart) / 7d) 回溯到之前的周期，不抛错。
 *   没给 weekStart 就统计最近 7 天的滚动窗口 (now − 7d, now]，resetsAt 为 null。
 *
 * 每条运行：有 quotaUnits（非 null/undefined 的有限数字，可为 0）就直接采用，
 * 不再按倍率重算（与 prompts 同时给出时以 quotaUnits 为准）；否则按 runCost 现算。
 *
 * used 四舍五入到两位小数；ratio = used / limit；未知 plan 抛 Error 并点名该套餐。
 * resetsAt 恒为 Date 或 null。不修改任何入参。
 *
 * @param {Array<{ model?: string, startedAt: Date|string|number, prompts?: number, quotaUnits?: number }>} runs
 * @param {Date|string|number} now
 * @param {{ plan?: string, weekStart?: Date|string|number|null }} [options] - plan 缺省 'v2-max'；weekStart 缺省 null（滚动窗口）。
 * @returns {{ fiveHour: Window, weekly: Window }} 其中 Window 为 { used, limit, ratio, resetsAt }
 * @throws {TypeError} runs 不是数组、元素不是对象、quotaUnits / 时间入参非法。
 * @throws {Error} plan 不是已知套餐。
 */
export function usage(runs, now, options = {}) {
  if (!Array.isArray(runs)) {
    throw new TypeError(`runs 必须是运行记录数组，收到：${describe(runs)}`);
  }
  const nowTs = toTime(now, 'now');
  const plan = options.plan === undefined ? 'v2-max' : options.plan;
  const limits = PLAN_LIMITS[plan];
  if (limits === undefined) {
    throw new Error(`未知套餐 ${describe(plan)}，可选：${Object.keys(PLAN_LIMITS).join(' / ')}`);
  }
  const weekStartRaw = options.weekStart;
  const weekStartTs =
    weekStartRaw === null || weekStartRaw === undefined
      ? null
      : toTime(weekStartRaw, 'weekStart');

  const fiveHourFrom = nowTs - 5 * MS_PER_HOUR;
  let weeklyFrom; // 周窗口左端点
  let weeklyInclusive; // 周期窗口左端点含边界；滚动窗口不含（与五小时窗口同为左开右闭）
  let weeklyResetsAt = null;
  if (weekStartTs === null) {
    weeklyFrom = nowTs - MS_PER_WEEK;
    weeklyInclusive = false;
  } else {
    const cycleIndex = Math.floor((nowTs - weekStartTs) / MS_PER_WEEK);
    weeklyFrom = weekStartTs + cycleIndex * MS_PER_WEEK;
    weeklyInclusive = true;
    weeklyResetsAt = weeklyFrom + MS_PER_WEEK;
  }

  let fiveHourSum = 0;
  let fiveHourEarliest = null; // 五小时窗口内最早一条的 startedAt
  let weeklySum = 0;
  for (const run of runs) {
    if (run === null || typeof run !== 'object') {
      throw new TypeError(`runs 的每一项必须是 { model, startedAt, prompts?, quotaUnits? } 对象，收到：${describe(run)}`);
    }
    const startedTs = toTime(run.startedAt, 'startedAt');
    if (startedTs > nowTs) continue; // 开始时刻在 now 之后的运行不计入任何窗口
    const cost = costOf(run);
    if (startedTs > fiveHourFrom) {
      fiveHourSum += cost;
      if (fiveHourEarliest === null || startedTs < fiveHourEarliest) fiveHourEarliest = startedTs;
    }
    if (weeklyInclusive ? startedTs >= weeklyFrom : startedTs > weeklyFrom) {
      weeklySum += cost;
    }
  }

  const fiveHourUsed = round2(fiveHourSum);
  const weeklyUsed = round2(weeklySum);
  return {
    fiveHour: {
      used: fiveHourUsed,
      limit: limits.fiveHour,
      ratio: fiveHourUsed / limits.fiveHour,
      resetsAt:
        fiveHourEarliest === null ? null : new Date(fiveHourEarliest + 5 * MS_PER_HOUR),
    },
    weekly: {
      used: weeklyUsed,
      limit: limits.weekly,
      ratio: weeklyUsed / limits.weekly,
      resetsAt: weeklyResetsAt === null ? null : new Date(weeklyResetsAt),
    },
  };
}

/**
 * 还能不能开一个预计花费 nextCost 的新运行。
 * 五小时与每周两项都要满足 used + nextCost ≤ limit × safetyRatio（比较带 1e-9 容差，
 * 恰好等于也放行）；先查五小时再查每周，两项都超时报 'five-hour'。
 * safetyRatio 只做类型校验（不小于 0 的有限数字），取值 > 1 会允许超出套餐限额，
 * 由调用方自担；缺省 0.9。成功返回 { ok: true }，不修改入参。
 * @param {{ fiveHour: Window, weekly: Window }} usageResult - usage() 的返回值。
 * @param {{ nextCost?: number, safetyRatio?: number }} [options]
 * @returns {{ ok: true } | { ok: false, reason: 'five-hour' | 'weekly', resetsAt: Date | null }}
 * @throws {TypeError} nextCost / safetyRatio / usageResult 形状非法。
 */
export function canStart(usageResult, { nextCost, safetyRatio = 0.9 } = {}) {
  if (typeof nextCost !== 'number' || !Number.isFinite(nextCost) || nextCost < 0) {
    throw new TypeError(`nextCost 必须是不小于 0 的有限数字，收到：${describe(nextCost)}`);
  }
  if (typeof safetyRatio !== 'number' || !Number.isFinite(safetyRatio) || safetyRatio < 0) {
    throw new TypeError(`safetyRatio 必须是不小于 0 的有限数字，收到：${describe(safetyRatio)}`);
  }
  if (usageResult === null || typeof usageResult !== 'object') {
    throw new TypeError(`usageResult 必须是 usage() 的返回结果对象，收到：${describe(usageResult)}`);
  }
  for (const key of ['fiveHour', 'weekly']) {
    if (usageResult[key] === null || typeof usageResult[key] !== 'object') {
      throw new TypeError(`usageResult.${key} 缺失或不是对象，收到：${describe(usageResult[key])}`);
    }
  }

  const fits = (window) => window.used + nextCost <= window.limit * safetyRatio + EPSILON;
  if (!fits(usageResult.fiveHour)) {
    return { ok: false, reason: 'five-hour', resetsAt: usageResult.fiveHour.resetsAt };
  }
  if (!fits(usageResult.weekly)) {
    return { ok: false, reason: 'weekly', resetsAt: usageResult.weekly.resetsAt };
  }
  return { ok: true };
}

/** 单条运行记录的扣减量：quotaUnits 优先，否则 runCost 现算。 */
function costOf(run) {
  const units = run.quotaUnits;
  if (units !== null && units !== undefined) {
    if (typeof units !== 'number' || !Number.isFinite(units) || units < 0) {
      throw new TypeError(`quotaUnits 必须是不小于 0 的有限数字，收到：${describe(units)}`);
    }
    return units;
  }
  return runCost(run);
}

/** 时间入参统一成 epoch 毫秒；Date / ISO 字符串 / epoch 毫秒之外的值（含缺失、Invalid Date）抛 TypeError。 */
function toTime(value, name) {
  let ts = NaN;
  if (value instanceof Date) ts = value.getTime();
  else if (typeof value === 'string') ts = Date.parse(value);
  else if (typeof value === 'number') ts = value;
  if (!Number.isFinite(ts)) {
    throw new TypeError(`时间参数 ${name} 必须是 Date、ISO 字符串或 epoch 毫秒，收到：${describe(value)}`);
  }
  return ts;
}

/** 错误信息里展示任意收到的值（字符串带引号，循环引用等兜底为 String()）。 */
function describe(value) {
  try {
    const json = JSON.stringify(value);
    if (json !== undefined) return json;
  } catch {
    // 循环引用、Symbol 等，落到 String() 兜底
  }
  return String(value);
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
