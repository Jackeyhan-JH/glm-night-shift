// issue #81 验收：`night-shift config set <键=值> …` 写看板设置页那七个设置键。
// 端到端子进程跑 bin（与 test/cli.test.js 的 spawnCli 同款）：fakeEnv 隔离环境，
// NIGHT_SHIFT_HOME 指到临时目录，绝不碰真实 ~/.glm-night-shift，也不调真实 claude/gh。
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fakeEnv, makeTempHome } from './helpers.js';
import { SETTINGS_KEYS } from '../src/config.js';

const bin = fileURLToPath(new URL('../bin/night-shift.mjs', import.meta.url));

// 作为独立进程跑 bin（端到端）。默认 NIGHT_SHIFT_HOME 与 cwd 都指到同一个临时目录、
// TZ 固定 UTC；home 单独指定时与 cwd 解耦（数据目录尚不存在的用例）。
function spawnCli(t, args, { cwd, home, env: envOverrides = {} } = {}) {
  const dir = cwd ?? makeTempHome(t);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bin, ...args], {
      cwd: dir,
      env: fakeEnv({ NIGHT_SHIFT_HOME: home ?? dir, TZ: 'UTC', ...envOverrides }),
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

/** 预置一份带既有设置键与未知自定义键的 config.json，返回写下的字节（供前后对比）。 */
function seedConfig(home, obj = { port: 7999, timeoutMinutes: 15, concurrency: 1, custom: 'keep' }) {
  const bytes = Buffer.from(`${JSON.stringify(obj, null, 2)}\n`);
  fs.writeFileSync(path.join(home, 'config.json'), bytes);
  return bytes;
}

/** 成功写入后的整段 stdout：首行提示 + 七个键按 SETTINGS_KEYS 顺序。 */
function expectedSetOutput(overrides = {}) {
  const effective = {
    allowPeak: false,
    concurrency: 1,
    oneTaskPerRepo: true,
    autoFollowReviews: false,
    followPollMinutes: 30,
    prStatus: false,
    prStatusPollMinutes: 30,
    ...overrides,
  };
  return [
    '已写入配置。正在运行的看板要重启后才按新值运行。',
    ...SETTINGS_KEYS.map((key) => `${key}=${effective[key]}`),
    '',
  ].join('\n');
}

test('验收: config 与 config --json 保持只读：不创建 config.json 与数据库', async (t) => {
  const home = makeTempHome(t);
  const human = await spawnCli(t, ['config'], { home });
  assert.equal(human.code, 0);
  assert.equal(human.stderr, '');
  assert.ok(human.stdout.includes(`数据目录：${home}`));
  assert.ok(human.stdout.includes('不存在，用默认值'));
  assert.ok(human.stdout.includes('"concurrency": 1'));

  const jsonRes = await spawnCli(t, ['config', '--json'], { home });
  assert.equal(jsonRes.code, 0);
  assert.equal(jsonRes.stderr, '');
  const parsed = JSON.parse(jsonRes.stdout);
  assert.equal(parsed.home, home);
  assert.equal(parsed.configPath, path.join(home, 'config.json'));
  assert.equal(parsed.dbPath, path.join(home, 'night-shift.db'));
  assert.equal(parsed.config.concurrency, 1);
  assert.equal(parsed.config.port, 7788);

  // 第一个位置参数不是 set 仍是用法错误（退出 2），同样不写盘。
  const stray = await spawnCli(t, ['config', 'frobnicate'], { home });
  assert.equal(stray.code, 2);
  assert.equal(stray.stdout, '');
  assert.ok(stray.stderr.startsWith('错误：'));

  assert.equal(fs.existsSync(path.join(home, 'config.json')), false);
  assert.equal(fs.existsSync(path.join(home, 'night-shift.db')), false);
});

test('验收: config set 一次写多个键：原键与自定义键保留，不写整份默认配置', async (t) => {
  const home = makeTempHome(t);
  seedConfig(home);
  const res = await spawnCli(t, ['config', 'set', 'concurrency=2', 'allowPeak=false'], { home });
  assert.equal(res.code, 0);
  assert.equal(res.stderr, '');
  assert.equal(res.stdout, expectedSetOutput({ concurrency: 2, allowPeak: false }));

  const onDisk = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8'));
  assert.equal(onDisk.concurrency, 2);
  assert.equal(onDisk.allowPeak, false);
  assert.equal(onDisk.port, 7999);
  assert.equal(onDisk.timeoutMinutes, 15);
  assert.equal(onDisk.custom, 'keep');
  // 文件里只有原来的键 + 本次写入的键，不该凭空多出默认配置的键。
  assert.ok(!('claudeBin' in onDisk), '不应把整份 DEFAULT_CONFIG 写进 config.json');
  assert.deepEqual(Object.keys(onDisk), ['port', 'timeoutMinutes', 'concurrency', 'custom', 'allowPeak']);
});

test('验收: 数据目录不存在时 config set 建目录、只写本次的键、不建数据库', async (t) => {
  const base = makeTempHome(t);
  const home = path.join(base, 'not-yet');
  assert.equal(fs.existsSync(home), false);
  const res = await spawnCli(t, ['config', 'set', 'concurrency=2'], { home, cwd: base });
  assert.equal(res.code, 0);
  assert.equal(res.stderr, '');
  assert.equal(res.stdout, expectedSetOutput({ concurrency: 2 }));
  const onDisk = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8'));
  assert.deepEqual(onDisk, { concurrency: 2 });
  assert.equal(fs.existsSync(path.join(home, 'night-shift.db')), false);
});

test('验收: 有一个键不合法就整单拒绝：非 0 退出、stdout 空、config.json 字节不变', async (t) => {
  const home = makeTempHome(t);
  const bytes = seedConfig(home);
  const file = path.join(home, 'config.json');
  // [set 之后的参数, 期望退出码, stderr 必含片段]
  const cases = [
    [['concurrency=0'], 1, 'concurrency'],
    [['concurrency=1.0'], 1, 'concurrency'],
    [['concurrency=1e1'], 1, 'concurrency'],
    [['concurrency='], 1, 'concurrency'],
    [['allowPeak=yes'], 1, 'allowPeak'],
    [['allowPeak=True'], 1, 'allowPeak'],
    [['concurrency=2', 'allowPeak=yes'], 1, 'allowPeak'], // 混合：整单拒绝，一个键都不写
    [['port=1'], 1, `未知配置项：port（允许：${SETTINGS_KEYS.join(' | ')}）`],
    [['concurrency=2', 'concurrency=3'], 1, '配置项重复：concurrency'],
    [[], 2, '缺少要写入的配置项'],
    [['--json', 'concurrency=2'], 2, '不能与 --json 一起用'],
    [['concurrency=2', '--json'], 2, '不能与 --json 一起用'],
    [['concurrency'], 2, '键=值'],
  ];
  for (const [setArgs, code, needle] of cases) {
    const args = ['config', 'set', ...setArgs];
    const res = await spawnCli(t, args, { home });
    assert.notEqual(res.code, 0, JSON.stringify(args));
    assert.equal(res.code, code, `${JSON.stringify(args)} 应退出 ${code}，stderr：${res.stderr}`);
    assert.equal(res.stdout, '', JSON.stringify(args));
    assert.ok(res.stderr.startsWith('错误：'), JSON.stringify(args));
    assert.ok(res.stderr.includes(needle), `${JSON.stringify(args)} stderr 应含「${needle}」：${res.stderr}`);
    assert.deepEqual(fs.readFileSync(file), bytes, `${JSON.stringify(args)} 不应改动 config.json 字节`);
  }
  // 混合不合法之后重读：concurrency 仍是旧值 1。
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).concurrency, 1);
});

test('验收: config --json set … 与 set 的位置先后都算 --json 冲突，退出 2', async (t) => {
  const home = makeTempHome(t);
  const bytes = seedConfig(home);
  const res = await spawnCli(t, ['config', '--json', 'set', 'concurrency=2'], { home });
  assert.equal(res.code, 2);
  assert.equal(res.stdout, '');
  assert.ok(res.stderr.includes('不能与 --json 一起用'), res.stderr);
  assert.deepEqual(fs.readFileSync(path.join(home, 'config.json')), bytes);
});

test('验收: config.json 不是合法 JSON：set 退出非 0，「错误：」+ 路径，原字节不变', async (t) => {
  const home = makeTempHome(t);
  const bytes = Buffer.from('{oops');
  const file = path.join(home, 'config.json');
  fs.writeFileSync(file, bytes);
  const res = await spawnCli(t, ['config', 'set', 'concurrency=2'], { home });
  assert.notEqual(res.code, 0);
  assert.equal(res.stdout, '');
  assert.ok(res.stderr.startsWith('错误：'), res.stderr);
  assert.ok(res.stderr.includes(file), res.stderr);
  assert.deepEqual(fs.readFileSync(file), bytes);
});

test('验收: 校验失败时连数据目录都不创建（不 ensureHome）', async (t) => {
  const base = makeTempHome(t);
  const cases = [
    ['config', 'set', 'concurrency=0'],        // 类型不过 → 退出 1
    ['config', 'set', 'port=1'],               // 未知键 → 退出 1
    ['config', 'set', 'concurrency=2', 'concurrency=3'], // 重复 → 退出 1
    ['config', 'set'],                          // 缺键值 → 退出 2
    ['config', 'frobnicate'],                   // 未知位置参数 → 退出 2
  ];
  for (let i = 0; i < cases.length; i++) {
    const args = cases[i];
    const home = path.join(base, `missing-${i}`);
    const res = await spawnCli(t, args, { home, cwd: base });
    assert.notEqual(res.code, 0, JSON.stringify(args));
    assert.equal(fs.existsSync(home), false, `${JSON.stringify(args)} 失败时不应创建数据目录`);
  }
});
