// follow 的判定与入队规则，只有这一份（#48 建命令时写在 src/cli/follow-command.js，
// #49 抽出来共享）：「什么叫可跟进（只认 CHANGES_REQUESTED，且 PR 没合并也没关闭）、
// source 怎么拼、gitRef 用父任务分支、标题/说明怎么截断（说明带行内评审评论与冲突
// 提示）、已入队怎么去重」——`follow` / `follow --all`（src/cli/follow-command.js）与
// 调度器的自动跟进扫描（src/scheduler.js）都调这里，谁也不另写一套。
//
// ⚠️ 本文件与 src/tasks.js 同侧（静态引入它），因此不能被 CLI 文件静态依赖：
// follow-command.js 只能在 run() 的调用链里动态 import 本文件（时机说明见
// src/warnings.js）。调度器本来就在任务模块一侧，静态引入没有问题。
import { spawn } from 'node:child_process';
import { createTask, findTaskBySource, listTasks } from './tasks.js';

/** follow 生成的标题按 Unicode 码点截断到 80（与 import 一致，不加省略号）。 */
const TITLE_CODE_POINTS = 80;
/** 评审正文（说明的开头部分）按 Unicode 码点截断到 8000。 */
const REVIEW_BODY_CODE_POINTS = 8000;
/** reviewDecision 的「评审要求修改」值；APPROVED / COMMENTED / 空等其他值都不跟。 */
const CHANGES_REQUESTED = 'CHANGES_REQUESTED';
/** 评审列表里没有 CHANGES_REQUESTED 条目但结论已是 CHANGES_REQUESTED 时用的评审 id。 */
const DECISION_REVIEW_ID = 'decision';
/** 扫描 succeeded 父任务时的列表上限（listTasks 只认正整数）。 */
const LIST_LIMIT = 100_000;
/** mergeable 为 CONFLICTING 时加进说明的冲突提示（#60；放在分支那句之前，不进截断）。 */
const CONFLICT_LINE = '这个 PR 和默认分支有冲突，先把默认分支合进当前分支，再按评审改。';

/** spawn 并收集 stdout/stderr/退出码（参数走数组不经 shell）；启动失败 reject。 */
function spawnCapture(bin, args, env) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(bin, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      reject(new Error(`无法启动 ${bin}：${err.message}`));
      return;
    }
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (err) => {
      reject(new Error(`无法执行 ${bin}：${err.message}`));
    });
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

/** 从 prUrl 解析 PR 编号：优先末尾的 /pull/<数字>，否则取最后一个数字段；解析不出 null。 */
function prNumberFromUrl(url) {
  const pull = /\/pull\/(\d+)/.exec(url);
  if (pull !== null) return Number(pull[1]);
  const tail = /(\d+)[^\d]*$/.exec(url);
  return tail === null ? null : Number(tail[1]);
}

/** 文本按 Unicode 码点截到 max 个（中文 / emoji 不会被切成半个），不加省略号。 */
function takeCodePoints(text, max) {
  const chars = [...String(text)];
  return chars.length <= max ? chars.join('') : chars.slice(0, max).join('');
}

/**
 * gh pr view <编号> --repo <repo> --json reviewDecision,reviews,url,headRefName,state,mergeable
 * （#60 加了 state / mergeable）：退出码非 0 或 stdout 不是 JSON 对象时抛中文错误
 * （调用方按运行时错误退出 1，不建任务）。gh 用配置里的 ghBin，参数数组不经 shell，
 * 子进程环境用调用方传入的 env。
 */
async function viewPr(pullNumber, repo, { ghBin, env }) {
  const args = [
    'pr', 'view', String(pullNumber), '--repo', repo,
    '--json', 'reviewDecision,reviews,url,headRefName,state,mergeable',
  ];
  const res = await spawnCapture(ghBin, args, env);
  if (res.code !== 0) {
    throw new Error(`gh pr view 失败（退出码 ${res.code}）：${res.stderr.trim()}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(res.stdout);
  } catch (err) {
    throw new Error(`gh pr view 的输出不是合法 JSON：${err.message}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`gh pr view 的输出不是 JSON 对象：${res.stdout.slice(0, 400) || '（空）'}`);
  }
  return parsed;
}

/**
 * 从 gh pr view 的 JSON 里挑出要跟的那条评审：state 为 CHANGES_REQUESTED 的 reviews 里
 * id 数值最大的那个（GitHub 的评审 id 越晚越大，跟最新一条）。一条都没有但结论已是
 * CHANGES_REQUESTED 时用字面量 'decision'（reviews 为空 / 只有别的 state 都算）。
 * @returns {{ reviewId: string|number, body: string }} body 是该评审的正文（null 当空串）
 */
function pickReview(view) {
  const reviews = Array.isArray(view.reviews) ? view.reviews : [];
  let best = null;
  for (const review of reviews) {
    if (review?.state !== CHANGES_REQUESTED) continue;
    const id = Number(review.id);
    if (!Number.isFinite(id)) continue;
    if (best === null || id > Number(best.id)) best = review;
  }
  if (best === null) return { reviewId: DECISION_REVIEW_ID, body: '' };
  return { reviewId: best.id, body: typeof best.body === 'string' ? best.body : '' };
}

/**
 * gh api --paginate repos/<repo>/pulls/<编号>/comments：拉 PR 的行内评审评论（#60）。
 * 任何失败——退出码非 0、stdout 不是合法 JSON（含空输出）、解析结果不是数组、进程没
 * 起来——都当作「没有行内评论」返回 []：行内评论只是说明的补充，不值得为它把一次
 * 能入队的跟进搅黄。与 gh pr view 的失败语义不同：不抛错、调用方不设 ghError、扫描
 * 不因此停、命令行不因此退出 1。
 */
async function fetchReviewComments(pullNumber, repo, { ghBin, env }) {
  const args = ['api', '--paginate', `repos/${repo}/pulls/${pullNumber}/comments`];
  let res;
  try {
    res = await spawnCapture(ghBin, args, env);
  } catch {
    return []; // spawn 都没起来：与「要不到评论」同等对待
  }
  if (res.code !== 0) return [];
  let parsed;
  try {
    parsed = JSON.parse(res.stdout);
  } catch {
    return [];
  }
  return Array.isArray(parsed) ? parsed : [];
}

/** 行号取值：line 优先，其次 original_line；数字（含 0）或非空字符串都算，否则 null。 */
function commentLineNumber(comment) {
  for (const key of ['line', 'original_line']) {
    const value = comment[key];
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    if (typeof value === 'string' && value !== '') return value;
  }
  return null;
}

/**
 * 一条行内评论格式化成说明里的一行：有行号 `- <path>:<行号> <body>`，行号都没有则
 * `- <path> <body>`（没有冒号）。body 用 trim 后的内容；body 不是字符串或 trim 后为
 * 空、path 不是非空字符串的条目整个跳过（返回 null）。保留 API 数组顺序由调用方保证。
 */
function reviewCommentLine(comment) {
  if (comment === null || typeof comment !== 'object') return null;
  const body = typeof comment.body === 'string' ? comment.body.trim() : '';
  if (body === '') return null;
  if (typeof comment.path !== 'string' || comment.path === '') return null;
  const lineNumber = commentLineNumber(comment);
  return lineNumber === null ? `- ${comment.path} ${body}` : `- ${comment.path}:${lineNumber} ${body}`;
}

/**
 * 单个任务的 follow 判定与入队（follow <id> 与扫描共用）。
 * 返回三选一的结果对象：
 * - { kind: 'created', id, parentId, branch, source }：已入队（createTask 的返回）；
 * - { kind: 'skipped', parentId, message }：PR 已合并 / 已关闭（prOutcome 或 pr view 的
 *   state）、没有待处理的修改请求、已经入队，退出 0；
 * - { kind: 'failed', parentId, message, ghError }：状态不满足 / gh 失败等，按失败上报。
 *   ghError 为 true 表示失败出在 gh pr view 本身（退出码非 0 / 输出不是 JSON）——
 *   自动扫描据此「本轮不再对其余父任务调 gh」，别的调用方可以不理会这个字段。
 * 状态校验失败、gh 失败在这里抛 Error（follow <id> 的语义：退出 1，不建任务）；
 * 扫描传 throwOnError: false 时改为返回 failed 结果，继续下一条。
 */
export async function followTask(db, parent, { ghBin, env, config, throwOnError = true }) {
  const fail = (message, { ghError = false } = {}) => {
    if (throwOnError) throw new Error(message);
    return { kind: 'failed', parentId: parent.id, message, ghError };
  };
  const problems = [];
  if (parent.status !== 'succeeded') problems.push(`状态是 ${parent.status}`);
  if (parent.prUrl == null) problems.push('没有 prUrl');
  if (parent.branch == null) {
    problems.push('没有 branch');
  } else if (!parent.branch.startsWith('night-shift/')) {
    problems.push(`分支 ${parent.branch} 不是 night-shift/ 开头`);
  }
  if (problems.length > 0) {
    return fail(`任务 #${parent.id} 不能跟进：${problems.join('，')}`
      + '（follow 只针对已成功且在 night-shift 分支上开了 PR 的任务）');
  }
  const pullNumber = prNumberFromUrl(parent.prUrl);
  if (pullNumber === null) {
    return fail(`无法从任务 #${parent.id} 的 prUrl 解析 PR 编号：${parent.prUrl}`);
  }

  // #60 第 1 步：任务对象上的 prOutcome 已说明 PR 结束（#56 合入后 listTasks 会带上，
  // 现在还没有这个字段，只读调用方传进来的对象）→ 直接跳过，一次 gh 都不调。只认全等的
  // 小写 'merged' / 'closed'；大写、'open'、null、缺字段都不当作已结束。
  if (parent.prOutcome === 'merged' || parent.prOutcome === 'closed') {
    return {
      kind: 'skipped',
      parentId: parent.id,
      message: parent.prOutcome === 'merged' ? 'PR 已合并' : 'PR 已关闭',
    };
  }

  let view;
  try {
    view = await viewPr(pullNumber, parent.repo, { ghBin, env });
  } catch (err) {
    return fail(`任务 #${parent.id} 的 gh pr view 失败：${err.message}`, { ghError: true });
  }
  // #60 第 2 步：合并 / 关闭后 GitHub 仍可能把 reviewDecision 留在 CHANGES_REQUESTED，
  // state 优先于它。state 缺失、null 或其他值不当作失败，照旧走 reviewDecision 判定。
  if (view.state === 'MERGED' || view.state === 'CLOSED') {
    return {
      kind: 'skipped',
      parentId: parent.id,
      message: view.state === 'MERGED' ? 'PR 已合并' : 'PR 已关闭',
    };
  }
  if (view.reviewDecision !== CHANGES_REQUESTED) {
    return { kind: 'skipped', parentId: parent.id, message: '没有待处理的修改请求' };
  }
  const { reviewId, body } = pickReview(view);
  const source = `pr-review:${parent.repo}#${pullNumber}:${reviewId}`;
  const existing = findTaskBySource(db, source);
  if (existing !== null) {
    return {
      kind: 'skipped',
      parentId: parent.id,
      message: `已经入队 #${existing.id}（${existing.status}）`,
    };
  }
  const branch = parent.branch; // 跟进任务回原分支：gitRef = 父任务成功时推送的分支
  const tailLine = `只在当前分支 ${branch} 上提交并推送，不要开新分支，不要开新的 PR。`;
  // #60 第 4 步：真的要入队了才拉行内评论（去重命中时上面已经 return，不会多打一次
  // gh api）。正文在前、评论一行一行接在后面，合在一起截 8000 个码点。
  const commentLines = [];
  for (const comment of await fetchReviewComments(pullNumber, parent.repo, { ghBin, env })) {
    const line = reviewCommentLine(comment);
    if (line !== null) commentLines.push(line);
  }
  const trimmedBody = body.trim();
  const headParts = trimmedBody === '' ? [] : [trimmedBody];
  headParts.push(...commentLines);
  const head = headParts.length === 0 ? ''
    : takeCodePoints(headParts.join('\n'), REVIEW_BODY_CODE_POINTS);
  // #60 第 5 步：说明的拼法——截断后的「正文+行内评论」在前（可为空），可选的冲突
  // 提示居中，分支那句永远收尾；后两句都不进 8000。
  const promptParts = [];
  if (head !== '') promptParts.push(head);
  if (view.mergeable === 'CONFLICTING') promptParts.push(CONFLICT_LINE);
  promptParts.push(tailLine);
  let task;
  try {
    task = createTask(db, {
      repo: parent.repo,
      title: takeCodePoints(`跟进 #${parent.id}：${parent.title}`, TITLE_CODE_POINTS),
      prompt: promptParts.join('\n'),
      source,
      gitRef: branch,
      difficulty: parent.difficulty,
      priority: parent.priority,
      testCommand: parent.testCommand,
      allowPeak: parent.allowPeak,
      // 不照抄父任务的 maxAttempts：与 add 缺省一致，取（生效配置的）默认值。
      maxAttempts: config.maxAttempts,
    });
  } catch (err) {
    // gitRef 等字段没过校验（父任务的 branch 形状怪异）等：单条按失败处理，扫描继续。
    return fail(`任务 #${parent.id} 的跟进任务入队失败：${err instanceof Error ? err.message : String(err)}`);
  }
  return { kind: 'created', id: task.id, parentId: parent.id, branch, source };
}

/**
 * 扫描候选：全部 succeeded 且有 prUrl 的任务（follow --all 与调度器的自动扫描共用，
 * 排序沿用 listTasks：created_at DESC → id DESC）。
 */
export function listFollowParents(db) {
  return listTasks(db, { status: 'succeeded', limit: LIST_LIMIT })
    .filter((task) => task.prUrl != null);
}

/**
 * 调度器的自动跟进扫描（#49）：对全部候选跑与 follow --all 同一套判定。差别只在
 * gh 失败的处理：--all 记下来继续下一条、有失败退出码 1；这里第一条 gh 失败就停止
 * 本轮（不再对其余父任务调 gh），失败之前已入队的保留，原因经返回值交给调度器记
 * 日志。与 gh 无关的失败（分支形状怪异等）照 --all 的样子记下来继续下一条。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {object} options
 * @param {string} options.ghBin gh 可执行文件（配置的 ghBin）
 * @param {object} options.env gh 子进程环境变量（调度器的 env，原样传给 spawn）
 * @param {object} options.config 生效配置（follow 任务入队用 maxAttempts）
 * @returns {Promise<{created: Array<{id: number, parentId: number, branch: string, source: string}>,
 *   skipped: Array<{parentId: number, message: string}>,
 *   failed: Array<{parentId: number, message: string}>,
 *   ghError: string|null}>} ghError 非 null 时是本轮停下的那条 gh 失败的原因
 */
export async function scanFollowReviews(db, { ghBin, env, config }) {
  const created = [];
  const skipped = [];
  const failed = [];
  for (const parent of listFollowParents(db)) {
    const result = await followTask(db, parent, { ghBin, env, config, throwOnError: false });
    if (result.kind === 'created') {
      created.push({ id: result.id, parentId: result.parentId, branch: result.branch, source: result.source });
    } else if (result.kind === 'skipped') {
      skipped.push({ parentId: result.parentId, message: result.message });
    } else if (result.ghError === true) {
      return { created, skipped, failed, ghError: result.message };
    } else {
      failed.push({ parentId: result.parentId, message: result.message });
    }
  }
  return { created, skipped, failed, ghError: null };
}
