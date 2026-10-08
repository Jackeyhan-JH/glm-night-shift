import { isPeak, getStatus } from './peak.js';
import { runCost, canStart } from './quota.js';

/**
 * 调度前的统一闸门：综合高峰判断与额度计算，回答「现在能不能开始一个新运行」。
 *
 * 流程：peak = isPeak(now)；nextCost = runCost({ model, startedAt: now })。
 * 高峰且任务（allowPeak）与全局配置（configAllowPeak）都不允许高峰时直接拦下，
 * retryAt 为本次高峰的结束时刻（getStatus(now).nextSwitch，周五 18:00 后会跳到
 * 下周一 14:00 北京时间）；否则交给 canStart 按额度判断，超了就带上对应窗口的
 * resetsAt（可能为 null）作为 retryAt。allowPeak / configAllowPeak 缺省都视为不允许。
 *
 * @param {object} decision
 * @param {Date|string|number} decision.now - 判定时刻（Date / ISO 字符串 / epoch 毫秒）。
 * @param {string} decision.model - 即将使用的模型；未知模型按 glm-5.3 计。
 * @param {boolean} [decision.allowPeak] - 该任务是否允许在高峰期运行。
 * @param {boolean} [decision.configAllowPeak] - 全局配置是否允许高峰期运行。
 * @param {object} decision.usage - usage() 的返回值（fiveHour / weekly 两窗口）。
 * @param {number} [decision.safetyRatio] - 原样传给 canStart，缺省 0.9。
 * @returns {{ ok: boolean, reason: 'peak' | 'five-hour' | 'weekly' | null, nextCost: number, peak: boolean, retryAt: Date | null }}
 *   五个字段恒有：reason 为 null 表示放行；retryAt 为 null 表示无需等待
 *   （或该窗口没有 resetsAt）。nextCost / peak 恒返回，供调用方记账与展示。
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

// 与 quota.js 的时间入参约定保持一致（Date / ISO 字符串 / epoch 毫秒；非法抛
// TypeError）。quota.js 不导出这个私有助手（保持 issue 规定的 API 面），这里放一份等价实现。
function toDate(value, name) {
  let ts = NaN;
  if (value instanceof Date) ts = value.getTime();
  else if (typeof value === 'string') ts = Date.parse(value);
  else if (typeof value === 'number') ts = value;
  if (!Number.isFinite(ts)) {
    throw new TypeError(`时间参数 ${name} 必须是 Date、ISO 字符串或 epoch 毫秒，收到：${String(value)}`);
  }
  return new Date(ts);
}
