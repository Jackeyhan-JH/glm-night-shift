// src/git.js 的 gh（假替身）集成与 PR 正文纯函数测试（issue #8）。
// gh 一律指向 test/fixtures/fake-gh.mjs（或临时写的小替身脚本），绝不联网。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GitError, findOpenPr, createPr, buildPrBody } from '../src/git.js';
import { fixturePath, fakeEnv, makeTempHome } from './helpers.js';

const FAKE_GH = fixturePath('fake-gh.mjs');

/** 写一个一次性的 gh 替身脚本（可执行，/bin/sh），用来制造假 gh 覆盖不了的场景。 */
function ghStub(t, script) {
  const file = path.join(makeTempHome(t), 'gh-stub.sh');
  fs.writeFileSync(file, `#!/bin/sh\n${script}\n`);
  fs.chmodSync(file, 0o755);
  return file;
}

// ghStub 里 pr list 一律输出空数组，方便脚本只关心 pr create 的行为
const PR_LIST_EMPTY = 'if [ "$1" = pr ] && [ "$2" = list ]; then echo "[]"; exit 0; fi';

function readGhLog(file) {
  return fs.readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line));
}

// —— findOpenPr ——

test('验收：findOpenPr 无已有 PR 时返回 null，gh argv 逐项正确', async (t) => {
  const log = path.join(makeTempHome(t), 'gh.log');
  const url = await findOpenPr({
    repo: 'a/b',
    branch: 'night-shift/12-fix-login-bug',
    config: { ghBin: FAKE_GH },
    env: fakeEnv({ FAKE_GH_LOG: log }),
  });
  assert.equal(url, null);
  assert.deepEqual(readGhLog(log), [[
    'pr', 'list', '--repo', 'a/b', '--head', 'night-shift/12-fix-login-bug',
    '--state', 'open', '--json', 'url',
  ]]);
});

test('验收：设 FAKE_GH_EXISTING_PR_URL 时 findOpenPr 返回该 URL', async (t) => {
  const url = await findOpenPr({
    repo: 'a/b',
    branch: 'night-shift/12-fix-login-bug',
    config: { ghBin: FAKE_GH },
    env: fakeEnv({ FAKE_GH_EXISTING_PR_URL: 'https://github.com/a/b/pull/5' }),
  });
  assert.equal(url, 'https://github.com/a/b/pull/5');
});

test('findOpenPr：输出不是 JSON 数组时抛 GitError（附 stdout 片段）', async (t) => {
  const stub = ghStub(t, 'echo "这不是 JSON"');
  await assert.rejects(
    () => findOpenPr({ repo: 'a/b', branch: 'x', config: { ghBin: stub }, env: fakeEnv() }),
    (err) => err instanceof GitError && err.message.includes('不是 JSON 数组') && err.message.includes('这不是 JSON'),
  );
});

test('findOpenPr：gh 退出码非 0 时抛 GitError（含退出码与 stderr）', async (t) => {
  const stub = ghStub(t, 'echo "gh 挂了" >&2; exit 7');
  await assert.rejects(
    () => findOpenPr({ repo: 'a/b', branch: 'x', config: { ghBin: stub }, env: fakeEnv() }),
    (err) => err instanceof GitError && err.exitCode === 7 && err.message.includes('gh 挂了'),
  );
});

test('ghBin 不存在：清晰的 GitError（带路径），不挂起；临时正文目录也不残留', async (t) => {
  const nope = path.join(makeTempHome(t), 'definitely-no-such-gh');
  await assert.rejects(
    () => findOpenPr({ repo: 'a/b', branch: 'night-shift/12-x', config: { ghBin: nope }, env: fakeEnv() }),
    (err) => err instanceof GitError && err.message.includes('无法启动') && err.message.includes(nope),
  );
  const leftovers = () => fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith('night-shift-pr-'));
  const before = leftovers().length;
  await assert.rejects(
    () => createPr({
      repo: 'a/b', branch: 'night-shift/12-x', base: 'main', title: 't', body: 'b',
      config: { ghBin: nope }, env: fakeEnv(),
    }),
    (err) => err instanceof GitError && err.message.includes('无法启动'),
  );
  assert.equal(leftovers().length, before, 'gh 启动失败的路径上临时目录也要删干净');
});

// —— createPr ——

test('验收：createPr 的 argv 精确、正文落到 FAKE_GH_BODY_COPY、临时正文文件删净', async (t) => {
  const dir = makeTempHome(t);
  const log = path.join(dir, 'gh.log');
  const bodyCopy = path.join(dir, 'pr-body.md');
  const task = { id: 12, title: 'Fix Login Bug!!', prompt: '修复登录页的空指针', attempts: 2 };
  const body = buildPrBody({
    task,
    run: {
      summary: '改完了', model: 'glm-5.3', effort: 'high', peak: false,
      durationMs: 65000, quotaUnits: 1.5, attempt: 1,
    },
    test: { command: 'npm test', ok: true, skipped: false, exitCode: 0, timedOut: false, durationMs: 800, output: 'ok' },
  });

  const pr = await createPr({
    repo: 'a/b',
    branch: 'night-shift/12-fix-login-bug',
    base: 'main',
    title: 'night-shift: Fix Login Bug!!',
    body,
    config: { ghBin: FAKE_GH },
    env: fakeEnv({ FAKE_GH_PR_NUMBER: '9', FAKE_GH_LOG: log, FAKE_GH_BODY_COPY: bodyCopy }),
  });
  assert.deepEqual(pr, { url: 'https://github.com/a/b/pull/9', existed: false });

  const calls = readGhLog(log);
  assert.equal(calls.length, 2, '应先 pr list 再 pr create');
  assert.deepEqual(calls[0], [
    'pr', 'list', '--repo', 'a/b', '--head', 'night-shift/12-fix-login-bug',
    '--state', 'open', '--json', 'url',
  ]);
  const create = calls[1];
  const bodyFileIndex = create.indexOf('--body-file');
  assert.notEqual(bodyFileIndex, -1, '--body-file 必须传');
  const bodyFile = create[bodyFileIndex + 1];
  assert.ok(path.isAbsolute(bodyFile) && bodyFile.startsWith(os.tmpdir()), `临时文件应在 ${os.tmpdir()} 下：${bodyFile}`);
  assert.equal(fs.existsSync(bodyFile), false, '用完的临时正文文件应已删除');
  assert.equal(fs.existsSync(path.dirname(bodyFile)), false, '临时目录也应删除');
  // 除 --body-file 的值（动态路径）外，argv 逐项精确
  assert.deepEqual(
    create.filter((_, i) => i !== bodyFileIndex && i !== bodyFileIndex + 1),
    [
      'pr', 'create',
      '--repo', 'a/b',
      '--head', 'night-shift/12-fix-login-bug',
      '--base', 'main',
      '--title', 'night-shift: Fix Login Bug!!',
    ],
  );

  const copied = fs.readFileSync(bodyCopy, 'utf8');
  assert.ok(copied.includes('修复登录页的空指针'), '正文含任务 prompt');
  assert.ok(copied.includes('glm-5.3'), '正文含模型');
  assert.ok(copied.includes('high'), '正文含思考强度');
  assert.ok(copied.trimEnd().endsWith('由 GLM 夜班自动创建'), '正文以页脚结尾');
});

test('验收：FAKE_GH_EXISTING_PR_URL 时 createPr 直接返回已有 PR，不再调 pr create', async (t) => {
  const dir = makeTempHome(t);
  const log = path.join(dir, 'gh.log');
  const pr = await createPr({
    repo: 'a/b',
    branch: 'night-shift/12-fix-login-bug',
    base: 'main',
    title: 'night-shift: Fix Login Bug!!',
    body: 'x',
    config: { ghBin: FAKE_GH },
    env: fakeEnv({ FAKE_GH_EXISTING_PR_URL: 'https://github.com/a/b/pull/5', FAKE_GH_LOG: log }),
  });
  assert.deepEqual(pr, { url: 'https://github.com/a/b/pull/5', existed: true });
  const calls = readGhLog(log);
  assert.equal(calls.length, 1, '只应有 pr list 一次调用');
  assert.equal(calls[0][1], 'list');
});

test('验收：FAKE_GH_FAIL=1 时 createPr 抛错且信息含 fake gh failure', async (t) => {
  await assert.rejects(
    () => createPr({
      repo: 'a/b',
      branch: 'night-shift/12-x',
      base: 'main',
      title: 't',
      body: 'b',
      config: { ghBin: FAKE_GH },
      env: fakeEnv({ FAKE_GH_FAIL: '1' }),
    }),
    (err) => err instanceof GitError && err.message.includes('fake gh failure'),
  );
});

test('createPr：从 stdout 取最后一个 PR 地址', async (t) => {
  const stub = ghStub(t, `${PR_LIST_EMPTY}
echo 前置提示
echo https://github.com/a/b/pull/1
echo https://github.com/a/b/pull/42`);
  const pr = await createPr({
    repo: 'a/b', branch: 'night-shift/12-x', base: 'main', title: 't', body: 'b',
    config: { ghBin: stub }, env: fakeEnv(),
  });
  assert.deepEqual(pr, { url: 'https://github.com/a/b/pull/42', existed: false });
});

test('createPr：退出码 0 但 stdout 里没有 PR 地址时抛错', async (t) => {
  const stub = ghStub(t, `${PR_LIST_EMPTY}
echo 没有地址`);
  await assert.rejects(
    () => createPr({
      repo: 'a/b', branch: 'night-shift/12-x', base: 'main', title: 't', body: 'b',
      config: { ghBin: stub }, env: fakeEnv(),
    }),
    (err) => err instanceof GitError && err.message.includes('PR 地址'),
  );
});

test('createPr：含空格/Unicode/前置连字符的 title 与 base 照原样各占一个 argv token', async (t) => {
  const dir = makeTempHome(t);
  const log = path.join(dir, 'gh.log');
  const title = '-修 复 登 录“引号”';
  const pr = await createPr({
    repo: 'a/b', branch: 'night-shift/12-fix', base: 'release/1.0 x', title, body: 'b',
    config: { ghBin: FAKE_GH }, env: fakeEnv({ FAKE_GH_LOG: log }),
  });
  assert.deepEqual(pr, { url: 'https://github.com/a/b/pull/1', existed: false });
  const create = readGhLog(log).at(-1);
  const titleIndex = create.indexOf('--title');
  const baseIndex = create.indexOf('--base');
  assert.notEqual(titleIndex, -1);
  // title 以 '-' 开头也必须只是 --title 的值（下一个 token），不会被当成别的选项
  assert.deepEqual(create.slice(titleIndex, titleIndex + 2), ['--title', title]);
  assert.deepEqual(create.slice(baseIndex, baseIndex + 2), ['--base', 'release/1.0 x']);
});

test('createPr / findOpenPr：repo/branch/base/title 非法时先抛参数错误（不启动 gh）', async (t) => {
  const dir = makeTempHome(t);
  const log = path.join(dir, 'gh.log');
  const env = fakeEnv({ FAKE_GH_LOG: log });
  const base = { repo: 'a/b', branch: 'night-shift/12-x', base: 'main', title: 't', body: 'b', config: { ghBin: FAKE_GH }, env };
  const cases = [
    [{ ...base, repo: 'oops' }, /owner\/name/],
    [{ ...base, repo: '' }, /owner\/name/],
    [{ ...base, branch: '' }, /branch/],
    [{ ...base, branch: null }, /branch/],
    [{ ...base, base: '' }, /base/],
    [{ ...base, base: '  ' }, /base/],
    [{ ...base, title: '' }, /title/],
    [{ ...base, title: null }, /title/],
  ];
  for (const [args, pattern] of cases) {
    await assert.rejects(() => createPr(args), pattern, JSON.stringify(args));
  }
  await assert.rejects(
    () => findOpenPr({ repo: 'a/b', branch: '', config: { ghBin: FAKE_GH }, env }),
    /branch/,
  );
  assert.equal(fs.existsSync(log), false, '参数非法时根本不应调用 gh');
});

// —— buildPrBody ——

const FULL_TASK = { id: 12, title: 'Fix Login Bug!!', prompt: '修复登录页。', attempts: 3 };
const FULL_RUN = {
  summary: '重构了登录逻辑', model: 'glm-5.3', effort: 'high', peak: false,
  durationMs: 3723000, quotaUnits: 1.5, attempt: 2,
};

test('buildPrBody：完整字段（通过路径，无输出折叠块）', () => {
  const body = buildPrBody({
    task: FULL_TASK,
    run: FULL_RUN,
    test: { command: 'npm test', ok: true, skipped: false, exitCode: 0, timedOut: false, durationMs: 900, output: 'ok' },
  });
  assert.ok(body.includes('> 修复登录页。'));
  assert.ok(body.includes('重构了登录逻辑'));
  assert.ok(body.includes('模型：glm-5.3'));
  assert.ok(body.includes('思考强度：high'));
  assert.ok(body.includes('高峰时段：否'));
  assert.ok(body.includes('耗时：1 小时 2 分 3 秒'));
  assert.ok(body.includes('估算额度：1.5'));
  assert.ok(body.includes('尝试次数：第 2 / 3 次'));
  assert.ok(body.includes('命令：`npm test`'));
  assert.ok(body.includes('结果：通过'));
  assert.ok(!body.includes('<details>'));
  assert.equal(body.trimEnd().split('\n').at(-1), '由 GLM 夜班自动创建');
});

test('buildPrBody：高峰为「是」时如实展示', () => {
  const body = buildPrBody({ run: { ...FULL_RUN, peak: true }, test: null });
  assert.ok(body.includes('高峰时段：是'));
});

test('buildPrBody：多行 prompt 每行加 > 前缀，空行只有 >', () => {
  const body = buildPrBody({ task: { prompt: '第一行\n\n第三行' }, test: null });
  assert.ok(body.includes('> 第一行\n>\n> 第三行'));
  assert.ok(!body.includes('\n> \n'), '空行不应是 "> "');
});

test('buildPrBody：失败（exit N）附最后 40 行输出的折叠块', () => {
  const output = Array.from({ length: 100 }, (_, i) => `行${i}`).join('\n');
  const body = buildPrBody({
    task: FULL_TASK,
    run: FULL_RUN,
    test: { command: 'npm test', ok: false, skipped: false, exitCode: 3, timedOut: false, durationMs: 5, output },
  });
  assert.ok(body.includes('失败（exit 3）'));
  assert.ok(body.includes('<details>'));
  assert.ok(body.includes('</details>'));
  assert.ok(body.includes('行99'), '保留末尾');
  assert.ok(body.includes('行60'), '第 61 行起应保留');
  assert.ok(!body.includes('行59'), '更早的行应被丢弃');
  assert.equal(body.trimEnd().split('\n').at(-1), '由 GLM 夜班自动创建');
});

test('buildPrBody：超时显示「失败（超时）」并附输出', () => {
  const body = buildPrBody({
    task: FULL_TASK,
    run: FULL_RUN,
    test: { command: 'sleep 99', ok: false, skipped: false, exitCode: null, timedOut: true, durationMs: 900000, output: '卡死了' },
  });
  assert.ok(body.includes('失败（超时）'));
  assert.ok(body.includes('卡死'));
});

test('buildPrBody：未配置（skipped / 没有命令）显示「未配置」', () => {
  const skipped = buildPrBody({ task: FULL_TASK, run: FULL_RUN, test: { ok: true, skipped: true } });
  assert.ok(skipped.includes('结果：未配置'));

  const none = buildPrBody({ task: {}, run: null, test: null });
  assert.ok(none.includes('结果：未配置'));
  assert.ok(none.includes('（无运行摘要）'));
  assert.ok(none.includes('（任务未提供 prompt）'));
  assert.ok(none.includes('模型：未知'));
  assert.ok(none.includes('耗时：未知'));
  assert.ok(none.includes('尝试次数：未知'));
  assert.ok(none.includes('估算额度：未知'));
  assert.ok(none.includes('高峰时段：未知'));
});

test('buildPrBody：全部字段缺失（空对象、null）也不抛错，页脚仍是最后一行', () => {
  for (const args of [{}, { task: null, run: null, test: null }, undefined]) {
    const body = buildPrBody(args);
    assert.ok(typeof body === 'string' && body.length > 0);
    assert.equal(body.trimEnd().split('\n').at(-1), '由 GLM 夜班自动创建');
  }
});

test('buildPrBody：输出里含 ``` 时围栏比内容里的反引号串更长', () => {
  const body = buildPrBody({
    task: FULL_TASK,
    run: FULL_RUN,
    test: { command: 'npm test', ok: false, exitCode: 1, timedOut: false, output: '代码块：\n```\necho hi\n```\n收尾' },
  });
  // 内容里自己的 ``` 行还在，但包裹它的围栏必须是 4 个以上反引号，否则 Markdown 提前闭合
  assert.ok(body.includes('\n```\n'), '内容中的 ``` 应原样保留');
  const fences = body.match(/^`{4,}$/gm);
  assert.ok(fences && fences.length >= 2, '应有一对比 ``` 更长的围栏');
  assert.ok(fences.every((fence) => fence.length > 3));
});

test('buildPrBody：超长输入被截断，总体低于 GitHub 65536 上限，页脚保留', () => {
  const body = buildPrBody({
    task: { id: 1, prompt: 'p'.repeat(100000), attempts: 2 },
    run: { summary: 's'.repeat(100000), model: 'm', effort: 'e', durationMs: 1000 },
    test: { command: 'x'.repeat(100000), ok: false, exitCode: 1, timedOut: false, output: 'o'.repeat(200000) },
  });
  assert.ok(body.length < 65536, `实际长度 ${body.length}`);
  assert.ok(body.length > 50000, '截断后仍应保留主要内容');
  assert.ok(body.includes('已截断'));
  assert.equal(body.trimEnd().split('\n').at(-1), '由 GLM 夜班自动创建');
});
