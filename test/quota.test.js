import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MODEL_MULTIPLIERS,
  PLAN_LIMITS,
  multiplierFor,
  runCost,
  usage,
  canStart,
} from '../src/quota.js';

const NOW = '2026-10-08T12:00:00Z'; // 周四北京 20:00，非高峰
const RUNS = [
  { model: 'glm-5.3', startedAt: '2026-10-08T07:30:00Z' }, // 北京 15:30 高峰 → 3
  { model: 'glm-5.3-flash', startedAt: '2026-10-08T08:00:00Z' }, // 高峰 → 1.2
  { model: 'glm-5.3', startedAt: '2026-10-08T11:00:00Z' }, // 北京 19:00 非高峰 → 1
  { model: 'glm-5.3', startedAt: '2026-10-08T06:30:00Z' }, // 高峰 → 3，但在 5 小时窗口外
];

// 手工构造 usage 结果（canStart 只认这个形状）
const usageResult = (fiveHourUsed, weeklyUsed, resets = {}) => ({
  fiveHour: { used: fiveHourUsed, limit: 1600, ratio: fiveHourUsed / 1600, resetsAt: resets.fiveHour ?? null },
  weekly: { used: weeklyUsed, limit: 8000, ratio: weeklyUsed / 8000, resetsAt: resets.weekly ?? null },
});

// ---------- 常量 ----------

test('MODEL_MULTIPLIERS / PLAN_LIMITS 与规格一致且深层冻结', () => {
  assert.deepEqual(MODEL_MULTIPLIERS, {
    'glm-5.3': { offPeak: 1, peak: 3 },
    'glm-5.3-flash': { offPeak: 0.4, peak: 1.2 },
  });
  assert.deepEqual(PLAN_LIMITS, {
    'v2-lite': { fiveHour: 80, weekly: 400 },
    'v2-pro': { fiveHour: 400, weekly: 2000 },
    'v2-max': { fiveHour: 1600, weekly: 8000 },
  });
  assert.ok(Object.isFrozen(MODEL_MULTIPLIERS));
  assert.ok(Object.isFrozen(MODEL_MULTIPLIERS['glm-5.3']));
  assert.ok(Object.isFrozen(MODEL_MULTIPLIERS['glm-5.3-flash']));
  assert.ok(Object.isFrozen(PLAN_LIMITS));
  assert.ok(Object.isFrozen(PLAN_LIMITS['v2-lite']));
  assert.ok(Object.isFrozen(PLAN_LIMITS['v2-pro']));
  assert.ok(Object.isFrozen(PLAN_LIMITS['v2-max']));
});

// ---------- multiplierFor ----------

test('multiplierFor 验收用例（时间均为 UTC）', () => {
  assert.equal(multiplierFor('glm-5.3', '2026-10-08T07:00:00Z'), 3); // 周四北京 15:00
  assert.equal(multiplierFor('glm-5.3', '2026-10-08T12:00:00Z'), 1); // 北京 20:00
  assert.equal(multiplierFor('GLM-5.3-Flash', '2026-10-08T07:00:00Z'), 1.2);
  assert.equal(multiplierFor('glm-5.3-flash', '2026-10-10T07:00:00Z'), 0.4); // 周六
  assert.equal(multiplierFor('whatever', '2026-10-08T07:00:00Z'), 3); // 未知模型按 glm-5.3
});

test('multiplierFor 模型名去空白、不区分大小写；缺失模型也按 glm-5.3', () => {
  assert.equal(multiplierFor('  glm-5.3  ', '2026-10-08T07:00:00Z'), 3);
  assert.equal(multiplierFor(' GLM-5.3-FLASH ', '2026-10-08T07:00:00Z'), 1.2);
  assert.equal(multiplierFor(undefined, '2026-10-08T12:00:00Z'), 1);
});

test('multiplierFor 的 at 接受 Date / ISO 字符串 / epoch 毫秒，结果一致', () => {
  const d = new Date('2026-10-08T07:00:00Z');
  assert.equal(multiplierFor('glm-5.3', d), 3);
  assert.equal(multiplierFor('glm-5.3', d.getTime()), 3);
  assert.equal(multiplierFor('glm-5.3', '2026-10-08T07:00:00Z'), 3);
});

// ---------- runCost ----------

test('runCost：prompts 缺省 1，按起跑时刻的倍率计', () => {
  assert.equal(runCost({ model: 'glm-5.3', startedAt: '2026-10-08T07:00:00Z' }), 3);
  assert.equal(runCost({ model: 'glm-5.3', startedAt: '2026-10-08T07:00:00Z', prompts: 2 }), 6);
  assert.equal(runCost({ model: 'glm-5.3-flash', startedAt: '2026-10-10T07:00:00Z' }), 0.4);
  assert.ok(Math.abs(runCost({ model: 'glm-5.3-flash', startedAt: '2026-10-10T07:00:00Z', prompts: 3 }) - 1.2) < 1e-9);
  assert.equal(runCost({ model: 'glm-5.3', startedAt: '2026-10-08T12:00:00Z', prompts: 0 }), 0);
  assert.equal(runCost({ model: 'whatever', startedAt: '2026-10-08T07:00:00Z' }), 3); // 未知模型
});

test('runCost：prompts 非法时抛 TypeError', () => {
  const base = { model: 'glm-5.3', startedAt: '2026-10-08T12:00:00Z' };
  for (const bad of [-1, NaN, Infinity, '2', null]) {
    assert.throws(
      () => runCost({ ...base, prompts: bad }),
      TypeError,
      `prompts=${String(bad)} 应抛 TypeError`,
    );
  }
});

test('runCost：startedAt 缺失或非法时抛 TypeError', () => {
  assert.throws(() => runCost({ model: 'glm-5.3' }), TypeError);
  assert.throws(() => runCost({ model: 'glm-5.3', startedAt: 'not-a-time' }), TypeError);
  assert.throws(() => runCost({ model: 'glm-5.3', startedAt: new Date('oops') }), TypeError);
});

// ---------- usage：验收用例 ----------

test('usage 验收用例：5 小时窗口与滚动周窗口', () => {
  const u = usage(RUNS, NOW);
  assert.equal(u.fiveHour.used, 5.2); // 3 + 1.2 + 1，06:30 那条在窗口外
  assert.equal(u.fiveHour.limit, 1600);
  assert.equal(u.fiveHour.ratio, 5.2 / 1600);
  assert.ok(u.fiveHour.resetsAt instanceof Date);
  assert.equal(u.fiveHour.resetsAt.toISOString(), '2026-10-08T12:30:00.000Z'); // 07:30 + 5h
  assert.equal(u.weekly.used, 8.2); // 滚动窗口四条都算
  assert.equal(u.weekly.limit, 8000);
  assert.equal(u.weekly.ratio, 8.2 / 8000);
  assert.equal(u.weekly.resetsAt, null); // 滚动窗口没有 resetsAt
});

test('quotaUnits 直接采用，不重新计算（可为 0；null 视为未提供）', () => {
  const u = usage(
    [
      { model: 'glm-5.3', startedAt: '2026-10-08T07:30:00Z', quotaUnits: 10 }, // 否则应记 3
      { model: 'glm-5.3', startedAt: '2026-10-08T08:00:00Z', quotaUnits: 0 },
      { model: 'glm-5.3-flash', startedAt: '2026-10-08T11:00:00Z', quotaUnits: null }, // 回落到 runCost → 0.4
    ],
    NOW,
  );
  assert.equal(u.fiveHour.used, 10.4);
  const u2 = usage(
    [{ model: 'glm-5.3', startedAt: '2026-10-08T08:00:00Z', prompts: 100, quotaUnits: 10 }],
    NOW,
  );
  assert.equal(u2.fiveHour.used, 10); // quotaUnits 与 prompts 同时给时以 quotaUnits 为准
});

test('weekStart 周期窗口：cycleStart 含边界，resetsAt 为周期结束', () => {
  const u = usage(
    [
      ...RUNS,
      { model: 'glm-5.3', startedAt: '2026-10-08T00:00:00Z' }, // 恰为 cycleStart，计入（×1）
      { model: 'glm-5.3', startedAt: '2026-10-07T23:59:59.999Z' }, // 上一周期，不计入
    ],
    NOW,
    { weekStart: '2026-10-01T00:00:00Z' },
  );
  // 10-08 内：3 + 1.2 + 1 + 3 + 1 = 9.2；10-07 那条被周期窗口排除
  assert.equal(u.weekly.used, 9.2);
  assert.equal(u.weekly.resetsAt.toISOString(), '2026-10-15T00:00:00.000Z');
  // 五小时窗口不受 weekStart 影响
  assert.equal(u.fiveHour.used, 5.2);
});

// ---------- usage：窗口边界 ----------

test('5 小时窗口左开右闭：now−5h 不计入，now 计入；now 之后的运行忽略', () => {
  const runs = [
    { model: 'glm-5.3', startedAt: '2026-10-08T07:00:00.000Z' }, // 恰为 now−5h，不计入
    { model: 'glm-5.3', startedAt: '2026-10-08T07:00:00.001Z' }, // 窗口内最早一条（×3）
    { model: 'glm-5.3', startedAt: '2026-10-08T12:00:00.000Z' }, // 恰为 now，计入（×1）
    { model: 'glm-5.3', startedAt: '2026-10-08T12:00:00.001Z' }, // 未来，两个窗口都忽略
  ];
  const u = usage(runs, NOW);
  assert.equal(u.fiveHour.used, 4);
  assert.equal(u.fiveHour.resetsAt.toISOString(), '2026-10-08T12:00:00.001Z');
  assert.equal(u.weekly.used, 7); // 3 + 3 + 1，未来那条不计
});

test('滚动周窗口左开：恰为 now−7d 的运行不计入', () => {
  const runs = [
    { model: 'glm-5.3', startedAt: '2026-10-01T12:00:00.000Z' }, // 恰为 now−7d，不计入
    { model: 'glm-5.3', startedAt: '2026-10-01T12:00:00.001Z' }, // 计入（北京 20:00 ×1）
  ];
  const u = usage(runs, NOW);
  assert.equal(u.weekly.used, 1);
  assert.equal(u.weekly.resetsAt, null);
});

test('weekStart 晚于 now：周期数为负，回溯到之前的周期，不抛错', () => {
  // k = floor((10-08T12:00 − 10-10T00:00) / 7d) = −1 → cycleStart = 10-03T00:00Z
  const runs = [
    { model: 'glm-5.3', startedAt: '2026-10-03T00:00:00Z' }, // 恰为 cycleStart，计入（×1）
    { model: 'glm-5.3', startedAt: '2026-10-02T23:59:59.999Z' }, // 不计入
  ];
  const u = usage(runs, NOW, { weekStart: '2026-10-10T00:00:00Z' });
  assert.equal(u.weekly.used, 1);
  assert.equal(u.weekly.resetsAt.toISOString(), '2026-10-10T00:00:00.000Z');
});

test('窗口内没有运行时 used 为 0、五小时 resetsAt 为 null；周期窗口的 resetsAt 与有无运行无关', () => {
  const u = usage([], NOW);
  assert.equal(u.fiveHour.used, 0);
  assert.equal(u.fiveHour.ratio, 0);
  assert.equal(u.fiveHour.resetsAt, null);
  assert.equal(u.weekly.used, 0);
  assert.equal(u.weekly.resetsAt, null);

  const w = usage([], NOW, { weekStart: '2026-10-01T00:00:00Z' });
  assert.equal(w.weekly.resetsAt.toISOString(), '2026-10-15T00:00:00.000Z');
});

// ---------- usage：套餐与入参 ----------

test('三个套餐的限额都正确，缺省按 v2-max', () => {
  const expected = {
    'v2-lite': { fiveHour: 80, weekly: 400 },
    'v2-pro': { fiveHour: 400, weekly: 2000 },
    'v2-max': { fiveHour: 1600, weekly: 8000 },
  };
  for (const [plan, limits] of Object.entries(expected)) {
    const u = usage([], NOW, { plan });
    assert.deepEqual({ fiveHour: u.fiveHour.limit, weekly: u.weekly.limit }, limits, plan);
  }
  assert.deepEqual(
    { fiveHour: usage([], NOW).fiveHour.limit, weekly: usage([], NOW).weekly.limit },
    expected['v2-max'],
  );
});

test('未知套餐抛 Error 并点名该套餐（不是 TypeError）', () => {
  assert.throws(
    () => usage([], NOW, { plan: 'v2-nope' }),
    (err) => err instanceof Error && !(err instanceof TypeError) && err.message.includes('v2-nope'),
  );
});

test('时间入参接受 Date / ISO 字符串 / epoch 毫秒，结果一致', () => {
  const runs = [
    { model: 'glm-5.3', startedAt: new Date('2026-10-08T07:30:00Z') },
    { model: 'glm-5.3-flash', startedAt: '2026-10-08T08:00:00Z' },
    { model: 'glm-5.3', startedAt: new Date('2026-10-08T11:00:00Z').getTime() },
  ];
  const viaMixed = usage(runs, new Date(NOW), { weekStart: new Date('2026-10-01T00:00:00Z') });
  const viaStrings = usage(JSON.parse(JSON.stringify(runs)), NOW, { weekStart: '2026-10-01T00:00:00Z' });
  assert.deepEqual(viaMixed, viaStrings);
});

test('时间入参缺失或非法时抛 TypeError', () => {
  assert.throws(() => usage([], undefined), TypeError);
  assert.throws(() => usage([], 'not-a-time'), TypeError);
  assert.throws(() => usage([{ model: 'glm-5.3', startedAt: 'oops' }], NOW), TypeError);
  assert.throws(() => usage([], NOW, { weekStart: 'oops' }), TypeError);
  assert.throws(() => multiplierFor('glm-5.3', 'oops'), TypeError);
  assert.throws(() => multiplierFor('glm-5.3'), TypeError);
});

test('runs 不是数组或元素不是对象时抛 TypeError', () => {
  assert.throws(() => usage(null, NOW), TypeError);
  assert.throws(() => usage('x', NOW), TypeError);
  assert.throws(() => usage([null], NOW), TypeError);
  assert.throws(() => usage([42], NOW), TypeError);
});

test('quotaUnits 非法（负数 / NaN / Infinity / 字符串）时抛 TypeError', () => {
  for (const bad of [-1, NaN, Infinity, '10']) {
    assert.throws(
      () => usage([{ model: 'glm-5.3', startedAt: '2026-10-08T07:30:00Z', quotaUnits: bad }], NOW),
      TypeError,
      `quotaUnits=${String(bad)} 应抛 TypeError`,
    );
  }
});

test('usage 不修改任何入参', () => {
  const runs = structuredClone(RUNS);
  const snapshot = structuredClone(RUNS);
  const now = new Date(NOW);
  usage(runs, now, { plan: 'v2-pro', weekStart: '2026-10-01T00:00:00Z' });
  assert.deepEqual(runs, snapshot);
  assert.equal(now.toISOString(), '2026-10-08T12:00:00.000Z');
});

// ---------- canStart ----------

test('canStart 验收用例：1600 × 0.9 = 1440', () => {
  assert.deepEqual(canStart(usageResult(1430, 0), { nextCost: 3 }), { ok: true });
  const blocked = canStart(usageResult(1439, 0), { nextCost: 3 }); // 1442 > 1440
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason, 'five-hour');
});

test('canStart：恰好等于 limit × safetyRatio 也放行（浮点容差 1e-9）', () => {
  // 1437 + 3 = 1440 = 1600 × 0.9
  assert.deepEqual(canStart(usageResult(1437, 0), { nextCost: 3 }), { ok: true });
});

test('canStart：周额度超限报 weekly；两项都超报 five-hour', () => {
  const weekly = canStart(usageResult(0, 7199), { nextCost: 3 }); // 7202 > 8000 × 0.9
  assert.equal(weekly.ok, false);
  assert.equal(weekly.reason, 'weekly');
  const both = canStart(usageResult(1439, 7199), { nextCost: 3 });
  assert.equal(both.ok, false);
  assert.equal(both.reason, 'five-hour');
});

test('canStart：失败时带回对应窗口的 resetsAt（滚动窗口时为 null）', () => {
  const fiveHourReset = new Date('2026-10-08T12:30:00Z');
  const weeklyReset = new Date('2026-10-15T00:00:00Z');
  const fiveHourBlocked = canStart(
    usageResult(1439, 0, { fiveHour: fiveHourReset }),
    { nextCost: 3 },
  );
  assert.equal(fiveHourBlocked.resetsAt, fiveHourReset);
  const weeklyBlocked = canStart(
    usageResult(0, 7199, { weekly: weeklyReset }),
    { nextCost: 3 },
  );
  assert.equal(weeklyBlocked.resetsAt, weeklyReset);
  assert.equal(canStart(usageResult(1439, 0), { nextCost: 3 }).resetsAt, null);
});

test('canStart：safetyRatio 缺省 0.9，显式给值生效，非法值抛 TypeError', () => {
  // 1433 ≤ 1440（0.9）放行，但 1433 > 1600 × 0.85 = 1360 → 拦
  assert.deepEqual(canStart(usageResult(1430, 0), { nextCost: 3 }), { ok: true });
  assert.equal(canStart(usageResult(1430, 0), { nextCost: 3, safetyRatio: 0.85 }).reason, 'five-hour');
  for (const bad of [-0.1, NaN, Infinity, 'x', null]) {
    assert.throws(
      () => canStart(usageResult(0, 0), { nextCost: 1, safetyRatio: bad }),
      TypeError,
      `safetyRatio=${String(bad)} 应抛 TypeError`,
    );
  }
});

test('canStart：nextCost 缺失或非法时抛 TypeError', () => {
  for (const bad of [-1, NaN, Infinity, '3', null, undefined]) {
    assert.throws(
      () => canStart(usageResult(0, 0), { nextCost: bad }),
      TypeError,
      `nextCost=${String(bad)} 应抛 TypeError`,
    );
  }
  assert.throws(() => canStart(usageResult(0, 0)), TypeError); // 整个 options 缺失
});

test('canStart：usageResult 形状非法时抛 TypeError', () => {
  assert.throws(() => canStart(null, { nextCost: 1 }), TypeError);
  assert.throws(() => canStart('x', { nextCost: 1 }), TypeError);
  assert.throws(() => canStart({}, { nextCost: 1 }), TypeError); // 缺 fiveHour / weekly
});

test('canStart 不修改传入的 usageResult', () => {
  const u = usage(RUNS, NOW, { weekStart: '2026-10-01T00:00:00Z' });
  const snapshot = structuredClone(u);
  canStart(u, { nextCost: 3 });
  assert.deepEqual(u, snapshot);
});
