// 测试辅助。本文件被 `node --test` 当作测试文件扫过，import 时不做任何事（沙箱目录在
// 首次调用 fakeEnv() 时才创建），所有副作用都发生在测试内部的临时目录里。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

// 从子进程环境里剥掉的真实凭据 / 干扰项。
// MAX_THINKING_TOKENS 是调用方向 claude 传思考预算的变量，测试里由 overrides 显式给，
// 避免外层环境（比如本机全局设置）泄漏进断言。
const STRIP_ENV_KEYS = new Set([
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'GH_ENTERPRISE_TOKEN',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'NODE_TEST_CONTEXT',
  'MAX_THINKING_TOKENS',
]);
const STRIP_ENV_PREFIXES = ['NIGHT_SHIFT_', 'FAKE_CLAUDE_', 'FAKE_GH_'];

let sandbox = null;

/**
 * 创建一个全新的临时数据目录并返回其路径。
 * 传入 node:test 的 TestContext `t` 时，测试结束自动清理；否则用 cleanup(dir) 手动清理。
 */
export function makeTempHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'night-shift-test-'));
  if (t && typeof t.after === 'function') t.after(() => cleanup(dir));
  return dir;
}

/** 删除一个目录（不存在也不报错）。 */
export function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

/** test/fixtures/<name> 的绝对路径。 */
export function fixturePath(name) {
  return path.join(FIXTURES_DIR, name);
}

/**
 * 构造给被测子进程用的环境变量（基于 process.env）：
 * - 剥掉真实凭据与干扰项：GH_TOKEN / GITHUB_TOKEN / GH_ENTERPRISE_TOKEN、
 *   ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN / ANTHROPIC_BASE_URL、NODE_TEST_CONTEXT、
 *   MAX_THINKING_TOKENS，以及所有 NIGHT_SHIFT_* 和 FAKE_CLAUDE_* / FAKE_GH_*
 *   （FAKE_* / MAX_THINKING_TOKENS 只能通过 overrides 显式给）。
 * - 指向仓库里的假替身：NIGHT_SHIFT_CLAUDE_BIN / NIGHT_SHIFT_GH_BIN。
 * - NIGHT_SHIFT_HOME 默认指向沙箱里的全新临时目录：忘了传它的测试也绝不会碰到真实
 *   ~/.glm-night-shift（overrides 仍可覆盖）。
 * - GH_CONFIG_DIR / CLAUDE_CONFIG_DIR 指向沙箱里的空目录：即使意外跑到真实 gh/claude，也是未登录状态。
 * - PATH 前置沙箱里的 shim 目录，其中有可执行的 `claude` 和 `gh`（exec 到假替身），
 *   所以只写 `claudeBin: 'claude'` 的默认配置也会命中假替身。
 * - 最后应用 overrides（覆盖或新增，例如 FAKE_CLAUDE_SCENARIO）。
 * 沙箱目录（os.tmpdir() 下的 night-shift-sandbox-*）首次调用时创建一次并被复用，
 * 进程退出时自动删除，不会在 /tmp 里残留。
 */
export function fakeEnv(overrides = {}) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (STRIP_ENV_KEYS.has(key)) continue;
    if (matchesStrippedPrefix(key)) continue;
    env[key] = value;
  }
  const box = ensureSandbox();
  env.NIGHT_SHIFT_CLAUDE_BIN = fixturePath('fake-claude.mjs');
  env.NIGHT_SHIFT_GH_BIN = fixturePath('fake-gh.mjs');
  env.NIGHT_SHIFT_HOME = fs.mkdtempSync(path.join(box.root, 'home-'));
  env.GH_CONFIG_DIR = box.ghConfig;
  env.CLAUDE_CONFIG_DIR = box.claudeConfig;
  env.PATH = `${box.shim}${path.delimiter}${process.env.PATH ?? ''}`;
  return Object.assign(env, overrides);
}

function matchesStrippedPrefix(key) {
  return STRIP_ENV_PREFIXES.some((prefix) => key.startsWith(prefix));
}

function ensureSandbox() {
  if (sandbox) return sandbox;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'night-shift-sandbox-'));
  const dirs = {
    root,
    ghConfig: path.join(root, 'gh-config'),
    claudeConfig: path.join(root, 'claude-config'),
    shim: path.join(root, 'shim'),
  };
  for (const dir of [dirs.ghConfig, dirs.claudeConfig, dirs.shim]) fs.mkdirSync(dir);
  for (const [name, fixture] of [['claude', 'fake-claude.mjs'], ['gh', 'fake-gh.mjs']]) {
    const shim = path.join(dirs.shim, name);
    fs.writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${fixturePath(fixture)}" "$@"\n`);
    fs.chmodSync(shim, 0o755);
  }
  // 进程退出时删掉整个沙箱，避免在 /tmp 残留。
  process.once('exit', () => fs.rmSync(root, { recursive: true, force: true }));
  sandbox = dirs;
  return sandbox;
}
