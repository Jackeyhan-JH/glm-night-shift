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

// 作为独立进程跑 bin（端到端）；进程内直接调用 bin 的 runCli/main 见文件后半部分。
// 默认把 NIGHT_SHIFT_HOME 指到临时目录、TZ 固定 UTC（时间输出可断言）；
// exec 可换成别的 node（Node 22.13 的警告测试）。
function spawnCli(t, args, { cwd, env: envOverrides = {}, exec = process.execPath } = {}) {
  const dir = cwd ?? makeTempHome(t);
  return new Promise((resolve, reject) => {
    const child = spawn(exec, [binPath, ...args], {
      cwd: dir,
      env: fakeEnv({ NIGHT_SHIFT_HOME: dir, TZ: 'UTC', ...envOverrides }),
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

test('config.json 不合法：退出 1，stderr 带文件路径', async (t) => {
  const home = makeTempHome(t);
  fs.writeFileSync(path.join(home, 'config.json'), '{oops');
  const res = await spawnCli(t, ['config'], { cwd: home });
  assert.equal(res.code, 1);
  assert.ok(res.stderr.includes(path.join(home, 'config.json')), res.stderr);
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
  assert.ok(res.stdout.includes('glm-5.3'));
  assert.ok(res.stdout.includes('succeeded'));
  assert.ok(res.stdout.includes('/tmp/logs/task-1-run-1.log'));

  const json = await spawnCli(t, ['show', '1', '--json'], { cwd: home });
  const parsed = JSON.parse(json.stdout);
  assert.equal(parsed.runs.length, 1);
  assert.equal(parsed.runs[0].model, 'glm-5.3');
  assert.equal(parsed.runs[0].quotaUnits, 2);
  assert.equal(parsed.runs[0].numTurns, 3);
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

test('help 列出全部子命令与关键选项', async (t) => {
  const res = await spawnCli(t, ['--help']);
  assert.equal(res.code, 0);
  for (const name of ['add', 'list', 'show', 'cancel', 'retry', 'config', 'help']) {
    assert.ok(res.stdout.includes(name), `帮助应提到 ${name}`);
  }
  for (const opt of ['--repo', '--prompt-file', '--difficulty', '--max-attempts', '--status', '--json']) {
    assert.ok(res.stdout.includes(opt), `帮助应提到 ${opt}`);
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

const NODE22 = '/tmp/node-v22.13.0-linux-x64/bin/node';

test('Node 22：add/list 的 stderr 完全干净（SQLite 警告被过滤）', { skip: !fs.existsSync(NODE22) && '本机没有 Node 22.13，跳过' }, async (t) => {
  const home = makeTempHome(t);
  const addRes = await spawnCli(t, ['add', '--repo', 'a/b', '--prompt', '修复登录 bug'], { cwd: home, exec: NODE22 });
  assert.equal(addRes.code, 0, addRes.stderr);
  assert.equal(addRes.stdout, '已加入队列：#1 修复登录 bug\n');
  assert.equal(addRes.stderr, '', `Node 22 下 stderr 应为空：${addRes.stderr}`);
  const listRes = await spawnCli(t, ['list'], { cwd: home, exec: NODE22 });
  assert.equal(listRes.code, 0, listRes.stderr);
  assert.equal(listRes.stderr, '', `Node 22 下 stderr 应为空：${listRes.stderr}`);
});

test('Node 22：过滤只吞 SQLite 那条，其他警告照常输出', { skip: !fs.existsSync(NODE22) && '本机没有 Node 22.13，跳过' }, () => {
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
