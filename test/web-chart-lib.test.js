// web/chart-lib.js 的单元测试（issue #17 验收项）：纯函数在 node:test 里直接 import。
// 高峰带相关用例复用 src/peak.js 的 peakWindows 造窗口（浏览器里 usage.js 走 /src/peak.js）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { peakWindows } from '../src/peak.js';
import {
  MAX_SERIES,
  MS_PER_HOUR,
  OTHER_KEY,
  bandPositions,
  barGeometry,
  chartDomain,
  fmtAtOffset,
  fmtCountdown,
  fmtValue,
  layoutBars,
  localMidnights,
  meterState,
  niceTicks,
  partsAtOffset,
  serverNow,
  seriesOrder,
  stackSeries,
  timeX,
  tooltipLines,
} from '../web/chart-lib.js';

const CLOSE = 1e-9;

// ---------- 刻度 ----------

test('验收: 最大值 5.2 时纵轴刻度为整齐数值（0/2/4/6）', () => {
  assert.deepEqual(niceTicks(5.2), [0, 2, 4, 6]);
});

test('niceTicks：顶刻度覆盖最大值；0/负数/非法给 [0,1]；刻度数不超上限', () => {
  assert.deepEqual(niceTicks(8), [0, 2, 4, 6, 8]); // 恰好整除也覆盖
  assert.deepEqual(niceTicks(0), [0, 1]);
  assert.deepEqual(niceTicks(-3), [0, 1]);
  assert.deepEqual(niceTicks(Number.NaN), [0, 1]);
  for (const max of [1, 3.7, 12, 99.5, 1600, 8000, 0.4]) {
    const ticks = niceTicks(max);
    assert.ok(ticks.length <= 5, `${max}：刻度数 ${ticks.length} ≤ 5`);
    assert.ok(ticks[0] === 0, `${max}：从 0 起`);
    assert.ok(ticks[ticks.length - 1] >= max, `${max}：顶刻度 ${ticks.at(-1)} ≥ 最大值`);
    for (let i = 1; i < ticks.length; i++) {
      const multiple = ticks[i] / ticks[1];
      assert.ok(
        Math.abs(multiple - Math.round(multiple)) < 1e-9,
        `${max}：${ticks[i]} 应是 ${ticks[1]} 的整数倍`,
      );
    }
  }
});

// ---------- 堆叠 ----------

test('验收: 两个模型同一小时 3 和 1.2 → 堆叠后第二段的起点等于第一段的高度', () => {
  const bucket = {
    hour: '2026-10-08T07:00:00.000Z',
    byModel: { 'glm-5.3': 3, 'glm-5.3-flash': 1.2 },
    total: 4.2,
  };
  const order = ['glm-5.3', 'glm-5.3-flash'];
  const segments = stackSeries(bucket, order);
  assert.equal(segments.length, 2);
  assert.equal(segments[0].key, 'glm-5.3');
  assert.equal(segments[0].base, 0);
  assert.equal(segments[0].value, 3);
  assert.equal(segments[1].key, 'glm-5.3-flash');
  assert.equal(segments[1].base, 3); // 起点 = 第一段的高度
  assert.equal(segments[1].value, 1.2);
});

test('堆叠的像素坐标：gap=0 时上下两段严丝合缝；默认 gap=2 时下段顶部让出 2px', () => {
  const bucket = {
    hour: '2026-10-08T07:00:00.000Z',
    byModel: { 'glm-5.3': 3, 'glm-5.3-flash': 1.2 },
    total: 4.2,
  };
  const order = ['glm-5.3', 'glm-5.3-flash'];
  const plot = { x0: 0, x1: 100, y0: 100, y1: 0 };
  const flush = layoutBars({ buckets: [bucket], order, plot, gap: 0 });
  const [lower, upper] = flush.bars[0].segments;
  assert.ok(Math.abs(upper.y + upper.height - lower.y) < CLOSE, 'gap=0：上段底边 = 下段顶边');
  assert.equal(lower.top, false);
  assert.equal(upper.top, true);

  const gapped = layoutBars({ buckets: [bucket], order, plot, gap: 2 });
  const [lower2] = gapped.bars[0].segments;
  assert.ok(Math.abs(lower2.height - (lower.height - 2)) < CLOSE, 'gap=2：下段高度少 2px');
});

test('stackSeries：值为 0 的模型不出段；空桶 / 非法桶为空数组；多余模型折叠进「其他」', () => {
  assert.deepEqual(
    stackSeries({ byModel: { 'glm-5.3': 0 } }, ['glm-5.3']),
    [],
  );
  assert.deepEqual(stackSeries({}, ['glm-5.3']), []);
  assert.deepEqual(stackSeries(null, ['glm-5.3']), []);

  const order = ['glm-5.3', 'glm-5.3-flash', OTHER_KEY];
  const segments = stackSeries(
    { byModel: { 'glm-5.3': 1, 'zzz': 2.5, 'aaa': 0.5 } },
    order,
  );
  assert.deepEqual(
    segments.map((s) => [s.key, s.value, s.base]),
    [['glm-5.3', 1, 0], [OTHER_KEY, 3, 1]],
  );
});

// ---------- 柱子横向几何 ----------

test('验收: 24 个小时的柱子横坐标单调递增且不重叠（168 / 720 同理）', () => {
  for (const count of [24, 168, 720]) {
    const { bars } = barGeometry(count, 960);
    assert.equal(bars.length, count);
    for (let i = 1; i < bars.length; i++) {
      assert.ok(bars[i].x > bars[i - 1].x, `${count} 根：第 ${i} 根 x 应严格递增`);
      assert.ok(
        bars[i - 1].x + bars[i - 1].width <= bars[i].x + CLOSE,
        `${count} 根：第 ${i} 根与上一根不重叠`,
      );
    }
    assert.ok(bars[0].x >= 0 && bars.at(-1).x + bars.at(-1).width <= 960 + CLOSE, '都在绘图区内');
  }
  assert.deepEqual(barGeometry(0, 960).bars, []);
  assert.deepEqual(barGeometry(24, 0).bars, []);
});

test('barGeometry：柱宽有上限（24px）且永不超过格宽', () => {
  const wide = barGeometry(4, 400); // 格宽 100px，柱宽被钳到 24
  assert.equal(wide.bars[0].width, 24);
  const narrow = barGeometry(720, 960); // 格宽 ~1.33px，柱宽 ≤ 格宽
  assert.ok(narrow.bars[0].width <= narrow.step + CLOSE);
  assert.ok(narrow.step > 0);
});

// ---------- 高峰带 ----------

test('验收: 给定周四的数据，北京时间 14:00–18:00 对应的高峰带位置正确', () => {
  // 周四 2026-10-08（UTC 0 点起 24 小时）：peakWindows 给出 06:00Z–10:00Z 一段
  const windows = peakWindows(new Date('2026-10-08T00:00:00Z'), new Date('2026-10-09T00:00:00Z'));
  assert.equal(windows.length, 1);
  assert.equal(windows[0].start.toISOString(), '2026-10-08T06:00:00.000Z'); // 北京 14:00
  assert.equal(windows[0].end.toISOString(), '2026-10-08T10:00:00.000Z'); // 北京 18:00

  const domain = chartDomain([
    { hour: '2026-10-08T00:00:00.000Z' },
    { hour: '2026-10-08T23:00:00.000Z' },
  ]);
  assert.equal(domain.fromTs, Date.parse('2026-10-08T00:00:00.000Z'));
  assert.equal(domain.toTs, Date.parse('2026-10-09T00:00:00.000Z'));

  const bands = bandPositions(windows, domain, 0, 960);
  assert.equal(bands.length, 1);
  assert.ok(Math.abs(bands[0].x - 240) < CLOSE, `带起点 6/24 × 960 = 240，实际 ${bands[0].x}`);
  assert.ok(Math.abs(bands[0].width - 160) < CLOSE, `带宽 4/24 × 960 = 160，实际 ${bands[0].width}`);
});

test('bandPositions：跨界窗口被裁剪到域内；域外窗口不返回；周窗口按天并列', () => {
  // 域从周三 22:00Z 起：周三的高峰段 06:00–10:00Z 只剩…… 22:00 之前的都裁掉 → 不返回；
  // 周四段 06:00–10:00Z 全保留。
  const windows = peakWindows(new Date('2026-10-07T22:00:00Z'), new Date('2026-10-10T00:00:00Z'));
  assert.equal(windows.length, 2); // 周四、周五
  const domain = { fromTs: Date.parse('2026-10-08T00:00:00Z'), toTs: Date.parse('2026-10-10T00:00:00Z') };
  const bands = bandPositions(windows, domain, 0, 480);
  assert.equal(bands.length, 2);
  assert.ok(Math.abs(bands[0].x - 60) < CLOSE, '周四段：+6h / 48h × 480 = 60');
  assert.ok(Math.abs(bands[0].width - 40) < CLOSE, '段宽 4h / 48h × 480 = 40');
  assert.ok(Math.abs(bands[1].x - 300) < CLOSE, '周五段：+30h / 48h × 480 = 300');
  // 起点在域内、终点越出域尾：裁剪到 x1
  const clipped = bandPositions(
    [{ start: '2026-10-09T22:00:00Z', end: '2026-10-10T06:00:00Z' }],
    domain,
    0,
    480,
  );
  assert.equal(clipped.length, 1);
  assert.ok(Math.abs(clipped[0].x + clipped[0].width - 480) < CLOSE, '裁剪到右边界');
  assert.deepEqual(bandPositions(windows, null, 0, 480), []);
  assert.deepEqual(bandPositions(null, domain, 0, 480), []);
});

test('timeX：域两端映射到 x0 / x1，线性居中', () => {
  const domain = { fromTs: 0, toTs: 100 };
  assert.equal(timeX(0, domain, 10, 110), 10);
  assert.equal(timeX(100, domain, 10, 110), 110);
  assert.equal(timeX(50, domain, 10, 110), 60);
});

// ---------- 横轴按天标注 ----------

test('localMidnights：域内每个本地零点各一个、间隔一整天；不含域端点', () => {
  const from = Date.parse('2026-10-06T13:00:00Z');
  const to = from + 3 * 24 * MS_PER_HOUR; // 72 小时，跨 3 个本地零点
  const midnights = localMidnights(from, to);
  // 独立口径核对：按「本地日期翻页」数天数
  let dayChanges = 0;
  let currentDay = new Date(from).getDate();
  for (let ts = from; ts < to; ts += MS_PER_HOUR / 2) {
    const day = new Date(ts).getDate();
    if (day !== currentDay) {
      dayChanges += 1;
      currentDay = day;
    }
  }
  assert.equal(midnights.length, dayChanges);
  assert.ok(midnights.length >= 2 && midnights.length <= 4, `72 小时应跨 2～4 个零点：${midnights.length}`);
  for (const ts of midnights) {
    const d = new Date(ts);
    assert.equal(d.getHours(), 0);
    assert.equal(d.getMinutes(), 0);
    assert.ok(ts > from && ts < to, '不含域端点');
  }
  for (let i = 1; i < midnights.length; i++) {
    assert.equal(midnights[i] - midnights[i - 1], 24 * MS_PER_HOUR);
  }
  assert.deepEqual(localMidnights(to, from), []);
});

// ---------- 整图布局 ----------

test('layoutBars：桶数 = 柱数；空数据不抛错、刻度给 [0,1]；总量取最大桶', () => {
  const zeroBuckets = Array.from({ length: 24 }, (_, i) => ({
    hour: new Date(Date.parse('2026-10-07T13:00:00Z') + i * MS_PER_HOUR).toISOString(),
    byModel: {},
    total: 0,
  }));
  const layout = layoutBars({
    buckets: zeroBuckets,
    order: ['glm-5.3', 'glm-5.3-flash'],
    plot: { x0: 0, x1: 960, y0: 200, y1: 20 },
  });
  assert.equal(layout.bars.length, 24);
  assert.deepEqual(layout.ticks.map((t) => t.value), [0, 1]);
  assert.deepEqual(layout.ticks.map((t) => t.label), ['0', '1']);
  assert.ok(layout.bars.every((bar) => bar.segments.length === 0));
  assert.ok(layout.bars.every((bar) => bar.total === 0));
  assert.deepEqual(layoutBars({ buckets: [], order: [], plot: {} }).bars, []);
});

test('layoutBars：柱底在基线、柱顶不超过绘图区顶部；cellX 是悬停命中格', () => {
  const buckets = [
    { hour: '2026-10-08T07:00:00.000Z', byModel: { 'glm-5.3': 3, 'glm-5.3-flash': 1.2 }, total: 4.2 },
    { hour: '2026-10-08T08:00:00.000Z', byModel: {}, total: 0 },
  ];
  const plot = { x0: 0, x1: 200, y0: 180, y1: 20 };
  const layout = layoutBars({ buckets, order: ['glm-5.3', 'glm-5.3-flash'], plot });
  const bar = layout.bars[0];
  // 刻度 [0,2,4,6]：4.2 映射后顶段顶端不低于 y1
  const top = bar.segments[bar.segments.length - 1].y;
  assert.ok(top >= plot.y1 - CLOSE, `柱顶 ${top} 不越过绘图区顶部 ${plot.y1}`);
  assert.ok(Math.abs(bar.segments[0].y + bar.segments[0].height - plot.y0) < CLOSE, '底段坐在基线上');
  assert.ok(Math.abs(bar.cellWidth - 100) < CLOSE);
  assert.ok(bar.cellX <= bar.x && bar.x + bar.width <= bar.cellX + bar.cellWidth + CLOSE);
});

// ---------- 时钟 / 倒计时 / 时区 ----------

test('验收: 服务端 now=07:00Z（周四北京 15:00）、下次切换 10:00Z → 倒计时约 3 小时（03:00:00）', () => {
  const remaining = Date.parse('2026-10-08T10:00:00.000Z') - Date.parse('2026-10-08T07:00:00.000Z');
  assert.equal(remaining, 3 * MS_PER_HOUR);
  assert.equal(fmtCountdown(remaining), '03:00:00');
});

test('fmtCountdown：秒级进位、跨周末长倒计时、负数 / 非法钳到 0', () => {
  assert.equal(fmtCountdown(0), '00:00:00');
  assert.equal(fmtCountdown(59_999), '00:00:59'); // 向下取整到秒，不进位
  assert.equal(fmtCountdown(3_600_000), '01:00:00');
  assert.equal(fmtCountdown(3_723_000), '01:02:03');
  assert.equal(fmtCountdown(68 * 3_600_000), '68:00:00'); // 周五 18:00 → 下周一 14:00
  assert.equal(fmtCountdown(-1), '00:00:00');
  assert.equal(fmtCountdown(Number.NaN), '00:00:00');
});

test('serverNow：基准 + 已过时间；负的 elapsed 按 0；非法基准为 null', () => {
  const base = Date.parse('2026-10-08T12:00:00Z');
  assert.equal(serverNow(base, 5_000).getTime(), base + 5_000);
  assert.equal(serverNow('2026-10-08T12:00:00.000Z', 0).toISOString(), '2026-10-08T12:00:00.000Z');
  assert.equal(serverNow(base, -100).getTime(), base); // 不往回拨
  assert.equal(serverNow('oops', 0), null);
});

test('fmtAtOffset / partsAtOffset：北京时间 = UTC+8，星期与日历分量正确', () => {
  assert.equal(fmtAtOffset('2026-10-08T12:00:00Z', 480), '2026-10-08 20:00');
  assert.equal(fmtAtOffset('2026-10-08T16:00:00Z', 480), '2026-10-09 00:00'); // 跨日
  assert.equal(fmtAtOffset('2026-10-08T12:00:00Z', 0), '2026-10-08 12:00');
  assert.equal(fmtAtOffset('oops', 480), '-');
  const parts = partsAtOffset('2026-10-08T12:00:00Z', 480);
  assert.deepEqual(
    [parts.year, parts.month, parts.day, parts.hour, parts.minute, parts.weekday],
    [2026, 10, 8, 20, 0, 4], // 北京周四 20:00
  );
  assert.equal(partsAtOffset(null, 480), null);
});

// ---------- 进度条状态与数值格式 ----------

test('验收: ratio 超 safetyRatio 标黄（warn）、超 100% 标红（danger），恰好等于不算超', () => {
  assert.equal(meterState(5.2 / 1600, 0.9), 'ok');
  assert.equal(meterState(1500 / 1600, 0.9), 'warn'); // 0.9375 > 0.9
  assert.equal(meterState(0.9, 0.9), 'ok'); // 恰好等于安全阈值
  assert.equal(meterState(1.0, 0.9), 'warn'); // 恰好 100% 还不算「超过」
  assert.equal(meterState(1.005, 0.9), 'danger'); // 超过 100% → 红
  assert.equal(meterState(Number.NaN, 0.9), 'ok');
});

test('fmtValue：去尾零（3 → 3、1.2 → 1.2、5.2 → 5.2）；非法为 0', () => {
  assert.equal(fmtValue(3), '3');
  assert.equal(fmtValue(1.2), '1.2');
  assert.equal(fmtValue(5.2), '5.2');
  assert.equal(fmtValue(1500), '1500');
  assert.equal(fmtValue(0.30000000000000004), '0.3');
  assert.equal(fmtValue(0), '0');
  assert.equal(fmtValue(Number.NaN), '0');
});

// ---------- 系列顺序与悬停读数 ----------

test('seriesOrder：色随实体——已知模型固定前两槽、与传入顺序无关；未知按字母序；超上限折叠', () => {
  const a = seriesOrder(['glm-5.3-flash', 'glm-5.3']);
  const b = seriesOrder(['glm-5.3', 'glm-5.3-flash']);
  assert.deepEqual(a.order, ['glm-5.3', 'glm-5.3-flash']);
  assert.equal(a.colors.get('glm-5.3'), b.colors.get('glm-5.3'));
  assert.equal(a.colors.get('glm-5.3-flash'), b.colors.get('glm-5.3-flash'));
  assert.equal(a.folded, false);

  const mixed = seriesOrder(['zzz', 'glm-5.3-flash', 'aaa', 'glm-5.3']);
  assert.deepEqual(mixed.order, ['glm-5.3', 'glm-5.3-flash', 'aaa', 'zzz']);

  const many = seriesOrder(['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8', 'm9'], { max: MAX_SERIES });
  assert.equal(many.folded, true);
  assert.equal(many.order.length, MAX_SERIES);
  assert.equal(many.order.at(-1), OTHER_KEY);
  assert.equal(many.order.filter((k) => k !== OTHER_KEY).length, MAX_SERIES - 1);
});

test('验收: 悬停 07:00Z 那根显示 glm-5.3 3（tooltipLines 按系列顺序给值与合计）', () => {
  const bucket = { hour: '2026-10-08T07:00:00.000Z', byModel: { 'glm-5.3': 3 }, total: 3 };
  const { rows, total } = tooltipLines(bucket, ['glm-5.3', 'glm-5.3-flash']);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].key, 'glm-5.3');
  assert.equal(rows[0].value, 3);
  assert.equal(total, 3);

  const two = tooltipLines(
    { hour: '2026-10-08T08:00:00.000Z', byModel: { 'glm-5.3': 1, 'glm-5.3-flash': 1.2 }, total: 2.2 },
    ['glm-5.3', 'glm-5.3-flash'],
  );
  assert.deepEqual(two.rows.map((r) => [r.key, r.value]), [['glm-5.3', 1], ['glm-5.3-flash', 1.2]]);
  assert.equal(two.total, 2.2);

  const empty = tooltipLines({ hour: 'x', byModel: {}, total: 0 }, ['glm-5.3']);
  assert.deepEqual(empty.rows, []);
  assert.equal(empty.total, 0);
});
