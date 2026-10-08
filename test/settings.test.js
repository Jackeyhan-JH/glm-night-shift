// 设置页与 /api/config（issue #61）的端到端测试：serve-api 同款的 createServer + 临时
// NIGHT_SHIFT_HOME。覆盖：GET 只回七个设置键（重读盘：默认值 < config.json < 环境变量）、
// PATCH 校验失败时文件字节不动、成功时合并写盘且只影响下次启动（不测调度器热更新——
// 那条路线不存在）、页面成功句与错误处理的源码口径。不读 ~/.glm-night-shift，不调真
// claude / gh（本文件根本不起子进程）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_CONFIG, configPath, loadConfig } from '../src/config.js';
import { openDb } from '../src/db.js';
import { createServer } from '../src/server.js';
import { SAVE_OK_TEXT } from '../web/settings-lib.js';
import { makeTempHome } from './helpers.js';

const webDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../web');
const readWeb = (name) => fs.readFileSync(path.join(webDir, name), 'utf8');

/** GET /api/config 的七个键与顺序（与 src/config.js 的 SETTINGS_KEYS 同一份清单）。 */
const SETTINGS_KEYS = [
  'allowPeak', 'concurrency', 'oneTaskPerRepo', 'autoFollowReviews',
  'followPollMinutes', 'prStatus', 'prStatusPollMinutes',
];

/** 七个键的默认值（没有 config.json 时 GET 的完整响应）。 */
const SEVEN_DEFAULTS = {
  allowPeak: false,
  concurrency: 1,
  oneTaskPerRepo: true,
  autoFollowReviews: false,
  followPollMinutes: 30,
  prStatus: false,
  prStatusPollMinutes: 30,
};

// ---------- 辅助（与 test/web-usage.test.js 同款口径） ----------

function startServer(t, { env = {}, home: homeOverride = undefined } = {}) {
  const home = homeOverride ?? makeTempHome(t);
  const db = openDb(path.join(home, 'night-shift.db'));
  const config = loadConfig({ home, env });
  const server = createServer({ db, config, home, env });
  t.after(() => {
    server.close();
    server.closeAllConnections();
    db.close();
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve({ base: `http://127.0.0.1:${server.address().port}`, home });
    });
  });
}

async function getJson(url) {
  const res = await fetch(url);
  return { status: res.status, body: await res.json() };
}

async function patchJson(url, body, headers = {}) {
  const res = await fetch(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

/** 预置一份带多余键的 config.json（七个设置键之外的 port / difficulty / extraFlag）。 */
function seedConfigFile(home) {
  fs.writeFileSync(configPath(home), `${JSON.stringify({
    port: 7900,
    difficulty: { easy: { model: 'my-easy', effort: 'low' } },
    extraFlag: 'keep-me',
  }, null, 2)}\n`);
}

const fileBytes = (home) => fs.readFileSync(configPath(home));

// ---------- GET /api/config ----------

test('验收: 没有 config.json 时 GET /api/config 深度等于且仅有那七个默认值', async (t) => {
  const { base, home } = await startServer(t);
  assert.equal(fs.existsSync(configPath(home)), false, '前提：没有 config.json');

  const { status, body } = await getJson(`${base}/api/config`);
  assert.equal(status, 200);
  assert.deepEqual(body, SEVEN_DEFAULTS);
  assert.deepEqual(Object.keys(body), SETTINGS_KEYS);
});

test('验收: config.json 有改动值加 port/difficulty/extraFlag 时，GET 恰好回七个键、值来自文件', async (t) => {
  const { base, home } = await startServer(t);
  fs.writeFileSync(configPath(home), JSON.stringify({
    allowPeak: true,
    concurrency: 4,
    oneTaskPerRepo: false,
    autoFollowReviews: true,
    followPollMinutes: 15,
    prStatus: true,
    prStatusPollMinutes: 45,
    port: 9999,
    difficulty: { easy: { model: 'm', effort: 'low' } },
    extraFlag: 'secret',
  }));

  const { status, body } = await getJson(`${base}/api/config`);
  assert.equal(status, 200);
  assert.deepEqual(Object.keys(body), SETTINGS_KEYS);
  assert.deepEqual(body, {
    allowPeak: true,
    concurrency: 4,
    oneTaskPerRepo: false,
    autoFollowReviews: true,
    followPollMinutes: 15,
    prStatus: true,
    prStatusPollMinutes: 45,
  });
  assert.equal(body.port, undefined, '不能倒出 port');
  assert.equal(body.extraFlag, undefined, '不能倒出未知自定义键');
  assert.equal(body.difficulty, undefined, '不能倒出 difficulty');
});

test('验收: PATCH {"autoFollowReviews": true, "followPollMinutes": 15} 后：两值变了、多余键原样、GET 仍只有七个键', async (t) => {
  const { base, home } = await startServer(t);
  seedConfigFile(home);

  const { status, body } = await patchJson(`${base}/api/config`, {
    autoFollowReviews: true,
    followPollMinutes: 15,
  });
  assert.equal(status, 200);

  const saved = JSON.parse(fs.readFileSync(configPath(home), 'utf8'));
  assert.equal(saved.autoFollowReviews, true);
  assert.equal(saved.followPollMinutes, 15);
  assert.equal(saved.port, 7900);
  assert.deepEqual(saved.difficulty, { easy: { model: 'my-easy', effort: 'low' } });
  assert.equal(saved.extraFlag, 'keep-me');

  const { body: after } = await getJson(`${base}/api/config`);
  assert.equal(after.autoFollowReviews, true);
  assert.equal(after.followPollMinutes, 15);
  assert.deepEqual(Object.keys(after), SETTINGS_KEYS);
});

// ---------- PATCH 的拒绝路径（文件字节必须不动） ----------

test('验收: PATCH {"port": 1} → 400，error 含 port、field 为 port，config.json 字节与请求前完全一致', async (t) => {
  const { base, home } = await startServer(t);
  seedConfigFile(home);
  const before = fileBytes(home);

  const { status, body } = await patchJson(`${base}/api/config`, { port: 1 });
  assert.equal(status, 400);
  assert.ok(body.error.includes('port'), `error 应含字段名：${body.error}`);
  assert.equal(body.field, 'port');
  assert.ok(fileBytes(home).equals(before), '文件字节不变');
});

test('验收: PATCH {"concurrency": 0} → 400，error 含 concurrency，文件字节不变', async (t) => {
  const { base, home } = await startServer(t);
  seedConfigFile(home);
  const before = fileBytes(home);

  const { status, body } = await patchJson(`${base}/api/config`, { concurrency: 0 });
  assert.equal(status, 400);
  assert.ok(body.error.includes('concurrency'), `error 应含字段名：${body.error}`);
  assert.equal(body.field, 'concurrency');
  assert.ok(fileBytes(home).equals(before), '文件字节不变');
});

test('验收: PATCH {} → 400，文件字节不变；文件本来不存在则仍然不存在', async (t) => {
  const withFile = await startServer(t);
  seedConfigFile(withFile.home);
  const before = fileBytes(withFile.home);
  const rejected = await patchJson(`${withFile.base}/api/config`, {});
  assert.equal(rejected.status, 400);
  assert.ok(rejected.body.error.includes('没有可写入的配置项'), rejected.body.error);
  assert.ok(fileBytes(withFile.home).equals(before), '已有文件字节不变');

  const withoutFile = await startServer(t);
  const missing = await patchJson(`${withoutFile.base}/api/config`, {});
  assert.equal(missing.status, 400);
  assert.equal(fs.existsSync(configPath(withoutFile.home)), false, '文件仍然不存在');
});

test('验收: 类型不对都 400 且文件不变：concurrency 1.5 / allowPeak "yes" / followPollMinutes 0 / prStatusPollMinutes -2 / oneTaskPerRepo 1', async (t) => {
  const { base, home } = await startServer(t);
  seedConfigFile(home);
  const before = fileBytes(home);

  const cases = [
    { concurrency: 1.5 },
    { allowPeak: 'yes' },
    { followPollMinutes: 0 },
    { prStatusPollMinutes: -2 },
    { oneTaskPerRepo: 1 },
  ];
  for (const patchBody of cases) {
    const key = Object.keys(patchBody)[0];
    const { status, body } = await patchJson(`${base}/api/config`, patchBody);
    assert.equal(status, 400, `${key}=${JSON.stringify(patchBody[key])} 应 400`);
    assert.ok(body.error.includes(key), `error 应含字段名 ${key}：${body.error}`);
    assert.equal(body.field, key);
  }
  assert.ok(fileBytes(home).equals(before), '全部拒绝后文件字节仍不变');
});

test('验收: 未知键与类型错误同时给时，报未知键（error 含「未知字段」与该键名），文件不变', async (t) => {
  const { base, home } = await startServer(t);
  seedConfigFile(home);
  const before = fileBytes(home);

  const { status, body } = await patchJson(`${base}/api/config`, { concurrency: 0, bogus: 1 });
  assert.equal(status, 400);
  assert.ok(body.error.includes('未知字段'), body.error);
  assert.ok(body.error.includes('bogus'), body.error);
  assert.equal(body.field, 'bogus');
  assert.ok(fileBytes(home).equals(before), '文件字节不变');
});

test('验收: PATCH 超出七个键的清单（未知键）报 400 且一个键都不写', async (t) => {
  const { base, home } = await startServer(t);
  seedConfigFile(home);
  const before = fileBytes(home);

  const { status, body } = await patchJson(`${base}/api/config`, {
    allowPeak: true,
    host: '0.0.0.0',
  });
  assert.equal(status, 400);
  assert.equal(body.field, 'host');
  assert.ok(body.error.includes('host'), body.error);
  assert.ok(fileBytes(home).equals(before), '合法的 allowPeak 也不能被连带写入');
});

// ---------- PATCH 的成功路径 ----------

test('验收: 只 PATCH {"allowPeak": true} 时文件里其他键保留，GET 的 concurrency 仍是文件里的原值', async (t) => {
  const { base, home } = await startServer(t);
  fs.writeFileSync(configPath(home), JSON.stringify({
    concurrency: 3,
    allowPeak: false,
    extraFlag: null,
  }));

  const { status } = await patchJson(`${base}/api/config`, { allowPeak: true });
  assert.equal(status, 200);

  const saved = JSON.parse(fs.readFileSync(configPath(home), 'utf8'));
  assert.equal(saved.allowPeak, true);
  assert.equal(saved.concurrency, 3);
  assert.equal(saved.extraFlag, null, 'null 值的自定义键原样保留');

  const { body } = await getJson(`${base}/api/config`);
  assert.equal(body.allowPeak, true);
  assert.equal(body.concurrency, 3);
});

test('验收: 文件不存在时 PATCH {"prStatus": true} 创建的 config.json 解析后只有 prStatus（不带整份默认配置）', async (t) => {
  const { base, home } = await startServer(t);

  const { status, body } = await patchJson(`${base}/api/config`, { prStatus: true });
  assert.equal(status, 200);
  assert.equal(body.prStatus, true);

  const saved = JSON.parse(fs.readFileSync(configPath(home), 'utf8'));
  assert.deepEqual(Object.keys(saved), ['prStatus']);
  assert.equal(saved.prStatus, true);

  const { body: after } = await getJson(`${base}/api/config`);
  assert.equal(after.prStatus, true);
  assert.equal(after.concurrency, 1, 'concurrency 仍是默认 1（默认值来自读盘合并，不是写进文件）');
});

// ---------- 防护（与其它带请求体的接口同一套） ----------

test('验收: 跨站 Origin → 403 且文件不变；Content-Type: text/plain → 415 且文件不变', async (t) => {
  const { base, home } = await startServer(t);
  seedConfigFile(home);
  const before = fileBytes(home);

  const evil = await patchJson(`${base}/api/config`, { prStatus: true }, { Origin: 'http://evil.example' });
  assert.equal(evil.status, 403);
  assert.ok(fileBytes(home).equals(before), '403 后文件字节不变');

  const plain = await fetch(`${base}/api/config`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'text/plain' },
    body: '{"prStatus": true}',
  });
  assert.equal(plain.status, 415);
  assert.ok(fileBytes(home).equals(before), '415 后文件字节不变');
});

test('验收: 合法同源 Origin（与 Host 一致）的 PATCH 可以 200（followPollMinutes 0.5 也是合法正数）', async (t) => {
  const { base, home } = await startServer(t);

  const { status, body } = await patchJson(
    `${base}/api/config`,
    { followPollMinutes: 0.5 },
    { Origin: base },
  );
  assert.equal(status, 200);
  assert.equal(body.followPollMinutes, 0.5);

  const saved = JSON.parse(fs.readFileSync(configPath(home), 'utf8'));
  assert.equal(saved.followPollMinutes, 0.5);
});

test('home 缺失时 GET /api/config 是 500（不退回 ~/.glm-night-shift）', async (t) => {
  const home = makeTempHome(t);
  const db = openDb(path.join(home, 'night-shift.db'));
  const config = loadConfig({ home, env: {} });
  const server = createServer({ db, config, env: {} }); // 故意不传 home
  t.after(() => {
    server.close();
    server.closeAllConnections();
    db.close();
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { status, body } = await getJson(`http://127.0.0.1:${server.address().port}/api/config`);
  assert.equal(status, 500);
  assert.ok(typeof body.error === 'string' && body.error !== '');
});

test('config.json 已存在但不是合法 JSON 时 PATCH → 500，原字节不被覆盖', async (t) => {
  const { base, home } = await startServer(t);
  fs.writeFileSync(configPath(home), '{not json');
  const before = fileBytes(home);

  const { status } = await patchJson(`${base}/api/config`, { allowPeak: true });
  assert.equal(status, 500);
  assert.ok(fileBytes(home).equals(before), '坏文件的原字节必须原样保留');
});

// ---------- 页面与常量 ----------

test('验收: SAVE_OK_TEXT === "已写入配置。正在运行的看板要重启后才按新值运行。"', () => {
  assert.equal(SAVE_OK_TEXT, '已写入配置。正在运行的看板要重启后才按新值运行。');
  // 走到这里本身也证明 settings-lib.js 是可被 node:test 直接 import 的纯模块。
});

test('验收: settings.js 成功路径把 SAVE_OK_TEXT 写进页面（textContent），失败写 #settings-error，不只是 console', () => {
  const source = readWeb('settings.js');
  assert.ok(source.includes('SAVE_OK_TEXT'), '成功句必须来自 SAVE_OK_TEXT 常量');
  assert.ok(source.includes('textContent'), '成功路径用 textContent 写进页面元素');
  assert.ok(source.includes('#settings-error'), '失败要写页面错误元素');
  assert.ok(!source.includes('location.reload'), '不能靠刷新页面收尾');
  assert.ok(!/\bimport\s*\(\s*['"]\.\.\/src\//.test(source), '前端不得 import 调度器等 src/ 模块');
});

test('验收: GET /settings.html 返回 200，HTML 里能找到 settings.js 与「设置」', async (t) => {
  const { base } = await startServer(t);
  const res = await fetch(`${base}/settings.html`);
  assert.equal(res.status, 200);
  assert.ok(res.headers.get('content-type').startsWith('text/html'));
  const html = await res.text();
  assert.ok(html.includes('/settings.js'), '应引用 settings.js');
  assert.ok(html.includes('设置'), '页面标题 / 导航应含「设置」');
  assert.ok(html.includes('/style.css'), '复用公共样式');
  for (const file of ['/settings.js', '/settings-lib.js']) {
    const js = await fetch(`${base}${file}`);
    assert.equal(js.status, 200, file);
    assert.ok(js.headers.get('content-type').startsWith('text/javascript'), file);
  }
});

test('验收: Object.keys(DEFAULT_CONFIG) 深度等于锁死的键清单（键顺序不许变）', () => {
  assert.deepEqual(Object.keys(DEFAULT_CONFIG), [
    'concurrency', 'timeoutMinutes', 'killGraceSeconds', 'maxAttempts', 'pollSeconds',
    'port', 'host', 'plan', 'weekStart', 'safetyRatio', 'allowPeak', 'claudeBin', 'ghBin',
    'difficulty', 'effortThinkingTokens', 'remoteUrlTemplate', 'gitAuthorName',
    'gitAuthorEmail', 'testTimeoutMinutes', 'rateLimitBackoffMinutes',
    'keepFailedWorktrees', 'autoDiagnose', 'diagnoseModel', 'diagnoseTimeoutMinutes',
    'systemctlBin', 'oneTaskPerRepo', 'autoFollowReviews', 'followPollMinutes',
    'prStatus', 'prStatusPollMinutes',
  ]);
});
