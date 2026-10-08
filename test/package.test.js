import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));

test('package.json 符合骨架约定', () => {
  assert.equal(pkg.name, 'glm-night-shift');
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
  assert.equal(pkg.type, 'module');
  assert.deepEqual(pkg.engines, { node: '>=22' });
  assert.equal(pkg.scripts.test, 'node --test');
  assert.deepEqual(pkg.bin, { 'night-shift': 'bin/night-shift.mjs' });
  assert.ok(!('dependencies' in pkg), '不应有 dependencies');
  assert.ok(!('devDependencies' in pkg), '不应有 devDependencies');
});

test('入口和假替身都有可执行位', () => {
  for (const file of ['bin/night-shift.mjs', 'test/fixtures/fake-claude.mjs', 'test/fixtures/fake-gh.mjs']) {
    const mode = fs.statSync(path.join(repoRoot, file)).mode;
    assert.ok((mode & 0o111) !== 0, `${file} 应可执行`);
  }
});

test('src/ bin/ test/ 只允许 import node: 内置模块和相对路径', () => {
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(js|mjs)$/.test(entry.name)) files.push(full);
    }
  };
  for (const dir of ['src', 'bin', 'test']) walk(path.join(repoRoot, dir));

  const specifiers = [];
  // 按行匹配 import/export 语句（本项目里它们都顶格写在行首），捕获里禁止引号和换行，
  // 避免误伤普通字符串或注释里的 import / from 字样。
  const patterns = [
    /^[ \t]*(?:import|export)\b[^\n;]*?\bfrom[ \t]*['"]([^'"\n]+)['"]/, // 静态 from 形式
    /^[ \t]*import[ \t]+['"]([^'"\n]+)['"]/,                            // 副作用形式
    /\bimport\([ \t]*['"]([^'"\n]+)['"][ \t]*\)/,                       // 动态形式
  ];
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    for (const line of text.split('\n')) {
      for (const pattern of patterns) {
        const match = line.match(pattern);
        if (match) specifiers.push({ file, spec: match[1] });
      }
    }
  }
  assert.ok(specifiers.length > 0, '应至少扫描到一些 import');
  for (const { file, spec } of specifiers) {
    const ok = spec.startsWith('node:') || spec.startsWith('./') || spec.startsWith('../');
    assert.ok(ok, `${file} 引入了不允许的模块：${spec}`);
  }
});

test('仓库根目录没有 NIGHT_SHIFT_FAKE.md（测试不应在仓库根目录留下副作用）', () => {
  assert.equal(fs.existsSync(path.join(repoRoot, 'NIGHT_SHIFT_FAKE.md')), false);
});
