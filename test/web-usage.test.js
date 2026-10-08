// 额度与高峰页（issue #17）的端到端测试：serve-api 同款的 createServer + 临时
// NIGHT_SHIFT_HOME，测试数据直接写库（startRun + 改 started_at + finishRun）。
// 浏览器侧的纯计算已在 test/web-chart-lib.test.js 覆盖，这里补：静态资源与只读路由、
// /api/status 的新增字段、以及页面数据流上每条验收口径的取数。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.js';
import { systemClock } from '../src/clock.js';
import { openDb } from '../src/db.js';
import { createServer } from '../src/server.js';
import { createTask, finishRun, startRun } from '../src/tasks.js';
import { makeTempHome } from './helpers.js';
import { fmtCountdown, fmtValue, layoutBars, meterState, tooltipLines } from '../web/chart-lib.js';

const NOW = '2026-10-08T12:00:00Z'; // 周四北京 20:00，非高峰（与 #4 验收同款时刻）
/** #4 验收的那组运行：5 小时窗口内 3 + 1.2 + 1 = 5.2，06:30 那条在窗口外。 */
const QUOTA_RUNS = [
  { model: 'glm-5.3', startedAt: '2026-10-08T07:30:00Z' }, // 北京 15:30 高峰 → 3
  { model: 'glm-5.3-flash', startedAt: '2026-10-08T08:00:00Z' }, // 高峰 → 1.2
  { model: 'glm-5.3', startedAt: '2026-10-08T11:00:00Z' }, // 北京 19:00 非高峰 → 1
  { model: 'glm-5.3', startedAt: '2026-10-08T06:30:00Z' }, // 高峰 → 3，5 小时窗口外
];

// ---------- 辅助（与 test/server.test.js 同款口径） ----------

function startServer(t, { env = {}, scheduler = null } = {}) {
  const home = makeTempHome(t);
  fs.mkdirSync(path.join(home, 'logs'), { recursive: true });
  const db = openDb(path.join(home, 'night-shift.db'));
  const config = loadConfig({ home, env });
  const server = createServer({ db, config, home, clock: systemClock(env), scheduler });
  t.after(() => {
    server.close();
    server.closeAllConnections();
    db.close();
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve({ db, base: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

/** 写入几条历史运行（startedAt 指定、状态 succeeded；quotaUnits 可选）。 */
function insertRuns(db, specs) {
  const task = createTask(db, { repo: 'a/b', prompt: '验收数据' });
  for (const spec of specs) {
    const run = startRun(db, {
      taskId: task.id, attempt: 1, model: spec.model, effort: 'low', peak: true,
      logPath: '/tmp/none.log',
    });
    db.prepare('UPDATE runs SET started_at = ? WHERE id = ?').run(spec.startedAt, run.id);
    finishRun(db, run.id, { status: 'succeeded', quotaUnits: spec.quotaUnits });
  }
}

/** 发原始路径的请求（fetch 会先归一化 /../ 与 %2e%2e，测不到服务端的路径解析）。 */
function rawRequest(base, rawPath) {
  const url = new URL(base);
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: url.hostname, port: url.port, path: rawPath, method: 'GET' },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => resolve({
          status: res.statusCode,
          text: Buffer.concat(chunks).toString('utf8'),
        }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

async function getJson(url) {
  const res = await fetch(url);
  return { status: res.status, body: await res.json() };
}

// ---------- 静态资源与只读路由 ----------

test('验收: /usage.html 与 /usage.js、/chart-lib.js 可访问且类型正确；/src/peak.js 只读可取、其余 src/** 一律 404', async (t) => {
  const { base } = await startServer(t);

  const page = await fetch(`${base}/usage.html`);
  assert.equal(page.status, 200);
  assert.ok(page.headers.get('content-type').startsWith('text/html'));
  const html = await page.text();
  assert.ok(html.includes('/usage.js'), '应引用 usage.js');
  assert.ok(html.includes('/style.css'), '引用公共样式');

  for (const file of ['/usage.js', '/chart-lib.js', '/common.js', '/src/peak.js']) {
    const res = await fetch(`${base}${file}`);
    assert.equal(res.status, 200, file);
    assert.ok(res.headers.get('content-type').startsWith('text/javascript'), file);
    const text = await res.text();
    if (file === '/src/peak.js') {
      assert.ok(text.includes('export function peakWindows'), '取到的应是 src/peak.js 本体');
    }
    // 浏览器要能直接跑：不得 import 任何 node: 内置模块（注释里提到 node:test 不算）
    assert.doesNotMatch(text, /\bfrom\s+["']node:/, `${file} 不应 import Node 内置模块`);
    assert.doesNotMatch(text, /\bimport\s*\(\s*["']node:/, `${file} 不应动态 import Node 内置模块`);
  }

  // 白名单之外不暴露源码；路径穿越也不行
  for (const file of ['/src/server.js', '/src/config.js', '/src', '/src/']) {
    const res = await fetch(`${base}${file}`);
    assert.equal(res.status, 404, file);
  }
  for (const raw of ['/src/../package.json', '/src/%2e%2e/package.json', '/src/..%5cserver.js']) {
    const res = await rawRequest(base, raw);
    assert.equal(res.status, 404, raw);
    assert.ok(!res.text.includes('"name"'), `${raw} 不能泄漏仓库内容`);
  }
});

test('验收: web/ 下没有任何第三方库文件或 CDN 引用', async () => {
  const webDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../web');
  const forbidden = [
    /<script[^>]+src=["']https?:\/\//i, // CDN 脚本
    /<link[^>]+href=["']https?:\/\//i, // CDN 样式
    /@import\s+url\(\s*["']?https?:\/\//i, // CSS @import
    /\bfrom\s+["']https?:\/\//i, // 远程 ESM
    /\bimport\(\s*["']https?:\/\//i, // 远程动态 import
  ];
  for (const entry of fs.readdirSync(webDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const text = fs.readFileSync(path.join(webDir, entry.name), 'utf8');
    for (const pattern of forbidden) {
      assert.doesNotMatch(text, pattern, `${entry.name} 不应引用第三方资源`);
    }
  }
});

// ---------- /api/status 与额度卡片数据 ----------

test('验收: #4 那组运行、now=2026-10-08T12:00Z：5 小时显示 5.2 / 1600、恢复时间对应 12:30Z；safetyRatio=0.9', async (t) => {
  const { db, base } = await startServer(t, { env: { NIGHT_SHIFT_NOW: NOW } });
  insertRuns(db, QUOTA_RUNS);

  const { status, body } = await getJson(`${base}/api/status`);
  assert.equal(status, 200);
  assert.equal(body.usage.fiveHour.used, 5.2);
  assert.equal(body.usage.fiveHour.limit, 1600);
  // 页面进度条文案 `${fmtValue(used)} / ${fmtValue(limit)}`
  assert.equal(`${fmtValue(body.usage.fiveHour.used)} / ${fmtValue(body.usage.fiveHour.limit)}`, '5.2 / 1600');
  assert.equal(body.usage.fiveHour.resetsAt, '2026-10-08T12:30:00.000Z'); // 07:30 + 5h
  assert.equal(body.usage.weekly.used, 8.2);
  assert.equal(body.usage.weekly.resetsAt, null); // 无 weekStart → 滚动窗口
  assert.equal(body.plan, 'v2-max');
  assert.equal(body.safetyRatio, 0.9);
  assert.equal(meterState(body.usage.fiveHour.ratio, body.safetyRatio), 'ok');
});

test('验收: 07:00Z 与 08:00Z 两个小时有柱子，悬停 07:00Z 那根显示 glm-5.3 3', async (t) => {
  const { db, base } = await startServer(t, { env: { NIGHT_SHIFT_NOW: NOW } });
  insertRuns(db, QUOTA_RUNS);

  const { body: history } = await getJson(`${base}/api/usage/history?days=1`);
  const at07 = history.buckets.find((b) => b.hour === '2026-10-08T07:00:00.000Z');
  const at08 = history.buckets.find((b) => b.hour === '2026-10-08T08:00:00.000Z');
  assert.ok(at07.total > 0, '07:00Z 桶有柱子');
  assert.ok(at08.total > 0, '08:00Z 桶有柱子');
  assert.equal(at07.byModel['glm-5.3'], 3);

  // 悬停读数（页面用 tooltipLines(bucket, order)）
  const { rows, total } = tooltipLines(at07, ['glm-5.3', 'glm-5.3-flash']);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].key, 'glm-5.3');
  assert.equal(rows[0].value, 3);
  assert.equal(total, 3);
});

test('验收: NIGHT_SHIFT_NOW=2026-10-08T07:00Z 显示「高峰」、倒计时约 3 小时；2026-10-10T07:00Z 显示「非高峰」', async (t) => {
  const thursday = await startServer(t, { env: { NIGHT_SHIFT_NOW: '2026-10-08T07:00:00Z' } });
  const peakStatus = await (await fetch(`${thursday.base}/api/status`)).json();
  assert.equal(peakStatus.peak.peak, true); // 北京 15:00 周四
  assert.equal(peakStatus.peak.nextChange, '2026-10-08T10:00:00.000Z'); // 北京 18:00
  assert.equal(peakStatus.peak.multipliers['glm-5.3'], 3);
  assert.equal(peakStatus.peak.multipliers['glm-5.3-flash'], 1.2);
  // 页面倒计时 = nextChange −（now + 已过时间）；刚拿到数据时恰好 3 小时
  const remaining = Date.parse(peakStatus.peak.nextChange) - Date.parse(peakStatus.now);
  assert.equal(remaining, 3 * 3_600_000);
  assert.equal(fmtCountdown(remaining), '03:00:00');

  const saturday = await startServer(t, { env: { NIGHT_SHIFT_NOW: '2026-10-10T07:00:00Z' } });
  const offStatus = await (await fetch(`${saturday.base}/api/status`)).json();
  assert.equal(offStatus.peak.peak, false); // 周六北京 15:00
  assert.equal(offStatus.peak.multipliers['glm-5.3'], 1);
  assert.equal(offStatus.peak.nextChange, '2026-10-12T06:00:00.000Z'); // 下周一北京 14:00
});

test('验收: 插入使 5 小时用量达到 1500 的运行后，进度条应为警告色（ratio > safetyRatio → warn）', async (t) => {
  const { db, base } = await startServer(t, { env: { NIGHT_SHIFT_NOW: NOW } });
  insertRuns(db, [{ model: 'glm-5.3', startedAt: '2026-10-08T08:00:00Z', quotaUnits: 1500 }]);

  const { body } = await getJson(`${base}/api/status`);
  assert.equal(body.usage.fiveHour.used, 1500);
  assert.equal(body.usage.fiveHour.ratio, 1500 / 1600);
  assert.equal(meterState(body.usage.fiveHour.ratio, body.safetyRatio), 'warn');
  // 周额度离阈值远，仍是正常色
  assert.equal(meterState(body.usage.weekly.ratio, body.safetyRatio), 'ok');
});

test('验收: 没有任何运行时页面显示 0 且不报错（用量 0、图表布局空数据可用）', async (t) => {
  const { base } = await startServer(t, { env: { NIGHT_SHIFT_NOW: NOW } });
  const { body: status } = await getJson(`${base}/api/status`);
  assert.equal(status.usage.fiveHour.used, 0);
  assert.equal(status.usage.fiveHour.ratio, 0);
  assert.equal(status.usage.fiveHour.resetsAt, null);
  assert.equal(status.usage.weekly.used, 0);
  assert.equal(meterState(0, status.safetyRatio), 'ok');

  const { body: history } = await getJson(`${base}/api/usage/history?days=7`);
  assert.equal(history.buckets.length, 7 * 24);
  // 全零数据照样能布局（页面渲染不抛错），柱子全空
  const layout = layoutBars({
    buckets: history.buckets,
    order: ['glm-5.3', 'glm-5.3-flash'],
    plot: { x0: 0, x1: 960, y0: 240, y1: 20 },
  });
  assert.equal(layout.bars.length, 168);
  assert.ok(layout.bars.every((bar) => bar.segments.length === 0 && bar.total === 0));
});

test('验收: 切换 1 / 7 / 30 天时柱子数量分别为 24 / 168 / 720，横坐标单调且不重叠', async (t) => {
  const { db, base } = await startServer(t, { env: { NIGHT_SHIFT_NOW: NOW } });
  insertRuns(db, QUOTA_RUNS);

  for (const [days, expected] of [[1, 24], [7, 168], [30, 720]]) {
    const { body: history } = await getJson(`${base}/api/usage/history?days=${days}`);
    assert.equal(history.buckets.length, expected, `days=${days}`);
    const layout = layoutBars({
      buckets: history.buckets,
      order: ['glm-5.3', 'glm-5.3-flash'],
      plot: { x0: 0, x1: 960, y0: 240, y1: 20 },
    });
    assert.equal(layout.bars.length, expected, `days=${days} 柱子数`);
    for (let i = 1; i < layout.bars.length; i++) {
      assert.ok(layout.bars[i].x > layout.bars[i - 1].x, `days=${days}：x 单调递增`);
      assert.ok(
        layout.bars[i - 1].x + layout.bars[i - 1].width <= layout.bars[i].x + 1e-9,
        `days=${days}：相邻不重叠`,
      );
    }
  }
});

test('调度器被拦时 /api/status.scheduler.blocked 带原因与恢复时间（页面额度卡片的取数口径）', async (t) => {
  const { base } = await startServer(t, {
    env: { NIGHT_SHIFT_NOW: '2026-10-08T07:00:00Z' },
    scheduler: {
      status: () => ({
        running: [3],
        stopping: false,
        pausedUntil: null,
        blocked: { reason: 'five-hour', retryAt: new Date('2026-10-08T12:30:00Z') },
      }),
    },
  });
  const { body } = await getJson(`${base}/api/status`);
  assert.equal(body.scheduler.blocked.reason, 'five-hour');
  assert.equal(body.scheduler.blocked.retryAt, '2026-10-08T12:30:00.000Z');

  const quiet = await startServer(t, {
    env: { NIGHT_SHIFT_NOW: '2026-10-08T07:00:00Z' },
    scheduler: { status: () => ({ running: [], stopping: false, pausedUntil: null, blocked: null }) },
  });
  const { body: quietBody } = await getJson(`${quiet.base}/api/status`);
  assert.equal(quietBody.scheduler.blocked, null); // 未被拦 → 页面不显示提示框
});
