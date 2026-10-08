// 额度与高峰页（issue #17）：拉 /api/status 与 /api/usage/history，拼三张卡片——
// 高峰状态（大字 + 两地时间 + 倒计时 + 倍率 + 未来 7 天时段）、额度（5 小时 / 每周
// 进度条 + 调度器被拦原因）、按小时堆叠柱状图（纯 SVG，无图表库）。
//
// 分工：刻度 / 堆叠 / 坐标 / 高峰带等计算全在 /chart-lib.js（纯函数，node:test 有单测）；
// 本文件只做 DOM 拼装与事件。高峰区间复用 src/peak.js（服务端加了只读路由
// /src/peak.js，浏览器直接 import，不在 /api/status 里重复这些结果）。
//
// 时钟约定：页面「当前时刻」= /api/status 的 now + 页面已过时间（performance.now()
// 差值，单调、不受系统时间影响），绝不直接读浏览器墙钟——NIGHT_SHIFT_NOW 固定服务端
// 时间时页面照样走得通；倒计时归零就重新拉 /api/status 换基准。
import { api, fmtTime, navHtml } from '/common.js';
import { RULES, peakWindows } from '/src/peak.js';
import {
  MS_PER_DAY,
  bandPositions,
  fmtAtOffset,
  fmtCountdown,
  fmtValue,
  layoutBars,
  localMidnights,
  meterState,
  partsAtOffset,
  seriesOrder,
  serverNow,
  timeX,
  tooltipLines,
} from '/chart-lib.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const REFRESH_MS = 30_000; // 数据刷新间隔（issue 规格）
const CHART_HEIGHT = 280;
const CHART_MARGIN = { top: 14, right: 12, bottom: 26, left: 46 };
/** 北京时间 = UTC+8（无夏令时），偏移直接取 src/peak.js 的 RULES。 */
const BJ_OFFSET = RULES.tzOffsetMinutes;
const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const PLAN_LABELS = { 'v2-lite': 'Lite', 'v2-pro': 'Pro', 'v2-max': 'Max' };
const BLOCK_REASONS = {
  'peak': '高峰期，暂不领新任务',
  'five-hour': '5 小时额度已达安全阈值',
  'weekly': '每周额度已达安全阈值',
  'rate-limit': '触发限流，全局退避中',
};

const state = {
  status: null, // 最近一次 /api/status
  statusAt: 0, // 拿到 status 时的 performance.now()
  history: null, // 最近一次 /api/usage/history
  days: 7,
  lastZeroRefresh: 0, // 倒计时归零触发的重拉节流（避免固定时钟下来回打请求）
};
let chart = null; // 最近一次图表布局 { layout, order, colors }

const $ = (selector) => document.querySelector(selector);
const p2 = (n) => String(n).padStart(2, '0');
const fx = (n) => Math.round(n * 100) / 100; // SVG 属性里保留两位小数，输出稳定

// ---------------------------------------------------------------- 数据拉取

async function refreshStatus() {
  try {
    const status = await api('/api/status');
    state.status = status;
    state.statusAt = performance.now();
    hideError('peak-error');
    hideError('quota-error');
    renderPeak();
    renderQuota();
    tickClock(); // 立刻刷一次倒计时 / 双时钟，不等下一秒
  } catch (err) {
    showError('peak-error', err);
    showError('quota-error', err);
  }
}

async function refreshHistory() {
  const days = state.days; // 请求期间用户切了范围 → 这次响应作废（见下）
  try {
    const history = await api(`/api/usage/history?days=${days}`);
    if (days !== state.days) return;
    state.history = history;
    hideError('chart-error');
    renderChart();
  } catch (err) {
    showError('chart-error', err);
  }
}

function loadAll() {
  refreshStatus();
  refreshHistory();
}

// ---------------------------------------------------------------- 时钟与倒计时

/** 页面当前时刻（/api/status.now + 已过时间）；还没拿到 status 时为 null。 */
function serverNowDate() {
  if (state.status === null) return null;
  return serverNow(state.status.now, performance.now() - state.statusAt);
}

/** 每秒跑：更新两地时间与倒计时；倒计时归零 → 重新拉 /api/status（换基准与下次切换）。 */
function tickClock() {
  if (state.status === null) return;
  const now = serverNowDate();
  if (now === null) return;
  renderNowTimes(now);
  const target = Date.parse(state.status.peak.nextChange);
  const remaining = Number.isFinite(target) ? target - now.getTime() : 0;
  $('#countdown').textContent = fmtCountdown(remaining);
  if (remaining <= 0 && performance.now() - state.lastZeroRefresh > 10_000) {
    state.lastZeroRefresh = performance.now();
    refreshStatus();
  }
}

// ---------------------------------------------------------------- 高峰卡片

function renderPeak() {
  const { peak } = state.status;
  const badge = $('#peak-state');
  badge.textContent = peak.peak ? '高峰' : '非高峰';
  badge.classList.toggle('is-peak', peak.peak === true);
  badge.classList.toggle('is-offpeak', peak.peak !== true);
  $('#next-change').textContent = `${fmtAtOffset(peak.nextChange, BJ_OFFSET)}（北京）`
    + ` ｜ ${fmtTime(peak.nextChange)}（本地）`;
  $('#multipliers').replaceChildren(...Object.entries(peak.multipliers ?? {}).map(([model, m]) => {
    const li = document.createElement('li');
    li.textContent = `${model} ×${fmtValue(m)}`;
    return li;
  }));
  renderUpcoming(serverNowDate());
}

function renderNowTimes(now) {
  $('#now-beijing').textContent = fmtAtOffset(now.getTime(), BJ_OFFSET);
  $('#now-local').textContent = fmtTime(now.toISOString());
}

/** 未来 7 天的高峰时段列表（peakWindows 复用 src/peak.js；北京日期 + 本地起止）。 */
function renderUpcoming(now) {
  if (now === null) return;
  const windows = peakWindows(now, new Date(now.getTime() + 7 * MS_PER_DAY));
  $('#upcoming').replaceChildren(...windows.map((w) => {
    const start = partsAtOffset(w.start, BJ_OFFSET);
    const end = partsAtOffset(w.end, BJ_OFFSET);
    const li = document.createElement('li');
    li.textContent = `${p2(start.month)}-${p2(start.day)} ${WEEKDAYS[start.weekday]} `
      + `${p2(start.hour)}:${p2(start.minute)} – ${p2(end.hour)}:${p2(end.minute)}（北京）`
      + ` ｜ 本地 ${fmtTime(w.start.toISOString())} 起`;
    return li;
  }));
}

// ---------------------------------------------------------------- 额度卡片

function renderQuota() {
  const s = state.status;
  $('#plan').textContent = PLAN_LABELS[s.plan] ?? s.plan;
  renderMeter('five-hour', s.usage.fiveHour, '5 小时内没有用量');
  renderMeter('weekly', s.usage.weekly, '滚动 7 天统计');
  renderScheduler(s.scheduler);
}

/** 一条进度条：used/limit、百分比、状态色（超 safetyRatio 黄 / 超 100% 红）、恢复时间。 */
function renderMeter(prefix, win, emptyResetText) {
  const ratio = Number.isFinite(win.ratio) ? win.ratio : 0;
  const level = meterState(ratio, state.status.safetyRatio);
  $(`#${prefix}-text`).textContent = `${fmtValue(win.used)} / ${fmtValue(win.limit)}`;
  const pct = Math.round(ratio * 1000) / 10;
  const pctNote = level === 'danger' ? '（已超 100%）'
    : level === 'warn' ? '（超安全阈值）' : '';
  $(`#${prefix}-pct`).textContent = `${fmtValue(pct)}%${pctNote}`;
  $(`#${prefix}-reset`).textContent = win.resetsAt
    ? `恢复于 ${fmtTime(win.resetsAt)}（本地）`
    : emptyResetText;
  const fill = $(`#${prefix}-fill`);
  fill.style.width = `${Math.min(100, Math.max(0, ratio * 100))}%`;
  $(`#${prefix}-block`).dataset.state = level;
}

/** 调度器在运行且被拦下时，显示原因与预计恢复时间（/api/status.scheduler.blocked）。 */
function renderScheduler(scheduler) {
  const box = $('#scheduler-box');
  const blocked = scheduler !== null && typeof scheduler === 'object' ? scheduler.blocked : null;
  if (blocked === null || blocked === undefined) {
    box.classList.add('usage-hidden');
    box.textContent = '';
    return;
  }
  const reason = BLOCK_REASONS[blocked.reason] ?? `被拦下（${blocked.reason}）`;
  box.textContent = `调度器：${reason}`
    + (blocked.retryAt ? `；预计 ${fmtTime(blocked.retryAt)}（本地）恢复` : '');
  box.classList.remove('usage-hidden');
}

// ---------------------------------------------------------------- 用量图（纯 SVG）

function renderChart() {
  if (state.history === null) return;
  hideTooltip(); // 重画会换掉悬停命中的矩形：旧提示不复位就会永远挂着
  const wrap = $('#chart-wrap');
  const width = Math.max(Math.floor(wrap.clientWidth) || 920, 320);
  const height = CHART_HEIGHT;
  const m = CHART_MARGIN;
  const plot = { x0: m.left, x1: width - m.right, y0: height - m.bottom, y1: m.top };

  // 系列与配色：色随实体（glm-5.3 恒蓝、flash 恒橙），与出现顺序无关。
  const models = [];
  for (const bucket of state.history.buckets) {
    for (const model of Object.keys(bucket.byModel ?? {})) {
      if (!models.includes(model)) models.push(model);
    }
  }
  const { order, colors } = seriesOrder(models);
  const layout = layoutBars({ buckets: state.history.buckets, order, plot });
  chart = { layout, order, colors };
  renderLegend(order, colors);

  wrap.querySelector('svg')?.remove();
  const svg = svgEl('svg', {
    viewBox: `0 0 ${width} ${height}`,
    width, height,
    role: 'img',
    'aria-label': `最近 ${state.days} 天按小时的用量堆叠柱状图`,
  });

  // 1) 高峰背景带（画在最底层）：浅琥珀色带标出图覆盖范围里的高峰时段。
  const windows = peakWindows(new Date(layout.domain.fromTs), new Date(layout.domain.toTs));
  for (const band of bandPositions(windows, layout.domain, plot.x0, plot.x1)) {
    svg.append(svgEl('rect', {
      class: 'band',
      x: fx(band.x),
      y: fx(plot.y1),
      width: fx(band.width),
      height: fx(plot.y0 - plot.y1),
    }));
  }

  // 2) 网格线与纵轴刻度（0 是基线，画成轴线）。
  for (const tick of layout.ticks) {
    if (tick.value === 0) continue;
    svg.append(svgEl('line', {
      class: 'grid-line', x1: fx(plot.x0), x2: fx(plot.x1), y1: fx(tick.y), y2: fx(tick.y),
    }));
    svg.append(svgEl('text', {
      class: 'axis-label', x: fx(plot.x0 - 6), y: fx(tick.y + 4), 'text-anchor': 'end',
    }, tick.label));
  }
  svg.append(svgEl('line', {
    class: 'axis-line', x1: fx(plot.x0), x2: fx(plot.x1), y1: fx(plot.y0), y2: fx(plot.y0),
  }));

  // 3) 横轴按天标注日期：域内每个本地零点一个；太密（30 天）时隔天取一，
  //    起点标签只在离第一个零点标签足够远时才补（否则和它挤在一起）。
  const midnights = localMidnights(layout.domain.fromTs, layout.domain.toTs);
  const days = (layout.domain.toTs - layout.domain.fromTs) / 86_400_000;
  const daySpacingPx = (plot.x1 - plot.x0) / Math.max(days, 1);
  const everyNth = Math.max(1, Math.ceil(40 / daySpacingPx)); // 标签至少隔 ~40px
  const kept = midnights.filter((_, i) => i % everyNth === 0);
  const firstKeptX = kept.length > 0
    ? timeX(kept[0], layout.domain, plot.x0, plot.x1) - plot.x0
    : Infinity;
  const marks = firstKeptX < 60 ? kept : [layout.domain.fromTs, ...kept];
  for (const ts of marks) {
    const d = new Date(ts);
    svg.append(svgEl('text', {
      class: 'axis-label', x: fx(timeX(ts, layout.domain, plot.x0, plot.x1)) + 2, y: fx(plot.y0 + 16),
    }, `${p2(d.getMonth() + 1)}-${p2(d.getDate())}`));
  }

  // 4) 柱子：每段一个矩形；顶段用「上圆角、基线方角」的路径（窄柱退化为矩形）。
  for (const bar of layout.bars) {
    for (const seg of bar.segments) {
      const attrs = { class: 'bar-seg', fill: colors.get(seg.key) ?? '#94a3b8' };
      svg.append(seg.top && bar.width >= 8
        ? svgEl('path', { ...attrs, d: roundedTopRect(bar.x, seg.y, bar.width, seg.height) })
        : svgEl('rect', { ...attrs, x: fx(bar.x), y: fx(seg.y), width: fx(bar.width), height: fx(seg.height) }));
    }
  }

  // 5) 悬停 / 键盘命中层：每根柱子一格整高的透明矩形（命中区比柱子大）。
  for (const bar of layout.bars) {
    const hit = svgEl('rect', {
      class: 'bar-hit',
      x: fx(bar.cellX),
      y: fx(plot.y1),
      width: fx(Math.max(bar.cellWidth, 0.5)),
      height: fx(plot.y0 - plot.y1),
      tabindex: 0,
      'aria-label': `${hourRangeLabel(bar.hour)}，合计 ${fmtValue(bar.total)} prompt`,
    });
    hit.addEventListener('pointerenter', (evt) => showTooltip(bar.index, evt));
    hit.addEventListener('pointermove', (evt) => positionTooltip(evt, bar));
    hit.addEventListener('pointerleave', hideTooltip);
    hit.addEventListener('focus', () => showTooltip(bar.index, null));
    hit.addEventListener('blur', hideTooltip);
    svg.append(hit);
  }

  wrap.append(svg);
  renderTable(order);
}

/** 图例：系列色块 + 高峰带说明（≥2 个系列必有图例；单系列也列出高峰带）。 */
function renderLegend(order, colors) {
  const legend = $('#legend');
  const items = order.map((key) => legendItem(colors.get(key) ?? '#94a3b8', key, false));
  items.push(legendItem('#fef3c7', '高峰时段（北京时间 14:00–18:00）', true));
  legend.replaceChildren(...items);
}

function legendItem(color, label, isBand) {
  const item = document.createElement('span');
  item.className = 'legend-item';
  const swatch = document.createElement('span');
  swatch.className = `swatch${isBand ? ' band' : ''}`;
  swatch.style.background = color;
  item.append(swatch, document.createTextNode(label));
  return item;
}

/** 顶段柱子的路径：数据端（上沿）4px 圆角、基线端方角；窄 / 矮时圆角自动收小。 */
function roundedTopRect(x, y, w, h) {
  const r = Math.max(0, Math.min(4, w / 2, h));
  if (r < 0.5) return `M${fx(x)} ${fx(y)}h${fx(w)}v${fx(h)}h${fx(-w)}z`;
  const side = fx(h - r);
  return `M${fx(x + r)} ${fx(y)}h${fx(w - 2 * r)}a${fx(r)} ${fx(r)} 0 0 1 ${fx(r)} ${fx(r)}`
    + `v${side}h${fx(-w)}v${fx(-side)}a${fx(r)} ${fx(r)} 0 0 1 ${fx(r)} ${fx(-r)}z`;
}

/** 数据表（悬停之外的兜底读数）：只列有用量的小时，各系列与合计。 */
function renderTable(order) {
  const box = $('#table-box');
  box.replaceChildren();
  if (state.history === null) return;
  const table = document.createElement('table');
  const headRow = document.createElement('tr');
  for (const label of ['本地时间', ...order, '合计']) {
    const th = document.createElement('th');
    th.textContent = label;
    if (label !== '本地时间') th.className = 'num';
    headRow.append(th);
  }
  const thead = document.createElement('thead');
  thead.append(headRow);
  const tbody = document.createElement('tbody');
  for (const bucket of state.history.buckets) {
    if (!(Number(bucket.total) > 0)) continue;
    const values = new Map(tooltipLines(bucket, order).rows.map((row) => [row.key, row.value]));
    const row = document.createElement('tr');
    const hourCell = document.createElement('td');
    hourCell.textContent = hourRangeLabel(bucket.hour);
    row.append(hourCell);
    for (const key of order) {
      const cell = document.createElement('td');
      cell.className = 'num';
      cell.textContent = values.has(key) ? fmtValue(values.get(key)) : '-';
      row.append(cell);
    }
    const totalCell = document.createElement('td');
    totalCell.className = 'num';
    totalCell.textContent = fmtValue(bucket.total);
    row.append(totalCell);
    tbody.append(row);
  }
  table.append(thead, tbody);
  box.append(table);
}

// ---------------------------------------------------------------- 悬停提示

function showTooltip(index, evt) {
  if (chart === null || state.history === null) return;
  const bar = chart.layout.bars[index];
  if (bar === undefined) return;
  const tip = $('#chart-tooltip');
  const title = document.createElement('div');
  title.className = 'tip-title';
  title.textContent = `${hourRangeLabel(bar.hour)}（本地）`;
  tip.replaceChildren(title);
  const { rows, total } = tooltipLines(state.history.buckets[index], chart.order);
  if (rows.length === 0) {
    const empty = document.createElement('div');
    empty.textContent = '该小时没有用量';
    tip.append(empty);
  }
  for (const row of rows) {
    const line = document.createElement('div');
    line.className = 'tip-row';
    const key = document.createElement('span');
    key.className = 'tip-chip';
    key.style.background = chart.colors.get(row.key) ?? '#94a3b8';
    const name = document.createElement('span');
    name.textContent = row.key;
    const value = document.createElement('strong');
    value.textContent = fmtValue(row.value);
    line.append(key, name, value);
    tip.append(line);
  }
  const sum = document.createElement('div');
  sum.className = 'tip-total';
  sum.textContent = `合计 ${fmtValue(total)}`;
  tip.append(sum);
  tip.classList.remove('usage-hidden');
  positionTooltip(evt, bar);
}

function positionTooltip(evt, bar) {
  const tip = $('#chart-tooltip');
  const wrap = $('#chart-wrap');
  const wrapRect = wrap.getBoundingClientRect();
  let left;
  let top;
  if (evt !== null && evt !== undefined) {
    left = evt.clientX - wrapRect.left + 14;
    top = evt.clientY - wrapRect.top - tip.offsetHeight - 12;
  } else { // 键盘聚焦：定位到柱子所在格
    left = bar.cellX + bar.cellWidth / 2;
    top = 8;
  }
  left = Math.min(Math.max(left, 4), Math.max(wrapRect.width - tip.offsetWidth - 4, 4));
  top = Math.min(Math.max(top, 4), Math.max(wrapRect.height - tip.offsetHeight - 4, 4));
  tip.style.left = `${Math.round(left)}px`;
  tip.style.top = `${Math.round(top)}px`;
}

function hideTooltip() {
  $('#chart-tooltip').classList.add('usage-hidden');
}

// ---------------------------------------------------------------- 小工具

function svgEl(tag, attrs, text) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs ?? {})) el.setAttribute(key, String(value));
  if (text !== undefined) el.textContent = text;
  return el;
}

/** 该小时的本地时间区间标签：「2026-10-08 15:00 – 16:00」。 */
function hourRangeLabel(iso) {
  const end = new Date(Date.parse(iso) + 3_600_000);
  return `${fmtTime(iso)} – ${p2(end.getHours())}:${p2(end.getMinutes())}`;
}

function showError(id, err) {
  const el = $(`#${id}`);
  el.textContent = `加载失败：${err instanceof Error ? err.message : String(err)}`;
  el.classList.remove('usage-hidden');
}

function hideError(id) {
  $(`#${id}`).classList.add('usage-hidden');
}

// ---------------------------------------------------------------- 启动

function init() {
  $('#nav').innerHTML = navHtml('/usage.html');
  for (const btn of document.querySelectorAll('#range-toggle button')) {
    btn.addEventListener('click', () => {
      const days = Number(btn.dataset.days);
      if (!Number.isInteger(days) || days === state.days) return;
      state.days = days;
      for (const other of document.querySelectorAll('#range-toggle button')) {
        other.classList.toggle('active', other === btn);
      }
      hideTooltip();
      refreshHistory();
    });
  }
  // 窗口尺寸变了重画图（卡片宽度跟着变）；拖动中不狂刷。
  let resizeTimer = 0;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(renderChart, 200);
  });
  setInterval(loadAll, REFRESH_MS); // 每 30 秒刷新数据
  setInterval(tickClock, 1000); // 每秒更新双时钟与倒计时
  loadAll();
}

init();
