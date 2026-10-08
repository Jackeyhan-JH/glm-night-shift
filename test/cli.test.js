import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { fakeEnv, makeTempHome } from './helpers.js';
import { displayWidth } from '../src/format.js';
// 直接 import bin 不会自动执行 main（入口脚本守卫），所以可以在进程内测子命令机制。
// （import bin 的同时就装上了 SQLite 警告过滤，见 src/warnings.js。）
import { main, runCli, COMMANDS } from '../bin/night-shift.mjs';

const binPath = fileURLToPath(new URL('../bin/night-shift.mjs', import.meta.url));
const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const srcPath = (rel) => fileURLToPath(new URL(`../src/${rel}`, import.meta.url));

// 「无堆栈」断言用：报错文案里合法出现 "at position 1"（JSON 解析错误）不是堆栈，
// 只有另起一行、缩进后的 "at xxx (file:1:1)" 才是堆栈帧。
const hasStackTrace = (text) => /(^\s*at )|(\n\s*at )/.test(text);

// 作为独立进程跑 bin（端到端）；进程内直接调用 bin 的 runCli/main 见文件后半部分。
// 默认把 NIGHT_SHIFT_HOME 指到临时目录、TZ 固定 UTC（时间输出可断言）；
// exec 可换成别的 node（Node 22.13 的警告测试），bin 可换成符号链接（npm link 场景），
// home 单独指定时与 cwd 解耦。
function spawnCli(t, args, { cwd, home, env: envOverrides = {}, exec = process.execPath, bin = binPath } = {}) {
  const dir = cwd ?? makeTempHome(t);
  return new Promise((resolve, reject) => {
    const child = spawn(exec, [bin, ...args], {
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

test('--version / -v 输出 package.json 的版本号', async (t) => {
  for (const flag of ['--version', '-v']) {
    const res = await spawnCli(t, [flag]);
    assert.equal(res.code, 0, flag);
    assert.equal(res.stdout, `${pkg.version}\n`, flag);
    assert.equal(res.stderr, '', flag);
  }
});

test('--version 在别的 cwd 下也能读到版本号', async (t) => {
  const res = await spawnCli(t, ['--version'], { cwd: os.tmpdir() });
  assert.equal(res.code, 0);
  assert.equal(res.stdout, `${pkg.version}\n`);
});

test('help / --help / -h / 无参数：stdout 列出用法，退出 0', async (t) => {
  for (const args of [['help'], ['--help'], ['-h'], []]) {
    const res = await spawnCli(t, args);
    assert.equal(res.code, 0, JSON.stringify(args));
    assert.ok(res.stdout.includes('用法'), JSON.stringify(args));
    assert.ok(res.stdout.includes('help'), JSON.stringify(args));
    assert.equal(res.stderr, '', JSON.stringify(args));
  }
});

test('未知命令：stderr 报中文错误并附用法，退出 2', async (t) => {
  const res = await spawnCli(t, ['frobnicate']);
  assert.equal(res.code, 2);
  assert.equal(res.stdout, '');
  assert.ok(res.stderr.includes('未知命令：frobnicate'));
  assert.ok(res.stderr.includes('用法'));
});

test('未知选项：stderr 报中文错误并附用法，退出 2', async (t) => {
  const res = await spawnCli(t, ['--nope']);
  assert.equal(res.code, 2);
  assert.equal(res.stdout, '');
  assert.ok(res.stderr.includes('未知选项：--nope'));
  assert.ok(res.stderr.includes('用法'));
  assert.ok(!res.stderr.includes('at '), '不应打印堆栈');
});

// —— 验收标准（issue #5）：真实子进程跑 bin，NIGHT_SHIFT_HOME 指向临时目录 ——

test('验收: add 输出「已加入队列：#1 …」退出 0，数据目录出现 night-shift.db', async (t) => {
  const home = makeTempHome(t);
  const res = await spawnCli(t, ['add', '--repo', 'a/b', '--prompt', '修复登录 bug', '--difficulty', 'hard', '--priority', '3'], { cwd: home });
  assert.equal(res.code, 0);
  assert.equal(res.stdout, '已加入队列：#1 修复登录 bug\n');
  assert.equal(res.stderr, '');
  assert.ok(fs.existsSync(path.join(home, 'night-shift.db')), '数据目录里应出现 night-shift.db');
});

test('验收: add --prompt-file 用文件内容作为 prompt；--json 输出可解析的 queued 任务', async (t) => {
  const home = makeTempHome(t);
  fs.writeFileSync(path.join(home, 'task.txt'), '用文件内容作为提示词\n');
  const res = await spawnCli(t, ['add', '--repo', 'a/b', '--prompt-file', 'task.txt', '--json'], { cwd: home }); // 相对路径按 cwd 解析
  assert.equal(res.code, 0);
  assert.equal(res.stderr, '');
  const task = JSON.parse(res.stdout);
  assert.equal(task.status, 'queued');
  assert.equal(task.prompt, '用文件内容作为提示词'); // 末尾单个换行被去掉
  assert.equal(task.repo, 'a/b');
  assert.equal(task.id, 1);
});

test('验收: list 显示两条任务；--status queued --json 输出 JSON 数组；新目录输出「队列是空的」', async (t) => {
  const home = makeTempHome(t);
  await spawnCli(t, ['add', '--repo', 'a/b', '--prompt', '任务一'], { cwd: home });
  await spawnCli(t, ['add', '--repo', 'c/d', '--prompt', '任务二'], { cwd: home });

  const res = await spawnCli(t, ['list'], { cwd: home });
  assert.equal(res.code, 0);
  assert.equal(res.stderr, '');
  const lines = res.stdout.trimEnd().split('\n');
  assert.equal(lines.length, 3, '表头 + 两行数据');
  for (const h of ['ID', '状态', '难度', '优先级', '仓库', '标题', '创建时间']) {
    assert.ok(lines[0].includes(h), `表头缺「${h}」：${lines[0]}`);
  }
  assert.ok(res.stdout.includes('任务一') && res.stdout.includes('任务二'));

  const jsonRes = await spawnCli(t, ['list', '--status', 'queued', '--json'], { cwd: home });
  assert.equal(jsonRes.code, 0);
  const arr = JSON.parse(jsonRes.stdout);
  assert.ok(Array.isArray(arr));
  assert.equal(arr.length, 2);
  assert.ok(arr.every((task) => task.status === 'queued'));

  const empty = makeTempHome(t);
  const emptyRes = await spawnCli(t, ['list'], { cwd: empty });
  assert.equal(emptyRes.code, 0);
  assert.equal(emptyRes.stdout, '队列是空的\n');
  const emptyJson = await spawnCli(t, ['list', '--json'], { cwd: empty });
  assert.deepEqual(JSON.parse(emptyJson.stdout), [], '空目录 --json 输出 []，不是空消息');
});

test('验收: cancel 1 后 show 1 --json 是 canceled；retry 1 变回 queued', async (t) => {
  const home = makeTempHome(t);
  await spawnCli(t, ['add', '--repo', 'a/b', '--prompt', '修复'], { cwd: home });

  const cancelRes = await spawnCli(t, ['cancel', '1'], { cwd: home });
  assert.equal(cancelRes.code, 0);
  assert.equal(cancelRes.stdout, '#1 已取消（canceled）\n');
  assert.equal(cancelRes.stderr, '');
  const showRes = await spawnCli(t, ['show', '1', '--json'], { cwd: home });
  assert.equal(JSON.parse(showRes.stdout).status, 'canceled');

  const retryRes = await spawnCli(t, ['retry', '1'], { cwd: home });
  assert.equal(retryRes.code, 0);
  assert.equal(retryRes.stdout, '#1 已重新排队（queued）\n');
  const showAgain = await spawnCli(t, ['show', '1', '--json'], { cwd: home });
  assert.equal(JSON.parse(showAgain.stdout).status, 'queued');
});

test('验收: show 99 退出 1 且 stderr 说明任务不存在', async (t) => {
  const home = makeTempHome(t);
  await spawnCli(t, ['add', '--repo', 'a/b', '--prompt', 'x'], { cwd: home });
  const res = await spawnCli(t, ['show', '99'], { cwd: home });
  assert.equal(res.code, 1);
  assert.equal(res.stdout, '');
  assert.ok(res.stderr.includes('任务 99 不存在'), `stderr 应说明任务不存在：${res.stderr}`);
});

test('验收: add --repo "bad repo" --prompt x 退出 1 并指出 repo 不合法', async (t) => {
  const home = makeTempHome(t);
  const res = await spawnCli(t, ['add', '--repo', 'bad repo', '--prompt', 'x'], { cwd: home });
  assert.equal(res.code, 1);
  assert.ok(res.stderr.includes('repo'), res.stderr);
  assert.ok(res.stderr.includes('不合法'), res.stderr);
});

test('验收: 用法错误统一退出 2 并打印该命令用法', async (t) => {
  const cases = [
    { args: ['add', '--prompt', 'x'], needle: '--repo' }, // 缺必填 --repo
    { args: ['add', '--repo', 'a/b', '--prompt', 'x', '--difficulty', 'extreme'], needle: '--difficulty' }, // 枚举非法
    { args: ['add', '--repo', 'a/b'], needle: '--prompt' }, // --prompt / --prompt-file 都没给
    { args: ['add', '--repo', 'a/b', '--prompt', 'x', '--prompt-file', 'f.txt'], needle: '二选一' }, // 两个都给
    { args: ['add', '--repo', 'a/b', '--prompt', 'x', '--priority', '1.5'], needle: '--priority' },
    { args: ['add', '--repo', 'a/b', '--prompt', 'x', '--priority', 'abc'], needle: '--priority' },
    { args: ['add', '--repo', 'a/b', '--prompt', 'x', '--max-attempts', '0'], needle: '--max-attempts' },
    { args: ['list', '--status', 'paused'], needle: '--status' },
    { args: ['list', '--limit', 'x'], needle: '--limit' },
    { args: ['list', '--limit', '0'], needle: '--limit' },
    { args: ['show'], needle: '<id>' }, // 缺位置参数
    { args: ['show', 'abc'], needle: '<id>' }, // id 非数字
    { args: ['show', '0'], needle: '<id>' },
    { args: ['show', '1', '2'], needle: '<id>' }, // 多余位置参数
    { args: ['cancel'], needle: '<id>' },
    { args: ['retry', '-3'], needle: null }, // 负数被 parseArgs 当未知选项，也是退出 2 + 用法
    { args: ['add', '--repo', 'a/b', '--prompt', 'x', '多余参数'], needle: null }, // parseArgs 位置参数
    { args: ['frobnicate'], needle: '未知命令' },
  ];
  // 互不依赖，并行跑省时间
  const results = await Promise.all(cases.map((c) => spawnCli(t, c.args)));
  for (const [i, res] of results.entries()) {
    const { args, needle } = cases[i];
    assert.equal(res.code, 2, `${JSON.stringify(args)} 应退出 2（实际 ${res.code}，stderr：${res.stderr}）`);
    assert.equal(res.stdout, '', JSON.stringify(args));
    assert.ok(res.stderr.startsWith('错误：'), JSON.stringify(args));
    assert.ok(res.stderr.includes('用法：night-shift'), `应打印命令用法：${JSON.stringify(args)}`);
    if (needle !== null) assert.ok(res.stderr.includes(needle), `stderr 应提到 ${needle}：${res.stderr}`);
  }
});

test('验收: config --json 输出包含 concurrency、port 和数据目录路径', async (t) => {
  const home = makeTempHome(t);
  const res = await spawnCli(t, ['config', '--json'], { cwd: home });
  assert.equal(res.code, 0);
  assert.equal(res.stderr, '');
  const parsed = JSON.parse(res.stdout);
  assert.equal(parsed.home, home);
  assert.equal(parsed.configPath, path.join(home, 'config.json'));
  assert.equal(parsed.dbPath, path.join(home, 'night-shift.db'));
  assert.equal(parsed.config.concurrency, 1);
  assert.equal(parsed.config.port, 7788);
  // 整段输出直接 grep 键名也要能找到（规格说「包含」）
  assert.ok(res.stdout.includes('concurrency'));
  assert.ok(res.stdout.includes('port'));
});

test('config（人类可读）输出数据目录与生效配置', async (t) => {
  const home = makeTempHome(t);
  const res = await spawnCli(t, ['config'], { cwd: home });
  assert.equal(res.code, 0);
  assert.ok(res.stdout.includes(`数据目录：${home}`));
  assert.ok(res.stdout.includes(path.join(home, 'night-shift.db')));
  assert.ok(res.stdout.includes('不存在，用默认值'));
  assert.ok(res.stdout.includes('"concurrency": 1'));
  assert.ok(res.stdout.includes('"port": 7788'));
});

test('home 里的 config.json 被 config 与 add 采纳（--max-attempts 缺省取配置 maxAttempts）', async (t) => {
  const home = makeTempHome(t);
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ maxAttempts: 5, concurrency: 2, port: 7999 }));
  const cfg = await spawnCli(t, ['config', '--json'], { cwd: home });
  const parsed = JSON.parse(cfg.stdout);
  assert.equal(parsed.config.maxAttempts, 5);
  assert.equal(parsed.config.concurrency, 2);
  assert.equal(parsed.config.port, 7999);

  const addRes = await spawnCli(t, ['add', '--repo', 'a/b', '--prompt', 'x', '--json'], { cwd: home });
  assert.equal(JSON.parse(addRes.stdout).maxAttempts, 5);
  const explicit = await spawnCli(t, ['add', '--repo', 'a/b', '--prompt', 'x', '--max-attempts', '7', '--json'], { cwd: home });
  assert.equal(JSON.parse(explicit.stdout).maxAttempts, 7, '--max-attempts 显式给定时优先');
});

test('config.json 不合法：config 与 add 都退出 1，「错误：」+ 文件路径，无堆栈', async (t) => {
  const home = makeTempHome(t);
  fs.writeFileSync(path.join(home, 'config.json'), '{oops');
  const results = await Promise.all([
    spawnCli(t, ['config'], { cwd: home }),
    spawnCli(t, ['add', '--repo', 'a/b', '--prompt', 'x'], { cwd: home }),
  ]);
  for (const res of results) {
    assert.equal(res.code, 1);
    assert.ok(res.stderr.startsWith('错误：'), res.stderr);
    assert.ok(res.stderr.includes(path.join(home, 'config.json')), res.stderr);
    assert.ok(!hasStackTrace(res.stderr), '不应打印堆栈');
  }
});

test('验收: 不引入依赖（package.json 无 dependencies / devDependencies）', () => {
  // 「npm test 全部通过」由测试套件自身证明；这里锁住零依赖这半句（#1 约定）。
  assert.ok(!('dependencies' in pkg), '不应有 dependencies');
  assert.ok(!('devDependencies' in pkg), '不应有 devDependencies');
});

test('NIGHT_SHIFT_PORT 环境变量覆盖 config 输出', async (t) => {
  const home = makeTempHome(t);
  const res = await spawnCli(t, ['config', '--json'], { cwd: home, env: { NIGHT_SHIFT_PORT: '7900' } });
  assert.equal(JSON.parse(res.stdout).config.port, 7900);
});

test('add 各选项落库：title/test/allow-peak/priority/难度默认 medium', async (t) => {
  const home = makeTempHome(t);
  // 负数要用 --priority=-2 的等号写法：parseArgs 会把独立的 -2 当未知选项
  const res = await spawnCli(t, [
    'add', '--repo', 'o/r', '--prompt', 'p', '--title', '自定义标题',
    '--test', 'npm test', '--allow-peak', '--priority=-2', '--difficulty', 'easy', '--json',
  ], { cwd: home });
  assert.equal(res.code, 0, res.stderr);
  const task = JSON.parse(res.stdout);
  assert.equal(task.title, '自定义标题');
  assert.equal(task.testCommand, 'npm test');
  assert.equal(task.allowPeak, true);
  assert.equal(task.difficulty, 'easy');
  assert.equal(task.priority, -2);
  assert.equal(task.maxAttempts, 2); // 默认配置的 maxAttempts
});

test('add --prompt 是空白：退出 1（校验失败），中文原因', async (t) => {
  const home = makeTempHome(t);
  const res = await spawnCli(t, ['add', '--repo', 'a/b', '--prompt', '   '], { cwd: home });
  assert.equal(res.code, 1);
  assert.ok(res.stderr.includes('prompt'), res.stderr);
});

test('add --prompt-file 文件不存在：退出 1，stderr 带路径', async (t) => {
  const home = makeTempHome(t);
  const missing = path.join(home, 'nope.txt');
  const res = await spawnCli(t, ['add', '--repo', 'a/b', '--prompt-file', missing], { cwd: home });
  assert.equal(res.code, 1);
  assert.ok(res.stderr.includes(missing), res.stderr);
});

test('show（人类可读）列出任务字段与提示词', async (t) => {
  const home = makeTempHome(t);
  await spawnCli(t, ['add', '--repo', 'a/b', '--prompt', '修复登录', '--title', '登录修复', '--difficulty', 'hard'], { cwd: home });
  const res = await spawnCli(t, ['show', '1'], { cwd: home });
  assert.equal(res.code, 0);
  assert.ok(res.stdout.includes('任务 #1：登录修复'));
  for (const label of ['状态', '难度', '优先级', '仓库', '允许高峰', '尝试次数', '创建时间', '提示词']) {
    assert.ok(res.stdout.includes(label), `应包含字段「${label}」`);
  }
  assert.ok(res.stdout.includes('hard'));
  assert.ok(res.stdout.includes('运行记录：无'));
});

test('show --json：任务字段在顶层（含 status），runs 是数组', async (t) => {
  const home = makeTempHome(t);
  await spawnCli(t, ['add', '--repo', 'a/b', '--prompt', 'x'], { cwd: home });
  const res = await spawnCli(t, ['show', '1', '--json'], { cwd: home });
  assert.equal(res.code, 0);
  const task = JSON.parse(res.stdout);
  assert.equal(task.id, 1);
  assert.equal(task.repo, 'a/b');
  assert.equal(task.status, 'queued');
  assert.equal(task.prompt, 'x');
  assert.ok(Array.isArray(task.runs));
});

test('show 展示运行记录（尝试次数/模型/状态/耗时/额度/日志路径）', async (t) => {
  const home = makeTempHome(t);
  // 本进程造数据（bin 已 import，SQLite 警告过滤已装好），再用子进程 show 读同一文件库。
  const { openDb } = await import('../src/db.js');
  const { createTask, startRun, finishRun } = await import('../src/tasks.js');
  {
    const db = openDb(path.join(home, 'night-shift.db'));
    const task = createTask(db, { repo: 'a/b', prompt: '跑一次' });
    const run = startRun(db, {
      taskId: task.id, attempt: 1, model: 'glm-5.3', effort: 'high', peak: false,
      logPath: '/tmp/logs/task-1-run-1.log',
    });
    finishRun(db, run.id, { status: 'succeeded', exitCode: 0, numTurns: 3, prompts: 2, quotaUnits: 2 });
    db.close();
  }
  const res = await spawnCli(t, ['show', '1'], { cwd: home });
  assert.equal(res.code, 0);
  assert.ok(res.stdout.includes('运行记录（1 条）'));
  for (const column of ['尝试次数', '模型', '状态', '耗时', '额度', '日志路径']) {
    assert.ok(res.stdout.includes(column), `运行记录表头缺「${column}」`);
  }
  assert.ok(res.stdout.includes('glm-5.3'));
  assert.ok(res.stdout.includes('succeeded'));
  assert.ok(res.stdout.includes('2')); // 额度 quotaUnits
  assert.ok(res.stdout.includes('/tmp/logs/task-1-run-1.log'));

  const json = await spawnCli(t, ['show', '1', '--json'], { cwd: home });
  const parsed = JSON.parse(json.stdout);
  assert.ok(Array.isArray(parsed.runs));
  assert.equal(parsed.runs.length, 1);
  const run = parsed.runs[0];
  // 驼峰字段逐一核对（run 的全部对外字段）
  assert.equal(run.taskId, 1);
  assert.equal(run.attempt, 1);
  assert.equal(run.model, 'glm-5.3');
  assert.equal(run.effort, 'high');
  assert.equal(run.peak, false);
  assert.equal(run.status, 'succeeded');
  assert.equal(run.exitCode, 0);
  assert.equal(run.numTurns, 3);
  assert.equal(run.prompts, 2);
  assert.equal(run.quotaUnits, 2);
  assert.equal(run.logPath, '/tmp/logs/task-1-run-1.log');
  assert.equal(run.error, null);
  assert.ok(typeof run.durationMs === 'number' && run.durationMs >= 1, '耗时毫秒数');
  assert.ok(typeof run.startedAt === 'string' && typeof run.finishedAt === 'string');
});

// —— #75：list 的状态列 / show 的字段行补上 PR 结果、指定分支、暂不开始 ——
// prOutcome 没有公开 setter（调度器查完 PR 才写），测试里直接 UPDATE 库模拟。

test('验收: list 状态列在 succeeded 后标注「（已合并）」「（已关闭）」（全角括号）', async (t) => {
  const home = makeTempHome(t);
  const { openDb } = await import('../src/db.js');
  const { createTask, claimNextTask, finishTask } = await import('../src/tasks.js');
  {
    const db = openDb(path.join(home, 'night-shift.db'));
    for (const [id, outcome] of [[1, 'merged'], [2, 'closed']]) {
      const task = createTask(db, { repo: 'a/b', prompt: 'x', title: `任务${id}` });
      claimNextTask(db); // 队里最新的排队任务就是刚建的这条
      finishTask(db, task.id, { status: 'succeeded', prUrl: `https://example.test/pr/${task.id}` });
      db.prepare('UPDATE tasks SET pr_outcome = ? WHERE id = ?').run(outcome, task.id);
    }
    db.close();
  }
  const res = await spawnCli(t, ['list'], { cwd: home });
  assert.equal(res.code, 0, res.stderr);
  const lines = res.stdout.trimEnd().split('\n');
  assert.equal(lines.length, 3, '表头 + 两行数据');
  // 完整字符串断言：状态单元格是「succeeded（已合并）」这整体，不是 succeeded 后随便拼字
  assert.ok(lines.find((l) => l.includes('任务1')).includes('succeeded（已合并）'),
    `任务 1 的状态列应是 succeeded（已合并）：${lines.find((l) => l.includes('任务1'))}`);
  assert.ok(lines.find((l) => l.includes('任务2')).includes('succeeded（已关闭）'),
    `任务 2 的状态列应是 succeeded（已关闭）：${lines.find((l) => l.includes('任务2'))}`);
});

test('验收: list 状态列：prOutcome 是 open / 大小写不同 / 没写时仍是光秃秃的 succeeded', async (t) => {
  const home = makeTempHome(t);
  const { openDb } = await import('../src/db.js');
  const { createTask, claimNextTask, finishTask } = await import('../src/tasks.js');
  {
    const db = openDb(path.join(home, 'night-shift.db'));
    // open、'MERGED'（大小写不同）、null（完全不写 pr_outcome）三种都不该出标注
    for (const outcome of ['open', 'MERGED', null]) {
      const task = createTask(db, { repo: 'a/b', prompt: 'x', title: '普通成功' });
      claimNextTask(db);
      finishTask(db, task.id, { status: 'succeeded', prUrl: `https://example.test/pr/${task.id}` });
      if (outcome !== null) {
        db.prepare('UPDATE tasks SET pr_outcome = ? WHERE id = ?').run(outcome, task.id);
      }
    }
    db.close();
  }
  const res = await spawnCli(t, ['list'], { cwd: home });
  assert.equal(res.code, 0, res.stderr);
  const rows = res.stdout.trimEnd().split('\n').slice(1);
  assert.equal(rows.length, 3);
  for (const line of rows) {
    assert.ok(line.includes(' succeeded '), `状态列应仍是 succeeded：${line}`);
  }
  assert.ok(!res.stdout.includes('已合并'), 'open / 大小写不同 / 空都不该出「已合并」');
  assert.ok(!res.stdout.includes('已关闭'), '也不该出「已关闭」');
});

test('验收: list 状态列：排队等依赖的任务不吃 PR 结果标注', async (t) => {
  const home = makeTempHome(t);
  const { openDb } = await import('../src/db.js');
  const { createTask, setDependencies } = await import('../src/tasks.js');
  {
    const db = openDb(path.join(home, 'night-shift.db'));
    createTask(db, { repo: 'a/b', prompt: '上游' }); // 仍是 queued（未 succeeded）
    createTask(db, { repo: 'a/b', prompt: '下游' });
    setDependencies(db, 2, [1]); // 任务 2 被任务 1 挡住
    db.close();
  }
  const before = await spawnCli(t, ['list'], { cwd: home });
  assert.equal(before.code, 0, before.stderr);
  const blockedRow = (out) => out.trimEnd().split('\n').find((l) => l.startsWith('2 '));
  assert.ok(blockedRow(before.stdout).includes('queued（等 #1）'),
    `状态列应是 queued（等 #1）：${blockedRow(before.stdout)}`);

  // 即使这条任务上有 PR 结论，也仍是排队等依赖的显示
  {
    const db = openDb(path.join(home, 'night-shift.db'));
    db.prepare('UPDATE tasks SET pr_outcome = ? WHERE id = ?').run('merged', 2);
    db.close();
  }
  const after = await spawnCli(t, ['list'], { cwd: home });
  assert.equal(after.code, 0, after.stderr);
  assert.ok(blockedRow(after.stdout).includes('queued（等 #1）'),
    `prOutcome=merged 也该还是 queued（等 #1）：${blockedRow(after.stdout)}`);
  assert.ok(!after.stdout.includes('已合并'), '排队等依赖的任务不该带 PR 结果标注');
});

test('验收: show 补上指定分支 / PR 结果 / 暂不开始三行（有值才出，都在 PR 行之后）', async (t) => {
  const home = makeTempHome(t);
  const { openDb } = await import('../src/db.js');
  const { createTask, claimNextTask, finishTask } = await import('../src/tasks.js');
  {
    const db = openDb(path.join(home, 'night-shift.db'));
    const task = createTask(db, { repo: 'a/b', prompt: '跟进上游', gitRef: 'night-shift/1-demo' });
    claimNextTask(db);
    // 限流退避的放回：排回队列并写 notBefore（spawnCli 固定 TZ=UTC → 显示 2026-10-08 18:30）
    finishTask(db, task.id, {
      status: 'queued', notBefore: '2026-10-08T18:30:00.000Z', refundAttempt: true,
    });
    db.prepare('UPDATE tasks SET pr_outcome = ? WHERE id = ?').run('merged', task.id);
    db.close();
  }
  const res = await spawnCli(t, ['show', '1'], { cwd: home });
  assert.equal(res.code, 0, res.stderr);
  const lines = res.stdout.split('\n');
  const lineOf = (prefix, what) => {
    const line = lines.find((l) => l.startsWith(prefix));
    assert.ok(line !== undefined, `应有一行以「${prefix}」开头（${what}）`);
    return line;
  };
  // 「PR」行本身保持原样（这条任务没有 prUrl → （无））；三行新字段按固定顺序跟在它后面
  const prLine = lineOf('PR', 'PR 行');
  assert.ok(!prLine.startsWith('PR 结果'), `找的应是「PR」行而不是「PR 结果」行：${prLine}`);
  assert.ok(/^PR\s+（无）$/.test(prLine), `没有 prUrl 时 PR 行显示（无）：${prLine}`);
  const gitRefLine = lineOf('指定分支', 'gitRef');
  const outcomeLine = lineOf('PR 结果', 'PR 结果');
  const notBeforeLine = lineOf('暂不开始', 'notBefore');
  const errorLine = lineOf('最近错误', '最近错误');
  const pos = (prefix) => lines.findIndex((l) => l.startsWith(prefix));
  assert.ok(pos('PR') < pos('指定分支'), '指定分支在 PR 行之后');
  assert.ok(pos('指定分支') < pos('PR 结果'), 'PR 结果在指定分支之后');
  assert.ok(pos('PR 结果') < pos('暂不开始'), '暂不开始在 PR 结果之后');
  assert.ok(pos('暂不开始') < pos('最近错误'), '三行插在 PR 与最近错误之间');
  // 值在同一视觉行、且就是行尾（标签对齐后两个空格接值，后面没有别的字）
  assert.ok(/night-shift\/1-demo\s*$/.test(gitRefLine), `gitRef 原样输出：${gitRefLine}`);
  assert.ok(/已合并\s*$/.test(outcomeLine), `PR 结果的值是已合并：${outcomeLine}`);
  assert.ok(/2026-10-08 18:30\s*$/.test(notBeforeLine), `notBefore 按 UTC 显示：${notBeforeLine}`);
  // 与「创建时间」同一套 formatLocalMinute（YYYY-MM-DD HH:mm）和同一套 padEndDisplay 对齐
  const createdLine = lineOf('创建时间', '创建时间');
  assert.match(createdLine, /\d{4}-\d{2}-\d{2} \d{2}:\d{2}/);
  const valueCol = (line, label) =>
    displayWidth(label) + line.slice(label.length).match(/^ */)[0].length;
  for (const [label, line] of [['指定分支', gitRefLine], ['PR 结果', outcomeLine], ['暂不开始', notBeforeLine]]) {
    assert.equal(valueCol(line, label), valueCol(createdLine, '创建时间'),
      `「${label}」的值应与「创建时间」的值对齐（进同一套 fields / padEndDisplay）`);
  }
});

test('验收: show 普通任务（add 出来的）不出现指定分支 / PR 结果 / 暂不开始', async (t) => {
  const home = makeTempHome(t);
  await spawnCli(t, ['add', '--repo', 'a/b', '--prompt', 'x'], { cwd: home });
  const res = await spawnCli(t, ['show', '1'], { cwd: home });
  assert.equal(res.code, 0, res.stderr);
  for (const label of ['指定分支', 'PR 结果', '暂不开始']) {
    assert.ok(!res.stdout.includes(label), `没有值就不该出现「${label}」：\n${res.stdout}`);
  }
  assert.ok(/^PR\s+（无）$/m.test(res.stdout), '「PR」行本身保持原样（（无））');
});

test('验收: --json 形状不变：status 是裸状态串，prOutcome 原样，不掺人类可读装饰', async (t) => {
  const home = makeTempHome(t);
  const { openDb } = await import('../src/db.js');
  const { createTask, claimNextTask, finishTask } = await import('../src/tasks.js');
  {
    const db = openDb(path.join(home, 'night-shift.db'));
    const task = createTask(db, { repo: 'a/b', prompt: 'x', title: '带结论的任务' });
    claimNextTask(db);
    finishTask(db, task.id, { status: 'succeeded', prUrl: 'https://example.test/pr/1' });
    db.prepare('UPDATE tasks SET pr_outcome = ? WHERE id = ?').run('merged', task.id);
    db.close();
  }
  const listJson = await spawnCli(t, ['list', '--json'], { cwd: home });
  assert.equal(listJson.code, 0, listJson.stderr);
  const [task] = JSON.parse(listJson.stdout);
  assert.equal(task.status, 'succeeded', 'status 仍是字符串 succeeded，不是 succeeded（已合并）');
  assert.equal(task.prOutcome, 'merged');

  const showJson = await spawnCli(t, ['show', '1', '--json'], { cwd: home });
  assert.equal(showJson.code, 0, showJson.stderr);
  const detail = JSON.parse(showJson.stdout);
  assert.equal(detail.status, 'succeeded', 'show --json 顶层 status 同样是裸状态串');
  assert.equal(detail.prOutcome, 'merged');
  assert.ok(Array.isArray(detail.runs));
  for (const deco of ['已合并', '已关闭', '指定分支', 'PR 结果', '暂不开始']) {
    assert.ok(!showJson.stdout.includes(deco) && !listJson.stdout.includes(deco),
      `JSON 输出不掺人类可读装饰「${deco}」`);
  }

  // 普通任务的 show --json：改前就有的键都在，也没有新造的键（本来就不该加）
  const plainHome = makeTempHome(t);
  await spawnCli(t, ['add', '--repo', 'a/b', '--prompt', 'x'], { cwd: plainHome });
  const plainJson = await spawnCli(t, ['show', '1', '--json'], { cwd: plainHome });
  const plain = JSON.parse(plainJson.stdout);
  for (const key of ['id', 'status', 'repo', 'title', 'prompt', 'gitRef', 'prOutcome',
    'notBefore', 'prUrl', 'branch', 'runs', 'dependsOn', 'blockedBy']) {
    assert.ok(key in plain, `改前就有的键 ${key} 应仍在`);
  }
  const knownKeys = new Set(['id', 'repo', 'source', 'gitRef', 'title', 'prompt', 'difficulty',
    'priority', 'testCommand', 'allowPeak', 'status', 'attempts', 'maxAttempts', 'branch',
    'prUrl', 'prOutcome', 'lastError', 'notBefore', 'createdAt', 'updatedAt', 'startedAt',
    'finishedAt', 'dependsOn', 'blockedBy', 'runs']);
  for (const key of Object.keys(plain)) {
    assert.ok(knownKeys.has(key), `不该出现新造的键：${key}`);
  }
});

// —— #85：list / show 说明排队任务「在等这个仓库」（oneTaskPerRepo 开着且同仓库另有 running）——
// 造数都在本进程直连 home 的 night-shift.db（claimNextTask 缺省不看 oneTaskPerRepo 开关，
// 可以直接把队首排队任务领成 running），再用子进程读同一个文件库；repo 全等比较
// （===，不 trim、不 toLowerCase）的边界用直写 UPDATE 模拟（repo 列没有 CHECK）。

/** 在 home 的 night-shift.db 上跑一次 build(db, api)（api 是 tasks.js 的函数表）。 */
async function seedTasks(home, build) {
  const { openDb } = await import('../src/db.js');
  const api = await import('../src/tasks.js');
  const db = openDb(path.join(home, 'night-shift.db'));
  try {
    build(db, api);
  } finally {
    db.close();
  }
}

/** list 表格里 id 那一行（ID 是首列，单元格以「<id> 」开头）。 */
const rowOf = (out, id) => out.trimEnd().split('\n').find((l) => l.startsWith(`${id} `));

/** 同仓库「一条 running + 一条 queued」的常用造数；返回两边的 id。 */
function seedRunningAndQueued(db, api, repo = 'a/b') {
  api.createTask(db, { repo, prompt: '先跑的' });
  api.claimNextTask(db); // 领走队首（#1）→ running
  api.createTask(db, { repo, prompt: '后到的' }); // 同仓库排队
}

test('验收: 同仓库一条 running、一条 queued：排队行标「queued（等这个仓库）」，running 行不标', async (t) => {
  const home = makeTempHome(t); // 没有 config.json：loadConfig 合并默认值，oneTaskPerRepo 是 true
  await seedTasks(home, seedRunningAndQueued);
  const res = await spawnCli(t, ['list'], { cwd: home });
  assert.equal(res.code, 0, res.stderr);
  assert.ok(rowOf(res.stdout, 2).includes('queued（等这个仓库）'),
    `#2 的状态列应是 queued（等这个仓库）：${rowOf(res.stdout, 2)}`);
  const runningRow = rowOf(res.stdout, 1);
  assert.ok(runningRow.includes('running'), `#1 的状态列应是 running：${runningRow}`);
  assert.ok(!runningRow.includes('等这个仓库'), `running 行不该标：${runningRow}`);
});

test('验收: 排队等依赖又等仓库：queued（等 #1，等这个仓库）；两个依赖 queued（等 #1,#2，等这个仓库）', async (t) => {
  const home = makeTempHome(t);
  await seedTasks(home, (db, { createTask, claimNextTask, setDependencies }) => {
    createTask(db, { repo: 'a/b', prompt: '正在跑' }); // #1 → running，也是依赖目标
    claimNextTask(db);
    createTask(db, { repo: 'a/b', prompt: '等一个' }); // #2
    setDependencies(db, 2, [1]);
    createTask(db, { repo: 'a/b', prompt: '等两个' }); // #3
    setDependencies(db, 3, [1, 2]);
  });
  const res = await spawnCli(t, ['list'], { cwd: home });
  assert.equal(res.code, 0, res.stderr);
  assert.ok(rowOf(res.stdout, 2).includes('queued（等 #1，等这个仓库）'),
    `一个依赖：${rowOf(res.stdout, 2)}`);
  assert.ok(rowOf(res.stdout, 3).includes('queued（等 #1,#2，等这个仓库）'),
    `两个依赖（依赖之间仍是 ,#）：${rowOf(res.stdout, 3)}`);
});

test('验收: 同仓库另一条也只是 queued（没有 running）：状态列与现在相同，不出现「等这个仓库」', async (t) => {
  const home = makeTempHome(t); // 默认开关是 true，但没有 running，照样不标
  await seedTasks(home, (db, { createTask, setDependencies }) => {
    createTask(db, { repo: 'a/b', prompt: '排队一' }); // #1 queued
    createTask(db, { repo: 'a/b', prompt: '排队二' }); // #2 queued，同仓库无 running
    createTask(db, { repo: 'a/b', prompt: '等依赖' }); // #3
    setDependencies(db, 3, [1]);
  });
  const res = await spawnCli(t, ['list'], { cwd: home });
  assert.equal(res.code, 0, res.stderr);
  for (const id of [1, 2]) {
    assert.ok(rowOf(res.stdout, id).includes(' queued '),
      `#${id} 仍是光秃秃的 queued：${rowOf(res.stdout, id)}`);
  }
  assert.ok(rowOf(res.stdout, 3).includes('queued（等 #1）'),
    `#3 仍是 queued（等 #1）：${rowOf(res.stdout, 3)}`);
  assert.ok(!res.stdout.includes('等这个仓库'), '同仓库只有另一条 queued 不算在等仓库');
});

test('验收: oneTaskPerRepo 为 false / 字符串 "true" / 数字 1：同仓库有 running 也不出现「等这个仓库」', async (t) => {
  for (const value of [false, 'true', 1]) {
    const home = makeTempHome(t);
    fs.writeFileSync(path.join(home, 'config.json'), `${JSON.stringify({ oneTaskPerRepo: value })}\n`);
    await seedTasks(home, seedRunningAndQueued);
    const res = await spawnCli(t, ['list'], { cwd: home });
    assert.equal(res.code, 0, res.stderr);
    assert.ok(!res.stdout.includes('等这个仓库'),
      `oneTaskPerRepo=${JSON.stringify(value)}（非全等 true）不该标`);
    assert.ok(rowOf(res.stdout, 2).includes(' queued '),
      `仍是裸 queued：${rowOf(res.stdout, 2)}`);
  }
});

test('验收: repo 大小写不同（A/B 与 a/b）或只差首尾空白（a/b 与 "a/b "）：不算同仓库', async (t) => {
  const caseHome = makeTempHome(t);
  await seedTasks(caseHome, (db, { createTask, claimNextTask }) => {
    createTask(db, { repo: 'A/B', prompt: '大写在跑' });
    claimNextTask(db);
    createTask(db, { repo: 'a/b', prompt: '小写在等' }); // 'a/b' !== 'A/B'，不 toLowerCase
  });
  const caseRes = await spawnCli(t, ['list'], { cwd: caseHome });
  assert.equal(caseRes.code, 0, caseRes.stderr);
  assert.ok(!caseRes.stdout.includes('等这个仓库'), '大小写不同不算同仓库');

  const trimHome = makeTempHome(t);
  await seedTasks(trimHome, (db, { createTask, claimNextTask }) => {
    createTask(db, { repo: 'a/b', prompt: '在跑的' });
    claimNextTask(db);
    const queued = createTask(db, { repo: 'a/b', prompt: '在等的' });
    // createTask 会 trim，尾部空白只能直写库模拟（repo 列没有 CHECK，脏值能进）
    db.prepare('UPDATE tasks SET repo = ? WHERE id = ?').run('a/b ', queued.id);
  });
  const trimRes = await spawnCli(t, ['list'], { cwd: trimHome });
  assert.equal(trimRes.code, 0, trimRes.stderr);
  assert.ok(!trimRes.stdout.includes('等这个仓库'), '差一个尾部空格不算同仓库（不 trim）');
});

test('验收: list --status queued --limit 1：running 不在列表结果里，同仓库排队行仍标「等这个仓库」', async (t) => {
  const home = makeTempHome(t);
  await seedTasks(home, (db, { createTask, claimNextTask }) => {
    createTask(db, { repo: 'a/b', prompt: '在跑的' }); // #1 → running
    claimNextTask(db);
    createTask(db, { repo: 'a/b', prompt: '在等的' }); // #2，排队队首
    createTask(db, { repo: 'c/d', prompt: '别的仓库' }); // #3
  });
  const res = await spawnCli(t, ['list', '--status', 'queued', '--limit', '1'], { cwd: home });
  assert.equal(res.code, 0, res.stderr);
  assert.ok(!res.stdout.includes('running'), 'running 任务不在这次列表结果里');
  const lines = res.stdout.trimEnd().split('\n');
  assert.equal(lines.length, 2, '表头 + 一行（--limit 1）');
  assert.ok(lines[1].startsWith('2 '), `--limit 1 取排队队首 #2：${lines[1]}`);
  assert.ok(lines[1].includes('queued（等这个仓库）'),
    `running 是另查的（limit 固定 1000），不受本次 --limit 影响：${lines[1]}`);
});

test('验收: succeeded（已合并）的任务即使同仓库有 running：该行仍是 succeeded（已合并）', async (t) => {
  const home = makeTempHome(t);
  await seedTasks(home, (db, { createTask, claimNextTask, finishTask }) => {
    createTask(db, { repo: 'a/b', prompt: '在跑的' }); // #1 → running
    claimNextTask(db);
    const done = createTask(db, { repo: 'a/b', prompt: '已合并的' }); // #2
    claimNextTask(db); // 领走 #2（claimNextTask 缺省不看 oneTaskPerRepo）
    finishTask(db, done.id, { status: 'succeeded', prUrl: 'https://example.test/pr/2' });
    db.prepare('UPDATE tasks SET pr_outcome = ? WHERE id = ?').run('merged', done.id);
    createTask(db, { repo: 'a/b', prompt: '在等的' }); // #3 queued
  });
  const res = await spawnCli(t, ['list'], { cwd: home });
  assert.equal(res.code, 0, res.stderr);
  const mergedRow = rowOf(res.stdout, 2);
  assert.ok(mergedRow.includes('succeeded（已合并）'), `#2 仍是 succeeded（已合并）：${mergedRow}`);
  assert.ok(!mergedRow.includes('等这个仓库'), `succeeded 不吃「等这个仓库」：${mergedRow}`);
  assert.ok(rowOf(res.stdout, 3).includes('queued（等这个仓库）'),
    `#3 排队照常标：${rowOf(res.stdout, 3)}`);
});

test('验收: show 该等的时候：「状态」值就是 queued（等这个仓库）；有依赖也不塞 等 #，依赖行仍在', async (t) => {
  const home = makeTempHome(t);
  await seedTasks(home, (db, { createTask, claimNextTask, setDependencies }) => {
    createTask(db, { repo: 'a/b', prompt: '在跑的' }); // #1 → running
    claimNextTask(db);
    createTask(db, { repo: 'a/b', prompt: '无依赖的排队' }); // #2
    createTask(db, { repo: 'a/b', prompt: '等上游的排队' }); // #3，依赖另一条排队任务
    setDependencies(db, 3, [2]);
  });
  const plain = await spawnCli(t, ['show', '2'], { cwd: home });
  assert.equal(plain.code, 0, plain.stderr);
  assert.match(plain.stdout, /^状态\s+queued（等这个仓库）$/m,
    '状态值就是 queued（等这个仓库），值在行尾，后面没有别的字');
  assert.equal(plain.stdout.match(/等这个仓库/g)?.length, 1, '只出现在状态格里，不另加一行');

  const withDeps = await spawnCli(t, ['show', '3'], { cwd: home });
  assert.equal(withDeps.code, 0, withDeps.stderr);
  assert.match(withDeps.stdout, /^状态\s+queued（等这个仓库）$/m,
    '有依赖时状态值仍只是 queued（等这个仓库），不包含 等 #');
  assert.ok(/^依赖：#2 queued$/m.test(withDeps.stdout), '依赖行保持原样、单独一行');
});

test('验收: show 不该等的时候（开关 false / 同仓库只有另一条 queued / 自己是 running）：状态是原始状态', async (t) => {
  const offHome = makeTempHome(t);
  fs.writeFileSync(path.join(offHome, 'config.json'), `${JSON.stringify({ oneTaskPerRepo: false })}\n`);
  await seedTasks(offHome, seedRunningAndQueued);
  const offRes = await spawnCli(t, ['show', '2'], { cwd: offHome });
  assert.equal(offRes.code, 0, offRes.stderr);
  assert.ok(!offRes.stdout.includes('等这个仓库'), '开关是 false 不标');
  assert.match(offRes.stdout, /^状态\s+queued$/m, '状态是原始 queued');

  const queuedHome = makeTempHome(t);
  await seedTasks(queuedHome, (db, { createTask, setDependencies }) => {
    createTask(db, { repo: 'a/b', prompt: '排队一' }); // #1 queued
    createTask(db, { repo: 'a/b', prompt: '排队二' }); // #2 queued
    setDependencies(db, 2, [1]);
  });
  const queuedRes = await spawnCli(t, ['show', '2'], { cwd: queuedHome });
  assert.equal(queuedRes.code, 0, queuedRes.stderr);
  assert.ok(!queuedRes.stdout.includes('等这个仓库'), '同仓库只有另一条 queued 不标');
  assert.match(queuedRes.stdout, /^状态\s+queued$/m, '状态是原始 queued');
  assert.ok(/^依赖：#1 queued$/m.test(queuedRes.stdout), '不该等时依赖行仍在');

  const runningHome = makeTempHome(t); // 开关默认 true、同仓库也真有 running，但自己是 running
  await seedTasks(runningHome, seedRunningAndQueued);
  const runningRes = await spawnCli(t, ['show', '1'], { cwd: runningHome });
  assert.equal(runningRes.code, 0, runningRes.stderr);
  assert.ok(!runningRes.stdout.includes('等这个仓库'), '任务是 running 不标');
  assert.match(runningRes.stdout, /^状态\s+running$/m, '状态是原始 running');
});

test('验收: --json 不受影响：status 是裸状态串、prOutcome 原样，没有新键；坏掉的 config.json 也不退出 1', async (t) => {
  const home = makeTempHome(t);
  await seedTasks(home, (db, { createTask, claimNextTask, finishTask }) => {
    createTask(db, { repo: 'a/b', prompt: '在跑的' }); // #1 → running
    claimNextTask(db);
    const done = createTask(db, { repo: 'a/b', prompt: '已合并的' }); // #2
    claimNextTask(db);
    finishTask(db, done.id, { status: 'succeeded', prUrl: 'https://example.test/pr/2' });
    db.prepare('UPDATE tasks SET pr_outcome = ? WHERE id = ?').run('merged', done.id);
    createTask(db, { repo: 'a/b', prompt: '在等的' }); // #3 queued
  });
  const listJson = await spawnCli(t, ['list', '--json'], { cwd: home });
  assert.equal(listJson.code, 0, listJson.stderr);
  const byId = new Map(JSON.parse(listJson.stdout).map((task) => [task.id, task]));
  assert.equal(byId.get(1).status, 'running');
  assert.equal(byId.get(2).status, 'succeeded', 'status 是裸的 succeeded，不是 succeeded（已合并）');
  assert.equal(byId.get(2).prOutcome, 'merged');
  assert.equal(byId.get(3).status, 'queued', 'status 是裸的 queued，不是 queued（等这个仓库）');
  assert.ok(!listJson.stdout.includes('等这个仓库'), 'list --json 不掺「等这个仓库」');

  for (const [id, status] of [[1, 'running'], [3, 'queued']]) {
    const showJson = await spawnCli(t, ['show', String(id), '--json'], { cwd: home });
    assert.equal(showJson.code, 0, showJson.stderr);
    const detail = JSON.parse(showJson.stdout);
    assert.equal(detail.status, status, 'show --json 顶层 status 是裸状态串');
    const knownKeys = new Set(['id', 'repo', 'source', 'gitRef', 'title', 'prompt', 'difficulty',
      'priority', 'testCommand', 'allowPeak', 'status', 'attempts', 'maxAttempts', 'branch',
      'prUrl', 'prOutcome', 'lastError', 'notBefore', 'createdAt', 'updatedAt', 'startedAt',
      'finishedAt', 'dependsOn', 'blockedBy', 'runs']);
    for (const key of Object.keys(detail)) {
      assert.ok(knownKeys.has(key), `不该出现新造的键（如 waitingSameRepo / sameRepo）：${key}`);
    }
  }

  // 坏掉的 config.json：--json 路径不读配置，不该突然退出 1
  const brokenHome = makeTempHome(t);
  fs.writeFileSync(path.join(brokenHome, 'config.json'), '{oops');
  await seedTasks(brokenHome, seedRunningAndQueued);
  const brokenList = await spawnCli(t, ['list', '--json'], { cwd: brokenHome });
  assert.equal(brokenList.code, 0, brokenList.stderr);
  assert.ok(!brokenList.stdout.includes('等这个仓库'));
  const brokenShow = await spawnCli(t, ['show', '2', '--json'], { cwd: brokenHome });
  assert.equal(brokenShow.code, 0, brokenShow.stderr);
  assert.equal(JSON.parse(brokenShow.stdout).status, 'queued');
});

test('cancel 已是终态的任务：退出 1（非法状态转换，中文原因）', async (t) => {
  const home = makeTempHome(t);
  await spawnCli(t, ['add', '--repo', 'a/b', '--prompt', 'x'], { cwd: home });
  await spawnCli(t, ['cancel', '1'], { cwd: home });
  const again = await spawnCli(t, ['cancel', '1'], { cwd: home });
  assert.equal(again.code, 1);
  assert.ok(again.stderr.includes('不能从 canceled'), again.stderr);
});

test('retry 不存在的任务 / retry 未失败的任务：退出 1', async (t) => {
  const home = makeTempHome(t);
  await spawnCli(t, ['add', '--repo', 'a/b', '--prompt', 'x'], { cwd: home });
  const missing = await spawnCli(t, ['retry', '42'], { cwd: home });
  assert.equal(missing.code, 1);
  assert.ok(missing.stderr.includes('任务 42 不存在'), missing.stderr);
  const notFailed = await spawnCli(t, ['retry', '1'], { cwd: home }); // queued 不能 retry
  assert.equal(notFailed.code, 1);
  assert.ok(notFailed.stderr.includes('不能从 queued'), notFailed.stderr);
});

test('list 表格：CJK 长标题截断且时间列与 ASCII 标题行对齐', async (t) => {
  const home = makeTempHome(t);
  await spawnCli(t, ['add', '--repo', 'a/b', '--prompt', 'x', '--title', '很长的中文标题内容需要被截断掉'.repeat(6)], { cwd: home });
  await spawnCli(t, ['add', '--repo', 'c/d', '--prompt', 'x', '--title', 'short title'], { cwd: home });
  const res = await spawnCli(t, ['list'], { cwd: home });
  assert.equal(res.code, 0);
  const lines = res.stdout.trimEnd().split('\n');
  assert.equal(lines.length, 3);
  assert.ok(lines.find((l) => l.includes('很长的中文标题')).includes('…'), '长标题应以 … 截断');
  // 两行数据的时间列起始「显示列」必须一致（若按 .length 而不是显示宽度对齐，中文行会错位；
  // 直接比 indexOf 字符位置会误报——中文 1 字符占 2 列）
  const timeStart = (line) => displayWidth(line.slice(0, line.indexOf('2026-')));
  assert.ok(timeStart(lines[1]) > 0 && timeStart(lines[2]) > 0);
  assert.equal(timeStart(lines[1]), timeStart(lines[2]));
});

test('list --limit 控制条数（store 排序：最新在前）', async (t) => {
  const home = makeTempHome(t);
  for (const title of ['甲', '乙', '丙']) {
    await spawnCli(t, ['add', '--repo', 'a/b', '--prompt', 'x', '--title', title], { cwd: home });
  }
  const res = await spawnCli(t, ['list', '--limit', '2', '--json'], { cwd: home });
  const arr = JSON.parse(res.stdout);
  assert.equal(arr.length, 2);
  assert.deepEqual(arr.map((task) => task.title), ['丙', '乙']); // created_at DESC
});

// —— 加固：负数选项、管道提前关闭、坏数据目录、符号链接、控制字符 ——

test('负数选项：--priority -2 与 --priority=-2 等价；--limit/--max-attempts 负数报整数错误', async (t) => {
  const home = makeTempHome(t);
  const spaceForm = await spawnCli(t, ['add', '--repo', 'a/b', '--prompt', 'x', '--priority', '-2', '--json'], { cwd: home });
  assert.equal(spaceForm.code, 0, spaceForm.stderr);
  assert.equal(JSON.parse(spaceForm.stdout).priority, -2);

  const eqForm = await spawnCli(t, ['add', '--repo', 'a/b', '--prompt', 'x', '--priority=-3', '--json'], { cwd: home });
  assert.equal(eqForm.code, 0, eqForm.stderr);
  assert.equal(JSON.parse(eqForm.stdout).priority, -3);

  const limit = await spawnCli(t, ['list', '--limit', '-5'], { cwd: home });
  assert.equal(limit.code, 2);
  assert.ok(limit.stderr.includes('--limit 必须是不小于 1 的整数'), limit.stderr);
  assert.ok(!limit.stderr.includes('未知选项'), '负数不该被当成未知选项');

  const maxAttempts = await spawnCli(t, ['add', '--repo', 'a/b', '--prompt', 'x', '--max-attempts', '-1'], { cwd: home });
  assert.equal(maxAttempts.code, 2);
  assert.ok(maxAttempts.stderr.includes('--max-attempts 必须是不小于 1 的整数'), maxAttempts.stderr);
  assert.ok(!maxAttempts.stderr.includes('未知选项'));
});

test('list | head 提前关管道：静默退出，不打堆栈（EPIPE）', async (t) => {
  const home = makeTempHome(t);
  // 本进程直接批量造任务（比逐条 CLI 快得多），让 list 输出远超管道缓冲区（64KB）
  const { openDb } = await import('../src/db.js');
  const { createTask } = await import('../src/tasks.js');
  {
    const db = openDb(path.join(home, 'night-shift.db'));
    const title = '很长的标题'.repeat(12); // 60 个汉字，展示时截到 40 列
    for (let i = 0; i < 1200; i++) {
      createTask(db, { repo: 'a/b', prompt: 'x', title: `${title}${i}` });
    }
    db.close();
  }
  const result = await new Promise((resolve, reject) => {
    const child = spawn('/bin/sh', ['-c',
      `${JSON.stringify(process.execPath)} ${JSON.stringify(binPath)} list --limit 2000 | head -2`], {
      cwd: home,
      env: fakeEnv({ NIGHT_SHIFT_HOME: home, TZ: 'UTC' }),
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
  assert.equal(result.code, 0, `管道应静默成功，stderr：${result.stderr}`);
  assert.ok(result.stdout.includes('ID'), 'head 应能看到表头');
  assert.ok(!result.stderr.includes('EPIPE'), `不应出现 EPIPE 报错：${result.stderr}`);
  assert.ok(!result.stderr.includes('at '), '不应打印堆栈');
});

test('NIGHT_SHIFT_HOME 指到普通文件：退出 1，中文原因带路径，无堆栈', async (t) => {
  const home = makeTempHome(t);
  const notADir = path.join(home, 'not-a-dir');
  fs.writeFileSync(notADir, 'x');
  const cases = [
    { args: ['list'], needle: '无法打开数据库' },
    { args: ['add', '--repo', 'a/b', '--prompt', 'x'], needle: '无法读取配置文件' },
    { args: ['config'], needle: '无法读取配置文件' },
  ];
  for (const { args, needle } of cases) {
    const res = await spawnCli(t, args, { home: notADir, cwd: home });
    assert.equal(res.code, 1, JSON.stringify(args));
    assert.ok(res.stderr.startsWith('错误：'), res.stderr);
    assert.ok(res.stderr.includes(needle), `${JSON.stringify(args)} 应含「${needle}」：${res.stderr}`);
    assert.ok(res.stderr.includes(notADir), res.stderr);
    assert.ok(!hasStackTrace(res.stderr), '不应打印堆栈');
  }
});

test('通过符号链接调用（npm link 场景）：动态 import 的 db.js 按真实路径解析', async (t) => {
  const dir = makeTempHome(t); // 放符号链接的目录（也是 cwd）
  const home = makeTempHome(t); // 数据目录另放，验证 NIGHT_SHIFT_HOME 与 cwd 解耦
  const link = path.join(dir, 'night-shift');
  fs.symlinkSync(binPath, link);

  const addRes = await spawnCli(t, ['add', '--repo', 'a/b', '--prompt', 'x'], { cwd: dir, home, bin: link });
  assert.equal(addRes.code, 0, addRes.stderr);
  assert.equal(addRes.stdout, '已加入队列：#1 x\n');
  const listRes = await spawnCli(t, ['list'], { cwd: dir, home, bin: link });
  assert.equal(listRes.code, 0, listRes.stderr);
  assert.equal(listRes.stdout.trimEnd().split('\n').length, 2, '表头 + 1 行，能读回数据');
  assert.ok(fs.existsSync(path.join(home, 'night-shift.db')), '数据库建在 NIGHT_SHIFT_HOME 而不是链接目录');
});

test('标题/提示词带换行、制表、控制字符：list 表格不被破坏，show 提示词缩进多行', async (t) => {
  const home = makeTempHome(t);
  await spawnCli(t, ['add', '--repo', 'a/b', '--prompt', '第一行\n第二行\t带制表\x07', '--title', '标\n题\x1b'], { cwd: home });
  await spawnCli(t, ['add', '--repo', 'c/d', '--prompt', 'x', '--title', '正常标题'], { cwd: home });

  const listRes = await spawnCli(t, ['list'], { cwd: home });
  assert.equal(listRes.code, 0);
  const lines = listRes.stdout.trimEnd().split('\n');
  assert.equal(lines.length, 3, '控制字符换成空格后，行数仍是表头 + 2 行');
  const timeStart = (line) => displayWidth(line.slice(0, line.indexOf('2026-')));
  assert.equal(timeStart(lines[1]), timeStart(lines[2]), '对齐不受影响');
  const dataLines = listRes.stdout.split('\n').slice(1);
  assert.ok(dataLines.every((line) => !/[\x00-\x1f]/.test(line)), '数据行里不该再有任何控制字符');

  const showRes = await spawnCli(t, ['show', '1'], { cwd: home });
  assert.equal(showRes.code, 0);
  assert.ok(showRes.stdout.includes('任务 #1：标 题 '), '详情标题行压平成一行');
  assert.ok(showRes.stdout.includes('提示词：\n  第一行\n  第二行 带制表 '), '提示词逐行缩进，制表/控制字符换空格');
});

test('help 列出全部子命令与每个命令的每个选项', async (t) => {
  const res = await spawnCli(t, ['help']);
  assert.equal(res.code, 0);
  assert.equal(res.stderr, '');
  for (const name of ['add', 'list', 'show', 'cancel', 'retry', 'config', 'help']) {
    assert.ok(res.stdout.includes(name), `帮助应提到 ${name}`);
  }
  // add 的全部选项
  for (const opt of ['--repo', '--prompt', '--prompt-file', '--title', '--difficulty',
    '--priority', '--test', '--allow-peak', '--max-attempts', '--json']) {
    assert.ok(res.stdout.includes(opt), `帮助应提到 ${opt}`);
  }
  // list / show / config 的选项
  for (const opt of ['--status', '--limit', '--json']) {
    assert.ok(res.stdout.includes(opt), `帮助应提到 ${opt}`);
  }
  // 每个命令都有自己的一条用法
  for (const name of ['add', 'list', 'show', 'cancel', 'retry', 'config']) {
    assert.ok(res.stdout.includes(`night-shift ${name}`), `帮助应含 ${name} 的用法行`);
  }
});

test('<命令> --help / -h：退出 0，打印该命令自己的用法（含全部选项）', async (t) => {
  const results = await Promise.all([
    spawnCli(t, ['add', '--help']),
    spawnCli(t, ['add', '-h']),
    spawnCli(t, ['list', '--help']),
    spawnCli(t, ['show', '--help']),
    spawnCli(t, ['cancel', '--help']),
    spawnCli(t, ['retry', '--help']),
    spawnCli(t, ['config', '--help']),
  ]);
  for (const res of results) {
    assert.equal(res.code, 0, res.stderr);
    assert.equal(res.stderr, '');
    assert.ok(res.stdout.startsWith('用法：night-shift '), res.stdout);
    assert.ok(res.stdout.trimEnd().length > 0);
  }
  assert.ok(results[0].stdout.includes('--allow-peak'));
  assert.ok(results[0].stdout.includes('--prompt-file'));
  assert.ok(results[2].stdout.includes('--status'));
  assert.ok(results[2].stdout.includes('--limit'));
});

test('用法/帮助输出都以且仅以一个换行结尾（不粘 shell 提示符）', async (t) => {
  const endsWithExactlyOneNewline = (text, label) => {
    assert.ok(text.endsWith('\n'), `${label} 应以换行结尾：${JSON.stringify(text.slice(-50))}`);
    assert.ok(!text.endsWith('\n\n'), `${label} 结尾不应有多余换行`);
  };
  // 用法错误：该命令的 usage 打到 stderr（全局 usage 的未知命令也查一遍）
  const badStatus = await spawnCli(t, ['list', '--status', 'bogus']);
  assert.equal(badStatus.code, 2);
  endsWithExactlyOneNewline(badStatus.stderr, 'list --status bogus 的 stderr');
  const unknownCmd = await spawnCli(t, ['frobnicate']);
  endsWithExactlyOneNewline(unknownCmd.stderr, '未知命令的 stderr');
  // 帮助路径：命令级 --help 与全局 help / --help 打到 stdout
  for (const args of [['add', '--help'], ['help'], ['--help'], []]) {
    const res = await spawnCli(t, args);
    assert.equal(res.code, 0, JSON.stringify(args));
    endsWithExactlyOneNewline(res.stdout, `${JSON.stringify(args)} 的 stdout`);
  }
});

test('COMMANDS 表包含 #5 的全部子命令（供后续 issue 在进程内扩展）', () => {
  for (const name of ['add', 'list', 'show', 'cancel', 'retry', 'config', 'help']) {
    const cmd = COMMANDS[name];
    assert.ok(cmd, name);
    assert.equal(typeof cmd.run, 'function', name);
    assert.ok(typeof cmd.summary === 'string' && cmd.summary.length > 0, name);
    assert.ok(cmd.usage.includes(name), `${name} 的 usage 应包含命令名`);
  }
});

// —— SQLite 实验性警告（#5 产品评论）：只屏蔽 node:sqlite 那一条 ——

// Node 24 上本来就没有这条警告；逐命令确认 stderr 干净。
test('验收: Node 24 下各命令 stderr 没有 SQLite 实验性警告', async (t) => {
  const home = makeTempHome(t);
  await spawnCli(t, ['add', '--repo', 'a/b', '--prompt', 'x'], { cwd: home });
  const readRuns = await Promise.all([
    spawnCli(t, ['list'], { cwd: home }),
    spawnCli(t, ['show', '1'], { cwd: home }),
    spawnCli(t, ['config'], { cwd: home }),
  ]);
  // cancel → retry 有先后依赖，不能和别的写命令并行
  const cancelRes = await spawnCli(t, ['cancel', '1'], { cwd: home });
  const retryRes = await spawnCli(t, ['retry', '1'], { cwd: home });
  for (const res of [...readRuns, cancelRes, retryRes]) {
    assert.equal(res.code, 0, res.stderr);
    assert.ok(!res.stderr.includes('SQLite'), `不应出现 SQLite 警告：${res.stderr}`);
    assert.ok(!res.stderr.includes('ExperimentalWarning'), `不应出现实验性警告：${res.stderr}`);
  }
});

// Node 22 可执行文件：优先用环境变量 NODE22_BIN（CI 或别的机器上的安装路径），否则用本机约定的解压位置。
// 两者都不存在时这两个测试跳过。
const NODE22 = process.env.NODE22_BIN || '/tmp/node-v22.13.0-linux-x64/bin/node';

test('验收: Node 22 只屏蔽 SQLite 警告——add/list 的 stderr 完全干净', { skip: !fs.existsSync(NODE22) && `找不到 Node 22（${NODE22}；可用 NODE22_BIN 指定），跳过` }, async (t) => {
  const home = makeTempHome(t);
  const addRes = await spawnCli(t, ['add', '--repo', 'a/b', '--prompt', '修复登录 bug'], { cwd: home, exec: NODE22 });
  assert.equal(addRes.code, 0, addRes.stderr);
  assert.equal(addRes.stdout, '已加入队列：#1 修复登录 bug\n');
  assert.equal(addRes.stderr, '', `Node 22 下 stderr 应为空：${addRes.stderr}`);
  const listRes = await spawnCli(t, ['list'], { cwd: home, exec: NODE22 });
  assert.equal(listRes.code, 0, listRes.stderr);
  assert.equal(listRes.stderr, '', `Node 22 下 stderr 应为空：${listRes.stderr}`);
});

test('验收: Node 22 下其他警告照常输出（过滤只吞 SQLite 那一条）', { skip: !fs.existsSync(NODE22) && `找不到 Node 22（${NODE22}；可用 NODE22_BIN 指定），跳过` }, () => {
  // 子进程脚本：装过滤 → 动态加载 db.js 并真的打开库（触发 SQLite 警告，应被吞）→
  // 发两条自定义警告（一条同为 ExperimentalWarning），它们必须照常打印。
  const script = `
const { installSqliteWarningFilter } = await import(${JSON.stringify(srcPath('warnings.js'))});
installSqliteWarningFilter();
const { openDb } = await import(${JSON.stringify(srcPath('db.js'))});
const db = openDb(':memory:');
db.exec('CREATE TABLE t (x)');
db.close();
process.emitWarning('自定义实验性警告', 'ExperimentalWarning');
process.emitWarning('自定义废弃警告', 'DeprecationWarning');
`;
  const res = spawn(NODE22, ['--input-type=module', '-e', script], { env: fakeEnv() });
  let stderr = '';
  res.stderr.setEncoding('utf8');
  res.stderr.on('data', (chunk) => { stderr += chunk; });
  return new Promise((resolve, reject) => {
    res.on('error', reject);
    res.on('close', (code) => {
      try {
        assert.equal(code, 0, stderr);
        assert.ok(!stderr.includes('SQLite'), `SQLite 警告应被过滤：${stderr}`);
        assert.ok(stderr.includes('自定义实验性警告'), `其他 ExperimentalWarning 应照常：${stderr}`);
        assert.ok(stderr.includes('自定义废弃警告'), `DeprecationWarning 应照常：${stderr}`);
        resolve();
      } catch (err) {
        reject(err);
      }
    });
  });
});

// —— 以下在进程内测子命令机制（临时注入测试命令，测试结束删掉） ——

function sink() {
  const chunks = [];
  return {
    write(chunk) {
      chunks.push(String(chunk));
      return true;
    },
    text: () => chunks.join(''),
  };
}

function injectCommand(t, name, def) {
  COMMANDS[name] = def;
  t.after(() => { delete COMMANDS[name]; });
}

test('异步子命令 resolve 的数字成为退出码，main 会写 process.exitCode', async (t) => {
  injectCommand(t, '__test_async', {
    summary: '测试用',
    usage: 'night-shift __test_async',
    run: async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return 3;
    },
  });
  const out = sink();
  const err = sink();
  const prevExitCode = process.exitCode;
  const code = await main(['__test_async'], { stdout: out, stderr: err });
  assert.equal(code, 3);
  assert.equal(process.exitCode, 3);
  assert.equal(out.text(), '');
  process.exitCode = prevExitCode; // 恢复，避免污染本测试进程的退出码
});

test('异步子命令抛出的异常走同一条错误映射（退出 1，不打印堆栈）', async (t) => {
  injectCommand(t, '__test_boom', {
    summary: '测试用',
    usage: 'night-shift __test_boom',
    run: async () => {
      throw new Error('异步爆炸');
    },
  });
  const err = sink();
  const code = await runCli(['__test_boom'], { stdout: sink(), stderr: err });
  assert.equal(code, 1);
  assert.ok(err.text().includes('错误：异步爆炸'));
  assert.ok(!err.text().includes('at '), '不应打印堆栈');
});

test('UsageError 带该命令自己的 usage：退出 2，只打印该命令用法', async (t) => {
  const usage = '用法：night-shift __test_usage --repo <owner/name>\n';
  injectCommand(t, '__test_usage', {
    summary: '测试用',
    usage,
    run(_args, ctx) {
      throw new ctx.UsageError('缺少必填参数：--repo', { usage });
    },
  });
  const err = sink();
  const code = await runCli(['__test_usage'], { stdout: sink(), stderr: err });
  assert.equal(code, 2);
  assert.ok(err.text().includes('错误：缺少必填参数：--repo'));
  assert.ok(err.text().includes('__test_usage --repo'));
  assert.ok(!err.text().includes('GLM 夜班'), '不应回退到全局用法');
});

test('命令内 util.parseArgs 的 ERR_PARSE_ARGS_* 映射为该命令的用法错误（退出 2）', async (t) => {
  const usage = '用法：night-shift __test_parse [--title <标题>]\n';
  injectCommand(t, '__test_parse', {
    summary: '测试用',
    usage,
    run(args) {
      parseArgs({ args, options: { title: { type: 'string' } } }); // 未知选项会抛 ERR_PARSE_ARGS_*
      return 0;
    },
  });
  const err = sink();
  const code = await runCli(['__test_parse', '--nope'], { stdout: sink(), stderr: err });
  assert.equal(code, 2);
  assert.ok(err.text().includes('--nope'));
  assert.ok(err.text().includes('__test_parse'));
});
