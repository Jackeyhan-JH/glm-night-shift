import test from 'node:test';
import assert from 'node:assert/strict';
import { startDecision } from '../src/gate.js';
import { usage } from '../src/quota.js';

// 空记录的 usage：两项都是 0，任何正常的 nextCost 都放行
const okUsage = () => usage([], '2026-10-08T12:00:00Z');

test('验收: startDecision 周四北京 15:00、allowPeak 与 configAllowPeak 均为 false → reason:"peak"、retryAt=2026-10-08T10:00Z', () => {
  const d = startDecision({
    now: '2026-10-08T07:00:00Z', // 周四北京 15:00
    model: 'glm-5.3',
    allowPeak: false,
    configAllowPeak: false,
    usage: okUsage(),
  });
  assert.deepEqual(d, {
    ok: false,
    reason: 'peak',
    nextCost: 3,
    peak: true,
    retryAt: new Date('2026-10-08T10:00:00.000Z'),
  });
});

test('验收: startDecision 任务 allowPeak:true → 不因高峰拦截，nextCost=3', () => {
  const d = startDecision({
    now: '2026-10-08T07:00:00Z',
    model: 'glm-5.3',
    allowPeak: true,
    configAllowPeak: false,
    usage: okUsage(),
  });
  assert.deepEqual(d, { ok: true, reason: null, nextCost: 3, peak: true, retryAt: null });
});

test('配置 configAllowPeak: true → 同样不因高峰拦截', () => {
  const d = startDecision({
    now: '2026-10-08T07:00:00Z',
    model: 'glm-5.3',
    allowPeak: false,
    configAllowPeak: true,
    usage: okUsage(),
  });
  assert.deepEqual(d, { ok: true, reason: null, nextCost: 3, peak: true, retryAt: null });
});

test('allowPeak / configAllowPeak 缺省视为不允许', () => {
  const d = startDecision({
    now: '2026-10-08T07:00:00Z',
    model: 'glm-5.3',
    usage: okUsage(),
  });
  assert.equal(d.ok, false);
  assert.equal(d.reason, 'peak');
});

test('非高峰：正常放行，peak false、nextCost 按非高峰倍率', () => {
  const d = startDecision({
    now: '2026-10-08T12:00:00Z', // 北京 20:00
    model: 'glm-5.3-flash',
    allowPeak: false,
    configAllowPeak: false,
    usage: okUsage(),
  });
  assert.deepEqual(d, { ok: true, reason: null, nextCost: 0.4, peak: false, retryAt: null });
});

test('高峰被拦时 flash 模型的 nextCost 也按高峰倍率（1.2），五个字段齐全', () => {
  const d = startDecision({
    now: '2026-10-08T07:00:00Z',
    model: 'GLM-5.3-Flash',
    allowPeak: false,
    configAllowPeak: false,
    usage: okUsage(),
  });
  assert.equal(d.reason, 'peak');
  assert.equal(d.nextCost, 1.2);
  assert.deepEqual(Object.keys(d).sort(), ['nextCost', 'ok', 'peak', 'reason', 'retryAt']);
});

test('周五北京 17:00 被高峰拦时 retryAt 为当天 10:00Z（北京 18:00）', () => {
  const d = startDecision({
    now: '2026-10-09T09:00:00Z',
    model: 'glm-5.3',
    allowPeak: false,
    configAllowPeak: false,
    usage: okUsage(),
  });
  assert.equal(d.reason, 'peak');
  assert.equal(d.retryAt.toISOString(), '2026-10-09T10:00:00.000Z');
});

test('五小时额度不足：reason five-hour，retryAt 为该窗口的 resetsAt', () => {
  const u = usage(
    [{ model: 'glm-5.3', startedAt: '2026-10-08T07:30:00Z', prompts: 480 }], // 480 × 3 = 1440
    '2026-10-08T12:00:00Z',
  );
  assert.equal(u.fiveHour.used, 1440);
  const d = startDecision({
    now: '2026-10-08T12:00:00Z',
    model: 'glm-5.3',
    allowPeak: false,
    configAllowPeak: false,
    usage: u,
  });
  assert.equal(d.ok, false);
  assert.equal(d.reason, 'five-hour');
  assert.equal(d.peak, false);
  assert.equal(d.retryAt.toISOString(), '2026-10-08T12:30:00.000Z');
});

test('周额度不足：reason weekly，retryAt 为周期结束', () => {
  const u = usage(
    // 10-08T06:00Z（北京 14:00 高峰 ×3）在当前周期内、5 小时窗口外 → 2401 × 3 = 7203
    [{ model: 'glm-5.3', startedAt: '2026-10-08T06:00:00Z', prompts: 2401 }],
    '2026-10-08T12:00:00Z',
    { weekStart: '2026-10-01T00:00:00Z' },
  );
  const d = startDecision({
    now: '2026-10-08T12:00:00Z',
    model: 'glm-5.3',
    allowPeak: false,
    configAllowPeak: false,
    usage: u,
  });
  assert.equal(d.ok, false);
  assert.equal(d.reason, 'weekly');
  assert.equal(d.retryAt.toISOString(), '2026-10-15T00:00:00.000Z');
});

test('高峰但 allowPeak: true 且额度不足：reason 来自额度而不是 peak', () => {
  const u = usage(
    [{ model: 'glm-5.3', startedAt: '2026-10-08T07:30:00Z', prompts: 480 }],
    '2026-10-08T08:00:00Z', // 高峰内
  );
  const d = startDecision({
    now: '2026-10-08T08:00:00Z',
    model: 'glm-5.3',
    allowPeak: true,
    configAllowPeak: false,
    usage: u,
  });
  assert.equal(d.ok, false);
  assert.equal(d.reason, 'five-hour');
  assert.equal(d.peak, true);
  assert.equal(d.retryAt.toISOString(), '2026-10-08T12:30:00.000Z');
});

test('end-to-end：真实 usage 结果直接放行', () => {
  const now = '2026-10-08T12:00:00Z';
  const u = usage([{ model: 'glm-5.3', startedAt: '2026-10-08T11:00:00Z' }], now);
  const d = startDecision({
    now,
    model: 'glm-5.3-flash',
    allowPeak: false,
    configAllowPeak: false,
    usage: u,
  });
  assert.deepEqual(d, { ok: true, reason: null, nextCost: 0.4, peak: false, retryAt: null });
});

test('now 接受 Date / ISO 字符串 / epoch 毫秒，结果一致', () => {
  const base = { model: 'glm-5.3', allowPeak: false, configAllowPeak: false, usage: okUsage() };
  const a = startDecision({ ...base, now: new Date('2026-10-08T07:00:00Z') });
  const b = startDecision({ ...base, now: '2026-10-08T07:00:00Z' });
  const c = startDecision({ ...base, now: new Date('2026-10-08T07:00:00Z').getTime() });
  assert.deepEqual(a, b);
  assert.deepEqual(b, c);
});

test('now 缺失或非法时抛 TypeError', () => {
  assert.throws(
    () => startDecision({ now: 'oops', model: 'glm-5.3', usage: okUsage() }),
    TypeError,
  );
  assert.throws(() => startDecision({ model: 'glm-5.3', usage: okUsage() }), TypeError);
  assert.throws(
    () => startDecision({ now: new Date('oops'), model: 'glm-5.3', usage: okUsage() }),
    TypeError,
  );
});
