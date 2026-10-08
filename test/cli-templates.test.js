// templates 命令与 add --template 的端到端测试（issue #13）。
// 按团队约定放在独立文件（而不是 append 到 test/cli.test.js），减少并行 issue 的合并冲突。
// 全部用真实子进程跑 bin + 仓库里的假 gh，NIGHT_SHIFT_HOME 指向临时目录。
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fakeEnv, makeTempHome } from './helpers.js';

const binPath = fileURLToPath(new URL('../bin/night-shift.mjs', import.meta.url));

// spawnCli：真实子进程跑 bin；home 默认临时目录，TZ 固定 UTC，fakeEnv 指向假 gh。
function spawnCli(t, args, { cwd, home, env: envOverrides = {} } = {}) {
  const dir = cwd ?? makeTempHome(t);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [binPath, ...args], {
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

/** 在 <home>/templates/ 下写一个用户模板。 */
function writeUserTemplate(home, name, content) {
  const dir = path.join(home, 'templates');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.md`);
  fs.writeFileSync(file, content);
  return file;
}

// —— templates 命令 ——

test('验收: templates --json 列出四个内置模板，source 都是 builtin，fix-issue 的 vars 正确', async (t) => {
  const res = await spawnCli(t, ['templates', '--json']);
  assert.equal(res.code, 0, res.stderr);
  assert.equal(res.stderr, '');
  const templates = JSON.parse(res.stdout);
  assert.deepEqual(templates.map((x) => x.name), ['add-tests', 'docs', 'fix-issue', 'refactor']);
  for (const x of templates) {
    assert.equal(x.source, 'builtin', x.name);
    assert.deepEqual(
      Object.keys(x).sort(),
      ['description', 'difficulty', 'name', 'path', 'source', 'testCommand', 'vars'],
    );
  }
  const fix = templates.find((x) => x.name === 'fix-issue');
  assert.ok(fix.vars.some((v) => v.name === 'issue' && v.required === true), JSON.stringify(fix.vars));
  assert.ok(fix.vars.some((v) => v.name === 'extra' && v.required === false), JSON.stringify(fix.vars));
  assert.ok(fix.path.endsWith(path.join('templates', 'fix-issue.md')), fix.path);
});

test('templates（人类可读）：列出名字/来源/难度/变量/说明，内置四个都在', async (t) => {
  const res = await spawnCli(t, ['templates']);
  assert.equal(res.code, 0, res.stderr);
  assert.equal(res.stderr, '');
  for (const header of ['名字', '来源', '难度', '变量', '说明']) {
    assert.ok(res.stdout.includes(header), `表头缺「${header}」`);
  }
  for (const name of ['add-tests', 'docs', 'fix-issue', 'refactor']) {
    assert.ok(res.stdout.includes(name), `应列出 ${name}`);
  }
  assert.ok(res.stdout.includes('内置'));
  assert.ok(res.stdout.includes('issue, extra?'), '变量列应有紧凑声明');
});

test('templates show <名字>：打印文件路径与模板原文', async (t) => {
  const res = await spawnCli(t, ['templates', 'show', 'fix-issue']);
  assert.equal(res.code, 0, res.stderr);
  assert.equal(res.stderr, '');
  const expectedPath = fileURLToPath(new URL('../templates/fix-issue.md', import.meta.url));
  assert.ok(res.stdout.includes(expectedPath), '应打印文件路径');
  assert.equal(res.stdout.includes(fs.readFileSync(expectedPath, 'utf8')), true, '应原样打印模板文件');
});

test('验收: front-matter 缺结束 --- 的模板：templates show 退出 1，报错含文件路径', async (t) => {
  const home = makeTempHome(t);
  const file = writeUserTemplate(home, 'broken', '---\ndescription: 坏模板\nvars: topic\n');
  const res = await spawnCli(t, ['templates', 'show', 'broken'], { home });
  assert.equal(res.code, 1);
  assert.equal(res.stdout, '');
  assert.ok(res.stderr.startsWith('错误：'), res.stderr);
  assert.ok(res.stderr.includes(file), `报错应含文件路径：${res.stderr}`);
});

test('templates 的用法错误：缺 <名字>、多余参数、未知子命令都退出 2', async (t) => {
  const cases = [
    { args: ['templates', 'show'], needle: '<名字>' },
    { args: ['templates', 'show', 'docs', 'x'], needle: '参数过多' },
    { args: ['templates', 'bogus'], needle: '未知参数' },
  ];
  for (const { args, needle } of cases) {
    const res = await spawnCli(t, args);
    assert.equal(res.code, 2, JSON.stringify(args));
    assert.equal(res.stdout, '', JSON.stringify(args));
    assert.ok(res.stderr.includes(needle), `${JSON.stringify(args)} 应提到 ${needle}：${res.stderr}`);
    assert.ok(res.stderr.includes('用法：night-shift templates'), res.stderr);
  }
});

// —— add --template ——

test('验收: add --template fix-issue --repo a/b --var issue=12（假 gh）渲染标题/正文/难度，FAKE_GH_LOG 记录参数', async (t) => {
  const home = makeTempHome(t);
  const log = path.join(home, 'gh.log');
  const res = await spawnCli(t, ['add', '--template', 'fix-issue', '--repo', 'a/b', '--var', 'issue=12', '--json'], {
    home,
    env: {
      FAKE_GH_ISSUE_JSON: '{"title":"登录报错","body":"点击登录 500"}',
      FAKE_GH_LOG: log,
    },
  });
  assert.equal(res.code, 0, res.stderr);
  assert.equal(res.stderr, '');
  const task = JSON.parse(res.stdout);
  assert.equal(task.title, '修复 #12：登录报错');
  assert.ok(task.prompt.includes('issue #12'), task.prompt);
  assert.ok(task.prompt.includes('登录报错'), task.prompt);
  assert.ok(task.prompt.includes('点击登录 500'), task.prompt);
  assert.equal(task.difficulty, 'medium');
  assert.equal(task.repo, 'a/b');
  const logged = fs.readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(logged, [['issue', 'view', '12', '--repo', 'a/b', '--json', 'title,body']]);
});

test('验收: 同上加 --difficulty hard → 任务 difficulty 为 hard（显式参数覆盖模板默认）', async (t) => {
  const home = makeTempHome(t);
  const res = await spawnCli(t, [
    'add', '--template', 'fix-issue', '--repo', 'a/b', '--var', 'issue=12', '--difficulty', 'hard', '--json',
  ], { home, env: { FAKE_GH_ISSUE_JSON: '{"title":"t","body":"b"}' } });
  assert.equal(res.code, 0, res.stderr);
  assert.equal(JSON.parse(res.stdout).difficulty, 'hard');
});

test('显式 --title / --test 覆盖模板默认值；模板的 testCommand 默认也生效', async (t) => {
  const home = makeTempHome(t);
  const withDefaults = await spawnCli(t, [
    'add', '--template', 'add-tests', '--repo', 'a/b', '--var', 'target=src/format.js', '--json',
  ], { home });
  assert.equal(withDefaults.code, 0, withDefaults.stderr);
  const defaults = JSON.parse(withDefaults.stdout);
  assert.equal(defaults.testCommand, 'npm test'); // 模板默认
  assert.ok(defaults.prompt.includes('src/format.js'), defaults.prompt);
  assert.match(defaults.title, /^请为本仓库的 src\/format\.js/); // 无 title 模板：取 prompt 前 60 码点

  const overridden = await spawnCli(t, [
    'add', '--template', 'add-tests', '--repo', 'a/b', '--var', 'target=x',
    '--title', '自定义标题', '--test', 'npm run test:unit', '--difficulty', 'easy', '--json',
  ], { home });
  assert.equal(overridden.code, 0, overridden.stderr);
  const task = JSON.parse(overridden.stdout);
  assert.equal(task.title, '自定义标题');
  assert.equal(task.testCommand, 'npm run test:unit');
  assert.equal(task.difficulty, 'easy');
});

test('可选变量：--var extra=... 有值时进正文，缺省时不留空行', async (t) => {
  const home = makeTempHome(t);
  const ghEnv = { FAKE_GH_ISSUE_JSON: '{"title":"t","body":"b"}' };
  const withExtra = await spawnCli(t, [
    'add', '--template', 'fix-issue', '--repo', 'a/b', '--var', 'issue=1', '--var', 'extra=补充要求', '--json',
  ], { home, env: ghEnv });
  assert.ok(JSON.parse(withExtra.stdout).prompt.includes('补充要求'));
  const without = await spawnCli(t, [
    'add', '--template', 'fix-issue', '--repo', 'a/b', '--var', 'issue=1', '--json',
  ], { home, env: ghEnv });
  assert.ok(!/\n{3,}/.test(JSON.parse(without.stdout).prompt), '不应有连续空行');
});

test('验收: 渲染错误退出 1：缺 issue 提示 issue、--var isue 拼错提示 isue、--template nope 不存在', async (t) => {
  const home = makeTempHome(t);
  for (const { args, needle } of [
    { args: ['add', '--template', 'fix-issue', '--repo', 'a/b'], needle: 'issue' },
    { args: ['add', '--template', 'fix-issue', '--repo', 'a/b', '--var', 'isue=1'], needle: 'isue' },
    { args: ['add', '--template', 'nope', '--repo', 'a/b'], needle: 'nope' },
  ]) {
    const res = await spawnCli(t, args, { home });
    assert.equal(res.code, 1, JSON.stringify(args));
    assert.equal(res.stdout, '', JSON.stringify(args));
    assert.ok(res.stderr.startsWith('错误：'), res.stderr);
    assert.ok(res.stderr.includes(needle), `${JSON.stringify(args)} 应提到 ${needle}：${res.stderr}`);
  }
});

test('验收: --template docs --prompt x 退出 2（与 --prompt-file 同理）', async (t) => {
  const home = makeTempHome(t);
  for (const extra of [['--prompt', 'x'], ['--prompt-file', 'f.txt']]) {
    const res = await spawnCli(t, ['add', '--template', 'docs', '--repo', 'a/b', ...extra], { home });
    assert.equal(res.code, 2, extra.join(' '));
    assert.equal(res.stdout, '');
    assert.ok(res.stderr.includes('--template'), res.stderr);
    assert.ok(res.stderr.includes('用法：night-shift add'), res.stderr);
  }
});

test('--var 的用法错误：没有 =、名字为空、不带 --template 都退出 2', async (t) => {
  const home = makeTempHome(t);
  for (const args of [
    ['add', '--template', 'docs', '--repo', 'a/b', '--var', 'topic'],
    ['add', '--template', 'docs', '--repo', 'a/b', '--var', '=x'],
    ['add', '--repo', 'a/b', '--prompt', 'x', '--var', 'a=b'],
  ]) {
    const res = await spawnCli(t, args, { home });
    assert.equal(res.code, 2, JSON.stringify(args));
    assert.equal(res.stdout, '', JSON.stringify(args));
    assert.ok(res.stderr.includes('--var'), JSON.stringify(args));
  }
});

test('验收: FAKE_GH_ISSUE_FAIL=1 时 add --template 退出 1，stderr 含 Could not resolve，队列没有新任务', async (t) => {
  const home = makeTempHome(t);
  const res = await spawnCli(t, ['add', '--template', 'fix-issue', '--repo', 'a/b', '--var', 'issue=9'], {
    home,
    env: { FAKE_GH_ISSUE_FAIL: '1' },
  });
  assert.equal(res.code, 1);
  assert.equal(res.stdout, '');
  assert.ok(res.stderr.includes('Could not resolve'), res.stderr);
  const list = await spawnCli(t, ['list', '--json'], { home });
  assert.equal(list.code, 0);
  assert.deepEqual(JSON.parse(list.stdout), [], '渲染失败不应创建任务');
});

test('验收: <home>/templates/docs.md 覆盖内置后 add 用自定义内容，mine.md 也出现在列表', async (t) => {
  const home = makeTempHome(t);
  writeUserTemplate(home, 'docs', '---\ndescription: 自定义文档模板\nvars: topic\n---\n自定义 {{topic}} 文档');

  const listing = await spawnCli(t, ['templates', '--json'], { home });
  assert.equal(listing.code, 0, listing.stderr);
  const templates = JSON.parse(listing.stdout);
  assert.equal(templates.find((x) => x.name === 'docs').source, 'user');
  assert.equal(templates.find((x) => x.name === 'fix-issue').source, 'builtin');

  writeUserTemplate(home, 'mine', '---\ndescription: 我的模板\nvars: a\n---\n内容 {{a}}');
  const withMine = await spawnCli(t, ['templates', '--json'], { home });
  assert.ok(JSON.parse(withMine.stdout).some((x) => x.name === 'mine' && x.source === 'user'));

  const addRes = await spawnCli(t, ['add', '--template', 'docs', '--repo', 'a/b', '--var', 'topic=x', '--json'], { home });
  assert.equal(addRes.code, 0, addRes.stderr);
  const task = JSON.parse(addRes.stdout);
  assert.equal(task.prompt, '自定义 x 文档');
  assert.equal(task.title, '自定义 x 文档'); // 模板无 title：按规则取 prompt 前 60 码点
});

test('templates show 用户模板：来源显示自定义，路径指向 <home>/templates', async (t) => {
  const home = makeTempHome(t);
  const file = writeUserTemplate(home, 'mine', '---\ndescription: 我的模板\nvars: a\n---\n内容 {{a}}');
  const res = await spawnCli(t, ['templates', 'show', 'mine'], { home });
  assert.equal(res.code, 0, res.stderr);
  assert.ok(res.stdout.includes('自定义'));
  assert.ok(res.stdout.includes(file));
  assert.ok(res.stdout.includes('内容 {{a}}'));
});

test('add 不带任何提示词来源仍退出 2：--prompt / --prompt-file / --template 三选一', async (t) => {
  const res = await spawnCli(t, ['add', '--repo', 'a/b']);
  assert.equal(res.code, 2);
  assert.ok(res.stderr.includes('--template'), res.stderr);
  assert.ok(res.stderr.includes('--prompt'), res.stderr);
});
