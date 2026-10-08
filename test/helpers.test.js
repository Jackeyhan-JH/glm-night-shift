import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fakeEnv } from './helpers.js';

const helpersUrl = new URL('./helpers.js', import.meta.url);

test('fakeEnv：NIGHT_SHIFT_HOME 默认指向临时目录，绝不指向真实 ~/.glm-night-shift', () => {
  const env = fakeEnv();
  assert.ok(env.NIGHT_SHIFT_HOME.startsWith(os.tmpdir()), '应在 os.tmpdir() 之下');
  assert.ok(fs.existsSync(env.NIGHT_SHIFT_HOME), '默认数据目录应已创建');
  assert.notEqual(env.NIGHT_SHIFT_HOME, path.join(os.homedir(), '.glm-night-shift'));

  const overridden = fakeEnv({ NIGHT_SHIFT_HOME: '/tmp/override-wins' });
  assert.equal(overridden.NIGHT_SHIFT_HOME, '/tmp/override-wins', 'overrides 应优先于默认值');
});

test('fakeEnv 的沙箱目录随进程退出被删除，不在 /tmp 残留', () => {
  // 子进程 import helpers 并调用 fakeEnv()，把自己的默认 NIGHT_SHIFT_HOME 打出来；
  // 它退出后，其沙箱目录（该路径的上一级）应当已被 process.once("exit") 清掉。
  const child = spawnSync(process.execPath, [
    '--input-type=module',
    '-e',
    `import { fakeEnv } from ${JSON.stringify(helpersUrl.href)};\n`
    + 'process.stdout.write(fakeEnv().NIGHT_SHIFT_HOME);',
  ], { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  const home = child.stdout.trim();
  assert.ok(home.includes('night-shift-sandbox-'), `应在沙箱目录下：${home}`);
  assert.equal(fs.existsSync(path.dirname(home)), false, '子进程退出后沙箱应被删除');
  assert.equal(fs.existsSync(home), false);
});
