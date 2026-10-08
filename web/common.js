// 看板前端公共模块（issue #14）：四个看板页（队列 / 任务详情 / 额度 / 设置）共用的工具。
// 纯 ESM、零依赖，浏览器里 <script type="module"> 直接引；除 api() 在调用时才碰
// fetch 外全是纯函数，import 时不碰任何 DOM——所以 node:test 也能直接 import 单测
// （见 test/web-common.test.js）。

/**
 * 调后端 JSON 接口。
 * @param {string} path 路径（如 '/api/tasks'）。
 * @param {{ method?: string, body?: object }} [options] method 缺省 GET；给了 body 才
 *   发 JSON（自动带 Content-Type: application/json）。
 * @returns {Promise<*>} 解析后的 JSON（空响应体为 null）。
 * @throws {Error} 网络失败或非 2xx：message 是后端的 error 文本（没有则带 HTTP 状态），
 *   err.status = HTTP 状态码，err.field = 后端点名的字段（没有则 undefined）。
 */
export async function api(path, { method = 'GET', body } = {}) {
  const hasBody = body !== undefined;
  const response = await fetch(path, {
    method,
    headers: hasBody ? { 'Content-Type': 'application/json' } : undefined,
    body: hasBody ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let data = null;
  if (text !== '') {
    try {
      data = JSON.parse(text);
    } catch {
      data = null; // 非 JSON 响应体：ok 时原样丢弃，非 ok 时退回到状态码报错
    }
  }
  if (!response.ok) {
    const err = new Error(
      (data !== null && typeof data.error === 'string' && data.error !== '')
        ? data.error
        : `请求失败（HTTP ${response.status}）`,
    );
    err.status = response.status;
    if (data !== null && data.field !== undefined) err.field = data.field;
    throw err;
  }
  return data;
}

/**
 * UTC ISO 时间 → 本地时区的「YYYY-MM-DD HH:mm」（到分钟）。null/undefined/非法时间 → '-'。
 */
export function fmtTime(iso) {
  if (iso === null || iso === undefined || iso === '') return '-';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '-';
  const p2 = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} `
    + `${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

/**
 * 毫秒 → 人类可读耗时：
 * - null / undefined / 负数 / NaN → '-'（真实耗时不可知）；
 * - < 1 分钟 → 「45 秒」（整数秒，向下取整）；
 * - < 1 小时 → 「1 分 05 秒」（秒补零到两位，65000 → '1 分 05 秒'）；
 * - ≥ 1 小时 → 「2 小时 03 分」（分钟补零到两位）。
 */
export function fmtDuration(ms) {
  if (ms === null || ms === undefined || typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) {
    return '-';
  }
  const totalSeconds = Math.floor(ms / 1000);
  const p2 = (n) => String(n).padStart(2, '0');
  if (totalSeconds < 60) return `${totalSeconds} 秒`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes} 分 ${p2(seconds)} 秒`;
  const hours = Math.floor(minutes / 60);
  return `${hours} 小时 ${p2(minutes % 60)} 分`;
}

/**
 * 额度数值 → 保留 1 位小数的字符串（3 → '3.0'、1.25 → '1.3'）；null/undefined → '-'。
 */
export function fmtUnits(n) {
  if (n === null || n === undefined || typeof n !== 'number' || !Number.isFinite(n)) return '-';
  return n.toFixed(1);
}

/** 任务状态的中文标签（五个状态全）；未知状态原样返回，页面不至于显示空白。 */
export function statusLabel(status) {
  const labels = {
    queued: '排队中',
    running: '执行中',
    succeeded: '成功',
    failed: '失败',
    canceled: '已取消',
  };
  return labels[status] ?? status;
}

/**
 * 顶部导航的 HTML（纯字符串拼装，不碰 DOM）。
 * @param {string} [active=''] 当前页路径（'/' 或 '/usage.html' 或 '/settings.html'），
 *   命中的项加 class="active"。
 */
export function navHtml(active = '') {
  const items = [
    { href: '/', label: '队列' },
    { href: '/usage.html', label: '额度' },
    { href: '/settings.html', label: '设置' },
  ];
  const links = items
    .map(({ href, label }) => `  <a href="${href}"${href === active ? ' class="active"' : ''}>${label}</a>`)
    .join('\n');
  return `<nav class="topnav">\n${links}\n</nav>`;
}
