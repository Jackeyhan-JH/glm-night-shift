// 任务与运行记录的领域逻辑（issue #3）。所有函数第一个参数是 openDb() 的 DatabaseSync，
// 返回驼峰字段的普通对象：布尔（allowPeak / peak）转回真布尔，NULL 保持 null。
// 时间一律存 UTC ISO 字符串（约定见 #1），对外接受 Date 或 ISO 字符串（见 toIso）。
//
// 并发约定：调度器、看板、命令行会是不同进程，各自 openDb 同一个文件库（WAL +
// busy_timeout 支持多读单写）。因此所有状态流转都是「单条带状态守卫的原子
// UPDATE … WHERE id = ? AND status IN (…) RETURNING」——先到者的更新生效；后到者
// 未命中时重读库里的当前状态，抛 NotFoundError / InvalidTransitionError，绝不静默
// 覆盖别人的结果（例：看板刚取消了一个 running 任务，调度器再报成功会抛错而不是
// 把 canceled 改回 succeeded）。
import { DEFAULT_CONFIG } from './config.js';

/** tasks.status 的全部合法值。 */
export const TASK_STATUSES = ['queued', 'running', 'succeeded', 'failed', 'canceled'];
/** runs.status 的全部合法值。 */
export const RUN_STATUSES = ['running', 'succeeded', 'failed', 'timeout', 'canceled'];
/** tasks.difficulty 的全部合法值。 */
export const DIFFICULTIES = ['easy', 'medium', 'hard'];

const REPO_PATTERN = /^[\w.-]+\/[\w.-]+$/;
const TITLE_MAX_CODE_POINTS = 60; // title 缺省时取 prompt 的前 60 个字符（按 Unicode 码点数）

/**
 * 字段校验失败。
 * @property {string} field 出问题的字段名（驼峰），message 里也点名该字段。
 */
export class ValidationError extends Error {
  /**
   * @param {string} field 字段名
   * @param {string} reason 该字段为什么不合法
   */
  constructor(field, reason) {
    super(`字段 ${field} 不合法：${reason}`);
    this.name = 'ValidationError';
    this.field = field;
  }
}

/**
 * 任务或 run 不存在。
 * @property {number} id 查找的 id。
 */
export class NotFoundError extends Error {
  /**
   * @param {number} id 查找的 id
   * @param {string} [kind='任务'] 报错时说的种类（任务 / run）
   */
  constructor(id, kind = '任务') {
    super(`${kind} ${id} 不存在`);
    this.name = 'NotFoundError';
    this.id = id;
  }
}

/**
 * 非法状态转换。message 同时包含源状态和目标状态。
 * @property {string} from 库里实际的当前状态。
 * @property {string} to 调用方想要的目标状态。
 */
export class InvalidTransitionError extends Error {
  /**
   * @param {string} from 当前状态
   * @param {string} to 目标状态
   * @param {string} [kind='任务'] 报错时说的种类（任务 / run）
   */
  constructor(from, to, kind = '任务') {
    super(`${kind}状态不能从 ${from} 转为 ${to}`);
    this.name = 'InvalidTransitionError';
    this.from = from;
    this.to = to;
  }
}

/**
 * @typedef {object} TaskRow 对外返回的任务对象（驼峰字段，布尔是真布尔，NULL 保持 null）。
 * @property {number} id
 * @property {string} repo `owner/name`
 * @property {string} title
 * @property {string} prompt
 * @property {('easy'|'medium'|'hard')} difficulty
 * @property {number} priority
 * @property {?string} testCommand
 * @property {boolean} allowPeak
 * @property {('queued'|'running'|'succeeded'|'failed'|'canceled')} status
 * @property {number} attempts
 * @property {number} maxAttempts
 * @property {?string} branch
 * @property {?string} prUrl
 * @property {?string} lastError
 * @property {string} createdAt UTC ISO
 * @property {string} updatedAt UTC ISO
 * @property {?string} startedAt UTC ISO，最近一次领取时间（重试再领会覆盖）
 * @property {?string} finishedAt UTC ISO，终态（含 canceled）达成时间；重试回排队时为 null
 */

/**
 * @typedef {object} RunRow 对外返回的运行记录对象。
 * @property {number} id
 * @property {number} taskId
 * @property {number} attempt
 * @property {string} model
 * @property {string} effort
 * @property {boolean} peak
 * @property {('running'|'succeeded'|'failed'|'timeout'|'canceled')} status
 * @property {?number} exitCode
 * @property {?number} numTurns
 * @property {number} prompts
 * @property {?number} quotaUnits
 * @property {string} logPath
 * @property {string} startedAt UTC ISO
 * @property {?string} finishedAt UTC ISO
 * @property {?number} durationMs 毫秒；崩溃恢复标记的 run 为 null（真实耗时不可知）
 * @property {?string} error
 */

// ---------------------------------------------------------------- 任务

/**
 * 新建任务（状态 queued，attempts 0）。字符串字段先 trim 再校验/入库。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {object} input
 * @param {string} input.repo `owner/name`，须匹配 `^[\w.-]+\/[\w.-]+$`
 * @param {string} input.prompt 非空
 * @param {string} [input.title] 缺省（undefined/null）时取 prompt 前 60 个 Unicode 码点
 *   （按码点切，中文 / emoji 不会被切成半个）；给了则 trim 后必须非空
 * @param {('easy'|'medium'|'hard')} [input.difficulty='medium']
 * @param {number} [input.priority=0] 任意整数（越大越先被领取，负数合法）
 * @param {?string} [input.testCommand=null] null 或非空字符串
 * @param {boolean} [input.allowPeak=false]
 * @param {number} [input.maxAttempts=DEFAULT_CONFIG.maxAttempts] 正整数（当前默认 2）
 * @returns {TaskRow} 新建的任务
 * @throws {ValidationError} 任一字段不合法（err.field 指明字段，message 点名）
 */
export function createTask(db, input = {}) {
  const repo = requiredTrimmed(input.repo, 'repo');
  if (!REPO_PATTERN.test(repo)) {
    throw new ValidationError('repo', `必须形如 owner/name（当前值：${repo}）`);
  }
  const prompt = requiredTrimmed(input.prompt, 'prompt');
  const difficulty = input.difficulty ?? 'medium';
  if (!DIFFICULTIES.includes(difficulty)) {
    throw new ValidationError('difficulty', `必须是 ${DIFFICULTIES.join(' | ')} 之一（当前值：${difficulty}）`);
  }
  const priority = input.priority ?? 0;
  if (!Number.isInteger(priority)) {
    throw new ValidationError('priority', `必须是整数（当前值：${priority}）`);
  }
  const testCommand = optionalTrimmed(input.testCommand, 'testCommand');
  const allowPeak = input.allowPeak ?? false;
  if (typeof allowPeak !== 'boolean') {
    throw new ValidationError('allowPeak', `必须是布尔值（当前值：${allowPeak}）`);
  }
  const maxAttempts = input.maxAttempts ?? DEFAULT_CONFIG.maxAttempts;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new ValidationError('maxAttempts', `必须是正整数（当前值：${maxAttempts}）`);
  }
  const title = input.title === undefined || input.title === null
    ? [...prompt].slice(0, TITLE_MAX_CODE_POINTS).join('')
    : requiredTrimmed(input.title, 'title');

  const now = nowIso();
  const row = db.prepare(`
    INSERT INTO tasks (repo, title, prompt, difficulty, priority, test_command, allow_peak,
                       status, attempts, max_attempts, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?, ?)
    RETURNING *
  `).get(repo, title, prompt, difficulty, priority, testCommand, allowPeak ? 1 : 0, maxAttempts, now, now);
  return rowToTask(row);
}

/**
 * 按 id 取任务。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} id 正整数
 * @returns {?TaskRow} 不存在返回 null（“操作类”函数才抛 NotFoundError）
 * @throws {ValidationError} id 不是正整数（field='id'）
 */
export function getTask(db, id) {
  assertPositiveInt(id, 'id');
  return rowToTask(db.prepare('SELECT * FROM tasks WHERE id = ?').get(id));
}

/**
 * 任务列表。queued 按队列语义（priority DESC → created_at ASC → id ASC，先进先出），
 * 其他状态以及不传 status 时按 created_at DESC → id DESC（最新在前）；id 兜底保证
 * 同一毫秒创建的任务顺序也确定。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {object} [options]
 * @param {('queued'|'running'|'succeeded'|'failed'|'canceled')} [options.status] 按状态过滤
 * @param {number} [options.limit=100] 正整数
 * @returns {TaskRow[]}
 * @throws {ValidationError} status 不在枚举里（field='status'）或 limit 非正整数
 */
export function listTasks(db, { status, limit = 100 } = {}) {
  if (status !== undefined && !TASK_STATUSES.includes(status)) {
    throw new ValidationError('status', `必须是 ${TASK_STATUSES.join(' | ')} 之一（当前值：${status}）`);
  }
  assertPositiveInt(limit, 'limit');
  const where = status === undefined ? '' : 'WHERE status = ?';
  const order = status === 'queued'
    ? 'priority DESC, created_at ASC, id ASC'
    : 'created_at DESC, id DESC';
  const params = status === undefined ? [limit] : [status, limit];
  return db.prepare(`SELECT * FROM tasks ${where} ORDER BY ${order} LIMIT ?`)
    .all(...params)
    .map(rowToTask);
}

/**
 * 原子领取下一个排队任务：单条 UPDATE（子查询选 id + `AND status = 'queued'` 双保险，
 * SQLite 写语句串行执行），两个连接 / 进程绝不会领到同一个任务。改为 running、
 * attempts + 1、写 started_at / updated_at。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {object} [options]
 * @param {boolean} [options.allowPeakOnly=false] true 时只领 allow_peak = 1 的任务
 * @returns {?TaskRow} 被领取的任务；没有可领的返回 null。
 *   started_at 语义：最近一次领取时间（重试后再领会覆盖，配合 attempts 递增读）
 * @throws {ValidationError} allowPeakOnly 非布尔
 */
export function claimNextTask(db, { allowPeakOnly = false } = {}) {
  if (typeof allowPeakOnly !== 'boolean') {
    throw new ValidationError('allowPeakOnly', `必须是布尔值（当前值：${allowPeakOnly}）`);
  }
  const now = nowIso();
  const row = db.prepare(`
    UPDATE tasks
    SET status = 'running', attempts = attempts + 1, started_at = ?, updated_at = ?
    WHERE id = (
      SELECT id FROM tasks
      WHERE status = 'queued' ${allowPeakOnly ? 'AND allow_peak = 1' : ''}
      ORDER BY priority DESC, created_at ASC, id ASC
      LIMIT 1
    ) AND status = 'queued'
    RETURNING *
  `).get(now, now);
  return rowToTask(row);
}

// ---------------------------------------------------------------- 任务状态流转

const FINISH_TASK_STATUSES = ['succeeded', 'failed', 'queued'];

/**
 * 结束一个 running 任务。原子：UPDATE 带 `status = 'running'` 守卫，未命中（任务不存在，
 * 或状态已被别的连接改掉）时重读库里的当前状态抛错，不会静默覆盖并发操作的结果。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} id 正整数
 * @param {object} fields
 * @param {('succeeded'|'failed'|'queued')} fields.status queued 表示排回队列重试
 * @param {?string} [fields.lastError] undefined = 保持原值；给了则覆盖（null = 清空）
 * @param {?string} [fields.prUrl] 同上
 * @param {?string} [fields.branch] 同上
 * @returns {TaskRow} 更新后的任务。终态写 finished_at，重试（queued）清空它；
 *   started_at 不动，仍是最近一次领取时间；attempts 不变（只有 retryTask 归零）
 * @throws {ValidationError} id 非正整数、status 不在允许集合（field='status'），
 *   或 lastError/prUrl/branch 给了却不是字符串或 null
 * @throws {NotFoundError} 任务不存在
 * @throws {InvalidTransitionError} 当前状态不是 running（err.from 是库里实际的当前状态）
 */
export function finishTask(db, id, { status, lastError, prUrl, branch } = {}) {
  assertPositiveInt(id, 'id');
  if (!FINISH_TASK_STATUSES.includes(status)) {
    throw new ValidationError(
      'status',
      `finishTask 只接受 ${FINISH_TASK_STATUSES.join(' | ')}（queued 表示重试；当前值：${status}）`,
    );
  }
  assertOptionalString(lastError, 'lastError');
  assertOptionalString(prUrl, 'prUrl');
  assertOptionalString(branch, 'branch');
  const now = nowIso();
  const sets = ['status = ?', 'updated_at = ?', 'finished_at = ?'];
  const params = [status, now, status === 'queued' ? null : now];
  appendOptionalColumn(sets, params, ['last_error', lastError]);
  appendOptionalColumn(sets, params, ['pr_url', prUrl]);
  appendOptionalColumn(sets, params, ['branch', branch]);
  params.push(id);
  const row = db.prepare(
    `UPDATE tasks SET ${sets.join(', ')} WHERE id = ? AND status = 'running' RETURNING *`,
  ).get(...params);
  if (row === undefined) throw staleTransitionError(db, id, status);
  return rowToTask(row);
}

/**
 * 取消任务：queued | running → canceled（终态，写 finished_at）。
 * 原子：UPDATE 带源状态守卫，并发下后到者抛错而不是覆盖。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} id 正整数
 * @returns {TaskRow} 更新后的任务
 * @throws {ValidationError} id 非正整数
 * @throws {NotFoundError} 任务不存在
 * @throws {InvalidTransitionError} 当前已是终态（succeeded / failed / canceled）
 */
export function cancelTask(db, id) {
  assertPositiveInt(id, 'id');
  const now = nowIso();
  const row = db.prepare(`
    UPDATE tasks
    SET status = 'canceled', finished_at = ?, updated_at = ?
    WHERE id = ? AND status IN ('queued', 'running')
    RETURNING *
  `).get(now, now, id);
  if (row === undefined) throw staleTransitionError(db, id, 'canceled');
  return rowToTask(row);
}

/**
 * 重新排队：failed | canceled → queued；attempts 归零、last_error / finished_at 清空；
 * started_at 保留（下次领取时覆盖），branch / pr_url 也保留（接着上次的开 PR 结果）。
 * 原子：UPDATE 带源状态守卫，并发下后到者抛错而不是覆盖。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} id 正整数
 * @returns {TaskRow} 更新后的任务
 * @throws {ValidationError} id 非正整数
 * @throws {NotFoundError} 任务不存在
 * @throws {InvalidTransitionError} 当前状态不是 failed / canceled
 */
export function retryTask(db, id) {
  assertPositiveInt(id, 'id');
  const now = nowIso();
  const row = db.prepare(`
    UPDATE tasks
    SET status = 'queued', attempts = 0, last_error = NULL, finished_at = NULL, updated_at = ?
    WHERE id = ? AND status IN ('failed', 'canceled')
    RETURNING *
  `).get(now, id);
  if (row === undefined) throw staleTransitionError(db, id, 'queued');
  return rowToTask(row);
}

/**
 * 服务重启时的恢复（单个 IMMEDIATE 事务）：所有 running 任务改回 queued，它们未结束
 * 的 run 标为 failed、error = 'interrupted'。
 *
 * 取舍（规格未明说）：任务的 attempts / started_at 保留不重置——中断的那次算消耗掉，
 * 防止反复崩溃导致无限重试；run 的 finished_at 记恢复时刻，duration_ms 留 null，
 * 因为进程已死，真实耗时不可知（不拿停机时长冒充执行时长）。
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {number[]} 受影响的任务 id（升序）
 */
export function recoverStaleRunning(db) {
  const now = nowIso();
  db.exec('BEGIN IMMEDIATE');
  try {
    const ids = db.prepare("SELECT id FROM tasks WHERE status = 'running' ORDER BY id ASC")
      .all()
      .map((row) => row.id);
    if (ids.length > 0) {
      db.prepare("UPDATE tasks SET status = 'queued', updated_at = ? WHERE status = 'running'").run(now);
      const placeholders = ids.map(() => '?').join(', ');
      db.prepare(`
        UPDATE runs
        SET status = 'failed', error = 'interrupted', finished_at = ?
        WHERE status = 'running' AND task_id IN (${placeholders})
      `).run(now, ...ids);
    }
    db.exec('COMMIT');
    return ids;
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // 事务已不在：保留并抛出原始错误，别让 ROLLBACK 的报错盖住它
    }
    throw err;
  }
}

// ---------------------------------------------------------------- 运行记录（runs）

/**
 * 开始一次运行（status = 'running'，prompts 先按默认 1 记，finishRun 时可覆盖）。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {object} input
 * @param {number} input.taskId 正整数，任务必须存在
 * @param {number} input.attempt 正整数，一般传任务当时的 attempts（领取后 ≥ 1）
 * @param {string} input.model 非空
 * @param {string} input.effort 非空
 * @param {boolean} input.peak 开始时是否高峰
 * @param {string} input.logPath 空串或非空字符串。空串合法：#7 的 runTask 先 startRun
 *   拿到 id（日志路径里要用它），再立刻 setRunLogPath 补上真实路径；纯空白仍然非法。
 * @returns {RunRow} 新建的 run
 * @throws {ValidationError} 任一字段缺失或类型不对（err.field 指明字段）
 * @throws {NotFoundError} 任务不存在
 */
export function startRun(db, { taskId, attempt, model, effort, peak, logPath } = {}) {
  assertPositiveInt(taskId, 'taskId');
  assertPositiveInt(attempt, 'attempt');
  const theModel = requiredTrimmed(model, 'model');
  const theEffort = requiredTrimmed(effort, 'effort');
  if (typeof peak !== 'boolean') {
    throw new ValidationError('peak', `必须是布尔值（当前值：${peak}）`);
  }
  // 空串放行（见上），其余交给 requiredTrimmed：非字符串 / 纯空白照样报错。
  const theLogPath = logPath === '' ? '' : requiredTrimmed(logPath, 'logPath');
  taskRow(db, taskId); // 任务不存在时抛 NotFoundError
  const now = nowIso();
  const row = db.prepare(`
    INSERT INTO runs (task_id, attempt, model, effort, peak, status, prompts, log_path, started_at)
    VALUES (?, ?, ?, ?, ?, 'running', 1, ?, ?)
    RETURNING *
  `).get(taskId, attempt, theModel, theEffort, peak ? 1 : 0, theLogPath, now);
  return rowToRun(row);
}

/**
 * 补写 run 的日志路径（#7 的 runTask 流程：startRun 先传空串拿到 id，用 id 拼出
 * `<home>/logs/task-<taskId>/run-<runId>.log` 后马上调这里更新）。
 * 单条 UPDATE，run 不存在时抛 NotFoundError。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} runId 正整数
 * @param {string} logPath 非空字符串（trim 后入库）
 * @returns {RunRow} 更新后的 run
 * @throws {ValidationError} runId 非正整数，或 logPath 不是非空字符串（field 对应）
 * @throws {NotFoundError} run 不存在
 */
export function setRunLogPath(db, runId, logPath) {
  assertPositiveInt(runId, 'runId');
  const theLogPath = requiredTrimmed(logPath, 'logPath');
  const row = db.prepare('UPDATE runs SET log_path = ? WHERE id = ? RETURNING *')
    .get(theLogPath, runId);
  if (row === undefined) throw new NotFoundError(runId, 'run');
  return rowToRun(row);
}

const FINISH_RUN_STATUSES = ['succeeded', 'failed', 'timeout', 'canceled'];

/**
 * 结束一次运行。原子：UPDATE 带 `status = 'running'` 守卫，run 已被别的连接结束 /
 * 恢复时抛错而不是覆盖。自动写 finished_at 并算 duration_ms = finished_at -
 * started_at，钳到至少 1ms（同毫秒开始并结束的 run 也报告正数）。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} runId 正整数
 * @param {object} fields
 * @param {('succeeded'|'failed'|'timeout'|'canceled')} fields.status
 * @param {?number} [fields.exitCode] 整数或 null；undefined = 保持原值
 * @param {?number} [fields.numTurns] 非负整数或 null；undefined = 保持原值
 * @param {number} [fields.prompts] 非负数值（列 NOT NULL DEFAULT 1，不接受 null）；
 *   undefined = 保持 startRun 写入的 1
 * @param {?number} [fields.quotaUnits] 数值或 null；undefined = 保持原值
 * @param {?string} [fields.error] 字符串或 null；undefined = 保持原值
 * @returns {RunRow} 更新后的 run
 * @throws {ValidationError} runId 非正整数、status 不在允许集合（field='status'），
 *   或可选字段给了却类型不对（field = 对应字段名）
 * @throws {NotFoundError} run 不存在
 * @throws {InvalidTransitionError} run 已不是 running（err.from 是库里实际的当前状态）
 */
export function finishRun(db, runId, { status, exitCode, numTurns, prompts, quotaUnits, error } = {}) {
  assertPositiveInt(runId, 'runId');
  if (!FINISH_RUN_STATUSES.includes(status)) {
    throw new ValidationError(
      'status',
      `finishRun 只接受 ${FINISH_RUN_STATUSES.join(' | ')}（当前值：${status}）`,
    );
  }
  if (exitCode !== undefined && !(exitCode === null || Number.isInteger(exitCode))) {
    throw new ValidationError('exitCode', `必须是整数或 null（当前值：${exitCode}）`);
  }
  if (numTurns !== undefined && !(numTurns === null || (Number.isInteger(numTurns) && numTurns >= 0))) {
    throw new ValidationError('numTurns', `必须是非负整数或 null（当前值：${numTurns}）`);
  }
  if (prompts !== undefined
      && !(typeof prompts === 'number' && Number.isFinite(prompts) && prompts >= 0)) {
    throw new ValidationError('prompts', `必须是非负数值（当前值：${prompts}）`);
  }
  if (quotaUnits !== undefined
      && !(quotaUnits === null || (typeof quotaUnits === 'number' && Number.isFinite(quotaUnits)))) {
    throw new ValidationError('quotaUnits', `必须是数值或 null（当前值：${quotaUnits}）`);
  }
  if (error !== undefined && !(error === null || typeof error === 'string')) {
    throw new ValidationError('error', `必须是字符串或 null（当前值：${error}）`);
  }

  // started_at 只在 startRun 时写、running 期间不变，可以先读再条件更新；
  // 若期间被别的连接结束 / 恢复，下面的 UPDATE 会因状态守卫未命中而抛错。
  const current = db.prepare('SELECT * FROM runs WHERE id = ?').get(runId);
  if (current === undefined) throw new NotFoundError(runId, 'run');
  const finishedAt = nowIso();
  const durationMs = Math.max(1, Date.parse(finishedAt) - Date.parse(current.started_at));
  const sets = ['status = ?', 'finished_at = ?', 'duration_ms = ?'];
  const params = [status, finishedAt, durationMs];
  appendOptionalColumn(sets, params, ['exit_code', exitCode]);
  appendOptionalColumn(sets, params, ['num_turns', numTurns]);
  appendOptionalColumn(sets, params, ['prompts', prompts]);
  appendOptionalColumn(sets, params, ['quota_units', quotaUnits]);
  appendOptionalColumn(sets, params, ['error', error]);
  params.push(runId);
  const row = db.prepare(
    `UPDATE runs SET ${sets.join(', ')} WHERE id = ? AND status = 'running' RETURNING *`,
  ).get(...params);
  if (row === undefined) {
    const nowCurrent = db.prepare('SELECT * FROM runs WHERE id = ?').get(runId);
    if (nowCurrent === undefined) throw new NotFoundError(runId, 'run');
    throw new InvalidTransitionError(nowCurrent.status, status, 'run');
  }
  return rowToRun(row);
}

/**
 * 运行记录列表：started_at DESC → id DESC（同毫秒开始的按新 id 在前）。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {object} [options]
 * @param {number} [options.taskId] 正整数，按任务过滤
 * @param {Date|string} [options.since] 只取 started_at >= since（含等于）；字符串须能被
 *   Date.parse 解析，比较前统一规范化成 UTC ISO
 * @param {number} [options.limit=100] 正整数
 * @returns {RunRow[]}
 * @throws {ValidationError} taskId / limit 非正整数，或 since 不是合法时间（field='since'）
 */
export function listRuns(db, { taskId, since, limit = 100 } = {}) {
  if (taskId !== undefined) assertPositiveInt(taskId, 'taskId');
  const sinceIso = since === undefined ? undefined : toIso(since, 'since');
  assertPositiveInt(limit, 'limit');
  const where = [];
  const params = [];
  if (taskId !== undefined) {
    where.push('task_id = ?');
    params.push(taskId);
  }
  if (sinceIso !== undefined) {
    where.push('started_at >= ?');
    params.push(sinceIso);
  }
  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  params.push(limit);
  return db.prepare(`SELECT * FROM runs ${whereSql} ORDER BY started_at DESC, id DESC LIMIT ?`)
    .all(...params)
    .map(rowToRun);
}

// ---------------------------------------------------------------- 辅助

function nowIso() {
  return new Date().toISOString();
}

/** Date 或 ISO 字符串 → 规范化的 UTC ISO 字符串；两者都不是则抛 ValidationError。 */
function toIso(value, field) {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new ValidationError(field, '不是合法时间');
    return value.toISOString();
  }
  if (typeof value === 'string' && value.trim() !== '' && !Number.isNaN(Date.parse(value))) {
    return new Date(value).toISOString();
  }
  throw new ValidationError(field, '必须是 Date 或 ISO 时间字符串');
}

function requiredTrimmed(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ValidationError(field, '必须是非空字符串');
  }
  return value.trim();
}

/** undefined/null → null；否则要求 trim 后非空的字符串。 */
function optionalTrimmed(value, field) {
  if (value === undefined || value === null) return null;
  return requiredTrimmed(value, field);
}

function assertPositiveInt(value, field) {
  if (!Number.isInteger(value) || value < 1) {
    throw new ValidationError(field, `必须是正整数（当前值：${value}）`);
  }
}

/** finishTask 的可选字段：undefined = 不更新；其余必须是字符串或 null。 */
function assertOptionalString(value, field) {
  if (value === undefined) return;
  if (value !== null && typeof value !== 'string') {
    throw new ValidationError(field, `必须是字符串或 null（当前值：${value}）`);
  }
}

// 动态拼 SET 子句用：value !== undefined 才追加 `column = ?`（undefined = 保持原值）。
function appendOptionalColumn(sets, params, [column, value]) {
  if (value === undefined) return;
  sets.push(`${column} = ?`);
  params.push(value);
}

// 条件 UPDATE 因状态守卫未命中时：任务不在了 → NotFoundError；
// 状态被并发改掉 → InvalidTransitionError（按库里当前的实际情况报）。
function staleTransitionError(db, id, to) {
  return new InvalidTransitionError(taskRow(db, id).status, to);
}

function rowToTask(row) {
  if (row === undefined) return null;
  return {
    id: row.id,
    repo: row.repo,
    title: row.title,
    prompt: row.prompt,
    difficulty: row.difficulty,
    priority: row.priority,
    testCommand: row.test_command,
    allowPeak: row.allow_peak === 1,
    status: row.status,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    branch: row.branch,
    prUrl: row.pr_url,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

function rowToRun(row) {
  if (row === undefined) return null;
  return {
    id: row.id,
    taskId: row.task_id,
    attempt: row.attempt,
    model: row.model,
    effort: row.effort,
    peak: row.peak === 1,
    status: row.status,
    exitCode: row.exit_code,
    numTurns: row.num_turns,
    prompts: row.prompts,
    quotaUnits: row.quota_units,
    logPath: row.log_path,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    durationMs: row.duration_ms,
    error: row.error,
  };
}

function taskRow(db, id) {
  const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
  if (row === undefined) throw new NotFoundError(id);
  return row;
}
