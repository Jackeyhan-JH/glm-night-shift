// 展示层的纯文本格式化：终端显示宽度（东亚宽字符算两列）、按宽度对齐/截断、
// 本地时间、耗时。全是纯函数，不碰 IO，单测见 test/format.test.js。

// 按终端惯例显示宽度为 2 列的码点区间（CJK、全角、谚文、常用 emoji 等）。
// 这是务实近似而非完整 Unicode 表——标题/prompt 以 ASCII 与中日韩为主，
// 不常见区间的个别误差只影响那一行的对齐，不影响功能。
const WIDE_RANGES = [
  [0x1100, 0x115f], // 谚文字母
  [0x2e80, 0x303e], // CJK 部首、注音、CJK 符号（含全角空格 U+3000）
  [0x3041, 0x33ff], // 假名、CJK 兼容
  [0x3400, 0x4dbf], // CJK 扩展 A
  [0x4e00, 0x9fff], // CJK 统一表意文字
  [0xa000, 0xa4cf], // 彝文
  [0xac00, 0xd7a3], // 谚文音节
  [0xf900, 0xfaff], // CJK 兼容表意文字
  [0xfe30, 0xfe4f], // CJK 兼容形式
  [0xff00, 0xff60], // 全角形式
  [0xffe0, 0xffe6], // 全角符号
  [0x1f300, 0x1f64f], // 常用 emoji
  [0x1f900, 0x1f9ff], // emoji 补充
  [0x20000, 0x2fffd], // CJK 扩展 B 起
  [0x30000, 0x3fffd],
];

/** 组合附标（不占列）与零宽字符区间。 */
const ZERO_WIDTH_RANGES = [
  [0x0300, 0x036f], // 常见组合附标
  [0x200b, 0x200f], // 零宽空格 / 连接符
];

/**
 * 终端显示宽度（列数）：按 Unicode 码点逐个累加，东亚宽字符/全角算 2 列，
 * 组合附标与零宽字符算 0 列，其余 1 列。对齐表格必须用这个而不是 .length
 * （「修复」是 2 个字符、4 列）。
 */
export function displayWidth(text) {
  let width = 0;
  for (const ch of String(text)) {
    const cp = ch.codePointAt(0);
    if (inRanges(cp, ZERO_WIDTH_RANGES)) continue;
    width += inRanges(cp, WIDE_RANGES) ? 2 : 1;
  }
  return width;
}

/**
 * 超过 maxColumns 显示列时截断，结尾用 …（1 列），保证结果 ≤ maxColumns 列；
 * 没超则原样返回。按码点切，不会把宽字符劈成两半或产生半个代理对。
 */
export function truncateDisplay(text, maxColumns) {
  const str = String(text);
  if (displayWidth(str) <= maxColumns) return str;
  let out = '';
  let width = 0;
  for (const ch of str) {
    const w = displayWidth(ch);
    if (width + w > maxColumns - 1) break; // 留 1 列给 …
    out += ch;
    width += w;
  }
  return `${out}…`;
}

/** 右侧补空格到 width 显示列；已经超宽则原样返回（调用方保证列宽 ≥ 内容宽）。 */
export function padEndDisplay(text, width) {
  const str = String(text);
  const current = displayWidth(str);
  if (current >= width) return str;
  return str + ' '.repeat(width - current);
}

/**
 * UTC ISO 时间 → 本地时区的「YYYY-MM-DD HH:mm」（到分钟，规格要求）。
 * 用本地 getter，跟随进程 TZ（测试里 spawn 子进程时设 TZ 固定输出）。
 */
export function formatLocalMinute(iso) {
  const d = new Date(iso);
  const p2 = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

/**
 * 毫秒 → 人类可读耗时：「250毫秒」「1秒」「59.4秒」「1分2秒」「2小时3分」。
 * null/undefined（真实耗时不可知，如崩溃恢复标记的 run）→ '-'。
 */
export function formatDurationMs(ms) {
  if (ms === null || ms === undefined) return '-';
  if (ms < 1000) return `${ms}毫秒`;
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) {
    const tenth = Math.floor((ms % 1000) / 100); // 一位小数，向下截断避免 59.9 秒进成 60 秒
    return tenth === 0 ? `${totalSeconds}秒` : `${totalSeconds}.${tenth}秒`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return seconds === 0 ? `${minutes}分` : `${minutes}分${seconds}秒`;
  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  return remMinutes === 0 ? `${hours}小时` : `${hours}小时${remMinutes}分`;
}

function inRanges(cp, ranges) {
  for (const [lo, hi] of ranges) {
    if (cp >= lo && cp <= hi) return true;
  }
  return false;
}
