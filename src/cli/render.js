// list / show 的人类可读输出：对齐表格与字段列表。列宽按「显示宽度」算（中文两列，
// 见 src/format.js），时间转本地时区到分钟，标题超宽截断。纯拼装，不含命令逻辑；
// 单测（含对齐断言）见 test/format.test.js。
import {
  displayWidth,
  formatDurationMs,
  formatLocalMinute,
  padEndDisplay,
  truncateDisplay,
} from '../format.js';

/** list 标题列的最大显示列数，超过则截断加 …。 */
export const TITLE_MAX_COLUMNS = 40;

/** 换行/制表符换成空格，避免用户输入破坏表格对齐。 */
function singleLine(text) {
  return String(text).replace(/[\r\n\t]/g, ' ');
}

/**
 * list 的对齐表格：表头「ID 状态 难度 优先级 仓库 标题 创建时间」，
 * 每列宽取该列（含表头）的最大显示宽度，列间两个空格，行尾不去补空格。
 */
export function renderTasksTable(tasks) {
  const header = ['ID', '状态', '难度', '优先级', '仓库', '标题', '创建时间'];
  const rows = tasks.map((t) => [
    String(t.id),
    t.status,
    t.difficulty,
    String(t.priority),
    t.repo,
    truncateDisplay(singleLine(t.title), TITLE_MAX_COLUMNS),
    formatLocalMinute(t.createdAt),
  ]);
  return `${renderTable(header, rows)}\n`;
}

/**
 * show 的任务详情：标题行 + 对齐的字段列表 + 缩进的提示词 + 运行记录表格
 * （列：尝试次数、模型、状态、耗时、额度、日志路径）。没有运行记录时明确说无。
 */
export function renderTaskDetail(task, runs) {
  const fields = [
    ['状态', task.status],
    ['难度', task.difficulty],
    ['优先级', String(task.priority)],
    ['仓库', task.repo],
    ['允许高峰', task.allowPeak ? '是' : '否'],
    ['尝试次数', `${task.attempts}/${task.maxAttempts}`],
    ['测试命令', task.testCommand ?? '（未设置）'],
    ['分支', task.branch ?? '（无）'],
    ['PR', task.prUrl ?? '（无）'],
    ['最近错误', task.lastError ?? '（无）'],
    ['创建时间', formatLocalMinute(task.createdAt)],
    ['更新时间', formatLocalMinute(task.updatedAt)],
    ['开始时间', task.startedAt ? formatLocalMinute(task.startedAt) : '（未开始）'],
    ['完成时间', task.finishedAt ? formatLocalMinute(task.finishedAt) : '（未完成）'],
  ];
  const labelWidth = Math.max(...fields.map(([label]) => displayWidth(label)));
  const lines = [
    `任务 #${task.id}：${singleLine(task.title)}`,
    ...fields.map(([label, value]) => `${padEndDisplay(label, labelWidth)}  ${value}`),
    '',
    '提示词：',
    ...String(task.prompt).split('\n').map((line) => `  ${line}`),
  ];
  if (runs.length === 0) {
    lines.push('', '运行记录：无');
  } else {
    const header = ['尝试次数', '模型', '状态', '耗时', '额度', '日志路径'];
    const rows = runs.map((r) => [
      String(r.attempt),
      r.model,
      r.status,
      formatDurationMs(r.durationMs),
      r.quotaUnits === null || r.quotaUnits === undefined ? '-' : String(r.quotaUnits),
      r.logPath,
    ]);
    lines.push('', `运行记录（${runs.length} 条）：`, ...renderTable(header, rows, '  ').split('\n'));
  }
  return `${lines.join('\n')}\n`;
}

/** 通用小表格：首行表头，列间两空格，按显示宽度对齐；indent 是每行前缀。 */
function renderTable(header, rows, indent = '') {
  const widths = header.map(
    (_, i) => Math.max(displayWidth(header[i]), ...rows.map((row) => displayWidth(row[i]))),
  );
  const line = (cells) =>
    indent + cells.map((cell, i) => padEndDisplay(cell, widths[i])).join('  ').trimEnd();
  return [line(header), ...rows.map(line)].join('\n');
}
