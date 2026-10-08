import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fixturePath, fakeEnv, makeTempHome } from './helpers.js';

function runFakeGh(t, args, { env = {}, cwd } = {}) {
  const dir = cwd ?? makeTempHome(t);
  const res = spawnSync(process.execPath, [fixturePath('fake-gh.mjs'), ...args], {
    cwd: dir,
    env: fakeEnv(env),
    encoding: 'utf8',
  });
  assert.ok(!res.error, `假 gh 启动失败：${res.error}`);
  return { code: res.status, stdout: res.stdout, stderr: res.stderr, dir };
}

// 建一个本地 git 仓库并把 origin 指到指定地址（纯本地操作，不联网）。
function gitRepoWithOrigin(t, remoteUrl) {
  const dir = makeTempHome(t);
  for (const args of [['init', '-q'], ['remote', 'add', 'origin', remoteUrl]]) {
    const res = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
    assert.ok(res.status === 0, `git ${args[0]} 失败：${res.stderr}`);
  }
  return dir;
}

test('验收：pr create --repo a/b，FAKE_GH_PR_NUMBER=7', async (t) => {
  const res = runFakeGh(t, ['pr', 'create', '--repo', 'a/b', '--title', 't', '--body', 'x'], {
    env: { FAKE_GH_PR_NUMBER: '7' },
  });
  assert.equal(res.code, 0);
  assert.equal(res.stdout, 'https://github.com/a/b/pull/7\n');
  assert.equal(res.stderr, '');
});

test('不设 FAKE_GH_PR_NUMBER 时默认 PR 编号 1；--repo= 与 -R 写法都支持', async (t) => {
  for (const repoArgs of [['--repo', 'a/b'], ['--repo=a/b'], ['-R', 'a/b'], ['-R=a/b']]) {
    const res = runFakeGh(t, ['pr', 'create', ...repoArgs, '--title', 't'], {});
    assert.equal(res.code, 0);
    assert.equal(res.stdout, 'https://github.com/a/b/pull/1\n');
  }
});

test('FAKE_GH_FAIL=1 时 pr create 报错退出 1', async (t) => {
  const res = runFakeGh(t, ['pr', 'create', '--repo', 'a/b', '--title', 't'], { env: { FAKE_GH_FAIL: '1' } });
  assert.equal(res.code, 1);
  assert.notEqual(res.stderr.trim(), '');
  assert.equal(res.stdout, '');
});

test('repo view --json defaultBranchRef 输出默认分支，可用 FAKE_GH_DEFAULT_BRANCH 覆盖', async (t) => {
  const res = runFakeGh(t, ['repo', 'view', 'a/b', '--json', 'defaultBranchRef'], {});
  assert.equal(res.code, 0);
  assert.deepEqual(JSON.parse(res.stdout), { defaultBranchRef: { name: 'main' } });

  const custom = runFakeGh(t, ['repo', 'view', 'a/b', '--json', 'defaultBranchRef'], {
    env: { FAKE_GH_DEFAULT_BRANCH: 'develop' },
  });
  assert.deepEqual(JSON.parse(custom.stdout), { defaultBranchRef: { name: 'develop' } });
});

test('FAKE_GH_LOG 记录 argv（一个 JSON 数组一行）', async (t) => {
  const dir = makeTempHome(t);
  const log = path.join(dir, 'gh.log');
  const res = runFakeGh(t, ['pr', 'view', '99'], { env: { FAKE_GH_LOG: log }, cwd: dir });
  assert.equal(res.code, 0);
  assert.equal(res.stdout, '');
  const logged = fs.readFileSync(log, 'utf8');
  assert.deepEqual(JSON.parse(logged.trim()), ['pr', 'view', '99']);
  assert.ok(logged.endsWith('\n'));
});

test('在 git 仓库里执行时，从 origin 远端推导 owner/name', async (t) => {
  const cases = [
    ['git@github.com:zzz/qqq.git', 'zzz/qqq'],
    ['https://github.com/hh/mm.git', 'hh/mm'],
    ['ssh://git@github.com/aa/bb', 'aa/bb'],
    ['/tmp/night-shift-test-x/repos/somerepo.git', 'local/somerepo'],
  ];
  for (const [remoteUrl, expected] of cases) {
    const dir = gitRepoWithOrigin(t, remoteUrl);
    const res = runFakeGh(t, ['pr', 'create', '--title', 't'], { cwd: dir });
    assert.equal(res.code, 0, remoteUrl);
    assert.equal(res.stdout, `https://github.com/${expected}/pull/1\n`, remoteUrl);
  }
});

test('不在 git 仓库里时：FAKE_GH_REPO 兜底，再兜底 fake-owner/fake-repo', async (t) => {
  const withEnv = runFakeGh(t, ['pr', 'create', '--title', 't'], { env: { FAKE_GH_REPO: 'env/override' } });
  assert.equal(withEnv.stdout, 'https://github.com/env/override/pull/1\n');

  const fallback = runFakeGh(t, ['pr', 'create', '--title', 't'], {});
  assert.equal(fallback.stdout, 'https://github.com/fake-owner/fake-repo/pull/1\n');
});

test('其他子命令与无参数：静默退出 0', async (t) => {
  for (const args of [[], ['auth', 'status'], ['pr', 'view', '1'], ['repo', 'list']]) {
    const res = runFakeGh(t, args, {});
    assert.equal(res.code, 0, JSON.stringify(args));
    assert.equal(res.stdout, '', JSON.stringify(args));
    assert.equal(res.stderr, '', JSON.stringify(args));
  }
});

test('fakeEnv 的 PATH shim：裸 gh 命令也命中假替身', (t) => {
  const res = spawnSync('gh', ['pr', 'create', '--repo', 'a/b', '--title', 't'], {
    cwd: makeTempHome(t),
    env: fakeEnv(),
    encoding: 'utf8',
  });
  assert.ok(!res.error, `应通过 PATH 找到 gh shim：${res.error}`);
  assert.equal(res.status, 0);
  assert.equal(res.stdout, 'https://github.com/a/b/pull/1\n');
});
