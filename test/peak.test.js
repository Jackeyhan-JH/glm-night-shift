// 移植自 glm-peak-clock 的 test/peak.test.js（commit 6b2b937），去掉了针对上游
// package.json 的用例，换成「文件头注明复制来源 + 本仓库零依赖」的检查。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { RULES, isPeak, getStatus, peakWindows } from '../src/peak.js';

const utc = (s) => new Date(s);
const peakSrc = fs.readFileSync(fileURLToPath(new URL('../src/peak.js', import.meta.url)), 'utf8');

// ---------- 复制来源与零依赖 ----------

test('验收: src/peak.js 文件头注明复制来源（glm-peak-clock @ 6b2b937）', () => {
  assert.ok(peakSrc.startsWith('/*'), '文件头应是注释块');
  assert.match(peakSrc, /glm-peak-clock/);
  assert.match(peakSrc, /6b2b937/);
  // 上游原有的文件说明还在（说明除头部注释外原样复制）
  assert.ok(peakSrc.includes('GLM Coding Plan 高峰期核心逻辑'));
});

test('验收: src/peak.js 不引入任何依赖', () => {
  assert.doesNotMatch(peakSrc, /^\s*import\b/m); // 无静态 import 声明
  assert.doesNotMatch(peakSrc, /\bimport\s*\(/); // 无动态 import()
  assert.doesNotMatch(peakSrc, /\brequire\s*\(/); // 无 CommonJS require
});

// ---------- 验收用例（时间均为 UTC） ----------

test('2026-10-08T05:59:59Z（周四北京 13:59:59）→ 非高峰，1 秒后切换', () => {
  const d = utc('2026-10-08T05:59:59Z');
  const s = getStatus(d);
  assert.equal(isPeak(d), false);
  assert.equal(s.peak, false);
  assert.equal(s.nextSwitch.toISOString(), '2026-10-08T06:00:00.000Z');
  assert.equal(s.msUntilSwitch, 1000);
});

test('2026-10-08T06:00:00Z（周四北京 14:00）→ 高峰（左闭），4 小时后结束', () => {
  const d = utc('2026-10-08T06:00:00Z');
  const s = getStatus(d);
  assert.equal(isPeak(d), true);
  assert.equal(s.peak, true);
  assert.equal(s.nextSwitch.toISOString(), '2026-10-08T10:00:00.000Z');
});

test('2026-10-08T09:59:59Z → 高峰；2026-10-08T10:00:00Z → 非高峰（右开）', () => {
  assert.equal(isPeak(utc('2026-10-08T09:59:59Z')), true);
  const d = utc('2026-10-08T10:00:00Z');
  const s = getStatus(d);
  assert.equal(s.peak, false);
  assert.equal(s.nextSwitch.toISOString(), '2026-10-09T06:00:00.000Z');
});

test('2026-10-09T10:00:00Z（周五北京 18:00）→ 非高峰，跳到下周一 14:00', () => {
  const d = utc('2026-10-09T10:00:00Z');
  const s = getStatus(d);
  assert.equal(s.peak, false);
  assert.equal(s.nextSwitch.toISOString(), '2026-10-12T06:00:00.000Z');
});

test('2026-10-09T16:30:00Z（北京已是周六 00:30）→ 非高峰', () => {
  assert.equal(isPeak(utc('2026-10-09T16:30:00Z')), false);
});

test('2026-10-10T07:00:00Z（周六北京 15:00）→ 非高峰', () => {
  assert.equal(isPeak(utc('2026-10-10T07:00:00Z')), false);
});

test('2026-10-11T23:00:00Z（北京周一 07:00）→ 非高峰，nextSwitch 为当天 14:00 北京时间', () => {
  const d = utc('2026-10-11T23:00:00Z');
  const s = getStatus(d);
  assert.equal(s.peak, false);
  assert.equal(s.nextSwitch.toISOString(), '2026-10-12T06:00:00.000Z');
});

test('peakWindows(2026-10-05T00:00Z, 2026-10-12T00:00Z) 正好 5 个区间：10 月 5～9 日 06:00Z～10:00Z', () => {
  const ws = peakWindows(utc('2026-10-05T00:00:00Z'), utc('2026-10-12T00:00:00Z'));
  assert.equal(ws.length, 5);
  const expected = [5, 6, 7, 8, 9].map((day) => ({
    start: utc(`2026-10-0${day}T06:00:00Z`),
    end: utc(`2026-10-0${day}T10:00:00Z`),
  }));
  assert.deepEqual(ws, expected);
});

// ---------- 规则只写在 RULES 一处 ----------

test('RULES 与官方规则一致（北京时间、周一至周五、14:00～18:00）', () => {
  assert.deepEqual(RULES, {
    tzOffsetMinutes: 480,
    peakDays: [1, 2, 3, 4, 5],
    peakStartMinutes: 840,
    peakEndMinutes: 1080,
  });
});

// ---------- 边界与一致性 ----------

test('高峰最后一毫秒仍算高峰，1 毫秒后翻转', () => {
  const d = utc('2026-10-08T09:59:59.999Z');
  const s = getStatus(d);
  assert.equal(s.peak, true);
  assert.equal(s.nextSwitch.toISOString(), '2026-10-08T10:00:00.000Z');
  assert.equal(s.msUntilSwitch, 1);
});

test('周六、周日均指向下周一 14:00（北京时间）', () => {
  const sat = getStatus(utc('2026-10-10T07:00:00Z')); // 周六北京 15:00
  assert.equal(sat.nextSwitch.toISOString(), '2026-10-12T06:00:00.000Z');
  const sun = getStatus(utc('2026-10-11T02:00:00Z')); // 周日北京 10:00
  assert.equal(sun.nextSwitch.toISOString(), '2026-10-12T06:00:00.000Z');
});

test('msUntilSwitch 与 nextSwitch、传入时刻始终一致且为正', () => {
  const times = [
    '2026-10-05T00:00:00Z',
    '2026-10-06T05:59:59.999Z',
    '2026-10-07T08:00:00Z',
    '2026-10-08T05:59:59Z',
    '2026-10-08T06:00:00Z',
    '2026-10-08T10:00:00Z',
    '2026-10-09T10:00:00.001Z',
    '2026-10-10T00:00:00Z',
    '2026-10-11T23:59:59Z',
    '2026-12-31T23:00:00Z',
    '2027-01-01T06:00:00Z',
  ];
  for (const t of times) {
    const d = utc(t);
    const s = getStatus(d);
    assert.ok(Number.isFinite(s.msUntilSwitch) && s.msUntilSwitch > 0, t);
    assert.equal(s.msUntilSwitch, s.nextSwitch.getTime() - d.getTime(), t);
    assert.equal(s.peak, isPeak(d), t);
  }
});

test('跨年也正确：2026-12-31（周四）高峰日历不因年末错位', () => {
  // 2026-12-31 是周四，2027-01-01 周五，两者都有高峰
  const ws = peakWindows(utc('2026-12-31T00:00:00Z'), utc('2027-01-02T00:00:00Z'));
  assert.deepEqual(
    ws.map((w) => [w.start.toISOString(), w.end.toISOString()]),
    [
      ['2026-12-31T06:00:00.000Z', '2026-12-31T10:00:00.000Z'],
      ['2027-01-01T06:00:00.000Z', '2027-01-01T10:00:00.000Z'],
    ],
  );
});

// ---------- peakWindows 边界 ----------

test('区间起点落在高峰内：返回完整（未裁剪）的区间', () => {
  const ws = peakWindows(utc('2026-10-08T07:30:00Z'), utc('2026-10-08T09:00:00Z'));
  assert.equal(ws.length, 1);
  assert.equal(ws[0].start.toISOString(), '2026-10-08T06:00:00.000Z');
  assert.equal(ws[0].end.toISOString(), '2026-10-08T10:00:00.000Z');
});

test('空范围（from === to 或 from > to）返回空数组', () => {
  const a = utc('2026-10-08T00:00:00Z');
  assert.deepEqual(peakWindows(a, utc('2026-10-08T00:00:00Z')), []);
  assert.deepEqual(
    peakWindows(utc('2026-10-09T00:00:00Z'), utc('2026-10-05T00:00:00Z')),
    [],
  );
});

test('半开边界：to 恰为窗口起点、from 恰为窗口终点时，该窗口不算重叠', () => {
  // to = 10-06 06:00Z：10-06 的窗口起点等于 to，不含
  const wsTo = peakWindows(utc('2026-10-05T00:00:00Z'), utc('2026-10-06T06:00:00Z'));
  assert.equal(wsTo.length, 1);
  assert.equal(wsTo[0].start.toISOString(), '2026-10-05T06:00:00.000Z');

  // from = 10-08 10:00Z：10-08 的窗口终点等于 from，不含；10-09 的完整包含
  const wsFrom = peakWindows(utc('2026-10-08T10:00:00Z'), utc('2026-10-09T10:00:00Z'));
  assert.equal(wsFrom.length, 1);
  assert.equal(wsFrom[0].start.toISOString(), '2026-10-09T06:00:00.000Z');
  assert.equal(wsFrom[0].end.toISOString(), '2026-10-09T10:00:00.000Z');
});

test('多周范围：区间升序排列且数量正确（三周 = 15 个）', () => {
  const ws = peakWindows(utc('2026-10-05T00:00:00Z'), utc('2026-10-26T00:00:00Z'));
  assert.equal(ws.length, 15);
  for (let i = 1; i < ws.length; i++) {
    assert.ok(ws[i - 1].start.getTime() < ws[i].start.getTime());
    assert.ok(ws[i - 1].end.getTime() <= ws[i].start.getTime());
  }
  assert.equal(ws[0].start.toISOString(), '2026-10-05T06:00:00.000Z');
  assert.equal(ws.at(-1).end.toISOString(), '2026-10-23T10:00:00.000Z');
});

// ---------- 纯函数 ----------

test('不修改传入的 Date，返回的是新的 Date 对象', () => {
  const from = utc('2026-10-08T07:00:00Z');
  const to = utc('2026-10-09T00:00:00Z');
  const fromTs = from.getTime();
  const toTs = to.getTime();

  const ws = peakWindows(from, to);
  const s = getStatus(from);
  isPeak(from);

  assert.equal(from.getTime(), fromTs);
  assert.equal(to.getTime(), toTs);
  assert.notEqual(ws[0].start, from);
  assert.notEqual(s.nextSwitch, from);
});
