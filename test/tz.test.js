// peak / quota / gate 全部只用 UTC 算术 + 固定 +08:00 偏移，理论上与进程时区无关。
// 这里真的换掉 TZ 各跑一遍子进程加以证实：America/New_York（有夏令时）、
// Pacific/Kiritimati（UTC+14，跨日界线）、UTC。三个快照必须完全一致，
// 并与本进程（直接 import 模块）的计算结果逐项核对，避免「三个子进程一起错」。
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isPeak, getStatus } from '../src/peak.js';
import { usage } from '../src/quota.js';
import { startDecision } from '../src/gate.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const TIMES = [
  '2026-10-08T05:59:59.999Z',
  '2026-10-08T06:00:00Z',
  '2026-10-08T07:00:00Z',
  '2026-10-08T09:59:59.999Z',
  '2026-10-08T10:00:00Z',
  '2026-10-09T10:00:00Z',
  '2026-10-09T16:30:00Z', // 北京已是周六 00:30
  '2026-10-10T07:00:00Z',
  '2026-10-11T23:00:00Z', // 北京周一 07:00
  '2026-12-31T23:00:00Z',
];
const RUNS = [
  { model: 'glm-5.3', startedAt: '2026-10-08T07:30:00Z' },
  { model: 'glm-5.3-flash', startedAt: '2026-10-08T08:00:00Z' },
  { model: 'glm-5.3', startedAt: '2026-10-08T11:00:00Z' },
  { model: 'glm-5.3', startedAt: '2026-10-08T06:30:00Z' },
];
const NOW = '2026-10-08T12:00:00Z';

// 子进程脚本：-e 下按 CommonJS 运行，用动态 import 加载 ESM 模块，打印快照 JSON。
// TIMES / RUNS / NOW 由本文件注入，保证父子两边用的是同一份输入。
const CHILD_SCRIPT = `
const { pathToFileURL } = require('node:url');
const root = process.argv[1];
Promise.all([
  import(pathToFileURL(root + '/src/peak.js')),
  import(pathToFileURL(root + '/src/quota.js')),
  import(pathToFileURL(root + '/src/gate.js')),
]).then(([peak, quota, gate]) => {
  const times = ${JSON.stringify(TIMES)};
  const runs = ${JSON.stringify(RUNS)};
  const now = ${JSON.stringify(NOW)};
  const snapshot = {
    isPeak: times.map((t) => peak.isPeak(new Date(t))),
    nextSwitch: times.map((t) => peak.getStatus(new Date(t)).nextSwitch.toISOString()),
    multipliers: [
      quota.multiplierFor('glm-5.3', '2026-10-08T07:00:00Z'),
      quota.multiplierFor('glm-5.3', '2026-10-08T12:00:00Z'),
      quota.multiplierFor('GLM-5.3-Flash', '2026-10-08T07:00:00Z'),
      quota.multiplierFor('glm-5.3-flash', '2026-10-10T07:00:00Z'),
      quota.multiplierFor('whatever', '2026-10-08T07:00:00Z'),
    ],
    usage: quota.usage(runs, now, { weekStart: '2026-10-01T00:00:00Z' }),
    gate: gate.startDecision({
      now: '2026-10-08T07:00:00Z',
      model: 'glm-5.3',
      allowPeak: false,
      configAllowPeak: false,
      usage: quota.usage([], '2026-10-08T07:00:00Z'),
    }),
  };
  process.stdout.write(JSON.stringify(snapshot, (k, v) => (v instanceof Date ? v.toISOString() : v)));
});
`;

function snapshotWithTZ(tz) {
  const result = spawnSync(process.execPath, ['-e', CHILD_SCRIPT, repoRoot], {
    encoding: 'utf8',
    env: { ...process.env, TZ: tz },
  });
  assert.equal(result.status, 0, `TZ=${tz} 子进程失败：${result.stderr}`);
  return JSON.parse(result.stdout);
}

test('高峰与额度计算不依赖进程时区（UTC / America/New_York / Pacific/Kiritimati 一致）', () => {
  const utc = snapshotWithTZ('UTC');
  const newYork = snapshotWithTZ('America/New_York');
  const kiritimati = snapshotWithTZ('Pacific/Kiritimati');
  assert.deepEqual(newYork, utc, 'America/New_York（含夏令时）下结果应一致');
  assert.deepEqual(kiritimati, utc, 'Pacific/Kiritimati（UTC+14）下结果应一致');

  // 与本进程（模块直接导入）逐项核对
  assert.deepEqual(utc.isPeak, TIMES.map((t) => isPeak(new Date(t))));
  assert.deepEqual(utc.nextSwitch, TIMES.map((t) => getStatus(new Date(t)).nextSwitch.toISOString()));
  assert.deepEqual(utc.multipliers, [3, 1, 1.2, 0.4, 3]);
  assert.deepEqual(
    utc.usage,
    JSON.parse(
      JSON.stringify(usage(RUNS, NOW, { weekStart: '2026-10-01T00:00:00Z' }), (k, v) =>
        v instanceof Date ? v.toISOString() : v,
      ),
    ),
  );
  assert.equal(utc.usage.fiveHour.used, 5.2);
  assert.equal(utc.usage.weekly.resetsAt, '2026-10-15T00:00:00.000Z');
  assert.equal(utc.gate.reason, 'peak');
  assert.equal(utc.gate.retryAt, '2026-10-08T10:00:00.000Z');
});
