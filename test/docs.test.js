// 文档一致性测试（issue #20）：README.md 与 docs/configuration.md 必须跟上代码。
//   1) DEFAULT_CONFIG 的每个键（递归，含 difficulty / effortThinkingTokens 的嵌套键）
//      都要出现在两份文档的文本里——配置加了新键而文档没写时这里失败；
//   2) help 输出「命令：」清单里的每个命令都要出现在 README.md；
//   3) README 有安全提醒的三处字面量（--dangerously-skip-permissions / 专门的 Linux 用户
//      / 127.0.0.1）；
//   4) 两份文档都写到了 scheduler.lock、keepFailedWorktrees 与 prompt 的 trim（首尾空白）。
// 只读文档文件 + 用 fakeEnv() 起一个 `help` 子进程：不调用真实 claude/gh/systemctl，不联网。
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fakeEnv } from './helpers.js';
import { DEFAULT_CONFIG } from '../src/config.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const binPath = path.join(root, 'bin', 'night-shift.mjs');
const readDoc = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

/** 递归收集对象的所有键名（含嵌套普通对象；数组的下标不是键名）。 */
function collectKeys(value, out = []) {
  for (const [key, child] of Object.entries(value)) {
    out.push(key);
    if (child !== null && typeof child === 'object' && !Array.isArray(child)) {
      collectKeys(child, out);
    }
  }
  return out;
}

/**
 * 从「命令：」清单里解析命令名：取该节里每行的第一个词，跳过 --version / --help 这类
 * 旗标（以 - 开头），到空行结束。help 本身是命令，必须被解析出来。
 */
function commandNames(helpText) {
  const lines = helpText.split('\n');
  const start = lines.indexOf('命令：');
  assert.notEqual(start, -1, 'help 输出里找不到「命令：」小节');
  const names = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === '') break;
    const name = line.trim().split(/\s+/)[0];
    if (!name.startsWith('-')) names.push(name);
  }
  return names;
}

/** 起一个 CLI 子进程（fakeEnv 隔离环境），收集 stdout/stderr 与退出码。 */
function spawnCli(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [binPath, ...args], { env: fakeEnv() });
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

test('DEFAULT_CONFIG 的每个键（含嵌套）都出现在 README.md 与 docs/configuration.md', () => {
  const keys = collectKeys(DEFAULT_CONFIG);
  assert.ok(keys.length >= 25, `键收集数量异常：${keys.length}`);
  for (const rel of ['README.md', 'docs/configuration.md']) {
    const text = readDoc(rel);
    for (const key of keys) {
      assert.ok(text.includes(key), `${rel} 缺少配置键「${key}」`);
    }
  }
});

test('help 清单里的每个命令都出现在 README.md（help 也在；--version/--help 不算命令）', async () => {
  const res = await spawnCli(['help']);
  assert.equal(res.code, 0);
  assert.equal(res.stderr, '');
  const names = commandNames(res.stdout);
  assert.ok(names.includes('help'), '「命令：」清单里应包含 help 自身');
  assert.ok(!names.some((name) => name.startsWith('-')), '旗标不应被算进命令名');
  assert.ok(names.length >= 15, `命令数量异常：${names.length}`);
  const readme = readDoc('README.md');
  for (const name of names) {
    assert.ok(readme.includes(name), `README.md 缺少命令「${name}」`);
  }
});

test('README 的安全提醒包含三处必备字面量', () => {
  const readme = readDoc('README.md');
  for (const literal of ['--dangerously-skip-permissions', '专门的 Linux 用户', '127.0.0.1']) {
    assert.ok(readme.includes(literal), `README.md 缺少「${literal}」`);
  }
});

test('README 与 docs/configuration.md 都写到 scheduler.lock、keepFailedWorktrees 与 prompt 的 trim', () => {
  for (const rel of ['README.md', 'docs/configuration.md']) {
    const text = readDoc(rel);
    for (const term of ['scheduler.lock', 'keepFailedWorktrees', 'trim', '首尾空白']) {
      assert.ok(text.includes(term), `${rel} 缺少「${term}」`);
    }
  }
});
