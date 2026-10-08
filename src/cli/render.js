// list / show 的人类可读输出：对齐表格与字段列表。列宽按「显示宽度」算（中文两列，
// 见 src/format.js），时间转本地时区到分钟，标题/仓库超宽截断。纯拼装，不含命令逻辑；
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
/** list 仓库列的最大显示列数（owner/name 可以很长；完整值看 show）。 */
export const REPO_MAX_COLUMNS = 40;

/**
 * 控制字符（换行、制表、退格、ANSI 转义……C0/C1 全部，即 Unicode Cc 类）换成一个
 * 空格：单元格里只要混进这些，表格行就会断开、错位或在终端上乱写，一概压平成一行。
 */
function singleLine(text) {
  return String(text).replace(/\p{Cc}/gu, ' ');
}

/**
 * 提示词展示前的清理：CR / CRLF 归一成 LF（多行结构保留、逐行缩进），其余控制字符
 * （含 ANSI 转义）换成空格——既保住多行提示词的可读性，又不让控制字符乱写终端。
 */
function cleanPrompt(text) {
  return String(text)
    .replace(/\r\n?/g, '\n')
    .replace(/\p{Cc}/gu, (ch) => (ch === '\n' ? ch : ' '));
}

/**
 * list 的对齐表格：表头「ID 状态 难度 优先级 仓库 标题 创建时间」，
 * 每列宽取该列（含表头）的最大显示宽度，列间两个空格，行尾不去补空格。
 * 等依赖的排队任务状态显示为 `queued（等 #1）`（多个：`等 #1,#2`）——状态列随之
 * 变宽，同表其余行按显示宽度自动对齐。
 */
export function renderTasksTable(tasks) {
  const header = ['ID', '状态', '难度', '优先级', '仓库', '标题', '创建时间'];
  const rows = tasks.map((t) => [
    String(t.id),
    statusCell(t),
    t.difficulty,
    String(t.priority),
    truncateDisplay(singleLine(t.repo), REPO_MAX_COLUMNS),
    truncateDisplay(singleLine(t.title), TITLE_MAX_COLUMNS),
    formatLocalMinute(t.createdAt),
  ]);
  return `${renderTable(header, rows)}\n`;
}

/** 状态列：queued 且有未满足依赖时标注在等谁（blockedBy 升序 id）。 */
function statusCell(task) {
  if (task.status === 'queued' && task.blockedBy?.length > 0) {
    return `queued（等 #${task.blockedBy.join(',#')}）`;
  }
  return task.status;
}

/** 依赖清单展示串：`#1 succeeded，#2 queued`；没有依赖是「无」（issue #11 规格文案）。 */
function depsLine(deps) {
  return `依赖：${deps.length === 0 ? '无' : deps.map((d) => `#${d.id} ${d.status}`).join('，')}`;
}

/**
 * show 的任务详情：标题行 + 对齐的字段列表 + 依赖行 + 缩进的提示词 + 运行记录表格
 * （列：尝试次数、类型、模型、状态、耗时、额度、日志路径）。没有运行记录时明确说无。
 * 带诊断（#12）的运行在表格后逐行列出诊断第一行（诊断是多行文本，塞进表格会撑破列宽）。
 * deps 是 listDependencies() 的结果（[{id, status}]，升序）；缺省视为无依赖。
 */
export function renderTaskDetail(task, runs, deps = []) {
  const fields = [
    ['状态', task.status],
    ['难度', task.difficulty],
    ['优先级', String(task.priority)],
    ['仓库', task.repo],
  ];
  // 来源（#39 import 的 github:<repo>#<编号>）：只有非空才加这行，手工 add 的任务
  // 输出保持原样（不出现「来源（无）」之类的空行）。
  if (task.source) fields.push(['来源', task.source]);
  fields.push(
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
  );
  const labelWidth = Math.max(...fields.map(([label]) => displayWidth(label)));
  const lines = [
    `任务 #${task.id}：${singleLine(task.title)}`,
    ...fields.map(([label, value]) => `${padEndDisplay(label, labelWidth)}  ${value}`),
    depsLine(deps),
    '',
    '提示词：',
    ...cleanPrompt(task.prompt).split('\n').map((line) => `  ${line}`),
  ];
  if (runs.length === 0) {
    lines.push('', '运行记录：无');
  } else {
    const header = ['尝试次数', '类型', '模型', '状态', '耗时', '额度', '日志路径'];
    const rows = runs.map((r) => [
      String(r.attempt),
      r.kind ?? 'task',
      r.model,
      r.status,
      formatDurationMs(r.durationMs),
      r.quotaUnits === null || r.quotaUnits === undefined ? '-' : String(r.quotaUnits),
      r.logPath,
    ]);
    lines.push('', `运行记录（${runs.length} 条）：`, ...renderTable(header, rows, '  ').split('\n'));
    // 诊断第一行（#12）：标注在哪条运行上；多行诊断的其余行看 show --json 的 diagnosis 字段
    for (const r of runs) {
      if (r.diagnosis !== null && r.diagnosis !== undefined && r.diagnosis !== '') {
        lines.push(`诊断（run ${r.id}）：${singleLine(firstLine(r.diagnosis))}`);
      }
    }
  }
  return `${lines.join('\n')}\n`;
}

/** 多行文本的第一行（\r\n / \r 也归一按换行切）；没有内容返回 ''。 */
function firstLine(text) {
  const normalized = String(text).replace(/\r\n?/g, '\n');
  const nl = normalized.indexOf('\n');
  return nl === -1 ? normalized : normalized.slice(0, nl);
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
