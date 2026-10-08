import { isPeak, getStatus } from './peak.js';
import { runCost, canStart, toDate } from './quota.js';

/**
 * 调度前的统一闸门：综合高峰判断与额度计算，回答「现在能不能开始一个新运行」。
 *
 * 判定顺序：先高峰、后额度。
 * 1. peak = isPeak(now)；nextCost = runCost({ model, startedAt: now })。
 * 2. 高峰且任务（allowPeak）与全局配置（configAllowPeak）都不允许高峰时直接拦下，
 *    retryAt 为本次高峰的结束时刻（getStatus(now).nextSwitch；周五 18:00 之后会
 *    跳到下周一 14:00 北京时间）。
 * 3. 否则交给 canStart 按额度判断；超了 reason 为 'five-hour' / 'weekly'，retryAt
 *    为对应窗口的 resetsAt（滚动周窗口没有 resetsAt，此时为 null）。
 *
 * @param {object} decision
 * @param {Date|string|number} decision.now - 判定时刻（Date / ISO 字符串 / epoch 毫秒；非法抛 TypeError）。
 * @param {string} decision.model - 即将使用的模型；未知 / 缺失按 glm-5.3 计。
 * @param {boolean} [decision.allowPeak] - 该任务是否允许在高峰期运行；缺省视为 false。
 * @param {boolean} [decision.configAllowPeak] - 全局配置是否允许高峰期运行；缺省视为 false。
 * @param {{ fiveHour: object, weekly: object }} decision.usage - usage() 的返回值。
 * @param {number} [decision.safetyRatio] - 原样传给 canStart，缺省 0.9。
 * @returns {{ ok: boolean, reason: 'peak' | 'five-hour' | 'weekly' | null, nextCost: number, peak: boolean, retryAt: Date | null }}
 *   五个字段恒有：
 *   - ok - 能否开始；
 *   - reason - 拦截原因（放行为 null）；
 *   - nextCost - 本次运行的预计扣减，单位 prompt（被高峰拦下时也照常计算，供展示）；
 *   - peak - now 是否高峰；
 *   - retryAt - 最早可再试时刻（放行为 null）。
 * @throws {TypeError} now 非法，或 usage / nextCost / safetyRatio 不满足 canStart 的要求。
 */
export function startDecision({ now, model, allowPeak, configAllowPeak, usage: usageResult, safetyRatio }) {
  const nowDate = toDate(now, 'now');
  const peak = isPeak(nowDate);
  const nextCost = runCost({ model, startedAt: nowDate });

  if (peak && !allowPeak && !configAllowPeak) {
    return {
      ok: false,
      reason: 'peak',
      nextCost,
      peak,
      retryAt: getStatus(nowDate).nextSwitch,
    };
  }

  const decision = canStart(usageResult, { nextCost, safetyRatio });
  if (decision.ok) {
    return { ok: true, reason: null, nextCost, peak, retryAt: null };
  }
  return { ok: false, reason: decision.reason, nextCost, peak, retryAt: decision.resetsAt };
}
