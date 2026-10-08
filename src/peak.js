/*
 * 本文件逐字节复制自 Jackeyhan-JH/glm-peak-clock 仓库的 src/peak.js
 * （main 分支 commit 6b2b937，
 *   https://github.com/Jackeyhan-JH/glm-peak-clock/blob/main/src/peak.js）。
 * 除本注释块外与上游完全一致：请勿在本仓库内修改；上游更新时应整体重新复制，
 * 并同步更新上面的 commit 号。
 */

/**
 * GLM Coding Plan 高峰期核心逻辑（纯函数、零依赖）。
 *
 * 规则只写在下方 RULES 一处：高峰为北京时间（固定 UTC+8，无夏令时）
 * 周一至周五 14:00～18:00，区间左闭右开；周末全天非高峰。
 * 浏览器和 Node 18+ 均可直接加载本模块。
 */

/** 高峰规则；分钟数按北京日历日内计算，星期取值同 Date#getDay（周日为 0）。 */
export const RULES = {
  tzOffsetMinutes: 480,
  peakDays: [1, 2, 3, 4, 5],
  peakStartMinutes: 840, // 14:00
  peakEndMinutes: 1080, // 18:00
};

const MS_PER_MINUTE = 60_000;

/** 把时刻拆成「北京日历日 + 当天已过的毫秒数」，只用固定偏移换算。 */
function beijingParts(ts) {
  const shifted = new Date(ts + RULES.tzOffsetMinutes * MS_PER_MINUTE);
  const msOfDay =
    ((shifted.getUTCHours() * 60 + shifted.getUTCMinutes()) * 60 +
      shifted.getUTCSeconds()) *
      1000 +
    shifted.getUTCMilliseconds();
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth(),
    day: shifted.getUTCDate(),
    weekday: shifted.getUTCDay(),
    msOfDay,
  };
}

/** 某个北京日历日的高峰区间，返回绝对时间戳（毫秒）。 */
function windowOfUtcDay(year, month, day) {
  const dayStartUtcMs =
    Date.UTC(year, month, day) - RULES.tzOffsetMinutes * MS_PER_MINUTE;
  return {
    start: dayStartUtcMs + RULES.peakStartMinutes * MS_PER_MINUTE,
    end: dayStartUtcMs + RULES.peakEndMinutes * MS_PER_MINUTE,
  };
}

function isPeakWeekday(weekday) {
  return RULES.peakDays.includes(weekday);
}

/**
 * 判断某时刻是否处于高峰期。
 * 区间左闭右开：14:00:00 算高峰，18:00:00 不算。
 * @param {Date} date
 * @returns {boolean}
 */
export function isPeak(date) {
  const { weekday, msOfDay } = beijingParts(date.getTime());
  return (
    isPeakWeekday(weekday) &&
    msOfDay >= RULES.peakStartMinutes * MS_PER_MINUTE &&
    msOfDay < RULES.peakEndMinutes * MS_PER_MINUTE
  );
}

/**
 * 某时刻的高峰状态与下一次翻转。
 * @param {Date} date
 * @returns {{ peak: boolean, nextSwitch: Date, msUntilSwitch: number }}
 *   peak - 当前是否高峰；
 *   nextSwitch - 下一次状态翻转时刻（高峰中→本次高峰结束；非高峰→下一个高峰开始，
 *   周五 18:00 之后跳到下周一 14:00）；
 *   msUntilSwitch - 距离翻转的毫秒数。
 */
export function getStatus(date) {
  const ts = date.getTime();
  const { year, month, day, weekday, msOfDay } = beijingParts(ts);
  const today = windowOfUtcDay(year, month, day);
  const startMs = RULES.peakStartMinutes * MS_PER_MINUTE;
  const endMs = RULES.peakEndMinutes * MS_PER_MINUTE;

  let nextTs;
  if (isPeakWeekday(weekday) && msOfDay >= startMs && msOfDay < endMs) {
    // 高峰中：本次高峰结束
    nextTs = today.end;
  } else if (isPeakWeekday(weekday) && msOfDay < startMs) {
    // 工作日高峰前：今天 14:00
    nextTs = today.start;
  } else {
    // 工作日高峰后或周末：下一个高峰日的 14:00（最多隔 3 天）
    for (let offset = 1; offset <= 8; offset++) {
      const d = new Date(Date.UTC(year, month, day + offset));
      if (isPeakWeekday(d.getUTCDay())) {
        nextTs = windowOfUtcDay(
          d.getUTCFullYear(),
          d.getUTCMonth(),
          d.getUTCDate(),
        ).start;
        break;
      }
    }
  }
  return {
    peak: isPeak(date),
    nextSwitch: new Date(nextTs),
    msUntilSwitch: nextTs - ts,
  };
}

/**
 * 列出与 [from, to) 有重叠的所有高峰区间，不裁剪，按开始时间升序。
 * @param {Date} from
 * @param {Date} to
 * @returns {Array<{ start: Date, end: Date }>} 范围内没有高峰时为空数组。
 */
export function peakWindows(from, to) {
  const fromTs = from.getTime();
  const toTs = to.getTime();
  const windows = [];
  if (!(fromTs < toTs)) return windows;

  // 最早可能重叠的窗口在 from 所在的北京日（窗口起点 14:00 总在当天之内或之后）
  const { year, month, day } = beijingParts(fromTs);
  for (let offset = 0; ; offset++) {
    const d = new Date(Date.UTC(year, month, day + offset));
    const window = windowOfUtcDay(
      d.getUTCFullYear(),
      d.getUTCMonth(),
      d.getUTCDate(),
    );
    if (window.start >= toTs) break; // 后续窗口只会更晚
    if (isPeakWeekday(d.getUTCDay()) && window.end > fromTs) {
      windows.push({ start: new Date(window.start), end: new Date(window.end) });
    }
  }
  return windows;
}
