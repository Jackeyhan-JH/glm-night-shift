// src/stats.js 的单元测试（issue #14）：hourlyUsage 按 UTC 整点小时汇总用量。
import test from 'node:test';
import assert from 'node:assert/strict';
import { HISTORY_DAYS_MAX, HISTORY_DAYS_MIN, hourlyUsage } from '../src/stats.js';

// 与 #4 验收同款的一组运行（见 test/quota.test.js）。
const RUNS = [
  { model: 'glm-5.3', startedAt: '2026-10-08T07:30:00Z' }, // 高峰 → 3
  { model: 'glm-5.3-flash', startedAt: '2026-10-08T08:00:00Z' }, // 高峰 → 1.2
  { model: 'glm-5.3', startedAt: '2026-10-08T11:00:00Z' }, // 非高峰 → 1
  { model: 'glm-5.3', startedAt: '2026-10-08T06:30:00Z' }, // 高峰 → 3
];

test('验收: now=2026-10-08T12:00Z、days=1 → 24 桶，07:00 桶 glm-5.3=3，08:00 桶 flash=1.2', () => {
  const result = hourlyUsage(RUNS, '2026-10-08T12:00:00Z', 1);
  assert.equal(result.buckets.length, 24);
  assert.equal(result.from, '2026-10-07T13:00:00.000Z'); // floorHour(now) − 23h
  assert.equal(result.to, '2026-10-08T12:00:00.000Z');
  const at07 = result.buckets.find((b) => b.hour === '2026-10-08T07:00:00.000Z');
  assert.equal(at07.byModel['glm-5.3'], 3);
  assert.equal(at07.total, 3);
  const at08 = result.buckets.find((b) => b.hour === '2026-10-08T08:00:00.000Z');
  assert.equal(at08.byModel['glm-5.3-flash'], 1.2);
  assert.equal(at08.total, 1.2);
  const at11 = result.buckets.find((b) => b.hour === '2026-10-08T11:00:00.000Z');
  assert.equal(at11.byModel['glm-5.3'], 1);
  // 06:30 在窗口内（首桶是 07-07T13:00），落进自己的 06:00 桶
  const at06 = result.buckets.find((b) => b.hour === '2026-10-08T06:00:00.000Z');
  assert.equal(at06.byModel['glm-5.3'], 3, '06:30 的运行计入 06:00 桶');
});

test('窗口之前的运行不计入（首桶起点 07-07T13:00 之前一毫秒）', () => {
  const runs = [{ model: 'glm-5.3', startedAt: '2026-10-07T12:59:59.999Z' }];
  const result = hourlyUsage(runs, '2026-10-08T12:00:00Z', 1);
  assert.equal(result.buckets.length, 24);
  assert.ok(result.buckets.every((b) => b.total === 0));
});

test('每个小时都有一项（含整点边界的桶）、按时间升序、空桶 total 为 0 且 byModel 为空对象', () => {
  const result = hourlyUsage([], new Date('2026-10-08T12:34:56Z'), 2);
  assert.equal(result.buckets.length, 48);
  for (let i = 1; i < result.buckets.length; i++) {
    assert.ok(result.buckets[i - 1].hour < result.buckets[i].hour, '时间升序');
  }
  assert.deepEqual(result.buckets[0], { hour: '2026-10-06T13:00:00.000Z', byModel: {}, total: 0 });
  assert.deepEqual(result.buckets[47], { hour: '2026-10-08T12:00:00.000Z', byModel: {}, total: 0 });
  // from 与第一个桶一致
  assert.equal(result.from, result.buckets[0].hour);
});

test('桶边界：startedAt 恰在首桶起点计入、恰为 now 计入；晚于 now 不计入', () => {
  const now = '2026-10-08T12:00:00Z';
  const runs = [
    { model: 'glm-5.3', startedAt: '2026-10-07T13:00:00Z' }, // 恰在首桶起点（07:30 高峰无关，此刻非高峰 → 1）
    { model: 'glm-5.3-flash', startedAt: '2026-10-08T12:00:00Z' }, // 恰为 now
    { model: 'glm-5.3', startedAt: '2026-10-08T12:00:00.001Z' }, // 晚于 now
  ];
  const result = hourlyUsage(runs, now, 1);
  const first = result.buckets[0];
  assert.equal(first.byModel['glm-5.3'], 1);
  const last = result.buckets[23];
  assert.equal(last.byModel['glm-5.3-flash'], 0.4); // 12:00 北京 20:00 非高峰
  assert.ok(!('glm-5.3' in last.byModel), '晚于 now 的运行不计入');
  // 北京 07-07T13:00 = 21:00 非高峰 → 1；北京 07-07T12:00 = 20:00 也非高峰
});

test('quotaUnits 优先于 runCost；prompts 参与 runCost 计算', () => {
  const runs = [
    { model: 'glm-5.3', startedAt: '2026-10-08T07:10:00Z', quotaUnits: 10 }, // 高峰本应 3，直接采 10
    { model: 'glm-5.3', startedAt: '2026-10-08T07:20:00Z', prompts: 2 }, // 3 × 2 = 6
    { model: 'glm-5.3', startedAt: '2026-10-08T07:30:00Z', quotaUnits: 0 }, // 0 也采用
  ];
  const result = hourlyUsage(runs, '2026-10-08T08:00:00Z', 1);
  const bucket = result.buckets.find((b) => b.hour === '2026-10-08T07:00:00.000Z');
  assert.equal(bucket.byModel['glm-5.3'], 16);
  assert.equal(bucket.total, 16);
});

test('同桶多模型分组、浮点求和四舍五入到 2 位小数（0.4+0.4+1.2 不出毛刺）', () => {
  const runs = [
    { model: 'glm-5.3-flash', startedAt: '2026-10-08T12:10:00Z', prompts: 1 }, // 0.4
    { model: 'glm-5.3-flash', startedAt: '2026-10-08T12:20:00Z', prompts: 1 }, // 0.4
    { model: 'glm-5.3-flash', startedAt: '2026-10-08T12:30:00Z', prompts: 3 }, // 1.2
  ];
  const result = hourlyUsage(runs, '2026-10-08T13:00:00Z', 1);
  const bucket = result.buckets.find((b) => b.hour === '2026-10-08T12:00:00.000Z');
  assert.equal(bucket.byModel['glm-5.3-flash'], 2);
  assert.equal(bucket.total, 2);
});

test('时间入参接受 Date / ISO 字符串 / epoch 毫秒；不修改入参数组', () => {
  const runs = [{ model: 'glm-5.3', startedAt: '2026-10-08T07:30:00Z' }];
  const snapshot = JSON.stringify(runs);
  const a = hourlyUsage(runs, new Date('2026-10-08T12:00:00Z'), 1);
  const b = hourlyUsage(runs, Date.parse('2026-10-08T12:00:00Z'), 1);
  assert.deepEqual(a, b);
  assert.equal(JSON.stringify(runs), snapshot);
});

test('days 非法（0、31、1.5、abc、缺省）抛 TypeError 点名 days', () => {
  for (const bad of [0, 31, 1.5, 'abc', undefined, null]) {
    assert.throws(
      () => hourlyUsage([], new Date(), bad),
      (err) => err instanceof TypeError && err.message.includes('days'),
      `days=${JSON.stringify(bad)} 应抛 TypeError`,
    );
  }
  assert.equal(HISTORY_DAYS_MIN, 1);
  assert.equal(HISTORY_DAYS_MAX, 30);
});

test('days=30（上限）：720 个桶', () => {
  const result = hourlyUsage([], '2026-10-08T12:00:00Z', 30);
  assert.equal(result.buckets.length, 30 * 24);
});

test('runs 非数组或元素非对象抛 TypeError', () => {
  assert.throws(() => hourlyUsage('nope', new Date(), 1), TypeError);
  assert.throws(() => hourlyUsage([42], new Date(), 1), TypeError);
  assert.throws(() => hourlyUsage([{ model: 'x', startedAt: 'oops' }], new Date(), 1), TypeError);
});
