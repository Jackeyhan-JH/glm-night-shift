// 随机化属性测试：拿一个与实现相互独立的 oracle 对拍。
// - 高峰判定交给 Intl 的 Asia/Shanghai 日历（实现用的是 UTC 算术 + 固定偏移）；
// - 周期起点用「一周一周步进 / 回退」而不是 floor；
// - 窗口用暴力过滤，倍率 / 限额表在此文件里另抄一份。
// PRNG 固定种子（mulberry32，零依赖），整套测试确定可复现，总耗时远小于 1 秒。
import test from 'node:test';
import assert from 'node:assert/strict';
import { multiplierFor, usage, canStart } from '../src/quota.js';

const MS_HOUR = 3_600_000;
const MS_DAY = 86_400_000;
const MS_WEEK = 7 * MS_DAY;

// ---------- 固定种子 PRNG ----------

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t = (t + Math.imul(t ^ (t >>> 7), t | 61)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeRandom(seed) {
  const next = mulberry32(seed);
  return {
    next,
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    pick: (arr) => arr[Math.floor(next() * arr.length)],
  };
}

// ---------- 独立 oracle ----------

const beijingFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Asia/Shanghai',
  weekday: 'short',
  hour: 'numeric',
  minute: 'numeric',
  hourCycle: 'h23',
});
const WEEKDAY_NUM = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** 高峰 oracle：完全交给 Intl 的 Asia/Shanghai 日历。 */
function oracleIsPeak(ts) {
  const parts = {};
  for (const part of beijingFmt.formatToParts(new Date(ts))) parts[part.type] = part.value;
  const weekday = WEEKDAY_NUM[parts.weekday];
  const minutes = Number(parts.hour) * 60 + Number(parts.minute);
  return weekday >= 1 && weekday <= 5 && minutes >= 840 && minutes < 1080;
}

// oracle 自用的一份倍率 / 限额表（与实现里的常量分开维护，两边一致才算过）
const RATES = {
  'glm-5.3': { offPeak: 1, peak: 3 },
  'glm-5.3-flash': { offPeak: 0.4, peak: 1.2 },
};
const LIMITS = {
  'v2-lite': { fiveHour: 80, weekly: 400 },
  'v2-pro': { fiveHour: 400, weekly: 2000 },
  'v2-max': { fiveHour: 1600, weekly: 8000 },
};

function oracleMultiplier(model, ts) {
  const key = typeof model === 'string' ? model.trim().toLowerCase() : '';
  const rates = RATES[key] ?? RATES['glm-5.3'];
  return oracleIsPeak(ts) ? rates.peak : rates.offPeak;
}

/** weekStart 周期 oracle：从 weekStart 起一周一周步进；now 早于 weekStart 时先向后回退。 */
function oracleCycleStart(weekStartTs, nowTs) {
  let cycleStart = weekStartTs;
  while (cycleStart > nowTs) cycleStart -= MS_WEEK;
  while (cycleStart + MS_WEEK <= nowTs) cycleStart += MS_WEEK;
  return cycleStart;
}

function oracleUsage(runs, nowTs, plan, weekStartTs) {
  let fiveHourSum = 0;
  let fiveHourEarliest = null;
  let weeklySum = 0;
  const cycleStart = weekStartTs === null ? null : oracleCycleStart(weekStartTs, nowTs);
  for (const run of runs) {
    if (run.startedTs > nowTs) continue; // 未来的运行不计入任何窗口
    const cost = run.quotaUnits ?? (run.prompts ?? 1) * oracleMultiplier(run.model, run.startedTs);
    if (run.startedTs > nowTs - 5 * MS_HOUR && run.startedTs <= nowTs) {
      fiveHourSum += cost;
      if (fiveHourEarliest === null || run.startedTs < fiveHourEarliest) fiveHourEarliest = run.startedTs;
    }
    if (weekStartTs === null ? run.startedTs > nowTs - MS_WEEK : run.startedTs >= cycleStart) {
      weeklySum += cost;
    }
  }
  const round2 = (x) => Math.round(x * 100) / 100;
  const fiveHourUsed = round2(fiveHourSum);
  const weeklyUsed = round2(weeklySum);
  const limits = LIMITS[plan];
  return {
    fiveHour: {
      used: fiveHourUsed,
      limit: limits.fiveHour,
      ratio: fiveHourUsed / limits.fiveHour,
      resetsAt: fiveHourEarliest === null ? null : new Date(fiveHourEarliest + 5 * MS_HOUR),
    },
    weekly: {
      used: weeklyUsed,
      limit: limits.weekly,
      ratio: weeklyUsed / limits.weekly,
      resetsAt: cycleStart === null ? null : new Date(cycleStart + MS_WEEK),
    },
  };
}

function oracleCanStart(usageResult, nextCost, safetyRatio) {
  const fits = (window) => window.used + nextCost <= window.limit * safetyRatio + 1e-9;
  if (!fits(usageResult.fiveHour)) {
    return { ok: false, reason: 'five-hour', resetsAt: usageResult.fiveHour.resetsAt };
  }
  if (!fits(usageResult.weekly)) {
    return { ok: false, reason: 'weekly', resetsAt: usageResult.weekly.resetsAt };
  }
  return { ok: true };
}

// ---------- 属性测试 ----------

test('property: multiplierFor 与 Intl Asia/Shanghai 高峰 oracle 在 1500 个随机时刻一致', () => {
  const rnd = makeRandom(20261008);
  for (let i = 0; i < 1500; i++) {
    const ts = Date.UTC(2025, 0, 1) + rnd.int(0, 900 * MS_DAY - 1);
    const peak = oracleIsPeak(ts);
    for (const [model, rates] of [
      ['glm-5.3', RATES['glm-5.3']],
      ['GLM-5.3-Flash', RATES['glm-5.3-flash']],
      [' glm-5.3 ', RATES['glm-5.3']],
      ['unknown-model', RATES['glm-5.3']], // 未知模型按 glm-5.3
    ]) {
      assert.equal(
        multiplierFor(model, ts),
        peak ? rates.peak : rates.offPeak,
        `${model} @ ${new Date(ts).toISOString()}`,
      );
    }
  }
});

const MODELS = ['glm-5.3', 'GLM-5.3-Flash', ' glm-5.3-flash ', 'glm-5.3-FLASH', 'nonexistent', null, undefined];

function randomScenario(rnd) {
  const nowTs = Date.UTC(2026, 0, 1) + rnd.int(0, 500 * MS_DAY - 1);
  const plan = rnd.pick(['v2-lite', 'v2-pro', 'v2-max']);
  // 有时晚于 now（覆盖周期数为负的回退分支）
  const weekStartTs = rnd.next() < 0.6 ? nowTs + rnd.int(-40 * MS_DAY, 20 * MS_DAY) : null;
  const runs = [];
  for (let i = 0, n = rnd.int(0, 24); i < n; i++) {
    let startedTs = nowTs + rnd.int(-12 * MS_DAY, 4 * MS_DAY); // 多数在过去，部分在未来
    if (rnd.next() < 0.1) {
      // 偶尔把运行钉在窗口边界上，提高边界覆盖密度
      startedTs = rnd.pick(
        [nowTs, nowTs - 5 * MS_HOUR, nowTs - 5 * MS_HOUR + 1, nowTs - MS_WEEK, weekStartTs].filter(
          (v) => v !== null,
        ),
      );
    }
    const run = { model: rnd.pick(MODELS), startedTs };
    if (rnd.next() < 0.85) run.prompts = rnd.int(0, 5);
    if (rnd.next() < 0.3) run.quotaUnits = rnd.int(0, 8);
    runs.push(run);
  }
  return { nowTs, plan, weekStartTs, runs };
}

test('property: usage / canStart 在 250 个随机场景下与暴力 oracle 逐字段一致', () => {
  const rnd = makeRandom(42);
  for (let s = 0; s < 250; s++) {
    const { nowTs, plan, weekStartTs, runs } = randomScenario(rnd);
    // 同一逻辑时间随机用 epoch 毫秒 / ISO 字符串 / Date 三种编码喂给实现
    const enc = (ts) => {
      const dice = rnd.next();
      return dice < 0.4 ? ts : dice < 0.7 ? new Date(ts).toISOString() : new Date(ts);
    };
    const actual = usage(
      runs.map((run) => ({ ...run, startedAt: enc(run.startedTs) })),
      enc(nowTs),
      { plan, weekStart: weekStartTs === null ? null : enc(weekStartTs) },
    );
    const expected = oracleUsage(runs, nowTs, plan, weekStartTs);
    assert.deepEqual(actual, expected, `场景 ${s}：now=${new Date(nowTs).toISOString()}`);

    const nextCost = rnd.pick([0, 0.4, 1, 1.2, 3, 7.5]);
    const safetyRatio = rnd.pick([0.5, 0.9, 1]);
    assert.deepEqual(
      canStart(actual, { nextCost, safetyRatio }),
      oracleCanStart(expected, nextCost, safetyRatio),
      `场景 ${s} 的 canStart`,
    );
  }
});

test('性能：2 万条运行一次 usage 远小于 1 秒，且与 oracle 一致', () => {
  const rnd = makeRandom(7);
  const nowTs = Date.UTC(2026, 9, 8, 12);
  const weekStartTs = Date.UTC(2026, 9, 1);
  const runs = [];
  for (let i = 0; i < 20_000; i++) {
    runs.push({
      model: i % 3 === 0 ? 'glm-5.3-flash' : 'GLM-5.3',
      startedTs: nowTs - rnd.int(0, 10 * MS_DAY),
    });
  }
  const startedAt = process.hrtime.bigint();
  const u = usage(
    runs.map((run) => ({ model: run.model, startedAt: run.startedTs })),
    nowTs,
    { weekStart: weekStartTs },
  );
  const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
  assert.ok(elapsedMs < 1000, `2 万条运行耗时 ${elapsedMs}ms，应远小于 1 秒`);
  assert.deepEqual(u, oracleUsage(runs, nowTs, 'v2-max', weekStartTs));
});
