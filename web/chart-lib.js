// 额度与高峰页（issue #17）的纯计算函数：刻度、堆叠、柱子坐标、高峰带位置、倒计时
// 与进度条状态判定。零 import、不碰 DOM / fetch——浏览器里由 usage.js 调用后拼 SVG，
// node:test 里直接 import 单测（见 test/web-chart-lib.test.js）。
// 坐标约定：左上为原点、单位像素；y0 是基线（值 0），y1 是绘图区顶部（最大刻度）。

/** 分类色板（浅色主题、白色卡面）。顺序即槽位，经色板校验器验证：相邻 CVD ΔE、
 *  正常视觉 ΔE 与亮度带全部达标（见 PR 说明）；只有前两槽会用于已知模型。 */
export const SERIES_COLORS = [
  '#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948',
];
export const MAX_SERIES = SERIES_COLORS.length;
/** 已知模型的固定槽位（色随实体：无论哪些模型出现、按什么顺序出现，glm-5.3 永远是
 *  槽 1 蓝、flash 永远是槽 2 橙，切换天数 / 刷新都不会换色）。 */
export const KNOWN_MODELS = ['glm-5.3', 'glm-5.3-flash'];
/** 超过 MAX_SERIES 个模型时，多余模型折叠进这个系列名。 */
export const OTHER_KEY = '其他';

export const MS_PER_HOUR = 3_600_000;
export const MS_PER_DAY = 24 * MS_PER_HOUR;

// ---------------------------------------------------------------- 系列与配色

/**
 * 模型名集合 → 系列顺序与配色。
 * 已知模型占固定槽位；未知模型按字母序续排；总数超过 max 时保留前 max−1 个显式系列，
 * 其余折叠进「其他」（第 9 个系列永远不会是生成的第 9 种颜色）。
 * @param {Iterable<string>} models 出现过的模型名（重复 / 空串自动忽略）。
 * @param {{ max?: number }} [options] 显式系列数上限（含折叠位，缺省 8）。
 * @returns {{ order: string[], colors: Map<string, string>, folded: boolean }}
 */
export function seriesOrder(models, { max = MAX_SERIES } = {}) {
  const unique = [...new Set([...models])].filter((m) => typeof m === 'string' && m !== '');
  const known = KNOWN_MODELS.filter((m) => unique.includes(m));
  const rest = unique.filter((m) => !KNOWN_MODELS.includes(m)).sort();
  const all = [...known, ...rest];
  const folded = all.length > max;
  const order = folded ? [...all.slice(0, max - 1), OTHER_KEY] : all;
  const colors = new Map(order.map((key, i) => [key, SERIES_COLORS[i]]));
  return { order, colors, folded };
}

/**
 * 一个小时桶按系列顺序做**数值空间**的堆叠：返回 value > 0 的段，base 是该段起点
 * （= 前面各段高度之和，即「第二段的起点等于第一段的高度」）。
 * order 末位是 OTHER_KEY 时，把不在显式列表里的模型都汇总进该系列。
 * @param {{ byModel?: Record<string, number> }} bucket /api/usage/history 的一个桶。
 * @param {string[]} order seriesOrder().order。
 * @returns {Array<{ key: string, value: number, base: number }>} 按 order 顺序；空桶为 []。
 */
export function stackSeries(bucket, order = []) {
  if (bucket === null || typeof bucket !== 'object') return [];
  const byModel = bucket.byModel ?? {};
  const sums = new Map(order.filter((key) => key !== OTHER_KEY).map((key) => [key, 0]));
  for (const [model, raw] of Object.entries(byModel)) {
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) continue;
    if (sums.has(model)) sums.set(model, sums.get(model) + value);
    else if (order.includes(OTHER_KEY)) sums.set(OTHER_KEY, (sums.get(OTHER_KEY) ?? 0) + value);
  }
  const segments = [];
  let base = 0;
  for (const key of order) {
    const value = round2(sums.get(key) ?? 0);
    if (value <= 0) continue;
    segments.push({ key, value, base });
    base = round2(base + value);
  }
  return segments;
}

// ---------------------------------------------------------------- 刻度与几何

/**
 * 「整齐」的纵轴刻度：从 {1, 2, 5} × 10^k 里挑最小的 step，使刻度数（含 0）不超过
 * maxTicks；返回 [0, step, 2·step, …, top]，top ≥ maxValue 且被 maxValue ≤ top 覆盖。
 * @param {number} maxValue 数据最大值；≤ 0 或非法时返回 [0, 1]（空图也有 0 轴）。
 * @param {{ maxTicks?: number }} [options] 刻度数上限（含 0），缺省 5。
 * @returns {number[]}
 */
export function niceTicks(maxValue, { maxTicks = 5 } = {}) {
  if (!Number.isFinite(maxValue) || maxValue <= 0) return [0, 1];
  const rawStep = maxValue / (maxTicks - 1);
  const pow = Math.pow(10, Math.floor(Math.log10(rawStep)));
  let step = 10 * pow; // 兜底：rawStep < 10·pow 恒成立，循环至少在 10 命中
  for (const mantissa of [1, 2, 5, 10]) {
    const candidate = mantissa * pow;
    if (Math.ceil(maxValue / candidate - 1e-9) <= maxTicks - 1) {
      step = candidate;
      break;
    }
  }
  const steps = Math.ceil(maxValue / step - 1e-9);
  const ticks = [];
  for (let i = 0; i <= steps; i++) ticks.push(Number((i * step).toFixed(10)));
  return ticks;
}

/**
 * 柱子横向几何：count 根柱子均分 [0, plotWidth)，每根占一个宽 step 的格；
 * 柱宽 = min(maxWidth, step × (1 − 2·pad))，但不小于 min(minWidth, step)、也绝不超过
 * step——保证 x 严格单调递增且相邻不重叠（count 再大也只是柱子变细）。
 * @param {number} count 柱子数（≤ 0 或宽度非法 → 空结果）。
 * @param {number} plotWidth 绘图区像素宽。
 * @param {{ pad?: number, maxWidth?: number, minWidth?: number }} [options]
 *   pad - 每侧留白占 step 的比例（缺省 0.15）；maxWidth - 柱宽上限（缺省 24）；
 *   minWidth - 柱宽下限（缺省 1，仍受 step 钳制）。
 * @returns {{ step: number, bars: Array<{ cellX: number, cellWidth: number, x: number, width: number }> }}
 */
export function barGeometry(count, plotWidth, { pad = 0.15, maxWidth = 24, minWidth = 1 } = {}) {
  const n = Math.floor(count);
  if (!(n > 0) || !(plotWidth > 0)) return { step: 0, bars: [] };
  const step = plotWidth / n;
  let width = Math.min(maxWidth, step * (1 - 2 * pad));
  width = Math.max(width, Math.min(minWidth, step));
  width = Math.min(width, step); // 不重叠的硬保证
  const bars = [];
  for (let i = 0; i < n; i++) {
    const cellX = i * step;
    bars.push({ cellX, cellWidth: step, x: cellX + (step - width) / 2, width });
  }
  return { step, bars };
}

/**
 * 图表的 x 时间域：第一桶起点 → 最后一桶起点 + 1 小时（柱子恰好铺满整个域）。
 * @param {Array<{ hour: string }>} buckets /api/usage/history 的 buckets。
 * @returns {{ fromTs: number, toTs: number } | null} 空桶列表或时间非法时为 null。
 */
export function chartDomain(buckets) {
  if (!Array.isArray(buckets) || buckets.length === 0) return null;
  const fromTs = toMs(buckets[0]?.hour);
  const lastTs = toMs(buckets[buckets.length - 1]?.hour);
  if (fromTs === null || lastTs === null) return null;
  return { fromTs, toTs: lastTs + MS_PER_HOUR };
}

/**
 * 时刻 → x 像素（线性映射；chartDomain 的域内点落在 [x0, x1]，域外照算不裁剪，
 * 需要裁剪的用 bandPositions）。
 */
export function timeX(ts, domain, x0, x1) {
  if (domain === null) return 0;
  const t = toMs(ts);
  if (t === null) return 0;
  const span = domain.toTs - domain.fromTs;
  if (!(span > 0)) return x0;
  return x0 + ((t - domain.fromTs) / span) * (x1 - x0);
}

/**
 * 高峰区间（src/peak.js 的 peakWindows 结果）→ 背景带像素位置。带被裁剪到绘图区，
 * 与域无交集的不返回；x / width 由区间起止在线性时间轴上的比例得出。
 * @param {Array<{ start: Date|string|number, end: Date|string|number }>} windows
 * @param {{ fromTs: number, toTs: number } | null} domain chartDomain 的结果。
 * @param {number} x0 绘图区左端像素。
 * @param {number} x1 绘图区右端像素。
 * @returns {Array<{ x: number, width: number, startTs: number, endTs: number }>}
 */
export function bandPositions(windows, domain, x0, x1) {
  if (domain === null || !Array.isArray(windows)) return [];
  const span = domain.toTs - domain.fromTs;
  if (!(span > 0) || x1 === x0) return [];
  const bands = [];
  for (const window of windows) {
    const startTs = toMs(window?.start);
    const endTs = toMs(window?.end);
    if (startTs === null || endTs === null) continue;
    const s = Math.max(startTs, domain.fromTs);
    const e = Math.min(endTs, domain.toTs);
    if (s >= e) continue;
    const x = timeX(s, domain, x0, x1);
    bands.push({ x, width: timeX(e, domain, x0, x1) - x, startTs: s, endTs: e });
  }
  return bands;
}

/**
 * 域内所有**本地零点**时刻（严格大于 fromTs、小于 toTs，升序），给横轴「按天标注
 * 日期」用。按 30 分钟步进扫描，兼容半时区偏移（如 UTC+5:30）。
 * @returns {number[]}
 */
export function localMidnights(fromTs, toTs) {
  const out = [];
  if (!Number.isFinite(fromTs) || !Number.isFinite(toTs) || toTs <= fromTs) return out;
  const half = MS_PER_HOUR / 2;
  for (let ts = Math.floor(fromTs / half) * half + half; ts < toTs; ts += half) {
    const d = new Date(ts);
    if (d.getHours() === 0 && d.getMinutes() === 0) out.push(ts);
  }
  return out;
}

/**
 * 堆叠柱状图的完整布局（纯计算；usage.js 只按结果拼 SVG 与事件）。
 * @param {object} input
 * @param {Array<{ hour: string, byModel: Record<string, number>, total: number }>} input.buckets
 * @param {string[]} [input.order] 系列顺序（seriesOrder().order）。
 * @param {{ x0?: number, x1?: number, y0?: number, y1?: number }} [input.plot]
 *   绘图区像素（y0 基线、y1 顶部）。
 * @param {number} [input.gap=2] 堆叠段之间的表面留白（px）。
 * @param {number} [input.pad] barGeometry 的 pad。
 * @param {number} [input.maxWidth] barGeometry 的 maxWidth。
 * @returns {{
 *   domain: { fromTs: number, toTs: number } | null,
 *   topValue: number,
 *   ticks: Array<{ value: number, y: number, label: string }>,
 *   bars: Array<{ index: number, hour: string, total: number,
 *     cellX: number, cellWidth: number, x: number, width: number,
 *     segments: Array<{ key: string, value: number, base: number, y: number, height: number, top: boolean }> }>,
 * }}
 *   segments 自下而上排列；非顶段在顶部让出 gap 像素的表面留白（顶段保持数据端不缩），
 *   高度不足 gap 的段保留至少 1px（有量就有形）。空桶也有 bar（悬停显示合计 0）。
 */
export function layoutBars({ buckets, order = [], plot = {}, gap = 2, pad, maxWidth } = {}) {
  const empty = { domain: null, topValue: 0, ticks: [], bars: [] };
  if (!Array.isArray(buckets) || buckets.length === 0) return empty;
  const domain = chartDomain(buckets);
  if (domain === null) return empty;
  const { x0 = 0, x1 = 100, y0 = 100, y1 = 0 } = plot;
  const geo = barGeometry(buckets.length, x1 - x0, { pad, maxWidth });
  const maxTotal = round2(Math.max(0, ...buckets.map((b) => Number(b?.total) || 0)));
  const tickValues = niceTicks(maxTotal);
  const topValue = tickValues[tickValues.length - 1];
  const yFor = (value) => y0 - (value / topValue) * (y0 - y1);
  const ticks = tickValues.map((value) => ({ value, y: yFor(value), label: fmtValue(value) }));
  const theGap = Math.max(0, gap);
  const bars = buckets.map((bucket, index) => {
    const cell = geo.bars[index];
    const segments = stackSeries(bucket, order);
    const rects = segments.map((seg, i) => {
      const bottomY = yFor(seg.base);
      const rawHeight = bottomY - yFor(round2(seg.base + seg.value));
      const isTop = i === segments.length - 1;
      const height = isTop
        ? rawHeight
        : Math.max(rawHeight - theGap, Math.min(rawHeight, 1));
      return { ...seg, y: bottomY - height, height, top: isTop };
    });
    return {
      index,
      hour: bucket.hour,
      total: round2(Number(bucket?.total) || 0),
      cellX: x0 + cell.cellX,
      cellWidth: cell.cellWidth,
      x: x0 + cell.x,
      width: cell.width,
      segments: rects,
    };
  });
  return { domain, topValue, ticks, bars };
}

// ---------------------------------------------------------------- 时钟与格式

/**
 * 以 /api/status 返回的 now 为基准推算「当前时刻」：baseMs + 页面已过时间。
 * elapsedMs 用 performance.now() 差值（单调、不受系统时间 / NIGHT_SHIFT_NOW 影响），
 * 绝不直接读浏览器墙钟——这样测试固定服务端时间时页面照样走得通。
 * @param {Date|string|number} baseMs 服务端 now。
 * @param {number} elapsedMs 距离拿到 baseMs 已过的毫秒（负数按 0）。
 * @returns {Date | null} baseMs 非法时为 null。
 */
export function serverNow(baseMs, elapsedMs) {
  const base = toMs(baseMs);
  if (base === null) return null;
  const elapsed = Number.isFinite(elapsedMs) ? Math.max(0, elapsedMs) : 0;
  return new Date(base + elapsed);
}

/**
 * 剩余毫秒 → 「HH:MM:SS」（每秒更新的倒计时用）。负数 / 非法钳到 00:00:00
 * （归零时由 usage.js 重新拉 /api/status）；小时可超过 24（跨周末最长约 68 小时）。
 */
export function fmtCountdown(ms) {
  const total = Math.max(0, Math.floor((Number.isFinite(ms) ? ms : 0) / 1000));
  const p2 = (n) => String(n).padStart(2, '0');
  return `${p2(Math.floor(total / 3600))}:${p2(Math.floor((total % 3600) / 60))}:${p2(total % 60)}`;
}

/**
 * 时刻 → 固定偏移时区的「YYYY-MM-DD HH:mm」。北京时间用 offsetMinutes = 480
 * （中国无夏令时，固定偏移即正确；见 src/peak.js 的 RULES）。
 */
export function fmtAtOffset(value, offsetMinutes) {
  const parts = partsAtOffset(value, offsetMinutes);
  if (parts === null) return '-';
  const p2 = (n) => String(n).padStart(2, '0');
  return `${parts.year}-${p2(parts.month)}-${p2(parts.day)} ${p2(parts.hour)}:${p2(parts.minute)}`;
}

/**
 * 时刻在固定偏移时区下的日历分量（weekday 同 Date#getDay：0 = 周日）。
 * @returns {{ year, month, day, hour, minute, weekday } | null} 时刻非法时为 null。
 */
export function partsAtOffset(value, offsetMinutes) {
  const ms = toMs(value);
  if (ms === null) return null;
  const shifted = new Date(ms + (Number(offsetMinutes) || 0) * 60_000);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    weekday: shifted.getUTCDay(),
  };
}

/**
 * 额度进度条状态：ratio > 1 → 'danger'（红，超 100%）；ratio > safetyRatio → 'warn'
 * （黄，超安全阈值）；否则 'ok'。恰好等于阈值不算超。ratio 非法按 'ok'。
 */
export function meterState(ratio, safetyRatio = 0.9) {
  if (!Number.isFinite(ratio)) return 'ok';
  if (ratio > 1) return 'danger';
  if (ratio > safetyRatio) return 'warn';
  return 'ok';
}

/**
 * 数值 → 整洁字符串：四舍五入到 2 位小数后去掉尾零（3 → '3'、1.2 → '1.2'、
 * 5.2 → '5.2'、0.30000000000000004 → '0.3'）；非法值按 '0'。
 */
export function fmtValue(n) {
  if (!Number.isFinite(n)) return '0';
  return String(Number((Math.round(n * 100) / 100).toFixed(2)));
}

/**
 * 悬停某根柱子时的读数：该小时各系列（按 order 顺序、value > 0）的值与合计。
 * @returns {{ rows: Array<{ key, value, base }>, total: number }}
 */
export function tooltipLines(bucket, order = []) {
  const rows = stackSeries(bucket, order);
  return { rows, total: round2(rows.reduce((sum, row) => sum + row.value, 0)) };
}

// ---------------------------------------------------------------- 内部

/** Date / ISO 字符串 / epoch 毫秒 → 毫秒；非法返回 null（页面数据缺字段时不抛错）。 */
function toMs(value) {
  let ts = NaN;
  if (value instanceof Date) ts = value.getTime();
  else if (typeof value === 'string') ts = Date.parse(value);
  else if (typeof value === 'number') ts = value;
  return Number.isFinite(ts) ? ts : null;
}

function round2(value) {
  return Math.round(value * 100) / 100;
}
