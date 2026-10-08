// 队列页的纯函数库（issue #15）：按状态分组、依赖提示文本、状态条文案、表单数据 →
// POST /api/tasks 请求体、HTML 转义、lastError 第一行；#46 增加编辑排队中任务的
// 纯函数（行操作按钮、表单模式视图、任务 → 表单值、表单 → PATCH 请求体）；#50 增加
// 仓库筛选与「从 GitHub 导入 / 清理磁盘」两个面板的纯函数（选项、过滤、请求体、结果
// 文案）；#62 增加队列行的 PR 结果标签（已合并 / 已关闭）判定。全部是无副作用纯函数——
// 不碰 DOM、不发请求，import 时不依赖浏览器环境，
// node:test 直接单测（见 test/web-queue-lib.test.js / test/web-queue-edit.test.js /
// test/board-import.test.js）；DOM 与网络逻辑在 queue.js。

/** 历史标签最多展示的条数（issue 规格：最近 100 条）。 */
export const HISTORY_LIMIT = 100;

/** 历史标签收集的任务状态（终态）。 */
const HISTORY_STATUSES = ['succeeded', 'failed', 'canceled'];

/** 文本 → 可安全放进 HTML 文本 / 属性值的字符串：& < > " ' 全部转成实体。 */
export function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** 时间比较（升序）：API 返回的 UTC ISO 字符串字典序即时间序；null/undefined 排最前。 */
function compareAsc(a, b) {
  const x = a ?? '';
  const y = b ?? '';
  return x < y ? -1 : x > y ? 1 : 0;
}

/** 时间比较（降序）：compareAsc 取反。 */
function compareDesc(a, b) {
  return -compareAsc(a, b);
}

/**
 * 把任务列表按状态分成三个标签的数组（filter 出新数组再排，不改入参）：
 * - queued：领取顺序——priority DESC → createdAt ASC → id ASC，与 claimNextTask
 *   的领取规则一致（排前面的先被领走）；
 * - running：最近开始的在前（startedAt ?? createdAt DESC → id DESC）；
 * - history：succeeded / failed / canceled，最近完成的在前（finishedAt ?? createdAt
 *   DESC → id DESC），最多 HISTORY_LIMIT 条。
 * @param {Array<object>} tasks GET /api/tasks 的返回（TaskRow 列表）
 * @returns {{ queued: object[], running: object[], history: object[] }}
 */
export function groupTasks(tasks) {
  const list = Array.isArray(tasks) ? tasks : [];
  const queued = list
    .filter((t) => t.status === 'queued')
    .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0)
      || compareAsc(a.createdAt, b.createdAt)
      || (a.id ?? 0) - (b.id ?? 0));
  const running = list
    .filter((t) => t.status === 'running')
    .sort((a, b) => compareDesc(a.startedAt ?? a.createdAt, b.startedAt ?? b.createdAt)
      || compareDesc(a.id, b.id));
  const history = list
    .filter((t) => HISTORY_STATUSES.includes(t.status))
    .sort((a, b) => compareDesc(a.finishedAt ?? a.createdAt, b.finishedAt ?? b.createdAt)
      || compareDesc(a.id, b.id))
    .slice(0, HISTORY_LIMIT);
  return { queued, running, history };
}

/**
 * 依赖提示文本（排队中的任务行展示）：blockedBy（还没 succeeded 的依赖 id，API 升序
 * 返回）→ 「等 #1 #2」；空数组 / 非数组 → ''（不展示）。
 * @param {number[]} [blockedBy]
 * @returns {string}
 */
export function depHint(blockedBy) {
  if (!Array.isArray(blockedBy) || blockedBy.length === 0) return '';
  return `等 ${blockedBy.map((id) => `#${id}`).join(' ')}`;
}

/** 多行文本的第一行（历史里失败任务展示 lastError 第一行，悬停看全文）；空值 → ''。 */
export function firstLine(text) {
  if (typeof text !== 'string' || text === '') return '';
  return text.split(/\r?\n/, 1)[0] ?? '';
}

/**
 * /api/status → 状态条的一行文案：
 * 「非高峰时段 · 5 小时额度 1.0%（16/1600） · 运行中 2 个」。
 * 数据残缺（null / 缺字段 / limit 非正数）时对应部分退化为「-」，不抛错。
 * @param {object} [status] GET /api/status 的返回
 * @returns {string}
 */
export function statusBarText(status) {
  if (status === null || typeof status !== 'object') return '';
  const parts = [status.peak?.peak === true ? '高峰时段' : '非高峰时段'];
  const five = status.usage?.fiveHour;
  if (five !== null && typeof five === 'object'
      && typeof five.used === 'number' && Number.isFinite(five.used)
      && typeof five.limit === 'number' && five.limit > 0) {
    const pct = ((five.used / five.limit) * 100).toFixed(1);
    parts.push(`5 小时额度 ${pct}%（${five.used}/${five.limit}）`);
  } else {
    parts.push('5 小时额度 -');
  }
  const running = typeof status.runningCount === 'number' ? status.runningCount : 0;
  parts.push(`运行中 ${running} 个`);
  return parts.join(' · ');
}

/**
 * 手动暂停的展示视图（issue #38）：读 /api/status 顶层的 userPaused。
 * - 暂停中：按钮文案「恢复领任务」（点了去恢复），状态条追加一段「已暂停领取」
 *   （与按钮分开，不点按钮也能看见现在没在领）；
 * - 未暂停：按钮文案「暂停领任务」，不追加任何段（页面不该出现「已暂停领取」）。
 * status 残缺（null / 缺字段）按未暂停处理，不抛错。
 * @param {object} [status] GET /api/status 的返回
 * @returns {{ paused: boolean, buttonLabel: '恢复领任务'|'暂停领任务', pausedText: '已暂停领取'|'' }}
 */
export function pauseToggleView(status) {
  const paused = status !== null && typeof status === 'object' && status.userPaused === true;
  return {
    paused,
    buttonLabel: paused ? '恢复领任务' : '暂停领任务',
    pausedText: paused ? '已暂停领取' : '',
  };
}

/** 数字输入（字符串）→ 安全整数；空 / 非整数 → null（该字段不进请求体）。 */
function toSafeInt(value) {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const n = Number(String(value).trim());
  return Number.isSafeInteger(n) ? n : null;
}

/**
 * 新增任务表单的数据 → POST /api/tasks 的请求体（字段约定见 src/server.js）：
 * - 文本一律 trim，空的可选字段不进请求体（交给服务端默认值）；
 * - 选了模板：发 template + vars（值为空的变量不发：可选变量与「不填」等价，必填变量
 *   为空会被服务端 400 field=vars 点名，表单里也先用 required 拦一道）；不发 prompt；
 * - 没选模板：发 prompt（多行框内容，保留中间换行）；
 * - allowPeak 复选框恒为布尔值（总是发）；
 * - priority / maxAttempts 解析成整数，解析不出 / maxAttempts < 1 就不发；
 * - dependsOn 多选的字符串 id 转成数字并去无效项；为空就不发。
 * @param {object} form 表单原始数据（queue.js 从 DOM 收集；值多为字符串）
 * @returns {object} 请求体
 */
export function formToBody(form) {
  const body = { repo: String(form.repo ?? '').trim() };
  const template = String(form.template ?? '').trim();
  if (template !== '') {
    body.template = template;
    const vars = {};
    for (const [name, value] of Object.entries(form.vars ?? {})) {
      const text = String(value ?? '').trim();
      if (text !== '') vars[name] = text;
    }
    body.vars = vars;
  } else {
    body.prompt = String(form.prompt ?? '').trim();
  }
  const title = String(form.title ?? '').trim();
  if (title !== '') body.title = title;
  const difficulty = String(form.difficulty ?? '').trim();
  if (difficulty !== '') body.difficulty = difficulty;
  const priority = toSafeInt(form.priority);
  if (priority !== null) body.priority = priority;
  const testCommand = String(form.testCommand ?? '').trim();
  if (testCommand !== '') body.testCommand = testCommand;
  body.allowPeak = form.allowPeak === true;
  const maxAttempts = toSafeInt(form.maxAttempts);
  if (maxAttempts !== null && maxAttempts >= 1) body.maxAttempts = maxAttempts;
  const dependsOn = (Array.isArray(form.dependsOn) ? form.dependsOn : [])
    .map((id) => Number(id))
    .filter((id) => Number.isSafeInteger(id) && id >= 1);
  if (dependsOn.length > 0) body.dependsOn = dependsOn;
  return body;
}

// ---------------------------------------------------------------- 编辑排队中的任务（#46）

/**
 * 任务行的操作单元格 HTML：排队中 = 「取消」+「修改」（修改走现有新增表单，见
 * queue.js 的 enterEdit）；运行中只能取消（改不了的，要改先等它跑完或取消）；历史
 * （终态）是「重试」。按钮由 queue.js 的事件委托统一处理（表格每 5 秒重绘）。
 * @param {object} task TaskRow（用到 id / status）
 * @returns {string} HTML 片段
 */
export function taskRowActions(task) {
  const button = (action, label) =>
    `<button type="button" class="row-action" data-action="${action}" data-id="${task.id}">${label}</button>`;
  if (task.status === 'queued') return `${button('cancel', '取消')}${button('edit', '修改')}`;
  if (task.status === 'running') return button('cancel', '取消');
  return button('retry', '重试');
}

/**
 * 表单的模式视图（#46）：编辑哪个任务，还是「新增」。
 * - 编辑：标题「修改任务 #N」、提交按钮「保存修改」、「取消编辑」按钮可见；
 * - 新增（editingTask 为 null/undefined）：标题与按钮都是「新增任务」。
 * @param {?object} editingTask 正在编辑的任务（至少有 id）；null = 新增模式
 * @returns {{ editing: boolean, heading: string, submitLabel: string, cancelEditVisible: boolean }}
 */
export function formModeView(editingTask) {
  const editing = editingTask !== null && editingTask !== undefined;
  return {
    editing,
    heading: editing ? `修改任务 #${editingTask.id}` : '新增任务',
    submitLabel: editing ? '保存修改' : '新增任务',
    cancelEditVisible: editing,
  };
}

/**
 * 任务 → 新增表单的原始数据（形状与 queue.js 的 collectForm 一致），进入编辑模式时
 * 装进现有表单用。编辑不用模板（模板是建任务时渲染提示词的，改提示词直接改文本框），
 * template 固定 ''；依赖多选的值是字符串（与 <option value> 一致）。
 * @param {object} task TaskRow
 * @returns {object} 表单原始数据
 */
export function taskToForm(task) {
  return {
    repo: String(task.repo ?? ''),
    template: '',
    vars: {},
    prompt: String(task.prompt ?? ''),
    title: String(task.title ?? ''),
    difficulty: ['easy', 'medium', 'hard'].includes(task.difficulty) ? task.difficulty : 'medium',
    priority: Number.isSafeInteger(task.priority) ? task.priority : '',
    testCommand: task.testCommand === null || task.testCommand === undefined ? '' : String(task.testCommand),
    allowPeak: task.allowPeak === true,
    maxAttempts: Number.isSafeInteger(task.maxAttempts) ? task.maxAttempts : '',
    dependsOn: (Array.isArray(task.dependsOn) ? task.dependsOn : []).map((id) => String(id)),
  };
}

/**
 * 编辑模式的表单数据 → PATCH /api/tasks/:id 请求体（#46）。与 formToBody 的关键差别：
 * - **绝不带 repo**（repo / source / status 等是禁改字段，服务端 400 点名），也不带
 *   template / vars（编辑不用模板）；
 * - 空的可选字段不进请求体 = **保持原值**（PATCH 语义：不出现就不改），所以页面上
 *   清空测试命令不会清掉它——要清空用 CLI 的 edit --no-test；
 * - dependsOn 不发：依赖下拉只列排队中/运行中的任务，已经 succeeded 的依赖选不中，
 *   发出去会把它们悄悄丢掉；改依赖用 deps --set / edit --depends-on。
 * @param {object} form 表单原始数据（queue.js 从 DOM 收集）
 * @returns {object} 请求体（键只会在 updateTask 的白名单里）
 */
export function editBody(form) {
  const body = {};
  const prompt = String(form.prompt ?? '').trim();
  if (prompt !== '') body.prompt = prompt;
  const title = String(form.title ?? '').trim();
  if (title !== '') body.title = title;
  const difficulty = String(form.difficulty ?? '').trim();
  if (difficulty !== '') body.difficulty = difficulty;
  const priority = toSafeInt(form.priority);
  if (priority !== null) body.priority = priority;
  const testCommand = String(form.testCommand ?? '').trim();
  if (testCommand !== '') body.testCommand = testCommand;
  body.allowPeak = form.allowPeak === true; // 复选框恒为布尔，总是发
  const maxAttempts = toSafeInt(form.maxAttempts);
  if (maxAttempts !== null && maxAttempts >= 1) body.maxAttempts = maxAttempts;
  return body;
}

// ---------------------------------------------------------------- 仓库筛选与导入/清理面板（#50）

/** 仓库筛选「全部」选项的值（空串：真实仓库值不会为空，不会撞车）。 */
export const REPO_FILTER_ALL = '';

/**
 * 仓库筛选的选项（#50）：这一页已经拉到的任务里出现过的仓库（去重、按字节序），
 * 最前面外加「全部」（值为 REPO_FILTER_ALL）。只在浏览器里过滤，不发 repo 查询参数。
 * @param {Array<object>} tasks 当前已拉到的任务（GET /api/tasks 的返回）
 * @returns {string[]} 选项值数组（首项是 REPO_FILTER_ALL）
 */
export function repoFilterOptions(tasks) {
  const list = Array.isArray(tasks) ? tasks : [];
  const repos = [...new Set(
    list.map((t) => String(t?.repo ?? '')).filter((repo) => repo !== ''),
  )].sort();
  return [REPO_FILTER_ALL, ...repos];
}

/**
 * 仓库筛选（#50）：选中某仓库后只留该仓库的任务（新数组，不改入参）；「全部」
 * （空串 / null / undefined）原样全留。三个标签的表格都用它先滤再分组。
 * @param {Array<object>} tasks 当前已拉到的任务
 * @param {string} selected 选中的仓库（REPO_FILTER_ALL = 全部）
 * @returns {Array<object>} 筛出来的任务
 */
export function filterTasksByRepo(tasks, selected) {
  const list = Array.isArray(tasks) ? tasks : [];
  if (selected === null || selected === undefined || selected === REPO_FILTER_ALL) {
    return [...list];
  }
  return list.filter((t) => t?.repo === selected);
}

/**
 * 导入面板的原始输入 → POST /api/import 的请求体（#50）。预览与确认是同一组
 * repo / label / difficulty，只有 dryRun 不同（预览 true 不落库，确认 false 真正入队）。
 * 文本 trim；空标签不进请求体（= gh 参数里不带 --label，与命令行缺省一致）。
 * @param {object} form { repo, label, difficulty }（queue.js 从 DOM 收集，值多为字符串）
 * @param {boolean} dryRun
 * @returns {object} 请求体
 */
export function importBody(form, dryRun) {
  const body = { repo: String(form.repo ?? '').trim() };
  const label = String(form.label ?? '').trim();
  if (label !== '') body.label = label;
  body.difficulty = String(form.difficulty ?? '').trim() || 'medium';
  body.dryRun = dryRun === true;
  return body;
}

/** POST /api/import 响应里 added / skipped 数组的安全长度（残缺响应当 0）。 */
function resultCount(result, key) {
  return Array.isArray(result?.[key]) ? result[key].length : 0;
}

/** 导入预览的一行文案（预览写出将新增和将跳过的数量）。 */
export function importPreviewText(result) {
  return `将新增 ${resultCount(result, 'added')} 个，跳过 ${resultCount(result, 'skipped')} 个`;
}

/** 导入完成的一行文案（数量语义与 import 命令的合计行一致）。 */
export function importDoneText(result) {
  return `新增 ${resultCount(result, 'added')} 个，跳过 ${resultCount(result, 'skipped')} 个`;
}

/**
 * 清理面板 → POST /api/cleanup 的请求体（#50）：预览 dryRun true、确认 false；
 * logsOlderThan 用服务端缺省（14 天），面板不另设天数输入。
 * @param {boolean} dryRun
 * @returns {{ dryRun: boolean }} 请求体
 */
export function cleanupBody(dryRun) {
  return { dryRun: dryRun === true };
}

/**
 * 清理预览的多行文案：第一行是将删的数量，其后逐行列出将删除的路径
 * （worktrees 在前、logs 在后）。
 */
export function cleanupPreviewText(result) {
  const worktrees = Array.isArray(result?.worktrees) ? result.worktrees : [];
  const logs = Array.isArray(result?.logs) ? result.logs : [];
  const lines = [`将删除 worktree ${worktrees.length} 个、日志 ${logs.length} 个`];
  for (const p of worktrees) lines.push(String(p));
  for (const p of logs) lines.push(String(p));
  return lines.join('\n');
}

/** 清理完成的一行文案（failed 时页面错误条另有「有的没删掉」提示，不在这里重复）。 */
export function cleanupDoneText(result) {
  const worktrees = Array.isArray(result?.worktrees) ? result.worktrees : [];
  const logs = Array.isArray(result?.logs) ? result.logs : [];
  return `已删除 worktree ${worktrees.length} 个、日志 ${logs.length} 个`;
}

// ---------------------------------------------------------------- 队列行的 PR 结果标签（#62）

/**
 * 队列行的 PR 结果标签（#62）：PR 在 GitHub 上已合并 / 已关闭时，在状态徽章旁边
 * 额外显示两个字（成功建出的 PR 后来被合并 / 关闭，任务状态本身仍是「成功」）。
 * 只认 task.prOutcome 全等 'merged' / 'closed'（与详情页 #56 的「PR 结果」同一判定）；
 * 'open'、null / undefined / 缺字段、空串、大小写不同（MERGED / CLOSED）及其他任何
 * 值都返回 ''——调用方（queue.js）收到空串一个节点都不建，行文本里不出现这两个词。
 * @param {object} [task] TaskRow（只读 prOutcome，不改任务、不碰 task.status）
 * @returns {'已合并'|'已关闭'|''}
 */
export function prOutcomeLabel(task) {
  if (task?.prOutcome === 'merged') return '已合并';
  if (task?.prOutcome === 'closed') return '已关闭';
  return '';
}
