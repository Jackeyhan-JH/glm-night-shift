// src/clock.js 的测试（issue #9 验收项）：固定时刻、真实时钟、非法值在工厂调用时抛错。
import test from 'node:test';
import assert from 'node:assert/strict';
import { systemClock } from '../src/clock.js';

test('验收: NIGHT_SHIFT_NOW 设了就总是返回该时刻，且每次是新 Date 实例', () => {
  const clock = systemClock({ NIGHT_SHIFT_NOW: '2026-10-08T07:00:00Z' });
  const first = clock();
  assert.deepEqual(first, new Date('2026-10-08T07:00:00Z'));
  first.setFullYear(1999); // 调用方改返回值不影响后续读取
  assert.deepEqual(clock(), new Date('2026-10-08T07:00:00Z'));
  assert.notEqual(clock(), clock(), '每次调用返回新对象');
});

test('验收: 未设置（或缺 env 参数）时返回当前时间；空串同样视为未设置', () => {
  for (const env of [{}, { NIGHT_SHIFT_NOW: '' }, undefined]) {
    const clock = systemClock(env);
    const before = Date.now();
    const got = clock();
    const after = Date.now();
    assert.ok(got instanceof Date);
    assert.ok(got.getTime() >= before - 1 && got.getTime() <= after, `应≈当前时间：${got.toISOString()}`);
  }
});

test('NIGHT_SHIFT_NOW 非法时 systemClock() 立刻抛错，错误信息带变量名与原值', () => {
  for (const bad of ['not a date', '2026-13-99T99:00:00Z', '  ']) {
    assert.throws(
      () => systemClock({ NIGHT_SHIFT_NOW: bad }),
      (err) => err instanceof Error && err.message.includes('NIGHT_SHIFT_NOW')
        && err.message.includes(JSON.stringify(bad)),
      `NIGHT_SHIFT_NOW=${JSON.stringify(bad)} 应在工厂调用时抛错`,
    );
  }
  // 抛错发生在 systemClock() 时，而不是第一次取时
  const clock = systemClock({ NIGHT_SHIFT_NOW: '2026-10-08T07:00:00Z' });
  assert.doesNotThrow(() => clock());
});

test('固定时钟的返回值仍是 Date，时间部分可用（toISOString / 比较运算）', () => {
  const clock = systemClock({ NIGHT_SHIFT_NOW: '2026-10-10T07:00:00.000Z' });
  assert.equal(clock().toISOString(), '2026-10-10T07:00:00.000Z');
  assert.ok(clock() < new Date('2026-10-11T00:00:00Z'));
});
