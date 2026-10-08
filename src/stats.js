// 用量统计的纯函数（issue #14）。给看板的额度页 / `/api/usage/history` 用：
// 把一段运行按 UTC 整点小时汇总。不碰 IO、不碰 DOM，单测见 test/stats.test.js。
import { runCost, toDate } from './quota.js';

const MS_PER_HOUR = 60 * 60_000;
/** days 的合法范围（与 API 的校验一致：`/api/usage/history?days=1..30`）。 */
export const HISTORY_DAYS_MIN = 1;
export const HISTORY_DAYS_MAX = 30;

/**
 * 按 UTC 整点小时汇总额度用量。
 *
 * 窗口口径（文档化抉择）：桶是截止到 now 所在小时的 `days × 24` 个 **UTC 整点小时**——
 * 最后一桶是包含 now 的那个小时（floorHour(now)），第一桶 = floorHour(now) − (days·24−1)h。
 * 统计 startedAt 落在 [第一桶起点, now] 内（两端都含；晚于 now 的运行不计，与
 * quota.usage 同口径）的运行。选「整点对齐的窗口」而不是「now 往前精确 days 天」，
 * 是为了让同一小时内创建的运行总是落进同一个桶、桶边界与返回的 hour 标签一致，
 * 页面画图时 x 轴也自然对齐整点。
 *
 * 每条运行的扣减量与 quota.usage 同规则：quotaUnits 非 null/undefined 的有限数字时
 * 直接采用，否则按 runCost（prompts × 开始时刻的倍率）现算。byModel 按运行自己的
 * model 字符串原样分组（不归一化大小写——展示分组，不是计费）。
 *
 * @param {Array<{ model?: string, startedAt: Date|string|number, prompts?: number, quotaUnits?: number }>} runs
 *   运行记录（如 listRuns 的结果）。
 * @param {Date|string|number} now 统计基准时刻。
 * @param {number} days 天数，1～30 的整数。
 * @returns {{ from: string, to: string, buckets: Array<{ hour: string, byModel: Record<string, number>, total: number }> }}
 *   from = 第一桶起点的 UTC ISO（= buckets[0].hour），to = now 的 UTC ISO；
 *   buckets 恒有 days × 24 项、按时间升序，没运行的小时也有 total: 0；
 *   byModel 的值与 total 都四舍五入到 2 位小数。不修改入参。
 * @throws {TypeError} runs 不是数组 / 元素不是对象、时间入参非法、days 不是 1～30 的整数。
 */
export function hourlyUsage(runs, now, days) {
  if (!Array.isArray(runs)) {
    throw new TypeError(`runs 必须是运行记录数组，收到：${describe(runs)}`);
  }
  if (!Number.isInteger(days) || days < HISTORY_DAYS_MIN || days > HISTORY_DAYS_MAX) {
    throw new TypeError(`days 必须是 ${HISTORY_DAYS_MIN}～${HISTORY_DAYS_MAX} 的整数，收到：${describe(days)}`);
  }
  const nowDate = toDate(now, 'now');
  const nowTs = nowDate.getTime();
  const bucketMs = MS_PER_HOUR;
  const lastBucketStart = Math.floor(nowTs / bucketMs) * bucketMs;
  const bucketCount = days * 24;
  const fromTs = lastBucketStart - (bucketCount - 1) * bucketMs;

  // 先按桶下标累加，最后一次性补齐空桶，保证没有运行的小时也在结果里。
  const sums = new Map(); // bucketIndex -> { byModel: Map, total }
  for (const run of runs) {
    if (run === null || typeof run !== 'object') {
      throw new TypeError(`runs 的每一项必须是 { model, startedAt, prompts?, quotaUnits? } 对象，收到：${describe(run)}`);
    }
    const startedTs = toDate(run.startedAt, 'startedAt').getTime();
    if (startedTs < fromTs || startedTs > nowTs) continue; // 窗口外 / 晚于 now 的不计
    const index = Math.floor((startedTs - fromTs) / bucketMs);
    let entry = sums.get(index);
    if (entry === undefined) {
      entry = { byModel: new Map(), total: 0 };
      sums.set(index, entry);
    }
    const cost = costOf(run);
    const model = run.model === undefined || run.model === null ? '' : String(run.model);
    entry.byModel.set(model, round2((entry.byModel.get(model) ?? 0) + cost));
    entry.total += cost;
  }

  const buckets = [];
  for (let i = 0; i < bucketCount; i++) {
    const entry = sums.get(i);
    const byModel = {};
    if (entry !== undefined) {
      for (const [model, units] of entry.byModel) byModel[model] = units;
    }
    buckets.push({
      hour: new Date(fromTs + i * bucketMs).toISOString(),
      byModel,
      total: entry === undefined ? 0 : round2(entry.total),
    });
  }
  return { from: new Date(fromTs).toISOString(), to: nowDate.toISOString(), buckets };
}

/** 单条运行记录的扣减量：quotaUnits 优先，否则 runCost 现算（与 quota.usage 同规则）。 */
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

function round2(value) {
  return Math.round(value * 100) / 100;
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
