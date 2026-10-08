// web/common.js 的单元测试（issue #14）：纯函数在 node:test 里直接 import（模块在
// import 时不碰 DOM / fetch，只有调用 api() 才会发起请求——api 的行为由 test/server.test.js
// 端到端覆盖）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { fmtDuration, fmtTime, fmtUnits, navHtml, statusLabel } from '../web/common.js';

test('验收: fmtDuration(65000) 为「1 分 05 秒」', () => {
  assert.equal(fmtDuration(65000), '1 分 05 秒');
});

test('fmtDuration：不足 1 分钟按秒、满 1 小时按「H 小时 MM 分」、null/负数为 -', () => {
  assert.equal(fmtDuration(0), '0 秒');
  assert.equal(fmtDuration(45_000), '45 秒');
  assert.equal(fmtDuration(59_999), '59 秒'); // 秒向下取整，不进位
  assert.equal(fmtDuration(60_000), '1 分 00 秒');
  assert.equal(fmtDuration(3_594_000), '59 分 54 秒');
  assert.equal(fmtDuration(3_600_000), '1 小时 00 分');
  assert.equal(fmtDuration(7_385_000), '2 小时 03 分'); // 2h3m5s
  assert.equal(fmtDuration(null), '-');
  assert.equal(fmtDuration(undefined), '-');
  assert.equal(fmtDuration(-1), '-');
  assert.equal(fmtDuration(Number.NaN), '-');
});

test('验收: statusLabel 五个状态全（failed → 失败）；未知原样返回', () => {
  assert.equal(statusLabel('queued'), '排队中');
  assert.equal(statusLabel('running'), '执行中');
  assert.equal(statusLabel('succeeded'), '成功');
  assert.equal(statusLabel('failed'), '失败');
  assert.equal(statusLabel('canceled'), '已取消');
  assert.equal(statusLabel('weird'), 'weird');
});

test('fmtUnits 保留 1 位小数；null/undefined 为 -', () => {
  assert.equal(fmtUnits(3), '3.0');
  assert.equal(fmtUnits(1.24), '1.2');
  assert.equal(fmtUnits(1.25), '1.3'); // toFixed 四舍五入
  assert.equal(fmtUnits(0), '0.0');
  assert.equal(fmtUnits(null), '-');
  assert.equal(fmtUnits(undefined), '-');
});

test('fmtTime：本地时间到分钟；null/非法为 -', () => {
  // TZ 不定时不断言具体值，只断言形状与稳定性（用同一进程的本地时区）。
  const iso = '2026-10-08T07:30:00Z';
  assert.match(fmtTime(iso), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  assert.equal(fmtTime(iso), fmtTime(new Date(iso).toISOString()));
  assert.equal(fmtTime(null), '-');
  assert.equal(fmtTime(undefined), '-');
  assert.equal(fmtTime('not-a-time'), '-');
});

test('navHtml：队列 / 与额度 /usage.html 两项，命中项带 active', () => {
  const home = navHtml('/');
  assert.ok(home.includes('href="/"'));
  assert.ok(home.includes('href="/usage.html"'));
  assert.ok(home.includes('队列'));
  assert.ok(home.includes('额度'));
  assert.ok(home.includes('class="active"'));
  const usage = navHtml('/usage.html');
  assert.ok(usage.includes('class="active"'));
  assert.ok(!navHtml('/somewhere-else').includes('class="active"'));
});

test('验收: navHtml 有设置项（/settings.html），设置页命中时该项带 class="active"', () => {
  const html = navHtml('/settings.html');
  assert.ok(html.includes('href="/settings.html"'), '应有设置页链接');
  assert.ok(html.includes('设置'), '链接文案应为「设置」');
  assert.ok(html.includes('class="active"'), '设置页自身应命中 active');
  // active 恰好落在设置项上：截取该 <a> 整段核对（其他项不带 active）
  const item = html.split('\n').find((line) => line.includes('/settings.html'));
  assert.match(item, /class="active"/);
  assert.equal(navHtml('/').split('\n').find((line) => line.includes('/settings.html')).includes('active'), false);
});

test('web/common.js 是 ESM 且可被 Node 直接 import（无 DOM 依赖）', () => {
  // 走到这里本身就是证明；再确认导出形状。
  assert.equal(typeof navHtml, 'function');
  assert.equal(typeof statusLabel, 'function');
});
