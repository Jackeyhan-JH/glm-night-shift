// src/clock.js 的单元测试（issue #14，约定同 #9：NIGHT_SHIFT_NOW 固定时间）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { systemClock } from '../src/clock.js';

test('验收: 没设 NIGHT_SHIFT_NOW 时跟随系统时间，且每次调用都前进', () => {
  const clock = systemClock({});
  const first = clock();
  assert.ok(first instanceof Date);
  assert.ok(clock().getTime() >= first.getTime(), '后续调用不应早于前一次');
  assert.notEqual(clock(), first, '每次调用返回新对象');
});

test('验收: NIGHT_SHIFT_NOW 固定时间：恒返回该时刻，每次都是新的 Date', () => {
  const clock = systemClock({ NIGHT_SHIFT_NOW: '2026-10-08T07:00:00Z' });
  const a = clock();
  const b = clock();
  assert.equal(a.toISOString(), '2026-10-08T07:00:00.000Z');
  assert.equal(b.toISOString(), '2026-10-08T07:00:00.000Z');
  assert.notEqual(a, b, '每次调用返回新的 Date 对象');
  a.setFullYear(2000); // 调用方改其中一个不影响后续读取
  assert.equal(clock().toISOString(), '2026-10-08T07:00:00.000Z');
});

test('NIGHT_SHIFT_NOW 为空字符串视为未设置（跟随系统时间）', () => {
  const clock = systemClock({ NIGHT_SHIFT_NOW: '' });
  const real = Date.now();
  const tick = clock().getTime();
  assert.ok(Math.abs(tick - real) < 60_000, '应返回真实系统时间');
});

test('NIGHT_SHIFT_NOW 非法时抛出点名该变量的错误，不悄悄回退到真实时间', () => {
  for (const bad of ['not-a-time', '2026-13-40', ' someday ']) {
    assert.throws(
      () => systemClock({ NIGHT_SHIFT_NOW: bad }),
      (err) => err instanceof Error && err.message.includes('NIGHT_SHIFT_NOW') && err.message.includes(bad.trim()),
      `NIGHT_SHIFT_NOW=${JSON.stringify(bad)} 应抛错`,
    );
  }
});

test('接受各种可被 Date.parse 的写法（带偏移、无毫秒、epoch 不可：只收字符串）', () => {
  const clock = systemClock({ NIGHT_SHIFT_NOW: '2026-10-08T15:00:00+08:00' });
  assert.equal(clock().toISOString(), '2026-10-08T07:00:00.000Z');
});

test('缺省读 process.env（默认参数）', () => {
  const clock = systemClock();
  assert.ok(clock() instanceof Date);
});
