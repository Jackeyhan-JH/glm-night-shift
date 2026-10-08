// src/cli/scheduler-log.js 的单元测试（issue #84：start/serve 的额度拦截文案
// 与看板对齐，说「已达安全阈值」而不是「已满」）。直接驱动 attachSchedulerLog，
// 用 EventEmitter 模拟 scheduler.events，不 spawn start/serve，也不碰真实
// claude / gh / ~/.claude/settings.json。
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { attachSchedulerLog } from '../src/cli/scheduler-log.js';
import { formatLocalMinute } from '../src/format.js';

// clock 固定成一个 Date（[HH:MM] 前缀取值稳定）；write 收集整行，换行由
// attachSchedulerLog 自己补。blocked 事件载荷就是 { reason, retryAt }。
const NOW = new Date('2026-10-08T12:34:56Z');
const RETRY_AT = '2026-10-08T16:00:00Z';

function attach() {
  const events = new EventEmitter();
  const lines = [];
  attachSchedulerLog(
    { events },
    { db: null, clock: () => NOW, write: (line) => lines.push(line) },
  );
  return { events, lines };
}

test('验收: five-hour 且带 retryAt：说已达安全阈值并给出恢复时刻', () => {
  const { events, lines } = attach();
  events.emit('blocked', { reason: 'five-hour', retryAt: RETRY_AT });
  assert.equal(lines.length, 1, '一条 blocked 事件只打一行');
  const line = lines[0];
  assert.ok(line.includes('暂停领取：5 小时额度已达安全阈值，'), line);
  assert.ok(line.includes(`${formatLocalMinute(RETRY_AT)} 后恢复`), line);
  assert.ok(!line.includes('额度已满'), line);
});

test('验收: weekly 且带 retryAt：说已达安全阈值并给出恢复时刻', () => {
  const { events, lines } = attach();
  events.emit('blocked', { reason: 'weekly', retryAt: RETRY_AT });
  assert.equal(lines.length, 1, '一条 blocked 事件只打一行');
  const line = lines[0];
  assert.ok(line.includes('暂停领取：每周额度已达安全阈值，'), line);
  assert.ok(line.includes(`${formatLocalMinute(RETRY_AT)} 后恢复`), line);
  assert.ok(!line.includes('额度已满'), line);
});

test('验收: peak 且带 retryAt：仍是高峰期，不带安全阈值字样', () => {
  const { events, lines } = attach();
  events.emit('blocked', { reason: 'peak', retryAt: RETRY_AT });
  assert.equal(lines.length, 1, '一条 blocked 事件只打一行');
  const line = lines[0];
  assert.ok(line.includes('暂停领取：高峰期，') && line.includes('后恢复'), line);
  assert.ok(!line.includes('安全阈值'), line);
  assert.ok(!line.includes('额度已满'), line);
});

test('验收: rate-limit 且带 retryAt：仍是被限流，不带安全阈值字样', () => {
  const { events, lines } = attach();
  events.emit('blocked', { reason: 'rate-limit', retryAt: RETRY_AT });
  assert.equal(lines.length, 1, '一条 blocked 事件只打一行');
  const line = lines[0];
  assert.ok(line.includes('暂停领取：被限流，') && line.includes('后恢复'), line);
  assert.ok(!line.includes('安全阈值'), line);
  assert.ok(!line.includes('额度已满'), line);
});

test('验收: five-hour 且 retryAt 为 null：恢复时间未知', () => {
  const { events, lines } = attach();
  events.emit('blocked', { reason: 'five-hour', retryAt: null });
  assert.equal(lines.length, 1, '一条 blocked 事件只打一行');
  const line = lines[0];
  assert.ok(line.includes('5 小时额度已达安全阈值'), line);
  assert.ok(line.includes('恢复时间未知'), line);
  assert.ok(!line.includes('后恢复'), line);
  assert.ok(!line.includes('额度已满'), line);
});

test('验收: weekly 且 retryAt 为 undefined：恢复时间未知', () => {
  const { events, lines } = attach();
  events.emit('blocked', { reason: 'weekly', retryAt: undefined });
  assert.equal(lines.length, 1, '一条 blocked 事件只打一行');
  const line = lines[0];
  assert.ok(line.includes('每周额度已达安全阈值'), line);
  assert.ok(line.includes('恢复时间未知'), line);
  assert.ok(!line.includes('后恢复'), line);
  assert.ok(!line.includes('额度已满'), line);
});

test('验收: 整行仍是 [HH:MM] 前缀加换行，未知 reason 回退成原文', () => {
  const { events, lines } = attach();
  events.emit('blocked', { reason: 'some-new-reason', retryAt: RETRY_AT });
  assert.equal(lines.length, 1, '一条 blocked 事件只打一行');
  const line = lines[0];
  assert.match(line, /^\[\d{2}:\d{2}\] 暂停领取：some-new-reason，.* 后恢复\n$/);
});
