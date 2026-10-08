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
 * 等依赖的排队任务状态显示为 `queued（等 #1）`（多个：`等 #1,#2`）；succeeded 且
 * PR 已有结论时标 `succeeded（已合并）` / `succeeded（已关闭）`——状态列随之变宽，
 * 同表其余行按显示宽度自动对齐。waitingIds（#85，Set<number>，由 task-commands.js
 * 算好传入，不从任务对象上读）是「在等这个仓库」的排队任务 id 集合：命中的排队
 * 任务在状态里接「，等这个仓库」或整格标 `queued（等这个仓库）`；缺省不标，
 * 输出与从前逐字相同（format.test.js 不传第二参）。
 */
export function renderTasksTable(tasks, { waitingIds } = {}) {
  const header = ['ID', '状态', '难度', '优先级', '仓库', '标题', '创建时间'];
  const rows = tasks.map((t) => [
    String(t.id),
    statusCell(t, waitingIds),
    t.difficulty,
    String(t.priority),
    truncateDisplay(singleLine(t.repo), REPO_MAX_COLUMNS),
    truncateDisplay(singleLine(t.title), TITLE_MAX_COLUMNS),
    formatLocalMinute(t.createdAt),
  ]);
  return `${renderTable(header, rows)}\n`;
}

/**
 * 状态列：queued 且有未满足依赖时标注在等谁（blockedBy 升序 id）——先判这条，
 * 排队等依赖的任务永远不吃下面的 PR 结果标注（还没跑到开 PR 那步）。
 * #85：queued 且 id 在 waitingIds 里（oneTaskPerRepo 开着、同仓库另有 running）时
 * 接「，等这个仓库」（全角逗号），没有依赖则整格 `queued（等这个仓库）`；status
 * 不是 queued 的任务即使 id 误在集合里也不标。succeeded 且 PR 已有结论（#75）时
 * 在状态后注明：merged →「（已合并）」、closed →「（已关闭）」；open / 空 /
 * 其他值不加字，仍是光秃秃的 succeeded。
 */
function statusCell(task, waitingIds) {
  if (task.status === 'queued') {
    const waitingRepo = waitingIds?.has(task.id) === true;
    if (task.blockedBy?.length > 0) {
      return `queued（等 #${task.blockedBy.join(',#')}${waitingRepo ? '，等这个仓库' : ''}）`;
    }
    if (waitingRepo) return 'queued（等这个仓库）';
  }
  if (task.status === 'succeeded') {
    if (task.prOutcome === 'merged') return 'succeeded（已合并）';
    if (task.prOutcome === 'closed') return 'succeeded（已关闭）';
  }
  return task.status;
}

/** 依赖清单展示串：`#1 succeeded，#2 queued`；没有依赖是「无」（issue #11 规格文案）。 */
function depsLine(deps) {
  return `依赖：${deps.length === 0 ? '无' : deps.map((d) => `#${d.id} ${d.status}`).join('，')}`;
}

/**
 * show 的任务详情：标题行 + 对齐的字段列表 + 依赖行 + 缩进的提示词 + 运行记录表格
 * （列：尝试次数、类型、模型、思考强度、高峰、状态、开始时间、耗时、额度、轮数、错误、
 * 日志路径）。没有运行记录时明确说无。
 * 带诊断（#12）的运行在表格后逐行列出诊断第一行（诊断是多行文本，塞进表格会撑破列宽）。
 * deps 是 listDependencies() 的结果（[{id, status}]，升序）；缺省视为无依赖。
 * waitingSameRepo（#85，task-commands.js 判好传入）：true 且任务仍是 queued 时，
 * 「状态」格写成 `queued（等这个仓库）`（等谁不塞进来，依赖仍是单独一行）；缺省
 * false，输出与从前逐字相同。
 */
export function renderTaskDetail(task, runs, deps = [], { waitingSameRepo = false } = {}) {
  const fields = [
    ['状态', waitingSameRepo === true && task.status === 'queued'
      ? 'queued（等这个仓库）'
      : task.status],
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
  );
  // #75：PR 之后按「有值才出」补三行，顺序固定。空值整行不出现（不写「（无）」、
  // 也不留空行）；gitRef / notBefore 只判 null / undefined / ''（不 trim，值原样输出），
  // prOutcome 全等 merged / closed 才出——open 等其他值（PR 还开着或结论未知）不出。
  if (filled(task.gitRef)) fields.push(['指定分支', task.gitRef]);
  if (task.prOutcome === 'merged' || task.prOutcome === 'closed') {
    fields.push(['PR 结果', task.prOutcome === 'merged' ? '已合并' : '已关闭']);
  }
  if (filled(task.notBefore)) fields.push(['暂不开始', formatLocalMinute(task.notBefore)]);
  fields.push(
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
    const header = ['尝试次数', '类型', '模型', '思考强度', '高峰', '状态', '开始时间', '耗时', '额度', '轮数', '错误', '日志路径'];
    const rows = runs.map((r) => [
      String(r.attempt),
      r.kind ?? 'task',
      r.model,
      // #104 思考强度：缺值留空列（不写 null / -），有值原样（high 不翻译）
      filled(r.effort) ? String(r.effort) : '',
      r.peak ? '是' : '否',
      r.status,
      // #104 开始时间：缺值或非法时间给 -，合法 ISO 才转本地分钟（与详情页同规则）
      filled(r.startedAt) && !Number.isNaN(new Date(r.startedAt).getTime())
        ? formatLocalMinute(r.startedAt)
        : '-',
      formatDurationMs(r.durationMs),
      r.quotaUnits === null || r.quotaUnits === undefined ? '-' : String(r.quotaUnits),
      r.numTurns === null || r.numTurns === undefined ? '-' : String(r.numTurns),
      // #104 错误只出第一行（不 trim、不截断），再压平控制字符防撑破表格；诊断另有专行
      filled(r.error) ? singleLine(String(r.error).split('\n')[0]) : '',
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

/** 字段行「有值才出」的判空：null / undefined / '' 都算没有（值原样输出，不 trim）。 */
function filled(value) {
  return value !== null && value !== undefined && value !== '';
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
