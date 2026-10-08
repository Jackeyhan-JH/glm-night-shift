// import 命令的端到端测试（issue #39：按 GitHub issue 批量入队）。
// 全部用真实子进程跑 bin + 仓库里的假 gh（issue list 场景），NIGHT_SHIFT_HOME 指向
// 临时目录；把任务打成 failed 用 tasks.js 的公开函数，绝不连真实 claude/gh。
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fakeEnv, makeTempHome } from './helpers.js';
import { openDb } from '../src/db.js';
import { claimTaskById, finishTask } from '../src/tasks.js';

const binPath = fileURLToPath(new URL('../bin/night-shift.mjs', import.meta.url));

// 假 gh 的 issue list 输出：两个 issue，#13 的 body 故意带首尾空格（验证 trim）。
const ISSUES = '[{"number":12,"title":"登录失败","body":"登录接口 500"},'
  + '{"number":13,"title":"空指针","body":"  列表为空  "}]';

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

/** 读 FAKE_GH_LOG：每行一个 JSON 数组（一次 gh 调用的 argv）。 */
function readGhLog(log) {
  return fs.readFileSync(log, 'utf8').trim().split('\n').filter((line) => line !== '')
    .map((line) => JSON.parse(line));
}

/** 在测试进程里用 tasks.js 的公开函数把某个任务打成 failed（不连真实 claude/gh）。 */
function markFailed(home, id) {
  const db = openDb(path.join(home, 'night-shift.db'));
  try {
    claimTaskById(db, id);
    finishTask(db, id, { status: 'failed', lastError: '测试标记失败' });
  } finally {
    db.close();
  }
}

/** `list --json` 的解析结果（任务条数 / 深度比较用）。 */
async function listTasksJson(t, home) {
  const res = await spawnCli(t, ['list', '--json'], { home });
  assert.equal(res.code, 0, res.stderr);
  return JSON.parse(res.stdout);
}

// —— 基本导入 ——

test('验收: import --repo a/b --label night-shift 新增两条任务，标题/来源/prompt/gh 参数都正确', async (t) => {
  const home = makeTempHome(t);
  const log = path.join(home, 'gh.log');
  const res = await spawnCli(t, ['import', '--repo', 'a/b', '--label', 'night-shift'], {
    home,
    env: { FAKE_GH_ISSUE_LIST_JSON: ISSUES, FAKE_GH_LOG: log },
  });
  assert.equal(res.code, 0, res.stderr);
  assert.equal(res.stderr, '');
  assert.ok(res.stdout.includes('新增 #1 修复 #12：登录失败'), res.stdout);
  assert.ok(res.stdout.includes('新增 #2 修复 #13：空指针'), res.stdout);
  const lines = res.stdout.trim().split('\n');
  assert.equal(lines[lines.length - 1], '新增 2 个，跳过 0 个');

  const shown = await spawnCli(t, ['show', '1', '--json'], { home });
  assert.equal(shown.code, 0, shown.stderr);
  const task = JSON.parse(shown.stdout);
  assert.equal(task.source, 'github:a/b#12');
  assert.ok(task.prompt.includes('登录接口 500'), task.prompt);
  assert.ok(task.prompt.includes('不要 push'), task.prompt);
  assert.equal(task.status, 'queued');

  // #13 的 body 先 trim 再拼：没有前导空格，正文后换行接固定尾行
  const shown13 = await spawnCli(t, ['show', '2', '--json'], { home });
  const task13 = JSON.parse(shown13.stdout);
  assert.ok(task13.prompt.startsWith('列表为空\n在仓库 a/b 完成这个 issue'), task13.prompt);

  // gh 参数：label 在 --state 之后；只调了一次 list，没有多余的 gh
  const calls = readGhLog(log);
  assert.equal(calls.length, 1, `只应调用一次 gh：${JSON.stringify(calls)}`);
  assert.deepEqual(calls[0], [
    'issue', 'list', '--repo', 'a/b', '--state', 'open', '--label', 'night-shift',
    '--json', 'number,title,body', '--limit', '50',
  ]);
});

test('body 为空的任务 prompt 只有固定一行；--state/--limit 透传给 gh', async (t) => {
  const home = makeTempHome(t);
  const log = path.join(home, 'gh.log');
  const res = await spawnCli(t, ['import', '--repo', 'a/b', '--state', 'closed', '--limit', '5'], {
    home,
    env: { FAKE_GH_ISSUE_LIST_JSON: '[{"number":7,"title":"无正文"}]', FAKE_GH_LOG: log },
  });
  assert.equal(res.code, 0, res.stderr);
  const shown = await spawnCli(t, ['show', '1', '--json'], { home });
  const task = JSON.parse(shown.stdout);
  assert.equal(task.prompt, '在仓库 a/b 完成这个 issue。不要 push，不要切分支。');
  assert.deepEqual(readGhLog(log), [[
    'issue', 'list', '--repo', 'a/b', '--state', 'closed', '--json', 'number,title,body', '--limit', '5',
  ]]);
});

test('不带 --label 时 gh 参数里没有 --label', async (t) => {
  const home = makeTempHome(t);
  const log = path.join(home, 'gh.log');
  const res = await spawnCli(t, ['import', '--repo', 'a/b'], {
    home,
    env: { FAKE_GH_ISSUE_LIST_JSON: ISSUES, FAKE_GH_LOG: log },
  });
  assert.equal(res.code, 0, res.stderr);
  const calls = readGhLog(log);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].includes('--label'), false);
  assert.deepEqual(calls[0], [
    'issue', 'list', '--repo', 'a/b', '--state', 'open',
    '--json', 'number,title,body', '--limit', '50',
  ]);
});

test('标题超过 80 个 Unicode 码点被截断（不加省略号）', async (t) => {
  const home = makeTempHome(t);
  const longTitle = '修'.repeat(100);
  const res = await spawnCli(t, ['import', '--repo', 'a/b', '--json'], {
    home,
    env: { FAKE_GH_ISSUE_LIST_JSON: JSON.stringify([{ number: 12, title: longTitle, body: 'x' }]) },
  });
  assert.equal(res.code, 0, res.stderr);
  const { added } = JSON.parse(res.stdout);
  assert.equal(added.length, 1);
  assert.equal([...added[0].title].length, 80);
  assert.ok(added[0].title.startsWith('修复 #12：'));
  assert.ok(!added[0].title.includes('…'));
});

test('add 出来的任务 source 为 null；show 的人类可读输出不加「来源」行', async (t) => {
  const home = makeTempHome(t);
  const added = await spawnCli(t, ['add', '--repo', 'a/b', '--prompt', '手工任务'], { home });
  assert.equal(added.code, 0, added.stderr);
  const shown = await spawnCli(t, ['show', '1', '--json'], { home });
  assert.equal(JSON.parse(shown.stdout).source, null);
  const human = await spawnCli(t, ['show', '1'], { home });
  assert.equal(human.code, 0, human.stderr);
  assert.equal(human.stdout.includes('来源'), false, 'source 为空时不应出现「来源」行');

  const imported = await spawnCli(t, ['import', '--repo', 'c/d'], {
    home,
    env: { FAKE_GH_ISSUE_LIST_JSON: '[{"number":9,"title":"来自 issue"}]' },
  });
  assert.equal(imported.code, 0, imported.stderr);
  const humanImported = await spawnCli(t, ['show', '2'], { home });
  assert.ok(/来源\s+github:c\/d#9/.test(humanImported.stdout), humanImported.stdout);
});

// —— 去重 ——

test('再 import 一次：同 source 的任务全部跳过（不新建），list 仍是 2 条', async (t) => {
  const home = makeTempHome(t);
  const first = await spawnCli(t, ['import', '--repo', 'a/b'], { home, env: { FAKE_GH_ISSUE_LIST_JSON: ISSUES } });
  assert.equal(first.code, 0, first.stderr);

  const again = await spawnCli(t, ['import', '--repo', 'a/b'], { home, env: { FAKE_GH_ISSUE_LIST_JSON: ISSUES } });
  assert.equal(again.code, 0, again.stderr);
  assert.ok(again.stdout.includes('跳过 #12：已有任务 #1（queued）'), again.stdout);
  assert.ok(again.stdout.includes('跳过 #13：已有任务 #2（queued）'), again.stdout);
  const lines = again.stdout.trim().split('\n');
  assert.equal(lines[lines.length - 1], '新增 0 个，跳过 2 个');
  assert.equal((await listTasksJson(t, home)).length, 2);
});

test('同一 source 已是 failed 也跳过（任意状态都算），--json 的 skipped 含 failed 状态', async (t) => {
  const home = makeTempHome(t);
  const first = await spawnCli(t, ['import', '--repo', 'a/b'], { home, env: { FAKE_GH_ISSUE_LIST_JSON: ISSUES } });
  assert.equal(first.code, 0, first.stderr);
  markFailed(home, 1);

  const again = await spawnCli(t, ['import', '--repo', 'a/b'], { home, env: { FAKE_GH_ISSUE_LIST_JSON: ISSUES } });
  assert.equal(again.code, 0, again.stderr);
  assert.ok(again.stdout.includes('跳过 #12：已有任务 #1（failed）'), again.stdout);
  assert.ok(again.stdout.includes('新增 0 个，跳过 2 个'), again.stdout);

  const asJson = await spawnCli(t, ['import', '--repo', 'a/b', '--json'], {
    home,
    env: { FAKE_GH_ISSUE_LIST_JSON: ISSUES },
  });
  assert.equal(asJson.code, 0, asJson.stderr);
  const parsed = JSON.parse(asJson.stdout);
  assert.deepEqual(parsed.added, []);
  assert.ok(parsed.skipped.some((s) => s.issue === 12 && s.taskId === 1 && s.status === 'failed'),
    JSON.stringify(parsed.skipped));
  assert.ok(parsed.skipped.some((s) => s.issue === 13 && s.taskId === 2 && s.status === 'queued'),
    JSON.stringify(parsed.skipped));
  assert.equal((await listTasksJson(t, home)).length, 2, 'failed 的 source 也不新建');
});

test('同一批列表里 source 重复：先处理的留下，后一个跳过', async (t) => {
  const dup = JSON.stringify([
    { number: 21, title: '重复', body: 'x' },
    { number: 21, title: '重复', body: 'x' },
  ]);
  const home = makeTempHome(t);
  const res = await spawnCli(t, ['import', '--repo', 'a/b'], { home, env: { FAKE_GH_ISSUE_LIST_JSON: dup } });
  assert.equal(res.code, 0, res.stderr);
  assert.ok(res.stdout.includes('新增 #1 修复 #21：重复'), res.stdout);
  assert.ok(res.stdout.includes('跳过 #21：已有任务 #1（queued）'), res.stdout);
  assert.equal(res.stdout.trim().split('\n').at(-1), '新增 1 个，跳过 1 个');
  assert.equal((await listTasksJson(t, home)).length, 1);
});

// —— dry-run ——

test('验收: --dry-run 只预览不落库：前后 list --json 深度相等，将新增/跳过行正确', async (t) => {
  const home = makeTempHome(t);
  await spawnCli(t, ['import', '--repo', 'a/b'], { home, env: { FAKE_GH_ISSUE_LIST_JSON: ISSUES } });
  const before = await listTasksJson(t, home);

  const withThird = '[{"number":12,"title":"登录失败","body":"x"},'
    + '{"number":13,"title":"空指针","body":"x"},'
    + '{"number":14,"title":"新问题"}]';
  const dry = await spawnCli(t, ['import', '--repo', 'a/b', '--dry-run'], {
    home,
    env: { FAKE_GH_ISSUE_LIST_JSON: withThird },
  });
  assert.equal(dry.code, 0, dry.stderr);
  assert.equal(dry.stderr, '');
  assert.ok(dry.stdout.includes('将新增 修复 #14：新问题'), dry.stdout);
  assert.ok(dry.stdout.includes('跳过 #12：已有任务 #1（queued）'), dry.stdout);
  assert.ok(dry.stdout.includes('跳过 #13：已有任务 #2（queued）'), dry.stdout);
  assert.ok(!dry.stdout.includes('新增 #'), `dry-run 不应编造任务 id：${dry.stdout}`);
  assert.equal(dry.stdout.trim().split('\n').at(-1), '新增 1 个，跳过 2 个');

  assert.deepEqual(await listTasksJson(t, home), before);
});

test('dry-run --json：added 是预览对象（没有 id），本批重复记 {taskId:null,status:null}', async (t) => {
  const home = makeTempHome(t);
  const dup = JSON.stringify([
    { number: 31, title: '甲', body: '正文一' },
    { number: 31, title: '甲', body: '正文一' },
    { number: 32, title: '乙' },
  ]);
  const res = await spawnCli(t, ['import', '--repo', 'a/b', '--dry-run', '--json'], {
    home,
    env: { FAKE_GH_ISSUE_LIST_JSON: dup },
  });
  assert.equal(res.code, 0, res.stderr);
  const parsed = JSON.parse(res.stdout);
  assert.deepEqual(parsed.added, [
    {
      issue: 31,
      title: '修复 #31：甲',
      source: 'github:a/b#31',
      prompt: '正文一\n在仓库 a/b 完成这个 issue。不要 push，不要切分支。',
      repo: 'a/b',
      difficulty: 'medium',
    },
    {
      issue: 32,
      title: '修复 #32：乙',
      source: 'github:a/b#32',
      prompt: '在仓库 a/b 完成这个 issue。不要 push，不要切分支。',
      repo: 'a/b',
      difficulty: 'medium',
    },
  ]);
  assert.deepEqual(parsed.skipped, [{ issue: 31, taskId: null, status: null }]);
  assert.equal((await listTasksJson(t, home)).length, 0, 'dry-run 不写任务');
});

test('正式运行 --json：added 是任务对象（含 source），--json 时不打人类行', async (t) => {
  const home = makeTempHome(t);
  const res = await spawnCli(t, ['import', '--repo', 'a/b', '--difficulty', 'hard', '--json'], {
    home,
    env: { FAKE_GH_ISSUE_LIST_JSON: ISSUES },
  });
  assert.equal(res.code, 0, res.stderr);
  const parsed = JSON.parse(res.stdout);
  assert.equal(parsed.added.length, 2);
  const first = parsed.added[0];
  assert.equal(first.source, 'github:a/b#12');
  assert.equal(first.status, 'queued');
  assert.equal(first.difficulty, 'hard');
  assert.equal(first.priority, 0);
  assert.equal(first.allowPeak, false);
  assert.equal(first.maxAttempts, 2); // 配置缺省（与 add 一致）
  assert.deepEqual(first.dependsOn, []);
  assert.deepEqual(parsed.skipped, []);
  assert.equal(res.stdout.includes('新增 #'), false, '--json 时不打人类行');
});

// —— 失败路径 ——

test('验收: FAKE_GH_ISSUE_LIST_FAIL=1：退出 1，stderr 含假 gh 的错误行，任务条数不变', async (t) => {
  const home = makeTempHome(t);
  await spawnCli(t, ['add', '--repo', 'a/b', '--prompt', '已有任务'], { home });
  const res = await spawnCli(t, ['import', '--repo', 'a/b'], { home, env: { FAKE_GH_ISSUE_LIST_FAIL: '1' } });
  assert.equal(res.code, 1);
  assert.ok(res.stderr.startsWith('错误：'), res.stderr);
  assert.ok(res.stderr.includes('fake gh issue list failure (FAKE_GH_ISSUE_LIST_FAIL=1)'), res.stderr);
  assert.equal(res.stdout, '');
  assert.equal((await listTasksJson(t, home)).length, 1, '任务条数不变');
});

test('stdout 不是 JSON 数组 / number 非正整数 / title 非字符串：退出 1 且不写任务', async (t) => {
  const home = makeTempHome(t);
  const cases = [
    '{"number":12,"title":"对象不是数组"}',
    '[{"number":0,"title":"零编号"}]',
    '[{"number":12,"title":42}]',
    '不是 JSON',
  ];
  for (const payload of cases) {
    const res = await spawnCli(t, ['import', '--repo', 'a/b'], {
      home,
      env: { FAKE_GH_ISSUE_LIST_JSON: payload },
    });
    assert.equal(res.code, 1, payload);
    assert.ok(res.stderr.startsWith('错误：'), `${payload}：${res.stderr}`);
  }
  assert.equal((await listTasksJson(t, home)).length, 0, '一个任务都不写');
});

// —— 用法错误（退出码 2） ——

test('验收: --repo "bad repo" 退出 2，stderr 含用法', async (t) => {
  const res = await spawnCli(t, ['import', '--repo', 'bad repo']);
  assert.equal(res.code, 2);
  assert.equal(res.stdout, '');
  assert.ok(res.stderr.includes('用法'), res.stderr);
  assert.ok(res.stderr.includes('import'), res.stderr);
});

test('用法错误：缺 --repo、--state/--limit/--difficulty 非法都是退出 2，不写任务', async (t) => {
  const home = makeTempHome(t);
  const cases = [
    { args: ['import'], needle: '--repo' },
    { args: ['import', '--repo', 'a/b', '--state', 'opened'], needle: '--state' },
    { args: ['import', '--repo', 'a/b', '--limit', '0'], needle: '--limit' },
    { args: ['import', '--repo', 'a/b', '--limit', 'x'], needle: '--limit' },
    { args: ['import', '--repo', 'a/b', '--difficulty', 'extreme'], needle: '--difficulty' },
  ];
  for (const { args, needle } of cases) {
    const res = await spawnCli(t, args, { home });
    assert.equal(res.code, 2, JSON.stringify(args));
    assert.equal(res.stdout, '', JSON.stringify(args));
    assert.ok(res.stderr.includes(needle), `${JSON.stringify(args)} 应提到 ${needle}：${res.stderr}`);
    assert.ok(res.stderr.includes('用法：night-shift import'), res.stderr);
  }
  assert.equal((await listTasksJson(t, home)).length, 0, '用法错误不写任务');
});

test('import 进 help：总览有摘要，import --help 打印用法', async (t) => {
  const help = await spawnCli(t, ['--help']);
  assert.equal(help.code, 0, help.stderr);
  assert.ok(help.stdout.includes('import'));
  assert.ok(help.stdout.includes('按 GitHub issue 批量入队'));
  const own = await spawnCli(t, ['import', '--help']);
  assert.equal(own.code, 0, own.stderr);
  assert.ok(own.stdout.startsWith('用法：night-shift import --repo <owner/name>'));
});
