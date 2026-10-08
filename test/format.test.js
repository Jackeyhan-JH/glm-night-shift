// src/format.js 与 src/cli/render.js 的纯函数单测：显示宽度、按宽度对齐/截断、
// 本地时间、耗时，以及 list 表格 / show 详情的拼装（重点：中文按显示列对齐）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  displayWidth,
  formatDurationMs,
  formatLocalMinute,
  padEndDisplay,
  truncateDisplay,
} from '../src/format.js';
import { TITLE_MAX_COLUMNS, renderTaskDetail, renderTasksTable } from '../src/cli/render.js';

test('displayWidth：ASCII 1 列，CJK/全角/emoji 2 列，组合附标与零宽 0 列', () => {
  assert.equal(displayWidth('abc'), 3);
  assert.equal(displayWidth(''), 0);
  assert.equal(displayWidth('修复登录'), 8);
  assert.equal(displayWidth('修复bug'), 7); // 4 列 + 3 列
  assert.equal(displayWidth('ｆｕｌｌ'), 8); // 全角字母
  assert.equal(displayWidth('　'), 2); // 全角空格 U+3000
  assert.equal(displayWidth('áb'), 2); // 组合附标不占列
  assert.equal(displayWidth('a​b'), 2); // 零宽空格
  assert.equal(displayWidth('😀'), 2); // 常用 emoji
});

test('truncateDisplay：宽度内原样；超宽按码点截断加 …，结果 ≤ 上限', () => {
  assert.equal(truncateDisplay('short', 10), 'short');
  assert.equal(truncateDisplay('', 10), '');
  assert.equal(truncateDisplay('修复登录bug', 10), '修复登录b…'); // 8 列后只剩 1 列给 b
  assert.equal(displayWidth(truncateDisplay('修复登录bug', 10)), 10);
  const long = 'a'.repeat(60);
  assert.equal(truncateDisplay(long, 40), `${'a'.repeat(39)}…`);
  // 全中文：截断点不会把宽字符「切半」，落点可以是奇数列
  const cjkLong = '汉'.repeat(45); // 90 列
  const cut = truncateDisplay(cjkLong, TITLE_MAX_COLUMNS);
  assert.equal(cut, `${'汉'.repeat(19)}…`); // 19 × 2 = 38 列 + 1 列省略号
  assert.ok(displayWidth(cut) <= TITLE_MAX_COLUMNS);
});

test('padEndDisplay：按显示宽度补空格；超宽原样返回', () => {
  assert.equal(padEndDisplay('修复', 6), '修复  ');
  assert.equal(padEndDisplay('abc', 3), 'abc');
  assert.equal(padEndDisplay('abc', 5), 'abc  ');
  assert.equal(padEndDisplay('超宽了', 2), '超宽了');
});

test('formatDurationMs：毫秒/秒/分/小时逐级，null 表示不可知', () => {
  assert.equal(formatDurationMs(null), '-');
  assert.equal(formatDurationMs(undefined), '-');
  assert.equal(formatDurationMs(250), '250毫秒');
  assert.equal(formatDurationMs(999), '999毫秒');
  assert.equal(formatDurationMs(1000), '1秒');
  assert.equal(formatDurationMs(59400), '59.4秒');
  assert.equal(formatDurationMs(60000), '1分');
  assert.equal(formatDurationMs(62000), '1分2秒');
  assert.equal(formatDurationMs(3661000), '1小时1分');
});

test('formatLocalMinute：本地时区、到分钟（用本地构造再转 ISO，来回不受进程 TZ 影响）', () => {
  const local = new Date(2026, 9, 8, 15, 4, 5, 678); // 本地 2026-10-08 15:04:05.678
  assert.equal(formatLocalMinute(local.toISOString()), '2026-10-08 15:04');
});

test('formatLocalMinute：跟随进程 TZ（子进程固定 TZ 验证换算）', () => {
  const script = `
const { formatLocalMinute } = await import(${JSON.stringify(
  pathToFileURL(path.resolve(dirname(), '../src/format.js')).href,
)});
process.stdout.write(formatLocalMinute('2026-10-08T07:30:00.000Z'));
`;
  function withTZ(tz) {
    const res = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf8',
      env: { ...process.env, TZ: tz },
    });
    assert.equal(res.status, 0, res.stderr);
    return res.stdout;
  }
  assert.equal(withTZ('UTC'), '2026-10-08 07:30');
  assert.equal(withTZ('Asia/Shanghai'), '2026-10-08 15:30');
  assert.equal(withTZ('Pacific/Kiritimati'), '2026-10-08 21:30'); // UTC+14，跨日界线
});

// 本地 2026-10-08 15:30 创建的任务 → formatLocalMinute 回到同一墙钟时间，断言可写死。
const CREATED_AT = new Date(2026, 9, 8, 15, 30, 0).toISOString();

function taskFixture(overrides = {}) {
  return {
    id: 1,
    repo: 'a/b',
    title: '标题',
    prompt: '提示词',
    difficulty: 'medium',
    priority: 0,
    testCommand: null,
    allowPeak: false,
    status: 'queued',
    attempts: 0,
    maxAttempts: 2,
    branch: null,
    prUrl: null,
    lastError: null,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    startedAt: null,
    finishedAt: null,
    ...overrides,
  };
}

test('renderTasksTable：表头齐全，中文标题与 ASCII 标题的时间列起点相同（按显示列对齐）', () => {
  const ascii = taskFixture({ id: 1, title: 'abcdefgh' }); // 8 列
  const cjk = taskFixture({ id: 2, title: '修复登录' }); // 同为 8 显示列、只有 4 个字符
  const out = renderTasksTable([ascii, cjk]);
  const lines = out.trimEnd().split('\n');
  assert.equal(lines.length, 3);
  for (const h of ['ID', '状态', '难度', '优先级', '仓库', '标题', '创建时间']) {
    assert.ok(lines[0].includes(h), `表头缺 ${h}`);
  }
  // 若按 .length 补空格，「修复登录」行会少补 4 格导致错位——这里抓这种回归。
  // 注意要比较「显示列」起点：中文字符数 ≠ 列数，直接比 indexOf 会误报。
  const timeStart = (line) => displayWidth(line.slice(0, line.indexOf('2026-10-08 15:30')));
  assert.equal(timeStart(lines[1]), timeStart(lines[2]), '两行数据的时间列必须对齐');
  assert.ok(timeStart(lines[1]) > 0);
  assert.ok(out.endsWith('\n'));
});

test('renderTasksTable：超长标题截断加 …，截断后仍与短标题行对齐', () => {
  const short = taskFixture({ id: 1, title: 'short' });
  const longTitle = '很长的中文标题'.repeat(12); // 144 列
  const long = taskFixture({ id: 2, title: longTitle });
  const lines = renderTasksTable([short, long]).trimEnd().split('\n');
  const expectedTitle = truncateDisplay(longTitle, TITLE_MAX_COLUMNS);
  assert.ok(lines[2].includes('…'));
  assert.ok(lines[2].includes(expectedTitle), '表格里应是截断后的标题');
  assert.ok(displayWidth(expectedTitle) <= TITLE_MAX_COLUMNS);
  const timeStart = (line) => displayWidth(line.slice(0, line.indexOf('2026-10-08 15:30')));
  assert.equal(timeStart(lines[1]), timeStart(lines[2]));
});

test('renderTaskDetail：字段列表、提示词缩进、运行记录表（尝试/模型/状态/耗时/额度/日志）', () => {
  const task = taskFixture({
    id: 7,
    title: '修复登录',
    status: 'failed',
    difficulty: 'hard',
    priority: -3,
    testCommand: 'npm test',
    allowPeak: true,
    attempts: 1,
    lastError: 'claude 退出码 1',
    startedAt: CREATED_AT,
  });
  const runs = [
    {
      id: 1,
      taskId: 7,
      attempt: 1,
      model: 'glm-5.3',
      effort: 'high',
      peak: false,
      status: 'failed',
      exitCode: 1,
      numTurns: 4,
      prompts: 3,
      quotaUnits: 3,
      logPath: '/tmp/logs/task-7-run-1.log',
      startedAt: CREATED_AT,
      finishedAt: CREATED_AT,
      durationMs: 62000,
      error: 'claude 退出码 1',
    },
    {
      id: 2,
      taskId: 7,
      attempt: 2,
      model: 'glm-5.3-flash',
      effort: 'low',
      peak: true,
      status: 'running',
      exitCode: null,
      numTurns: null,
      prompts: 1,
      quotaUnits: null,
      logPath: '/tmp/logs/task-7-run-2.log',
      startedAt: CREATED_AT,
      finishedAt: null,
      durationMs: null,
      error: null,
    },
  ];
  const out = renderTaskDetail(task, runs);
  assert.ok(out.startsWith('任务 #7：修复登录\n'));
  for (const line of [
    '状态      failed',
    '难度      hard',
    '优先级    -3',
    '仓库      a/b',
    '允许高峰  是',
    '尝试次数  1/2',
    '测试命令  npm test',
    '最近错误  claude 退出码 1',
    '开始时间  2026-10-08 15:30',
  ]) {
    assert.ok(out.includes(line), `应包含「${line}」`);
  }
  assert.ok(out.includes('提示词：\n  提示词'));
  assert.ok(out.includes('运行记录（2 条）：'));
  assert.ok(out.includes('尝试次数'));
  assert.ok(out.includes('glm-5.3-flash'));
  assert.ok(out.includes('1分2秒')); // durationMs 62000
  assert.ok(out.includes('-')); // 进行中的 run：耗时/额度为 -
  assert.ok(out.includes('/tmp/logs/task-7-run-2.log'));
});

test('renderTaskDetail：没有运行记录时明确说无', () => {
  const out = renderTaskDetail(taskFixture(), []);
  assert.ok(out.includes('运行记录：无'));
  assert.ok(!out.includes('尝试次数  模型'));
});

function dirname() {
  return path.dirname(fileURLToPath(import.meta.url));
}
