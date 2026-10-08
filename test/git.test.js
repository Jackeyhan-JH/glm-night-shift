// src/git.js 的 git 部分测试（issue #8）：全部用本地 bare 仓库当远端、真实 git 操作，
// 绝不联网、不碰 GitHub。gh（假替身）相关测试在 test/git-pr.test.js。
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  GitError,
  remoteUrl,
  repoCacheDir,
  ensureRepoCache,
  defaultBranch,
  branchName,
  slugify,
  createWorktree,
  commitAll,
  runTestCommand,
  pushBranch,
  removeWorktree,
  prTitle,
  formatDuration,
  buildPrBody,
  createPr,
} from '../src/git.js';
import { makeTempHome, fixturePath, fakeEnv } from './helpers.js';

// 隔离 git 配置（node:test 每个文件独立进程，改 process.env 只影响本文件）：
// 不读机器的系统/全局配置——GIT_CONFIG_GLOBAL 指向不存在的文件等于空配置，也无需清理；
// 提交身份用环境变量显式给，不依赖任何机器设置。
process.env.GIT_CONFIG_NOSYSTEM = '1';
process.env.GIT_CONFIG_GLOBAL = path.join(os.tmpdir(), 'night-shift-git-test-absent-global-config');
process.env.GIT_AUTHOR_NAME = '夜班测试';
process.env.GIT_AUTHOR_EMAIL = 'night-shift-test@example.com';
process.env.GIT_COMMITTER_NAME = '夜班测试';
process.env.GIT_COMMITTER_EMAIL = 'night-shift-test@example.com';

/** 同步跑 git（参数数组，无 shell），失败即断言失败并附 stderr。 */
function git(args, cwd) {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.ok(res.status === 0, `git ${args.join(' ')} 失败（cwd=${cwd}）：${res.stderr}`);
  return res.stdout;
}

/**
 * 建一个本地 bare 仓库当远端：默认分支 branch（main 或 trunk），含一个 README 提交。
 * 返回 { dir（bare 所在临时目录）, bare, seed（可继续推送的克隆）, baseSha }。
 */
function makeBareRemote(t, { branch = 'main', repo = 'a/b' } = {}) {
  const dir = makeTempHome(t);
  const bare = path.join(dir, `${repo.replace('/', '__')}.git`);
  git(['init', '--bare', '-q', '-b', branch, bare]);
  const seed = path.join(dir, 'seed');
  git(['clone', '--quiet', bare, seed]); // 空仓库克隆只警告不失败
  git(['symbolic-ref', 'HEAD', `refs/heads/${branch}`], seed);
  fs.writeFileSync(path.join(seed, 'README.md'), `# ${repo}\n`);
  git(['add', '-A'], seed);
  git(['commit', '--quiet', '-m', 'init'], seed);
  const baseSha = git(['rev-parse', 'HEAD'], seed).trim();
  git(['push', '--quiet', 'origin', `HEAD:refs/heads/${branch}`], seed);
  return { dir, bare, seed, baseSha };
}

/** remoteUrlTemplate 指向本地 bare 仓库目录的配置。 */
function configFor(bareDir) {
  return { remoteUrlTemplate: path.join(bareDir, '{owner}__{name}.git') };
}

/** 常用前置：bare 远端 + home + task-12 的 worktree。 */
async function prepareWorktree(t) {
  const remote = makeBareRemote(t);
  const home = makeTempHome(t);
  const wt = await createWorktree({
    home,
    repo: 'a/b',
    task: { id: 12, title: 'fix login bug' },
    baseBranch: 'main',
    config: configFor(remote.dir),
  });
  return { ...remote, home, wt };
}

// —— 纯函数 ——

test('验收：remoteUrl 替换 {repo}/{owner}/{name}；缺省时用 GitHub 默认模板', () => {
  assert.equal(remoteUrl('a/b', { remoteUrlTemplate: '/tmp/x/{owner}__{name}.git' }), '/tmp/x/a__b.git');
  assert.equal(remoteUrl('a/b', {}), 'https://github.com/a/b.git');
  assert.equal(remoteUrl('a/b'), 'https://github.com/a/b.git');
  assert.equal(remoteUrl('a/b', { remoteUrlTemplate: null }), 'https://github.com/a/b.git');
  assert.equal(
    remoteUrl('o.n-m_e/r', { remoteUrlTemplate: '/r/{repo}|{owner}|{name}' }),
    '/r/o.n-m_e/r|o.n-m_e|r',
  );
  // 前后空白容忍
  assert.equal(remoteUrl(' a/b ', { remoteUrlTemplate: '/tmp/{repo}.git' }), '/tmp/a/b.git');
});

test('remoteUrl：非法 repo 抛错', () => {
  for (const bad of ['a', 'a/b/c', '', ' ', 'a b/c', '/b', 'a/', 'a/b?c', null, undefined, 42]) {
    assert.throws(() => remoteUrl(bad, {}), /owner\/name/, JSON.stringify(bad));
  }
});

test('repoCacheDir：<home>/repos/<owner>__<name>；非法 repo 抛错', () => {
  assert.equal(repoCacheDir('/h', 'a/b'), path.join('/h', 'repos', 'a__b'));
  assert.throws(() => repoCacheDir('/h', 'oops'), /owner\/name/);
});

test('验收：branchName / slugify', () => {
  assert.equal(branchName({ id: 12, title: 'Fix Login Bug!!' }), 'night-shift/12-fix-login-bug');
  assert.equal(branchName({ id: 3, title: '修复登录' }), 'night-shift/3-task');
  assert.equal(slugify('Fix Login Bug!!'), 'fix-login-bug');
  assert.equal(slugify('  --Hello,  World!!  '), 'hello-world');
  assert.equal(slugify('！！！'), 'task');
  assert.equal(slugify('🎉🎉 emoji 标题'), 'emoji');
  assert.equal(branchName({ id: 7 }), 'night-shift/7-task');

  // 超长标题：slug ≤ 40 且结尾无 '-'
  const long = branchName({ id: 99, title: 'a'.repeat(100) });
  assert.equal(long, `night-shift/99-${'a'.repeat(40)}`);
  const dashed = branchName({ id: 5, title: `a${'-'.repeat(50)}` });
  assert.equal(dashed, 'night-shift/5-a'); // 截到 40 后还要再剪掉尾部的 '-'

  for (const badId of [0, -1, 1.5, '12', null, undefined]) {
    assert.throws(() => branchName({ id: badId, title: 'x' }), /正整数/, JSON.stringify(badId));
  }
});

test('prTitle：night-shift: <标题>', () => {
  assert.equal(prTitle({ title: 'Fix Login Bug!!' }), 'night-shift: Fix Login Bug!!');
  assert.equal(prTitle({ title: '  修好它 ' }), 'night-shift: 修好它');
  assert.equal(prTitle({}), 'night-shift: 未命名任务');
  assert.equal(prTitle(null), 'night-shift: 未命名任务');
});

test('formatDuration 人类可读', () => {
  assert.equal(formatDuration(0), '<1 秒');
  assert.equal(formatDuration(999), '<1 秒');
  assert.equal(formatDuration(45000), '45 秒');
  assert.equal(formatDuration(60000), '1 分');
  assert.equal(formatDuration(65000), '1 分 5 秒');
  assert.equal(formatDuration(3600000), '1 小时');
  assert.equal(formatDuration(3723000), '1 小时 2 分 3 秒');
  assert.equal(formatDuration(undefined), '未知');
  assert.equal(formatDuration(null), '未知');
  assert.equal(formatDuration(-5), '未知');
});

// —— 仓库缓存 ——

test('验收：ensureRepoCache 首次克隆到 <home>/repos/a__b，远端推进后再调用缓存跟随', async (t) => {
  const { dir, bare, seed, baseSha } = makeBareRemote(t);
  const home = makeTempHome(t);
  const config = configFor(dir);
  const cache = await ensureRepoCache({ home, repo: 'a/b', config });
  assert.equal(cache, path.join(home, 'repos', 'a__b'));
  assert.ok(fs.statSync(path.join(cache, '.git', 'HEAD')).isFile());
  assert.equal(git(['rev-parse', 'origin/main'], cache).trim(), baseSha);

  // 往 bare 再推一个提交，第二次调用后缓存里的 origin/main 前进
  fs.writeFileSync(path.join(seed, 'second.txt'), '2\n');
  git(['add', '-A'], seed);
  git(['commit', '--quiet', '-m', 'second'], seed);
  git(['push', '--quiet', 'origin', `HEAD:refs/heads/main`], seed);
  const again = await ensureRepoCache({ home, repo: 'a/b', config });
  assert.equal(again, cache);
  assert.equal(git(['rev-parse', 'origin/main'], cache).trim(), git(['rev-parse', 'main'], bare).trim());
  assert.notEqual(git(['rev-parse', 'origin/main'], cache).trim(), baseSha);
});

test('ensureRepoCache：模板变化后把 origin 重指到新地址并拉取新远端', async (t) => {
  const first = makeBareRemote(t);
  const second = makeBareRemote(t);
  const home = makeTempHome(t);
  const cache = await ensureRepoCache({ home, repo: 'a/b', config: configFor(first.dir) });
  assert.equal(git(['remote', 'get-url', 'origin'], cache).trim(), first.bare);
  await ensureRepoCache({ home, repo: 'a/b', config: configFor(second.dir) });
  assert.equal(git(['remote', 'get-url', 'origin'], cache).trim(), second.bare);
  assert.equal(git(['rev-parse', 'origin/main'], cache).trim(), second.baseSha);
});

test('ensureRepoCache：缓存目录损坏（半截克隆）时删除重克隆', async (t) => {
  const { dir, baseSha } = makeBareRemote(t);
  const home = makeTempHome(t);
  const cache = repoCacheDir(home, 'a/b');
  fs.mkdirSync(cache, { recursive: true });
  fs.writeFileSync(path.join(cache, 'half'), '克隆到一半的残骸');
  const result = await ensureRepoCache({ home, repo: 'a/b', config: configFor(dir) });
  assert.equal(result, cache);
  assert.equal(fs.existsSync(path.join(cache, 'half')), false);
  assert.equal(git(['rev-parse', 'origin/main'], cache).trim(), baseSha);
});

test('ensureRepoCache：缓存是有效仓库但没有 origin 远端时也重克隆', async (t) => {
  const { dir, baseSha } = makeBareRemote(t);
  const home = makeTempHome(t);
  const cache = repoCacheDir(home, 'a/b');
  git(['init', '-q', cache]);
  await ensureRepoCache({ home, repo: 'a/b', config: configFor(dir) });
  assert.equal(git(['rev-parse', 'origin/main'], cache).trim(), baseSha);
});

// —— 默认分支 ——

test('验收：defaultBranch 对 main / trunk 两个 bare 仓库分别返回正确分支', async (t) => {
  const mainRemote = makeBareRemote(t, { branch: 'main' });
  const trunkRemote = makeBareRemote(t, { branch: 'trunk' });
  const home = makeTempHome(t);
  const mainCache = await ensureRepoCache({ home, repo: 'a/b', config: configFor(mainRemote.dir) });
  assert.equal(await defaultBranch(mainCache), 'main');
  const trunkCache = await ensureRepoCache({ home, repo: 'a/b', config: configFor(trunkRemote.dir) });
  assert.equal(await defaultBranch(trunkCache), 'trunk');
});

test('defaultBranch：空 bare 仓库解析不出分支时抛 GitError', async (t) => {
  const dir = makeTempHome(t);
  git(['init', '--bare', '-q', '-b', 'main', path.join(dir, 'a__b.git')]);
  const home = makeTempHome(t);
  const cache = await ensureRepoCache({ home, repo: 'a/b', config: configFor(dir) });
  await assert.rejects(
    () => defaultBranch(cache),
    (err) => err instanceof GitError && err.message.includes('ls-remote'),
  );
});

// —— worktree ——

test('验收：createWorktree 建出 task-12、分支正确、内容等于 origin/main', async (t) => {
  const { dir, baseSha } = makeBareRemote(t);
  const home = makeTempHome(t);
  const wt = await createWorktree({
    home,
    repo: 'a/b',
    task: { id: 12, title: 'Fix Login Bug!!' },
    baseBranch: 'main',
    config: configFor(dir),
  });
  assert.equal(wt.path, path.join(home, 'worktrees', 'task-12'));
  assert.equal(wt.branch, 'night-shift/12-fix-login-bug');
  assert.equal(wt.baseBranch, 'main');
  assert.equal(wt.baseSha, baseSha);
  assert.ok(fs.existsSync(path.join(wt.path, 'README.md')), '检出内容应等于 origin/main');
  assert.equal(git(['rev-parse', '--abbrev-ref', 'HEAD'], wt.path).trim(), wt.branch);
  assert.equal(git(['rev-parse', 'HEAD'], wt.path).trim(), baseSha);
  assert.equal(git(['rev-parse', `refs/heads/${wt.branch}`], repoCacheDir(home, 'a/b')).trim(), baseSha);
});

test('验收：对同一任务再次 createWorktree 不报错，分支被重置回基线', async (t) => {
  const { dir, baseSha } = makeBareRemote(t);
  const home = makeTempHome(t);
  const opts = {
    home,
    repo: 'a/b',
    task: { id: 12, title: 'fix login bug' },
    baseBranch: 'main',
    config: configFor(dir),
  };
  const first = await createWorktree(opts);
  fs.writeFileSync(path.join(first.path, 'new.txt'), 'x\n');
  const committed = await commitAll({ worktree: first.path, message: '第一次改动', config: {} });
  assert.equal(committed.changed, true);

  const second = await createWorktree(opts);
  assert.equal(second.path, first.path);
  assert.equal(second.branch, first.branch);
  assert.equal(second.baseSha, baseSha);
  assert.equal(git(['rev-parse', 'HEAD'], second.path).trim(), baseSha);
  assert.equal(git(['status', '--porcelain'], second.path), '', '重置后工作区应干净');
  assert.equal(fs.existsSync(path.join(second.path, 'new.txt')), false);
});

test('createWorktree：目标路径被非 worktree 的残留目录占用时先清掉', async (t) => {
  const { dir } = makeBareRemote(t);
  const home = makeTempHome(t);
  const junk = path.join(home, 'worktrees', 'task-12');
  fs.mkdirSync(junk, { recursive: true });
  fs.writeFileSync(path.join(junk, 'junk.txt'), '残留');
  const wt = await createWorktree({
    home, repo: 'a/b', task: { id: 12, title: 'x' }, baseBranch: 'main', config: configFor(dir),
  });
  assert.equal(fs.existsSync(path.join(wt.path, 'junk.txt')), false);
  assert.ok(fs.existsSync(path.join(wt.path, 'README.md')));
});

// —— 提交 ——

test('验收：commitAll 无改动 changed:false；写文件后 changed:true 且 git log 里有提交', async (t) => {
  const { wt } = await prepareWorktree(t);
  assert.deepEqual(await commitAll({ worktree: wt.path, message: '空提交', config: {} }), { changed: false, sha: null });

  fs.writeFileSync(path.join(wt.path, 'feat.txt'), '新功能\n');
  const res = await commitAll({ worktree: wt.path, message: '加 feat', config: {} });
  assert.equal(res.changed, true);
  assert.match(res.sha, /^[0-9a-f]{40}$/);
  assert.equal(git(['rev-parse', 'HEAD'], wt.path).trim(), res.sha);
  assert.equal(git(['log', '-1', '--format=%s'], wt.path).trim(), '加 feat');
  assert.equal(git(['status', '--porcelain'], wt.path), '');
});

test('验收：Claude 已自行提交（工作区干净）时 commitAll 仍返回 changed:true', async (t) => {
  const { wt } = await prepareWorktree(t);
  fs.writeFileSync(path.join(wt.path, 'by-claude.txt'), '1\n');
  git(['add', '-A'], wt.path);
  git(['commit', '--quiet', '-m', 'claude 自己提交'], wt.path);
  const head = git(['rev-parse', 'HEAD'], wt.path).trim();
  assert.deepEqual(
    await commitAll({ worktree: wt.path, message: '没活可干', config: {} }),
    { changed: true, sha: head },
  );
});

test('commitAll：自行提交后还有脏文件时，脏文件也一并提交', async (t) => {
  const { wt } = await prepareWorktree(t);
  fs.writeFileSync(path.join(wt.path, 'a.txt'), '1\n');
  git(['add', '-A'], wt.path);
  git(['commit', '--quiet', '-m', 'claude 提交'], wt.path);
  const claudeSha = git(['rev-parse', 'HEAD'], wt.path).trim();
  fs.writeFileSync(path.join(wt.path, 'b.txt'), '2\n');

  const res = await commitAll({ worktree: wt.path, message: '收尾提交', config: {} });
  assert.equal(res.changed, true);
  assert.notEqual(res.sha, claudeSha);
  assert.equal(git(['log', '-1', '--format=%s'], wt.path).trim(), '收尾提交');
  assert.equal(git(['status', '--porcelain'], wt.path), '');
});

test('commitAll：config 的 gitAuthorName/gitAuthorEmail 覆盖提交身份', async (t) => {
  const { wt } = await prepareWorktree(t);
  fs.writeFileSync(path.join(wt.path, 'x.txt'), '1\n');
  const res = await commitAll({
    worktree: wt.path,
    message: '署名提交',
    config: { gitAuthorName: '夜班机器人', gitAuthorEmail: 'bot@night.shift' },
  });
  assert.equal(res.changed, true);
  assert.equal(git(['log', '-1', '--format=%an <%ae>'], wt.path).trim(), '夜班机器人 <bot@night.shift>');
});

test('commitAll：显式 baseSha 优先于 createWorktree 记录的基线', async (t) => {
  const { wt } = await prepareWorktree(t);
  fs.writeFileSync(path.join(wt.path, 'a.txt'), '1\n');
  git(['add', '-A'], wt.path);
  git(['commit', '--quiet', '-m', 'claude 提交'], wt.path);
  const head = git(['rev-parse', 'HEAD'], wt.path).trim();
  // 记录的基线是旧 HEAD，但显式 baseSha 说「以当前为基线」→ 不算有改动
  assert.deepEqual(
    await commitAll({ worktree: wt.path, message: '无改动', config: {}, baseSha: head }),
    { changed: false, sha: null },
  );
});

test('commitAll：没有记录基线时用「HEAD 领先上游」兜底判断', async (t) => {
  const { wt } = await prepareWorktree(t);
  const gitDir = path.resolve(wt.path, git(['rev-parse', '--git-dir'], wt.path).trim());
  fs.rmSync(path.join(gitDir, 'night-shift-base'));
  assert.deepEqual(await commitAll({ worktree: wt.path, message: '无', config: {} }), { changed: false, sha: null });

  fs.writeFileSync(path.join(wt.path, 'a.txt'), '1\n');
  git(['add', '-A'], wt.path);
  git(['commit', '--quiet', '-m', 'claude 提交'], wt.path);
  const res = await commitAll({ worktree: wt.path, message: '无', config: {} });
  assert.equal(res.changed, true);
});

test('commitAll：参数缺失时抛错', async (t) => {
  const { wt } = await prepareWorktree(t);
  await assert.rejects(() => commitAll({ worktree: wt.path, message: '  ', config: {} }), /提交说明/);
  await assert.rejects(() => commitAll({ worktree: '', message: 'x', config: {} }), /worktree/);
});

// —— 测试命令 ——

test('验收：runTestCommand 基本行为（exit 0 / exit 3 / 空命令）', async (t) => {
  const dir = makeTempHome(t);
  const okRes = await runTestCommand({ worktree: dir, command: 'exit 0' });
  assert.equal(okRes.ok, true);
  assert.equal(okRes.skipped, false);
  assert.equal(okRes.exitCode, 0);
  assert.equal(okRes.timedOut, false);
  assert.ok(typeof okRes.durationMs === 'number' && okRes.durationMs >= 0);
  assert.equal(okRes.output, '');

  const fail = await runTestCommand({ worktree: dir, command: 'echo boom; exit 3' });
  assert.equal(fail.ok, false);
  assert.equal(fail.skipped, false);
  assert.equal(fail.exitCode, 3);
  assert.equal(fail.timedOut, false);
  assert.ok(fail.output.includes('boom'));

  for (const command of ['', '   ', null, undefined]) {
    assert.deepEqual(await runTestCommand({ worktree: dir, command }), { ok: true, skipped: true }, JSON.stringify(command));
  }
  assert.deepEqual(await runTestCommand({ worktree: dir }), { ok: true, skipped: true });
});

test('验收：sleep 5 + timeoutMs 300 超时 SIGTERM，1 秒内返回', async (t) => {
  const dir = makeTempHome(t);
  const res = await runTestCommand({ worktree: dir, command: 'sleep 5', timeoutMs: 300 });
  assert.equal(res.timedOut, true);
  assert.equal(res.ok, false);
  assert.equal(res.skipped, false);
  assert.equal(res.exitCode, null);
  assert.ok(res.durationMs < 1000, `耗时 ${res.durationMs}ms 应小于 1s`);
});

test('超时连孙进程一起杀：sleep 30 & sleep 30; wait', async (t) => {
  const dir = makeTempHome(t);
  const res = await runTestCommand({ worktree: dir, command: 'sleep 30 & sleep 30; wait', timeoutMs: 300 });
  assert.equal(res.timedOut, true);
  assert.equal(res.exitCode, null);
  assert.ok(res.durationMs < 1500, `耗时 ${res.durationMs}ms 应立刻返回`);
});

test('后台孙进程占着输出管道也不至于永远等下去', async (t) => {
  const dir = makeTempHome(t);
  const res = await runTestCommand({ worktree: dir, command: 'echo hi; sleep 20 &', timeoutMs: 60000 });
  assert.equal(res.exitCode, 0);
  assert.equal(res.ok, true);
  assert.ok(res.output.includes('hi'));
  assert.ok(res.durationMs < 5000, `耗时 ${res.durationMs}ms 应在宽限期内收尾`);
});

test('stdout 与 stderr 都进 output', async (t) => {
  const dir = makeTempHome(t);
  const res = await runTestCommand({ worktree: dir, command: 'echo out; echo err >&2; exit 9' });
  assert.equal(res.exitCode, 9);
  assert.ok(res.output.includes('out'));
  assert.ok(res.output.includes('err'));
});

test('输出只保留末尾 64KiB，且截断处不会产生坏 UTF-8 开头', async (t) => {
  const dir = makeTempHome(t);
  // 65530 个 a + 3 字节的「中」+ 65535 个 b：丢弃前 32 字节正好落在「中」的中间，
  // 剩下 [续字节] + b*65535，解码前必须先跳过那个续字节
  const tricky = '{ head -c 65530 /dev/zero | tr "\\0" a; printf \'中\'; head -c 65535 /dev/zero | tr "\\0" b; }';
  const res = await runTestCommand({ worktree: dir, command: tricky });
  assert.equal(res.exitCode, 0);
  assert.equal(res.output, 'b'.repeat(65535));
  assert.equal(Buffer.byteLength(res.output, 'utf8'), 65535);

  const many = await runTestCommand({
    worktree: dir,
    command: 'i=0; while [ $i -lt 20000 ]; do i=$((i+1)); echo $i; done',
  });
  assert.equal(many.exitCode, 0);
  assert.ok(Buffer.byteLength(many.output, 'utf8') <= 64 * 1024);
  assert.ok(many.output.endsWith('20000\n'), '保留的应是末尾');
  assert.ok(!many.output.startsWith('1\n'), '最早的输出应被丢弃');
});

test('超时缺省值来自 config.testTimeoutMinutes；非法超时抛错', async (t) => {
  const dir = makeTempHome(t);
  const res = await runTestCommand({ worktree: dir, command: 'sleep 5', config: { testTimeoutMinutes: 0.005 } });
  assert.equal(res.timedOut, true);
  await assert.rejects(() => runTestCommand({ worktree: dir, command: 'true', timeoutMs: 0 }), /大于 0/);
  await assert.rejects(() => runTestCommand({ worktree: dir, command: 'true', timeoutMs: -5 }), /大于 0/);
});

test('runTestCommand：worktree 不存在时不抛错，ok:false、说明在 output 里', async (t) => {
  const dir = path.join(makeTempHome(t), 'nope');
  const res = await runTestCommand({ worktree: dir, command: 'true', timeoutMs: 5000 });
  assert.equal(res.ok, false);
  assert.equal(res.skipped, false);
  assert.equal(res.exitCode, null);
  assert.ok(res.output.length > 0);
});

// —— 推送 ——

test('验收：pushBranch 推到 bare 的 night-shift/ 分支；amend 后可覆盖；拒绝其他命名空间', async (t) => {
  const { dir, bare } = makeBareRemote(t);
  const home = makeTempHome(t);
  const wt = await createWorktree({
    home, repo: 'a/b', task: { id: 12, title: 'fix login bug' }, baseBranch: 'main', config: configFor(dir),
  });
  fs.writeFileSync(path.join(wt.path, 'change.txt'), 'v1\n');
  const { sha } = await commitAll({ worktree: wt.path, message: 'v1', config: {} });

  const pushed = await pushBranch({ worktree: wt.path, branch: wt.branch });
  assert.deepEqual(pushed, { branch: wt.branch, sha });
  assert.equal(git(['rev-parse', `refs/heads/${wt.branch}`], bare).trim(), sha);

  // amend 产生非快进历史，--force-with-lease 允许覆盖（远端仍在 lease 认可的位置上）
  git(['commit', '--quiet', '--amend', '-m', 'v2'], wt.path);
  const amendedSha = git(['rev-parse', 'HEAD'], wt.path).trim();
  const pushedAgain = await pushBranch({ worktree: wt.path, branch: wt.branch });
  assert.equal(pushedAgain.sha, amendedSha);
  assert.equal(git(['rev-parse', `refs/heads/${wt.branch}`], bare).trim(), amendedSha);

  // 非 night-shift/ 分支拒绝，远端 main 不动
  const mainBefore = git(['rev-parse', 'refs/heads/main'], bare).trim();
  await assert.rejects(() => pushBranch({ worktree: wt.path, branch: 'main' }), /night-shift\//);
  await assert.rejects(() => pushBranch({ worktree: wt.path, branch: 'feature/x' }), /night-shift\//);
  assert.equal(git(['rev-parse', 'refs/heads/main'], bare).trim(), mainBefore);
});

// —— 清理 ——

test('验收：removeWorktree 删目录、worktree list 里没有、分支保留、重复调用不报错', async (t) => {
  const { dir } = makeBareRemote(t);
  const home = makeTempHome(t);
  const cache = repoCacheDir(home, 'a/b');
  const wt = await createWorktree({
    home, repo: 'a/b', task: { id: 12, title: 'fix login bug' }, baseBranch: 'main', config: configFor(dir),
  });

  await removeWorktree({ home, repo: 'a/b', worktree: wt.path });
  assert.equal(fs.existsSync(wt.path), false);
  assert.ok(!git(['worktree', 'list'], cache).includes(wt.path));
  assert.equal(git(['rev-parse', `refs/heads/${wt.branch}`], cache).trim(), wt.baseSha, '分支应保留');

  await removeWorktree({ home, repo: 'a/b', worktree: wt.path }); // 再来一次
  await removeWorktree({ home, repo: 'a/b', worktree: path.join(home, 'worktrees', 'task-999') }); // 从没存在过
});

test('removeWorktree：缓存目录没了但 worktree 目录还在 → 直接删目录不报错', async (t) => {
  const { dir } = makeBareRemote(t);
  const home = makeTempHome(t);
  const wt = await createWorktree({
    home, repo: 'a/b', task: { id: 12, title: 'x' }, baseBranch: 'main', config: configFor(dir),
  });
  fs.rmSync(repoCacheDir(home, 'a/b'), { recursive: true, force: true });
  await removeWorktree({ home, repo: 'a/b', worktree: wt.path });
  assert.equal(fs.existsSync(wt.path), false);
});

// —— 并发 ——

test('并发：同一仓库两个任务同时 ensureRepoCache + createWorktree 都成功', async (t) => {
  const { dir, baseSha } = makeBareRemote(t);
  const home = makeTempHome(t);
  const config = configFor(dir);
  const runTask = (task) => ensureRepoCache({ home, repo: 'a/b', config })
    .then(() => createWorktree({ home, repo: 'a/b', task, baseBranch: 'main', config }));
  const [wt12, wt13] = await Promise.all([
    runTask({ id: 12, title: 'alpha' }),
    runTask({ id: 13, title: 'beta' }),
  ]);
  assert.equal(wt12.branch, 'night-shift/12-alpha');
  assert.equal(wt13.branch, 'night-shift/13-beta');
  for (const wt of [wt12, wt13]) {
    assert.ok(fs.existsSync(path.join(wt.path, 'README.md')));
    assert.equal(git(['rev-parse', 'HEAD'], wt.path).trim(), baseSha);
  }
  const list = git(['worktree', 'list'], repoCacheDir(home, 'a/b'));
  assert.ok(list.includes(wt12.path));
  assert.ok(list.includes(wt13.path));
});

// —— 错误对象 ——

test('GitError：command/args/exitCode/stderr 字段齐全，message 含命令与 stderr 末尾', async (t) => {
  const { dir } = makeBareRemote(t);
  const home = makeTempHome(t);
  const err = await createWorktree({
    home, repo: 'a/b', task: { id: 12, title: 'x' }, baseBranch: 'does-not-exist', config: configFor(dir),
  }).then(
    () => { throw new Error('应该失败才对'); },
    (e) => e,
  );
  assert.ok(err instanceof GitError, `应是 GitError，实际 ${err && err.name}`);
  assert.ok(err.command.startsWith('git worktree add -B'), err.command);
  assert.ok(err.args.includes('origin/does-not-exist'));
  assert.equal(typeof err.exitCode, 'number');
  assert.notEqual(err.exitCode, 0);
  assert.ok(err.stderr.length > 0);
  assert.ok(err.stderr.length <= 2000);
  assert.ok(err.message.includes(err.command));
  assert.ok(err.message.includes(String(err.exitCode)));
  assert.ok(err.message.includes(err.stderr.slice(-40)));
});

// —— 全流程 ——

test('全流程：缓存 → 默认分支 → worktree → 改动 → 提交 → 测试 → 推送 → 开 PR → 清理', async (t) => {
  const { dir, bare } = makeBareRemote(t);
  const home = makeTempHome(t);
  const repo = 'a/b';
  const config = { ...configFor(dir), ghBin: fixturePath('fake-gh.mjs') };
  const task = { id: 12, title: 'Fix Login Bug!!', prompt: '修复登录页的空指针', attempts: 2 };

  const cache = await ensureRepoCache({ home, repo, config });
  assert.equal(await defaultBranch(cache), 'main');

  const wt = await createWorktree({ home, repo, task, baseBranch: 'main', config });
  fs.writeFileSync(path.join(wt.path, 'fix.txt'), '修好了\n');
  const commit = await commitAll({ worktree: wt.path, message: '修复登录 bug', config });
  assert.equal(commit.changed, true);

  const testRun = await runTestCommand({ worktree: wt.path, command: 'echo 测试通过' });
  assert.equal(testRun.ok, true);

  const push = await pushBranch({ worktree: wt.path, branch: wt.branch });
  assert.equal(push.sha, commit.sha);
  assert.equal(git(['rev-parse', `refs/heads/${wt.branch}`], bare).trim(), commit.sha);

  const bodyCopy = path.join(makeTempHome(t), 'pr-body.md');
  const pr = await createPr({
    repo,
    branch: wt.branch,
    base: 'main',
    title: prTitle(task),
    body: buildPrBody({
      task,
      run: { summary: '改好了', model: 'glm-5.3', effort: 'high', peak: false, durationMs: 65000, quotaUnits: 1.5, attempt: 1 },
      test: { command: 'echo 测试通过', ...testRun },
    }),
    config,
    env: fakeEnv({ FAKE_GH_PR_NUMBER: '9', FAKE_GH_BODY_COPY: bodyCopy }),
  });
  assert.deepEqual(pr, { url: 'https://github.com/a/b/pull/9', existed: false });
  const copied = fs.readFileSync(bodyCopy, 'utf8');
  assert.ok(copied.includes('修复登录页的空指针'));
  assert.ok(copied.trimEnd().endsWith('由 GLM 夜班自动创建'));

  await removeWorktree({ home, repo, worktree: wt.path });
  assert.equal(fs.existsSync(wt.path), false);
  assert.equal(git(['rev-parse', `refs/heads/${wt.branch}`], bare).trim(), commit.sha, '远端分支应保留');
});
