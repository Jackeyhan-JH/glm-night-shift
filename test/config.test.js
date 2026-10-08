import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_CONFIG, resolveHome, loadConfig, ensureHome, configPath } from '../src/config.js';
import { makeTempHome } from './helpers.js';

const EXPECTED_DEFAULTS = {
  concurrency: 1,
  timeoutMinutes: 60,
  killGraceSeconds: 10,
  maxAttempts: 2,
  pollSeconds: 30,
  port: 7788,
  plan: 'v2-max',
  weekStart: null,
  safetyRatio: 0.9,
  allowPeak: false,
  claudeBin: 'claude',
  ghBin: 'gh',
  difficulty: {
    easy: { model: 'glm-5.3-flash', effort: 'low' },
    medium: { model: 'glm-5.3', effort: 'medium' },
    hard: { model: 'glm-5.3', effort: 'high' },
  },
  effortThinkingTokens: { low: 0, medium: 8000, high: 32000 },
};

test('默认配置与规格一致，且被深层冻结', () => {
  assert.deepEqual(DEFAULT_CONFIG, EXPECTED_DEFAULTS);
  assert.ok(Object.isFrozen(DEFAULT_CONFIG));
  assert.ok(Object.isFrozen(DEFAULT_CONFIG.difficulty));
  assert.ok(Object.isFrozen(DEFAULT_CONFIG.difficulty.easy));
  assert.ok(Object.isFrozen(DEFAULT_CONFIG.effortThinkingTokens));
});

test('loadConfig 无配置文件时返回默认值，且不创建数据目录', (t) => {
  const home = path.join(makeTempHome(t), 'nope');
  const cfg = loadConfig({ home, env: {} });
  assert.deepEqual(cfg, EXPECTED_DEFAULTS);
  assert.ok(!('home' in cfg), '配置对象里不应混入 home 字段');
  assert.equal(fs.existsSync(home), false, 'loadConfig 不应创建 home 目录');
});

test('config.json 覆盖：嵌套对象按键合并，未提到的键保持默认', (t) => {
  const home = makeTempHome(t);
  fs.writeFileSync(configPath(home), JSON.stringify({
    concurrency: 3,
    difficulty: { easy: { model: 'x', effort: 'low' } },
  }));
  const cfg = loadConfig({ home, env: {} });
  assert.equal(cfg.concurrency, 3);
  assert.equal(cfg.difficulty.easy.model, 'x');
  assert.equal(cfg.difficulty.easy.effort, 'low');
  assert.deepEqual(cfg.difficulty.medium, EXPECTED_DEFAULTS.difficulty.medium);
  assert.deepEqual(cfg.difficulty.hard, EXPECTED_DEFAULTS.difficulty.hard);
  assert.deepEqual(cfg.effortThinkingTokens, EXPECTED_DEFAULTS.effortThinkingTokens);
});

test('环境变量覆盖 claudeBin/ghBin/port，port 是数字，且优先于 config.json', (t) => {
  const home = makeTempHome(t);
  fs.writeFileSync(configPath(home), JSON.stringify({ port: 5000, ghBin: 'from-file' }));
  const cfg = loadConfig({
    home,
    env: {
      NIGHT_SHIFT_CLAUDE_BIN: '/tmp/foo',
      NIGHT_SHIFT_GH_BIN: '/tmp/bar',
      NIGHT_SHIFT_PORT: '9000',
    },
  });
  assert.equal(cfg.claudeBin, '/tmp/foo');
  assert.equal(cfg.ghBin, '/tmp/bar');
  assert.strictEqual(cfg.port, 9000);
  assert.strictEqual(typeof cfg.port, 'number');
});

test('空字符串的环境变量被忽略', (t) => {
  const cfg = loadConfig({
    home: makeTempHome(t),
    env: { NIGHT_SHIFT_CLAUDE_BIN: '', NIGHT_SHIFT_GH_BIN: '', NIGHT_SHIFT_PORT: '' },
  });
  assert.equal(cfg.claudeBin, 'claude');
  assert.equal(cfg.ghBin, 'gh');
  assert.equal(cfg.port, 7788);
});

test('NIGHT_SHIFT_PORT 非法时抛错并点名该变量', (t) => {
  const home = makeTempHome(t);
  for (const bad of ['abc', '0', '70000', '-1', '1.5']) {
    assert.throws(
      () => loadConfig({ home, env: { NIGHT_SHIFT_PORT: bad } }),
      (err) => err instanceof Error && err.message.includes('NIGHT_SHIFT_PORT'),
      `NIGHT_SHIFT_PORT=${bad} 应抛错`,
    );
  }
});

test('config.json 不是合法 JSON 时，错误信息里带文件绝对路径', (t) => {
  const home = makeTempHome(t);
  fs.writeFileSync(configPath(home), '{oops');
  assert.throws(
    () => loadConfig({ home, env: {} }),
    (err) => err instanceof Error && err.message.includes(configPath(home)),
  );
});

test('config.json 顶层不是对象时同样报路径', (t) => {
  const home = makeTempHome(t);
  for (const raw of ['[1,2]', '42', 'null', '"str"', 'true']) {
    fs.writeFileSync(configPath(home), raw);
    assert.throws(
      () => loadConfig({ home, env: {} }),
      (err) => err instanceof Error && err.message.includes(configPath(home)),
      `顶层为 ${raw} 应抛错`,
    );
  }
});

test('未知字段原样保留', (t) => {
  const home = makeTempHome(t);
  fs.writeFileSync(configPath(home), JSON.stringify({
    myOwn: { a: [1, 2] },
    extra: 'x',
    difficulty: { custom: { model: 'y', effort: 'low' } },
  }));
  const cfg = loadConfig({ home, env: {} });
  assert.deepEqual(cfg.myOwn, { a: [1, 2] });
  assert.equal(cfg.extra, 'x');
  assert.deepEqual(cfg.difficulty.custom, { model: 'y', effort: 'low' });
  assert.equal(cfg.difficulty.easy.model, 'glm-5.3-flash');
});

test('loadConfig 返回全新可变对象，DEFAULT_CONFIG 不被改动', (t) => {
  const home = makeTempHome(t);
  fs.writeFileSync(configPath(home), JSON.stringify({ concurrency: 3 }));
  const cfg1 = loadConfig({ home, env: {} });
  const cfg2 = loadConfig({ home, env: {} });
  assert.notEqual(cfg1, cfg2);
  assert.notEqual(cfg1.difficulty, cfg2.difficulty);

  cfg1.concurrency = 9;
  cfg1.difficulty.easy.model = 'zzz';
  cfg1.effortThinkingTokens.low = 1;
  assert.equal(DEFAULT_CONFIG.concurrency, 1);
  assert.equal(DEFAULT_CONFIG.difficulty.easy.model, 'glm-5.3-flash');
  assert.equal(DEFAULT_CONFIG.effortThinkingTokens.low, 0);
  assert.deepEqual(DEFAULT_CONFIG, EXPECTED_DEFAULTS);
});

test('resolveHome：NIGHT_SHIFT_HOME 优先，缺省时用 ~/.glm-night-shift', () => {
  assert.equal(resolveHome({ NIGHT_SHIFT_HOME: '/tmp/x' }), '/tmp/x');
  assert.equal(resolveHome({ NIGHT_SHIFT_HOME: 'rel/dir' }), path.resolve('rel/dir'));
  assert.equal(resolveHome({ NIGHT_SHIFT_HOME: '' }), path.join(os.homedir(), '.glm-night-shift'));
  assert.equal(resolveHome({}), path.join(os.homedir(), '.glm-night-shift'));
});

test('ensureHome 创建 home 与三个子目录，幂等，返回绝对路径', (t) => {
  const home = path.join(makeTempHome(t), 'data');
  const dirs = ensureHome(home);
  assert.deepEqual(Object.keys(dirs).sort(), ['home', 'logs', 'repos', 'worktrees']);
  assert.equal(dirs.home, path.resolve(home));
  for (const dir of [dirs.home, dirs.logs, dirs.repos, dirs.worktrees]) {
    assert.ok(path.isAbsolute(dir), `${dir} 应为绝对路径`);
    assert.ok(fs.statSync(dir).isDirectory(), `${dir} 应为目录`);
  }
  assert.doesNotThrow(() => ensureHome(home)); // 再跑一遍不报错
});
