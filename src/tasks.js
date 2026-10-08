// 任务与运行记录的领域逻辑（issue #3）。所有函数第一个参数是 openDb() 的 DatabaseSync，
// 返回驼峰字段的普通对象：布尔（allowPeak / peak）转回真布尔，NULL 保持 null。
// 时间一律存 UTC ISO 字符串（约定见 #1），对外接受 Date 或 ISO 字符串（见 toIso）。
import { DEFAULT_CONFIG } from './config.js';

export const TASK_STATUSES = ['queued', 'running', 'succeeded', 'failed', 'canceled'];
export const RUN_STATUSES = ['running', 'succeeded', 'failed', 'timeout', 'canceled'];
export const DIFFICULTIES = ['easy', 'medium', 'hard'];

const REPO_PATTERN = /^[\w.-]+\/[\w.-]+$/;
const TITLE_MAX_CODE_POINTS = 60; // title 缺省时取 prompt 的前 60 个字符（按 Unicode 码点数）

/** 字段校验失败：`err.field` 是字段名，message 里也点名该字段。 */
export class ValidationError extends Error {
  constructor(field, reason) {
    super(`字段 ${field} 不合法：${reason}`);
    this.name = 'ValidationError';
    this.field = field;
  }
}

/** 任务或 run 不存在：`err.id` 是查找的 id。 */
export class NotFoundError extends Error {
  constructor(id, kind = '任务') {
    super(`${kind} ${id} 不存在`);
    this.name = 'NotFoundError';
    this.id = id;
  }
}

/** 非法状态转换：`err.from` / `err.to`，message 同时包含两个状态。 */
export class InvalidTransitionError extends Error {
  constructor(from, to, kind = '任务') {
    super(`${kind}状态不能从 ${from} 转为 ${to}`);
    this.name = 'InvalidTransitionError';
    this.from = from;
    this.to = to;
  }
}

// ---------------------------------------------------------------- 任务

/**
 * 新建任务（状态 queued，attempts 0）。字符串字段先 trim 再校验/入库。
 * - repo 形如 `owner/name`（`^[\w.-]+\/[\w.-]+$`）。
 * - prompt 非空；title 缺省（undefined/null）时取 prompt 前 60 个 Unicode 码点
 *   （按码点切，中文 / emoji 不会被切成半个）；显式给 title 则 trim 后必须非空。
 * - difficulty ∈ easy|medium|hard，默认 medium；priority 任意整数，默认 0。
 * - testCommand null 或非空字符串；allowPeak 布尔，默认 false。
 * - maxAttempts 缺省取 DEFAULT_CONFIG.maxAttempts（当前 2），必须是正整数。
 * 校验失败抛 ValidationError（带字段名）。
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

/** 按 id 取任务；不存在返回 null（与 NotFoundError 的“操作类”函数区分开）。 */
export function getTask(db, id) {
  assertPositiveInt(id, 'id');
  return rowToTask(db.prepare('SELECT * FROM tasks WHERE id = ?').get(id));
}

/**
 * 任务列表。queued 按队列语义（priority DESC → created_at ASC → id ASC，先进先出），
 * 其他状态以及不传 status 时按 created_at DESC → id DESC（最新在前）。
 * id 兜底保证同一毫秒创建的任务顺序也确定。limit 默认 100。
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
 * SQLite 写语句串行执行），改为 running、attempts + 1、写 started_at / updated_at，返回
 * 更新后的任务；没有可领的返回 null。allowPeakOnly 为 true 时只领 allow_peak = 1 的。
 *
 * started_at 语义：最近一次被领取的时间（重试后再领会覆盖，配合 attempts 递增读）。
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
 * 结束一个 running 任务。status 只能是 succeeded | failed | queued（queued = 排队重试）：
 * 终态写 finished_at，重试清空它（下次领取再写新的）。started_at 不动，仍是最近一次
 * 领取时间。lastError / prUrl / branch 只有调用方给了才更新（undefined = 保持原值；
 * 显式传 null 表示清空该列）。返回更新后的任务。
 */
export function finishTask(db, id, { status, lastError, prUrl, branch } = {}) {
  assertPositiveInt(id, 'id');
  if (!FINISH_TASK_STATUSES.includes(status)) {
    throw new ValidationError(
      'status',
      `finishTask 只接受 ${FINISH_TASK_STATUSES.join(' | ')}（queued 表示重试；当前值：${status}）`,
    );
  }
  const current = taskRow(db, id);
  if (current.status !== 'running') {
    throw new InvalidTransitionError(current.status, status);
  }
  const now = nowIso();
  const sets = ['status = ?', 'updated_at = ?', 'finished_at = ?'];
  const params = [status, now, status === 'queued' ? null : now];
  appendOptionalColumn(sets, params, ['last_error', lastError]);
  appendOptionalColumn(sets, params, ['pr_url', prUrl]);
  appendOptionalColumn(sets, params, ['branch', branch]);
  params.push(id);
  const row = db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ? RETURNING *`).get(...params);
  return rowToTask(row);
}

/**
 * 取消任务：queued | running → canceled（终态，写 finished_at）。
 * succeeded / failed / canceled 上再取消抛 InvalidTransitionError。
 */
export function cancelTask(db, id) {
  assertPositiveInt(id, 'id');
  const current = taskRow(db, id);
  if (current.status !== 'queued' && current.status !== 'running') {
    throw new InvalidTransitionError(current.status, 'canceled');
  }
  const now = nowIso();
  const row = db.prepare(
    "UPDATE tasks SET status = 'canceled', finished_at = ?, updated_at = ? WHERE id = ? RETURNING *",
  ).get(now, now, id);
  return rowToTask(row);
}

/**
 * 重新排队：failed | canceled → queued，attempts 归零、last_error / finished_at 清空。
 * started_at 保留（下次领取时覆盖），可空字段（branch / pr_url）也保留，方便接着上次的开 PR 结果。
 */
export function retryTask(db, id) {
  assertPositiveInt(id, 'id');
  const current = taskRow(db, id);
  if (current.status !== 'failed' && current.status !== 'canceled') {
    throw new InvalidTransitionError(current.status, 'queued');
  }
  const now = nowIso();
  const row = db.prepare(`
    UPDATE tasks
    SET status = 'queued', attempts = 0, last_error = NULL, finished_at = NULL, updated_at = ?
    WHERE id = ?
    RETURNING *
  `).get(now, id);
  return rowToTask(row);
}

/**
 * 服务重启时的恢复（单个 IMMEDIATE 事务）：所有 running 任务改回 queued，
 * 它们未结束的 run 标为 failed、error = 'interrupted'。返回受影响的任务 id（升序）。
 *
 * 取舍（规格未明说）：任务的 attempts / started_at 保留不重置——中断的那次算消耗掉，
 * 防止反复崩溃导致无限重试；run 的 finished_at 记恢复时刻，duration_ms 留 null，
 * 因为进程已死，真实耗时不可知（不拿停机时长冒充执行时长）。
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
 * 开始一次运行（status = running，prompts 先按默认 1 记，finishRun 时可覆盖）。
 * attempt 一般传任务当时的 attempts（≥ 1）。任务不存在抛 NotFoundError。
 * model / effort / logPath 必须是非空字符串，peak 布尔。
 */
export function startRun(db, { taskId, attempt, model, effort, peak, logPath } = {}) {
  assertPositiveInt(taskId, 'taskId');
  assertPositiveInt(attempt, 'attempt');
  const theModel = requiredTrimmed(model, 'model');
  const theEffort = requiredTrimmed(effort, 'effort');
  if (typeof peak !== 'boolean') {
    throw new ValidationError('peak', `必须是布尔值（当前值：${peak}）`);
  }
  const theLogPath = requiredTrimmed(logPath, 'logPath');
  taskRow(db, taskId); // 任务不存在时抛 NotFoundError
  const now = nowIso();
  const row = db.prepare(`
    INSERT INTO runs (task_id, attempt, model, effort, peak, status, prompts, log_path, started_at)
    VALUES (?, ?, ?, ?, ?, 'running', 1, ?, ?)
    RETURNING *
  `).get(taskId, attempt, theModel, theEffort, peak ? 1 : 0, theLogPath, now);
  return rowToRun(row);
}

const FINISH_RUN_STATUSES = ['succeeded', 'failed', 'timeout', 'canceled'];

/**
 * 结束一次运行：只允许 running → 终态，自动写 finished_at 并算 duration_ms
 * （finished_at - started_at，钳到至少 1ms：同毫秒开始并结束也算正数）。
 * exitCode / numTurns / prompts / quotaUnits / error 只有给了才更新（undefined = 保持）。
 * prompts 不给时保持 startRun 写入的默认 1。返回更新后的 run。
 */
export function finishRun(db, runId, { status, exitCode, numTurns, prompts, quotaUnits, error } = {}) {
  assertPositiveInt(runId, 'runId');
  if (!FINISH_RUN_STATUSES.includes(status)) {
    throw new ValidationError(
      'status',
      `finishRun 只接受 ${FINISH_RUN_STATUSES.join(' | ')}（当前值：${status}）`,
    );
  }
  const current = db.prepare('SELECT * FROM runs WHERE id = ?').get(runId);
  if (current === undefined) throw new NotFoundError(runId, 'run');
  if (current.status !== 'running') {
    throw new InvalidTransitionError(current.status, status, 'run');
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
  const row = db.prepare(`UPDATE runs SET ${sets.join(', ')} WHERE id = ? RETURNING *`).get(...params);
  return rowToRun(row);
}

/**
 * 运行记录列表：started_at DESC → id DESC（同毫秒开始的按新 id 在前）。
 * taskId 可选按任务过滤；since 可选（Date 或 ISO 字符串，含等于）过滤 started_at >= since；
 * limit 默认 100。
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

// 动态拼 SET 子句用：value !== undefined 才追加 `column = ?`（undefined = 保持原值）。
function appendOptionalColumn(sets, params, [column, value]) {
  if (value === undefined) return;
  sets.push(`${column} = ?`);
  params.push(value);
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
