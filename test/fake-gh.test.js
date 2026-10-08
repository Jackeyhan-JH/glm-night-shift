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

test('验收：pr list --state open --json url 未设 FAKE_GH_EXISTING_PR_URL 时输出 []', async (t) => {
  const res = runFakeGh(t, ['pr', 'list', '--repo', 'a/b', '--head', 'x', '--state', 'open', '--json', 'url'], {});
  assert.equal(res.code, 0);
  assert.equal(res.stdout, '[]\n');
  assert.equal(res.stderr, '');
});

test('设 FAKE_GH_EXISTING_PR_URL 时 pr list 输出含该 URL 的数组（JSON 可解析）', async (t) => {
  const res = runFakeGh(t, ['pr', 'list', '--repo', 'a/b', '--head', 'x', '--state', 'open', '--json', 'url'], {
    env: { FAKE_GH_EXISTING_PR_URL: 'https://github.com/a/b/pull/5' },
  });
  assert.equal(res.code, 0);
  assert.deepEqual(JSON.parse(res.stdout), [{ url: 'https://github.com/a/b/pull/5' }]);
  assert.ok(res.stdout.endsWith('\n'));
});

test('FAKE_GH_BODY_COPY：pr create 把 --body-file 的内容复制过去（两种写法都支持）', async (t) => {
  const dir = makeTempHome(t);
  const bodyFile = path.join(dir, 'body.md');
  fs.writeFileSync(bodyFile, '# 正文\n\n由 GLM 夜班自动创建\n');
  const forms = [['空格写法', ['--body-file', bodyFile]], ['等号写法', [`--body-file=${bodyFile}`]]];
  for (const [label, form] of forms) {
    const copyTo = path.join(dir, `copy-${label}.md`);
    const res = runFakeGh(t, ['pr', 'create', '--repo', 'a/b', '--title', 't', ...form], {
      env: { FAKE_GH_BODY_COPY: copyTo },
      cwd: dir,
    });
    assert.equal(res.code, 0, label);
    assert.equal(res.stdout, 'https://github.com/a/b/pull/1\n', label);
    assert.equal(fs.readFileSync(copyTo, 'utf8'), '# 正文\n\n由 GLM 夜班自动创建\n', label);
  }
});

test('FAKE_GH_BODY_COPY 与 FAKE_GH_FAIL=1 同时设置时不复制（失败路径没有正文可给）', async (t) => {
  const dir = makeTempHome(t);
  const bodyFile = path.join(dir, 'body.md');
  fs.writeFileSync(bodyFile, 'x');
  const copyTo = path.join(dir, 'copy.md');
  const res = runFakeGh(t, ['pr', 'create', '--repo', 'a/b', '--body-file', bodyFile], {
    env: { FAKE_GH_BODY_COPY: copyTo, FAKE_GH_FAIL: '1' },
    cwd: dir,
  });
  assert.equal(res.code, 1);
  assert.equal(fs.existsSync(copyTo), false);
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

// —— issue view（issue #13 的任务模板用） ——

test('验收: issue view 3 --repo a/b --json title,body 输出可解析 JSON，title 为 Fake issue #3', async (t) => {
  const res = runFakeGh(t, ['issue', 'view', '3', '--repo', 'a/b', '--json', 'title,body'], {});
  assert.equal(res.code, 0);
  assert.equal(res.stderr, '');
  const issue = JSON.parse(res.stdout);
  assert.equal(issue.title, 'Fake issue #3');
  assert.equal(issue.body, 'Fake body of a/b#3');
});

test('验收: FAKE_GH_ISSUE_FILE 指向的文件内容被原样输出', async (t) => {
  const dir = makeTempHome(t);
  const issueFile = path.join(dir, 'issue.json');
  fs.writeFileSync(issueFile, '{"title":"文件标题","body":"无尾换行"}'); // 故意不带换行
  const res = runFakeGh(t, ['issue', 'view', '5', '--repo', 'a/b', '--json', 'title,body'], {
    env: { FAKE_GH_ISSUE_FILE: issueFile },
    cwd: dir,
  });
  assert.equal(res.code, 0);
  assert.equal(res.stdout, '{"title":"文件标题","body":"无尾换行"}', '内容原样（不补换行）');
});

test('FAKE_GH_ISSUE_JSON 覆盖输出；优先级低于 FAKE_GH_ISSUE_FILE', async (t) => {
  const viaJson = runFakeGh(t, ['issue', 'view', '1', '--repo', 'a/b', '--json', 'title,body'], {
    env: { FAKE_GH_ISSUE_JSON: '{"title":"自定义","body":"正文"}' },
  });
  assert.equal(viaJson.code, 0);
  assert.deepEqual(JSON.parse(viaJson.stdout), { title: '自定义', body: '正文' });

  const dir = makeTempHome(t);
  const issueFile = path.join(dir, 'issue.json');
  fs.writeFileSync(issueFile, '{"title":"文件版"}');
  const viaFile = runFakeGh(t, ['issue', 'view', '1', '--repo', 'a/b', '--json', 'title,body'], {
    env: { FAKE_GH_ISSUE_FILE: issueFile, FAKE_GH_ISSUE_JSON: '{"title":"字符串版"}' },
    cwd: dir,
  });
  assert.equal(JSON.parse(viaFile.stdout).title, '文件版');
});

test('FAKE_GH_ISSUE_FAIL=1：stderr 含 Could not resolve，退出 1', async (t) => {
  const res = runFakeGh(t, ['issue', 'view', '42', '--repo', 'a/b', '--json', 'title,body'], {
    env: { FAKE_GH_ISSUE_FAIL: '1' },
  });
  assert.equal(res.code, 1);
  assert.equal(res.stdout, '');
  assert.ok(res.stderr.includes('Could not resolve to an issue or pull request with the number of 42.'), res.stderr);
});
