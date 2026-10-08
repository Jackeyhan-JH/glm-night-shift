// 任务与运行记录的领域逻辑（issue #3）。所有函数第一个参数是 openDb() 的 DatabaseSync，
// 返回驼峰字段的普通对象：布尔（allowPeak / peak）转回真布尔，NULL 保持 null。
// 时间一律存 UTC ISO 字符串（约定见 #1），对外接受 Date 或 ISO 字符串（见 toIso）。
//
// 并发约定：调度器、看板、命令行会是不同进程，各自 openDb 同一个文件库（WAL +
// busy_timeout 支持多读单写）。因此所有状态流转都是「单条带状态守卫的原子
// UPDATE … WHERE id = ? AND status IN (…) RETURNING」——先到者的更新生效；后到者
// 未命中时重读库里的当前状态，抛 NotFoundError / InvalidTransitionError，绝不静默
// 覆盖别人的结果（例：看板刚取消了一个 running 任务，调度器再报成功会抛错而不是
// 把 canceled 改回 succeeded）。需要多步写入的操作（建任务 + 写依赖边、终态变更 +
// 级联失败、重试前的依赖检查）在这些原子 UPDATE 外面再套一层 SAVEPOINT，
// 整体一起提交或回滚（见 inSavepoint）。
import { DEFAULT_CONFIG } from './config.js';

/** tasks.status 的全部合法值。 */
export const TASK_STATUSES = ['queued', 'running', 'succeeded', 'failed', 'canceled'];
/** runs.status 的全部合法值。 */
export const RUN_STATUSES = ['running', 'succeeded', 'failed', 'timeout', 'canceled'];
/** runs.kind 的全部合法值（#12）：task 普通执行 / diagnosis 失败诊断。 */
export const RUN_KINDS = ['task', 'diagnosis'];
/** tasks.difficulty 的全部合法值。 */
export const DIFFICULTIES = ['easy', 'medium', 'hard'];

const REPO_PATTERN = /^[\w.-]+\/[\w.-]+$/;
const TITLE_MAX_CODE_POINTS = 60; // title 缺省时取 prompt 的前 60 个字符（按 Unicode 码点数）
// #48 跟进任务跟随的分支名：只认 night-shift/ 命名空间（与 branchName/pushBranch 一致），
// 斜杠后必须有名字。空格 / 绝对路径 / 其他前缀（main、master、feature/…）都过不了这个形状。
const GIT_REF_PATTERN = /^night-shift\/[A-Za-z0-9._/-]+$/;

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
 * 任务还在等依赖（#11）：claimTaskById 点名领取一个依赖未全部 succeeded 的 queued 任务。
 * 是 InvalidTransitionError（queued → running 不允许）的子类，所以按状态冲突处理
 * （HTTP 409、命令行退出码 1）的调用方无需改动；需要区分时看 err.blockedBy。
 * @property {number} id 被点名的任务
 * @property {number[]} blockedBy 还没 succeeded 的依赖 id（升序）
 */
export class DependencyBlockedError extends InvalidTransitionError {
  /**
   * @param {number} id 被点名的任务
   * @param {{id: number, status: string}[]} blockers 未完成的依赖（id 升序）
   */
  constructor(id, blockers) {
    super('queued', 'running');
    this.name = 'DependencyBlockedError';
    this.id = id;
    this.blockedBy = blockers.map((b) => b.id);
    this.message = `任务 #${id} 还在等依赖 ${blockers.map((b) => `#${b.id}（${b.status}）`).join('，')}，`
      + '依赖全部成功后才能运行';
  }
}

/**
 * @typedef {object} TaskRow 对外返回的任务对象（驼峰字段，布尔是真布尔，NULL 保持 null）。
 * @property {number} id
 * @property {string} repo `owner/name`
 * @property {?string} source 来源标识（#39）：import 建的任务是 `github:<repo>#<编号>`，
 *   手工 add 的为 null
 * @property {?string} gitRef 跟进的分支（#48）：follow 建的跟进任务把它设为父任务成功时
 *   推送的 night-shift/<id>-<slug> 分支，createWorktree 据此从 origin/<gitRef> 检出，
 *   改动落回原分支、PR 复用原来那一个；普通任务为 null
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
 * @property {?string} notBefore UTC ISO，限流退避的最早重试时刻（claimNextTask 在
 *   not_before > now 时跳过该任务）；null = 立刻可领
 * @property {string} createdAt UTC ISO
 * @property {string} updatedAt UTC ISO
 * @property {?string} startedAt UTC ISO，最近一次领取时间（重试再领会覆盖）
 * @property {?string} finishedAt UTC ISO，终态（含 canceled）达成时间；重试回排队时为 null
 * @property {number[]} dependsOn 依赖的任务 id（升序去重）；全部 succeeded 前不可领取
 * @property {number[]} blockedBy dependsOn 里还没 succeeded 的任务 id（升序）
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
 * @property {('task'|'diagnosis')} kind 运行类型（#12）：task 普通执行 / diagnosis
 *   失败诊断（诊断也是一次真实调用，同样计额度）
 * @property {?string} diagnosis 诊断文本（≤2000 字符）；写在**被诊断的那次失败运行**行上，
 *   诊断运行自己的行与其他运行为 null
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
 * @param {?string} [input.source=null] 来源标识（#39 的 import 用 `github:<repo>#<编号>`）；
 *   null = 手工添加、无来源；给了则 trim 后必须非空
 * @param {?string} [input.gitRef=null] 跟进的分支（#48）：null = 普通任务（从默认分支检出）；
 *   给了则 trim 后必须形如 `night-shift/<名字>`（拒绝空格、`..`、空路径段、绝对路径与
 *   其他前缀——`main` / `master` / 裸 `night-shift` 都不行），createWorktree 会从
 *   `origin/<gitRef>` 检出并沿用这个分支名
 * @param {('easy'|'medium'|'hard')} [input.difficulty='medium']
 * @param {number} [input.priority=0] 任意整数（越大越先被领取，负数合法）
 * @param {?string} [input.testCommand=null] null 或非空字符串
 * @param {boolean} [input.allowPeak=false]
 * @param {number} [input.maxAttempts=DEFAULT_CONFIG.maxAttempts] 正整数（当前默认 2）
 * @param {number[]} [input.dependsOn=[]] 依赖的任务 id：每个都必须存在且不是
 *   failed / canceled；重复 id 去重。校验失败抛 ValidationError（field='dependsOn'，
 *   message 点名是哪个 id、什么原因）
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
  const source = optionalTrimmed(input.source, 'source');
  const gitRef = validateGitRef(input.gitRef);
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
  // 先校验依赖再插任务：新任务的 id 尚不存在，把「依赖自己」自然归并进「不存在」。
  const dependsOn = normalizeDependsOn(input.dependsOn ?? []);
  validateDependencyTargets(db, null, dependsOn);

  const now = nowIso();
  const row = inSavepoint(db, () => {
    const inserted = db.prepare(`
      INSERT INTO tasks (repo, title, prompt, difficulty, priority, test_command, allow_peak,
                         status, attempts, max_attempts, source, git_ref, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?, ?, ?, ?)
      RETURNING *
    `).get(repo, title, prompt, difficulty, priority, testCommand, allowPeak ? 1 : 0, maxAttempts, source, gitRef, now, now);
    insertTaskDeps(db, inserted.id, dependsOn);
    return inserted;
  });
  return hydrateTasks(db, [row])[0];
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
  const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
  return row === undefined ? null : hydrateTasks(db, [row])[0];
}

/**
 * 按来源标识找已有任务（#39 的 import 去重用）：同 source 取 id 最小的一条，
 * **任意状态都算**（queued / running / succeeded / failed / canceled）——已经为这个
 * 来源建过任务就不再重复入队，不管它跑成什么样。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} source 来源标识（如 `github:a/b#12`），trim 后必须非空
 * @returns {?{id: number, status: string}} 没有同 source 的任务时 null
 * @throws {ValidationError} source 不是非空字符串（field='source'）
 */
export function findTaskBySource(db, source) {
  const theSource = requiredTrimmed(source, 'source');
  const row = db.prepare(
    'SELECT id, status FROM tasks WHERE source = ? ORDER BY id ASC LIMIT 1',
  ).get(theSource);
  return row === undefined ? null : { id: row.id, status: row.status };
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
  return hydrateTasks(db, db.prepare(`SELECT * FROM tasks ${where} ORDER BY ${order} LIMIT ?`)
    .all(...params));
}

/**
 * 原子领取下一个排队任务：单条 UPDATE（子查询选 id + `AND status = 'queued'` 双保险，
 * SQLite 写语句串行执行），两个连接 / 进程绝不会领到同一个任务。改为 running、
 * attempts + 1、写 started_at / updated_at。
 * 依赖未满足（dependsOn 里有还没 succeeded 的）任务被 NOT EXISTS 子查询排除，
 * 排序规则不变，仍是单条原子语句。
 *
 * not_before（限流退避，#9）：`not_before > now` 的任务跳过。now 接受 Date 或 ISO
 * 字符串（比较前规范化成 UTC ISO，与写入方 finishTask 的格式一致，字典序即时间序），
 * 缺省为当前时间；它**只**用于 not_before 过滤，started_at / updated_at 仍取真实
 * 当前时间（不跟着测试时钟走）。
 *
 * oneTaskPerRepo（#47）：true 时某仓库已有 running 任务，就先不领它的其他排队任务
 * （并发 > 1 时两个任务各自开 worktree 却都往同一默认分支推 PR，后推的常和先推的打架）。
 * 过滤同样是 NOT EXISTS 子查询，仍在这一条原子 UPDATE 的 SELECT 里——不是先领再退回
 * （那会白加 attempts）。只挡领取，不限制一个仓库能排多少条；同一仓库不管分支算同一把锁。
 * 调度器按配置传入；缺省 false = 行为与本开关加入前完全一致（claimTaskById 点名领取
 * 不走这里，不受此锁约束）。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {object} [options]
 * @param {boolean} [options.allowPeakOnly=false] true 时只领 allow_peak = 1 的任务
 * @param {boolean} [options.oneTaskPerRepo=false] true 时跳过所在仓库已有 running 任务的排队任务
 * @param {Date|string} [options.now] 判断 not_before 的基准时刻，缺省当前时间
 * @returns {?TaskRow} 被领取的任务；没有可领的返回 null。
 *   started_at 语义：最近一次领取时间（重试后再领会覆盖，配合 attempts 递增读）
 * @throws {ValidationError} allowPeakOnly / oneTaskPerRepo 非布尔，或 now 不是合法时间（field='now'）
 */
export function claimNextTask(db, { allowPeakOnly = false, oneTaskPerRepo = false, now } = {}) {
  if (typeof allowPeakOnly !== 'boolean') {
    throw new ValidationError('allowPeakOnly', `必须是布尔值（当前值：${allowPeakOnly}）`);
  }
  if (typeof oneTaskPerRepo !== 'boolean') {
    throw new ValidationError('oneTaskPerRepo', `必须是布尔值（当前值：${oneTaskPerRepo}）`);
  }
  const readyIso = now === undefined ? null : toIso(now, 'now');
  const currentIso = nowIso();
  const row = db.prepare(`
    UPDATE tasks
    SET status = 'running', attempts = attempts + 1, started_at = ?, updated_at = ?
    WHERE id = (
      SELECT id FROM tasks
      WHERE status = 'queued' ${allowPeakOnly ? 'AND allow_peak = 1' : ''}
        AND (not_before IS NULL OR not_before <= ?)
        AND NOT EXISTS (
          SELECT 1
          FROM task_deps d JOIN tasks dep ON dep.id = d.depends_on
          WHERE d.task_id = tasks.id AND dep.status != 'succeeded'
        )
        ${oneTaskPerRepo ? `AND NOT EXISTS (
          SELECT 1
          FROM tasks busy
          WHERE busy.repo = tasks.repo AND busy.status = 'running'
        )` : ''}
      ORDER BY priority DESC, created_at ASC, id ASC
      LIMIT 1
    ) AND status = 'queued'
    RETURNING *
  `).get(currentIso, currentIso, readyIso ?? currentIso);
  return row === undefined ? null : hydrateTasks(db, [row])[0];
}

/**
 * 按 id 领取任务（#9 的 runNow 用）：只领 queued，语义同 claimNextTask（原子 UPDATE
 * 带状态守卫、attempts + 1、覆盖 started_at）。与 claimNextTask 不同：不排序、不看
 * not_before / allow_peak——runNow 是用户点名「现在就跑」，无视一切退避与高峰限制。
 *
 * 但**不绕过依赖门**（#11）：依赖里还有没 succeeded 的任务时不领取，抛
 * DependencyBlockedError（InvalidTransitionError 的子类，HTTP 映射 409、命令行退出 1）。
 * 理由：退避 / 高峰是「什么时候跑划算」的策略，用户可以拍板无视；依赖没完成则是
 * 「上游产出还不存在」，此时硬跑只会白花额度做无用功。门与状态守卫在同一条 UPDATE 里，
 * 原子：判定与领取之间不会有上游状态变化的窗口。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} id 正整数
 * @returns {TaskRow} 被领取的任务
 * @throws {ValidationError} id 非正整数
 * @throws {NotFoundError} 任务不存在
 * @throws {DependencyBlockedError} 任务是 queued 但依赖未全部 succeeded（err.blockedBy 列出 id）
 * @throws {InvalidTransitionError} 任务当前不是 queued（err.from 是库里实际的当前状态）
 */
export function claimTaskById(db, id) {
  assertPositiveInt(id, 'id');
  const now = nowIso();
  const row = db.prepare(`
    UPDATE tasks
    SET status = 'running', attempts = attempts + 1, started_at = ?, updated_at = ?
    WHERE id = ? AND status = 'queued'
      AND NOT EXISTS (
        SELECT 1
        FROM task_deps d JOIN tasks dep ON dep.id = d.depends_on
        WHERE d.task_id = tasks.id AND dep.status != 'succeeded'
      )
    RETURNING *
  `).get(now, now, id);
  if (row === undefined) {
    const current = db.prepare('SELECT status FROM tasks WHERE id = ?').get(id);
    if (current?.status === 'queued') {
      const blockers = db.prepare(`
        SELECT d.depends_on AS id, dep.status AS status
        FROM task_deps d JOIN tasks dep ON dep.id = d.depends_on
        WHERE d.task_id = ? AND dep.status != 'succeeded'
        ORDER BY d.depends_on ASC
      `).all(id);
      if (blockers.length > 0) throw new DependencyBlockedError(id, blockers);
    }
    throw staleTransitionError(db, id, 'running');
  }
  return hydrateTasks(db, [row])[0];
}

// ---------------------------------------------------------------- 任务状态流转

const FINISH_TASK_STATUSES = ['succeeded', 'failed', 'queued'];

/**
 * 结束一个 running 任务。原子：UPDATE 带 `status = 'running'` 守卫，未命中（任务不存在，
 * 或状态已被别的连接改掉）时重读库里的当前状态抛错，不会静默覆盖并发操作的结果。
 *
 * queued 分支额外支持（#9 调度器）：
 * - `refundAttempt: true` —— 退还这次尝试（attempts − 1，钳到 0）。限流、停机中断、
 *   闸门二次确认未通过这类「不算任务自身失败」的放回用它；普通失败重试不用。
 * - `notBefore`（Date 或 ISO 字符串，null = 清空）—— 限流退避的最早重试时刻，
 *   claimNextTask 会跳过 not_before > now 的任务；retryTask 重置任务时清空。
 * 两者都只允许配 queued（终态没有重试语义）。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} id 正整数
 * @param {object} fields
 * @param {('succeeded'|'failed'|'queued')} fields.status queued 表示排回队列重试
 * @param {?string} [fields.lastError] undefined = 保持原值；给了则覆盖（null = 清空）
 * @param {?string} [fields.prUrl] 同上
 * @param {?string} [fields.branch] 同上
 * @param {Date|string|null} [fields.notBefore] 仅 queued：最早重试时刻（写入前规范化
 *   成 UTC ISO）；undefined = 保持原值，null = 清空
 * @param {boolean} [fields.refundAttempt=false] 仅 queued：true 时 attempts − 1（不低于 0）
 * @returns {TaskRow} 更新后的任务。终态写 finished_at，重试（queued）清空它；
 *   started_at 不动，仍是最近一次领取时间；attempts 除 refundAttempt 外不变
 * @throws {ValidationError} id 非正整数、status 不在允许集合（field='status'）、
 *   lastError/prUrl/branch 给了却不是字符串或 null、refundAttempt 非布尔、
 *   notBefore 不是合法时间（field='notBefore'），或 notBefore/refundAttempt
 *   配了非 queued 的目标状态
 * @throws {NotFoundError} 任务不存在
 * @throws {InvalidTransitionError} 当前状态不是 running（err.from 是库里实际的当前状态）
 */
export function finishTask(db, id, { status, lastError, prUrl, branch, notBefore, refundAttempt = false } = {}) {
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
  if (typeof refundAttempt !== 'boolean') {
    throw new ValidationError('refundAttempt', `必须是布尔值（当前值：${refundAttempt}）`);
  }
  let notBeforeIso; // undefined = 不更新
  if (notBefore !== undefined) {
    notBeforeIso = notBefore === null ? null : toIso(notBefore, 'notBefore');
  }
  if ((refundAttempt || notBeforeIso !== undefined) && status !== 'queued') {
    throw new ValidationError(
      refundAttempt ? 'refundAttempt' : 'notBefore',
      `只在重试（queued）时可用，当前 status 是 ${status}`,
    );
  }
  const now = nowIso();
  const sets = ['status = ?', 'updated_at = ?', 'finished_at = ?'];
  const params = [status, now, status === 'queued' ? null : now];
  if (refundAttempt) sets.push('attempts = MAX(0, attempts - 1)');
  appendOptionalColumn(sets, params, ['last_error', lastError]);
  appendOptionalColumn(sets, params, ['pr_url', prUrl]);
  appendOptionalColumn(sets, params, ['branch', branch]);
  appendOptionalColumn(sets, params, ['not_before', notBeforeIso]);
  params.push(id);
  const row = inSavepoint(db, () => {
    const updated = db.prepare(
      `UPDATE tasks SET ${sets.join(', ')} WHERE id = ? AND status = 'running' RETURNING *`,
    ).get(...params);
    if (updated === undefined) throw staleTransitionError(db, id, status);
    // 级联失败与本次状态变更同一事务（保存点）：要么都生效，要么都不留痕。
    if (status === 'failed') cascadeFailDependents(db, id, now, '失败');
    return updated;
  });
  return hydrateTasks(db, [row])[0];
}

/**
 * 取消任务：queued | running → canceled（终态，写 finished_at）。
 * 原子：UPDATE 带源状态守卫，并发下后到者抛错而不是覆盖；取消与级联失败
 * （把还排着队的下游任务标为 failed）在同一个保存点事务里完成。
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
  const row = inSavepoint(db, () => {
    const updated = db.prepare(`
      UPDATE tasks
      SET status = 'canceled', finished_at = ?, updated_at = ?
      WHERE id = ? AND status IN ('queued', 'running')
      RETURNING *
    `).get(now, now, id);
    if (updated === undefined) throw staleTransitionError(db, id, 'canceled');
    cascadeFailDependents(db, id, now, '已取消');
    return updated;
  });
  return hydrateTasks(db, [row])[0];
}

/**
 * 重新排队：failed | canceled → queued；attempts 归零、last_error / finished_at /
 * not_before 清空；started_at 保留（下次领取时覆盖），branch / pr_url 也保留
 * （接着上次的开 PR 结果）。
 * 依赖里还有 failed / canceled 的不能重试（要按顺序先重试上游）；重试上游也**不会**
 * 自动恢复因它级联失败的下游——下游要单独 retry。读依赖 + 更新在同一个保存点事务里，
 * 并发下不会出现「校验时依赖还失败、更新时已被别人重试」的窗口。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} id 正整数
 * @returns {TaskRow} 更新后的任务
 * @throws {ValidationError} id 非正整数，或依赖里还有 failed / canceled 的任务
 *   （field='dependsOn'，message 点名是哪个 id、什么状态）
 * @throws {NotFoundError} 任务不存在
 * @throws {InvalidTransitionError} 当前状态不是 failed / canceled
 */
export function retryTask(db, id) {
  assertPositiveInt(id, 'id');
  const now = nowIso();
  const row = inSavepoint(db, () => {
    const blocker = db.prepare(`
      SELECT d.depends_on AS id, t.status AS status
      FROM task_deps d JOIN tasks t ON t.id = d.depends_on
      WHERE d.task_id = ? AND t.status IN ('failed', 'canceled')
      ORDER BY d.depends_on ASC
      LIMIT 1
    `).get(id);
    if (blocker !== undefined) {
      throw new ValidationError('dependsOn', `依赖 #${blocker.id} 仍是 ${blocker.status}，请先重试它`);
    }
    const updated = db.prepare(`
      UPDATE tasks
      SET status = 'queued', attempts = 0, last_error = NULL, finished_at = NULL,
          not_before = NULL, updated_at = ?
      WHERE id = ? AND status IN ('failed', 'canceled')
      RETURNING *
    `).get(now, id);
    if (updated === undefined) throw staleTransitionError(db, id, 'queued');
    return updated;
  });
  return hydrateTasks(db, [row])[0];
}

/** updateTask 允许出现的 patch 字段（#46）。其余键（repo / source / status / attempts /
 * branch / prUrl / 未知字段）带了就是校验错误，点名该字段。 */
const UPDATABLE_FIELDS = [
  'title', 'prompt', 'difficulty', 'priority', 'testCommand', 'allowPeak', 'maxAttempts', 'dependsOn',
];

/**
 * 修改排队中的任务（#46）。patch 里出现哪个字段才改哪个，不出现的保持原值：
 * - `title` / `prompt`：trim 后必须非空；
 * - `difficulty`：`easy | medium | hard`；
 * - `priority`：整数（负数合法，同 createTask）；
 * - `testCommand`：非空字符串，或 `null` 表示清掉；
 * - `allowPeak`：布尔；
 * - `maxAttempts`：正整数；
 * - `dependsOn`：出现就整组替换（规则与 setDependencies 相同：目标必须存在、不能是
 *   failed / canceled、不能成环），不出现则依赖不动。
 * repo / source / status / attempts / branch / prUrl 与任何未知字段不允许出现在
 * patch 里，带了抛 ValidationError 点名字段，任务原样不动（什么都不写）。一个
 * 可改字段都没给也是校验错误（field='patch'）。字段更新与依赖替换在同一个保存点
 * 事务里：dependsOn 校验失败时，本次的其他字段更新一并回滚。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} id 正整数
 * @param {object} patch 要修改的字段（出现才改）
 * @returns {TaskRow} 更新后的任务（updated_at 已前进；repo / source / status /
 *   attempts / branch / prUrl / createdAt / id 不变，领取顺序规则也不受影响）
 * @throws {ValidationError} id 非正整数、patch 为空、带了不可修改的字段，或任一
 *   字段不合法（err.field 指明字段）
 * @throws {NotFoundError} 任务不存在
 * @throws {InvalidTransitionError} 任务当前不是 queued（message 为
 *   「只有排队中的任务可以修改…」并点名当前状态；仍是 InvalidTransitionError，
 *   HTTP 层照常映射 409）
 */
export function updateTask(db, id, patch = {}) {
  assertPositiveInt(id, 'id');
  const input = patch ?? {};
  const updatable = new Set(UPDATABLE_FIELDS);
  for (const key of Object.keys(input)) {
    if (!updatable.has(key)) {
      throw new ValidationError(key, `不能修改（updateTask 只接受：${UPDATABLE_FIELDS.join(' | ')}）`);
    }
  }
  const has = (key) => input[key] !== undefined;
  const fields = {}; // 归一化后的普通字段值（dependsOn 单独处理）
  if (has('title')) fields.title = requiredTrimmed(input.title, 'title');
  if (has('prompt')) fields.prompt = requiredTrimmed(input.prompt, 'prompt');
  if (has('difficulty')) {
    if (!DIFFICULTIES.includes(input.difficulty)) {
      throw new ValidationError('difficulty', `必须是 ${DIFFICULTIES.join(' | ')} 之一（当前值：${input.difficulty}）`);
    }
    fields.difficulty = input.difficulty;
  }
  if (has('priority')) {
    if (!Number.isInteger(input.priority)) {
      throw new ValidationError('priority', `必须是整数（当前值：${input.priority}）`);
    }
    fields.priority = input.priority;
  }
  if (has('testCommand')) {
    fields.testCommand = input.testCommand === null
      ? null // null = 清掉
      : requiredTrimmed(input.testCommand, 'testCommand');
  }
  if (has('allowPeak')) {
    if (typeof input.allowPeak !== 'boolean') {
      throw new ValidationError('allowPeak', `必须是布尔值（当前值：${input.allowPeak}）`);
    }
    fields.allowPeak = input.allowPeak;
  }
  if (has('maxAttempts')) {
    if (!Number.isInteger(input.maxAttempts) || input.maxAttempts < 1) {
      throw new ValidationError('maxAttempts', `必须是正整数（当前值：${input.maxAttempts}）`);
    }
    fields.maxAttempts = input.maxAttempts;
  }
  const dependsOn = has('dependsOn') ? normalizeDependsOn(input.dependsOn) : undefined;
  if (Object.keys(fields).length === 0 && dependsOn === undefined) {
    throw new ValidationError('patch', `至少给一个要修改的字段（${UPDATABLE_FIELDS.join(' | ')}）`);
  }

  // patch 字段名 → tasks 列名（驼峰转蛇形，allowPeak 顺手转 0/1）。
  const COLUMN_OF = new Map([
    ['title', 'title'],
    ['prompt', 'prompt'],
    ['difficulty', 'difficulty'],
    ['priority', 'priority'],
    ['testCommand', 'test_command'],
    ['allowPeak', 'allow_peak'],
    ['maxAttempts', 'max_attempts'],
  ]);
  const now = nowIso();
  return inSavepoint(db, () => {
    const current = taskRow(db, id); // 不存在 → NotFoundError
    if (current.status !== 'queued') throw notEditableError(id, current.status);
    const sets = ['updated_at = ?'];
    const params = [now];
    for (const [field, column] of COLUMN_OF) {
      if (fields[field] === undefined) continue;
      sets.push(`${column} = ?`);
      params.push(field === 'allowPeak' ? (fields.allowPeak ? 1 : 0) : fields[field]);
    }
    params.push(id);
    // 与其他状态流转同样带 status = 'queued' 守卫：读与写之间被并发领取/取消时
    // 未命中，重读现状报错，不覆盖别人的结果。
    const updated = db.prepare(
      `UPDATE tasks SET ${sets.join(', ')} WHERE id = ? AND status = 'queued' RETURNING *`,
    ).get(...params);
    if (updated === undefined) {
      throw notEditableError(id, taskRow(db, id).status);
    }
    if (dependsOn !== undefined) {
      // 整组替换依赖，复用 deps --set 的全部规则与报错文案；它在自己的保存点里，
      // 失败会连同上面的字段更新一起回滚（本函数的外层保存点）。
      return setDependencies(db, id, dependsOn);
    }
    return hydrateTasks(db, [updated])[0];
  });
}

/**
 * updateTask 对非 queued 任务的报错：沿用 InvalidTransitionError（调用方按状态冲突
 * 处理：HTTP 409、命令行退出码 1），但 message 换成「只有排队中的任务可以修改」并
 * 点名当前状态——构造器的默认文案是给状态流转（cancel / retry / claim）用的，别处
 * 有测试断言，不能改，这里只在实例上覆盖 message。from 仍是库里实际的当前状态。
 */
function notEditableError(id, status) {
  const err = new InvalidTransitionError(status, 'queued');
  err.message = `只有排队中的任务可以修改（任务 #${id} 当前是 ${status}）`;
  return err;
}

// ---------------------------------------------------------------- 依赖

/**
 * 修改任务的依赖（整体替换）。只允许 queued 任务；每个依赖 id 必须存在、不能是自己、
 * 不能是 failed / canceled；新依赖与已有依赖边合在一起不能成环。
 * 替换（删旧插新）在同一个保存点事务里完成。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} taskId 正整数
 * @param {number[]} ids 新的依赖 id 列表（[] = 清空依赖）；重复 id 去重
 * @returns {TaskRow} 更新后的任务（dependsOn 已是 新值）
 * @throws {ValidationError} taskId 非正整数；ids 形状不对、含不存在 / 自己 /
 *   failed / canceled 的 id，或会形成依赖环（field='dependsOn'，环信息如 #1 → #2 → #1）
 * @throws {NotFoundError} 任务不存在
 * @throws {InvalidTransitionError} 任务当前不是 queued
 */
export function setDependencies(db, taskId, ids = []) {
  assertPositiveInt(taskId, 'id');
  const deps = normalizeDependsOn(ids);
  taskRow(db, taskId); // 不存在时抛 NotFoundError
  return inSavepoint(db, () => {
    // 状态检查、目标校验、写边、查环都在同一保存点里，任何一步失败整体回滚；
    // 环检测在**写入后**的完整图上做（从新依赖出发找回到自己的路径），即使别的
    // 连接同时加边也逃不过。要完全串行得 BEGIN IMMEDIATE，但那会与调用方自己的
    // 事务冲突——遵循 #3 的原子更新模型，窗口到事务内为止。
    const { status } = db.prepare('SELECT status FROM tasks WHERE id = ?').get(taskId);
    if (status !== 'queued') {
      throw new InvalidTransitionError(status, 'queued');
    }
    db.prepare('DELETE FROM task_deps WHERE task_id = ?').run(taskId);
    validateDependencyTargets(db, taskId, deps);
    insertTaskDeps(db, taskId, deps);
    const cycle = findDependencyCycle(db, taskId, deps);
    if (cycle !== null) {
      throw new ValidationError('dependsOn', `会形成依赖环：${cycle.map((id) => `#${id}`).join(' → ')}`);
    }
    return hydrateTasks(db, [taskRow(db, taskId)])[0];
  });
}

/**
 * 某任务依赖的各任务（id + 当前状态），id 升序；给 deps / show 展示用。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} taskId 正整数
 * @returns {{id: number, status: string}[]}
 * @throws {ValidationError} taskId 非正整数
 */
export function listDependencies(db, taskId) {
  assertPositiveInt(taskId, 'taskId');
  return db.prepare(`
    SELECT d.depends_on AS id, t.status AS status
    FROM task_deps d JOIN tasks t ON t.id = d.depends_on
    WHERE d.task_id = ?
    ORDER BY d.depends_on ASC
  `).all(taskId).map((row) => ({ id: row.id, status: row.status }));
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
 * @param {('task'|'diagnosis')} [input.kind='task'] 运行类型（#12）：诊断运行传
 *   'diagnosis'（attempt 与被诊断的失败运行相同）
 * @param {string} input.logPath 空串或非空字符串。空串合法：#7 的 runTask 先 startRun
 *   拿到 id（日志路径里要用它），再立刻 setRunLogPath 补上真实路径；纯空白仍然非法。
 * @returns {RunRow} 新建的 run
 * @throws {ValidationError} 任一字段缺失或类型不对（err.field 指明字段）
 * @throws {NotFoundError} 任务不存在
 */
export function startRun(db, { taskId, attempt, model, effort, peak, kind = 'task', logPath } = {}) {
  assertPositiveInt(taskId, 'taskId');
  assertPositiveInt(attempt, 'attempt');
  const theModel = requiredTrimmed(model, 'model');
  const theEffort = requiredTrimmed(effort, 'effort');
  if (typeof peak !== 'boolean') {
    throw new ValidationError('peak', `必须是布尔值（当前值：${peak}）`);
  }
  if (!RUN_KINDS.includes(kind)) {
    throw new ValidationError('kind', `必须是 ${RUN_KINDS.join(' | ')} 之一（当前值：${kind}）`);
  }
  // 空串放行（见上），其余交给 requiredTrimmed：非字符串 / 纯空白照样报错。
  const theLogPath = logPath === '' ? '' : requiredTrimmed(logPath, 'logPath');
  taskRow(db, taskId); // 任务不存在时抛 NotFoundError
  const now = nowIso();
  const row = db.prepare(`
    INSERT INTO runs (task_id, attempt, model, effort, peak, status, prompts, kind, log_path, started_at)
    VALUES (?, ?, ?, ?, ?, 'running', 1, ?, ?, ?)
    RETURNING *
  `).get(taskId, attempt, theModel, theEffort, peak ? 1 : 0, kind, theLogPath, now);
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
 * 把诊断文本写到一次运行的 runs.diagnosis 上（#12）。诊断写在**被诊断的那次失败运行**
 * 行上；诊断运行自己的行不写（它的结果就是这段文本的来源）。单条 UPDATE，无状态守卫
 * （失败运行早已结束，不存在并发改写结果的窗口）；run 不存在时抛 NotFoundError。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} runId 正整数
 * @param {?string} text 诊断文本（非空白字符串；null = 清空）
 * @returns {RunRow} 更新后的 run
 * @throws {ValidationError} runId 非正整数，或 text 不是非空白字符串 / null（field='diagnosis'）
 * @throws {NotFoundError} run 不存在
 */
export function setRunDiagnosis(db, runId, text) {
  assertPositiveInt(runId, 'runId');
  if (text !== null && (typeof text !== 'string' || text.trim() === '')) {
    throw new ValidationError('diagnosis', `必须是非空白字符串或 null（当前值：${text}）`);
  }
  const row = db.prepare('UPDATE runs SET diagnosis = ? WHERE id = ? RETURNING *')
    .get(text, runId);
  if (row === undefined) throw new NotFoundError(runId, 'run');
  return rowToRun(row);
}

/**
 * 运行记录列表：started_at DESC → id DESC（同毫秒开始的按新 id 在前）。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {object} [options]
 * @param {number} [options.taskId] 正整数，按任务过滤
 * @param {('task'|'diagnosis')} [options.kind] 按运行类型过滤（#12）：'diagnosis' 只看
 *   诊断运行，'task' 只看普通执行；缺省看全部
 * @param {Date|string} [options.since] 只取 started_at >= since（含等于）；字符串须能被
 *   Date.parse 解析，比较前统一规范化成 UTC ISO
 * @param {number} [options.limit=100] 正整数
 * @returns {RunRow[]}
 * @throws {ValidationError} taskId / limit 非正整数、kind 不在枚举里（field='kind'），
 *   或 since 不是合法时间（field='since'）
 */
export function listRuns(db, { taskId, kind, since, limit = 100 } = {}) {
  if (taskId !== undefined) assertPositiveInt(taskId, 'taskId');
  if (kind !== undefined && !RUN_KINDS.includes(kind)) {
    throw new ValidationError('kind', `必须是 ${RUN_KINDS.join(' | ')} 之一（当前值：${kind}）`);
  }
  const sinceIso = since === undefined ? undefined : toIso(since, 'since');
  assertPositiveInt(limit, 'limit');
  const where = [];
  const params = [];
  if (taskId !== undefined) {
    where.push('task_id = ?');
    params.push(taskId);
  }
  if (kind !== undefined) {
    where.push('kind = ?');
    params.push(kind);
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

/**
 * 按 id 取运行记录。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} id 正整数
 * @returns {?RunRow} 不存在返回 null（操作类函数才抛 NotFoundError）
 * @throws {ValidationError} id 不是正整数（field='id'）
 */
export function getRun(db, id) {
  assertPositiveInt(id, 'id');
  return rowToRun(db.prepare('SELECT * FROM runs WHERE id = ?').get(id));
}

// ---------------------------------------------------------------- meta（手动暂停 #38）

/** meta 表里手动暂停标记的键：值为 '1'（暂停领取新任务）或 '0'；缺行 = 未暂停。 */
export const USER_PAUSED_KEY = 'userPaused';

/**
 * 读手动暂停标记（#38）：meta.userPaused 为 '1' 表示用户要求暂不领取新任务，
 * 缺行 / 其他值都按未暂停处理。每次调用直接查库、不在进程里缓存——调度器、
 * 看板、命令行是多进程共享同一个文件库，谁改了都要立刻被别人看见。
 * 与调度器内存里的限流退避（pausedUntil）互相独立，读这里不影响那边。
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {boolean}
 */
export function getUserPaused(db) {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(USER_PAUSED_KEY);
  return row?.value === '1';
}

/**
 * 写手动暂停标记（#38）：paused → '1' / '0'（UPSERT，幂等，重复写同值不报错）。
 * 只动 meta 这一行：不清限流退避（pausedUntil / rateLimitBackoffMinutes）、
 * 不碰任务自己的 not_before——恢复领取 ≠ 限流已过。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {boolean} paused
 */
export function setUserPaused(db, paused) {
  db.prepare(`
    INSERT INTO meta (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(USER_PAUSED_KEY, paused ? '1' : '0');
}

// ---------------------------------------------------------------- 辅助

function nowIso() {
  return new Date().toISOString();
}

/**
 * 在保存点里执行 fn：调用方自己开着事务时是内嵌局部回滚，没开时（常态）SAVEPOINT
 * 会隐式开一个事务、RELEASE 时提交——两种情况下 fn 都原子。node:sqlite（22.13）没有
 * 可靠的 isTransaction 探测，所以统一用 SAVEPOINT 而不是 BEGIN/COMMIT。
 * @template T
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {() => T} fn
 * @returns {T}
 */
function inSavepoint(db, fn) {
  db.exec('SAVEPOINT night_shift_task');
  try {
    const result = fn();
    db.exec('RELEASE SAVEPOINT night_shift_task');
    return result;
  } catch (err) {
    try {
      db.exec('ROLLBACK TO SAVEPOINT night_shift_task');
      db.exec('RELEASE SAVEPOINT night_shift_task');
    } catch {
      // 保存点已不在（连接级回滚）：保留原始错误，别让清理的报错盖住它
    }
    throw err;
  }
}

/** dependsOn 入参形状校验：必须是正整数 id 的数组（安全整数）；去重 + 升序后返回。 */
function normalizeDependsOn(ids) {
  if (!Array.isArray(ids)) {
    throw new ValidationError('dependsOn', `必须是 id 数组（当前值：${ids}）`);
  }
  const out = [];
  for (const id of ids) {
    if (!Number.isSafeInteger(id) || id < 1) {
      throw new ValidationError('dependsOn', `id 必须是正整数（当前值：${id}）`);
    }
    if (!out.includes(id)) out.push(id);
  }
  return out.sort((a, b) => a - b);
}

/**
 * 逐个校验依赖目标：存在、不是 self、不是 failed / canceled。
 * 不满足抛 ValidationError（field='dependsOn'），message 点名哪个 id、什么原因。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {?number} self 自己的 id（createTask 还没有 id，传 null）
 * @param {number[]} deps 已归一化的依赖 id
 */
function validateDependencyTargets(db, self, deps) {
  const select = db.prepare('SELECT status FROM tasks WHERE id = ?');
  for (const id of deps) {
    if (id === self) {
      throw new ValidationError('dependsOn', `#${id} 不能依赖自己`);
    }
    const row = select.get(id);
    if (row === undefined) {
      throw new ValidationError('dependsOn', `#${id} 不存在`);
    }
    if (row.status === 'failed' || row.status === 'canceled') {
      throw new ValidationError('dependsOn', `#${id} 已是 ${row.status}，不能作为依赖`);
    }
  }
}

/**
 * 从每个新依赖出发沿「X 依赖 Y」的已有边找环：能走回 taskId 就成环。
 * 返回环路径（首尾都是 taskId，如 [1, 2, 1]），无环返回 null。
 * 只需检查穿过 taskId 的环——不改别人的边，别的环不会被创建。
 *
 * 迭代 DFS（显式栈）而不是递归：几万级的长依赖链（每个任务依赖前一个）造得出来，
 * 递归会撑爆 JS 调用栈（SQLite 侧的级联 CTE 是队列实现，不受此限）。parent 记录
 * 「从谁走到这个节点」，走到 taskId 后沿 parent 链回溯即得完整环路径。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} taskId 要改依赖的任务
 * @param {number[]} deps 归一化后的新依赖 id
 * @returns {?number[]}
 */
function findDependencyCycle(db, taskId, deps) {
  if (deps.length === 0) return null;
  const selectDeps = db.prepare(
    'SELECT depends_on FROM task_deps WHERE task_id = ? ORDER BY depends_on ASC',
  );
  const parent = new Map(); // 节点 → 从哪个节点走到它；种子依赖的父是 taskId
  const stack = [];
  for (const dep of deps) {
    parent.set(dep, taskId);
    stack.push(dep);
  }
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === taskId) {
      // 沿 parent 链取回 taskId ← … ← 种子，反转就是正向路径，首尾都是 taskId
      const back = [];
      for (let cur = parent.get(taskId); cur !== taskId; cur = parent.get(cur)) {
        back.push(cur);
      }
      return [taskId, ...back.reverse(), taskId];
    }
    for (const row of selectDeps.all(node)) {
      if (!parent.has(row.depends_on)) {
        parent.set(row.depends_on, node);
        stack.push(row.depends_on);
      }
    }
  }
  return null;
}

/** 写入依赖边（调用方已校验）。 */
function insertTaskDeps(db, taskId, deps) {
  if (deps.length === 0) return;
  const insert = db.prepare('INSERT INTO task_deps (task_id, depends_on) VALUES (?, ?)');
  for (const dep of deps) insert.run(taskId, dep);
}

/**
 * 给查询出来的任务行补上 dependsOn / blockedBy：一次 IN 查询取回这批任务的全部
 * 依赖边（不是每任务一查），依赖里还没 succeeded 的进 blockedBy。两边都升序。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {object[]} rows SELECT/RETURNING 出的任务行
 * @returns {TaskRow[]}
 */
function hydrateTasks(db, rows) {
  if (rows.length === 0) return rows;
  // 分批查依赖边：批大小远小于 SQLite 的绑定变量上限，任务再多也不会撞上；
  // 批数是 rows.length / 批大小，仍然不是每任务一查。
  const BATCH = 500;
  const edges = [];
  for (let start = 0; start < rows.length; start += BATCH) {
    const ids = rows.slice(start, start + BATCH).map((row) => row.id);
    edges.push(...db.prepare(`
      SELECT d.task_id AS taskId, d.depends_on AS depId, t.status AS status
      FROM task_deps d JOIN tasks t ON t.id = d.depends_on
      WHERE d.task_id IN (${ids.map(() => '?').join(', ')})
    `).all(...ids));
  }
  const byTask = new Map();
  for (const edge of edges) {
    let entry = byTask.get(edge.taskId);
    if (entry === undefined) {
      entry = { dependsOn: [], blockedBy: [] };
      byTask.set(edge.taskId, entry);
    }
    entry.dependsOn.push(edge.depId);
    if (edge.status !== 'succeeded') entry.blockedBy.push(edge.depId);
  }
  for (const entry of byTask.values()) {
    entry.dependsOn.sort((a, b) => a - b);
    entry.blockedBy.sort((a, b) => a - b);
  }
  return rows.map((row) => {
    const entry = byTask.get(row.id) ?? { dependsOn: [], blockedBy: [] };
    return rowToTask(row, entry.dependsOn, entry.blockedBy);
  });
}

/**
 * 级联失败：把所有直接或间接依赖 triggerId、且还在 queued 的任务改为 failed，
 * last_error 指名各自**直接**依赖的那个（`依赖 #<n> 失败` / `依赖 #<n> 已取消`，
 * 由 failureText 决定），并写 finished_at / updated_at。
 *
 * 单条语句完成：递归 CTE 找出（task_id, blocker）对——blocker 是该任务直接依赖的、
 * 正被这次变更干掉的依赖（对间接依赖者来说是级联失败的那个直接依赖）。同一任务有
 * 多个 blocker 时取 MIN，报错确定。注意不能用 SET 里的相关子查询取 blocker：递归
 * CTE 物化后没有索引，每行更新都全扫一遍，几万级长链是 O(n²)（实测 2 万链约 13 秒）；
 * UPDATE…FROM 先按 task_id GROUP BY 成小表再等值连接，整体 O(n)（实测毫秒级）。
 * 只碰 queued 任务（领取门已保证运行中的下游依赖都已 succeeded，正常流程到不了
 * 这里，守住即可）。必须与触发它的 finishTask / cancelTask 在同一事务（保存点）里调用。
 */
function cascadeFailDependents(db, triggerId, now, failureText) {
  db.prepare(`
    WITH RECURSIVE dependents(task_id, blocker) AS (
      SELECT d.task_id, d.depends_on
      FROM task_deps d
      WHERE d.depends_on = ?
        AND EXISTS (SELECT 1 FROM tasks t WHERE t.id = d.task_id AND t.status = 'queued')
      UNION
      SELECT d.task_id, d.depends_on
      FROM task_deps d
      JOIN dependents p ON d.depends_on = p.task_id
      WHERE EXISTS (SELECT 1 FROM tasks t WHERE t.id = d.task_id AND t.status = 'queued')
    )
    UPDATE tasks
    SET status = 'failed',
        last_error = '依赖 #' || m.blocker || ?,
        finished_at = ?,
        updated_at = ?
    FROM (SELECT task_id, MIN(blocker) AS blocker FROM dependents GROUP BY task_id) AS m
    WHERE tasks.id = m.task_id AND tasks.status = 'queued'
  `).run(triggerId, ` ${failureText}`, now, now);
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

/**
 * gitRef 校验（#48）：undefined/null → null（普通任务）；给了则 trim 后必须是
 * night-shift/ 命名空间下的分支名。逐条给出不合法的原因（ValidationError 的
 * message 点名），拒绝：空 / 纯空白、空格、`..`、空路径段（`//` 或以 `/` 结尾）、
 * 绝对路径、其他前缀（`main`、`master`、裸 `night-shift`、`feature/…` 都不行）。
 * @returns {?string} null 或 trim 后的合法分支名
 */
function validateGitRef(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    throw new ValidationError('gitRef', `必须是字符串或 null（当前值：${value}）`);
  }
  const gitRef = value.trim();
  if (gitRef === '') {
    throw new ValidationError('gitRef', '不能为空字符串（不跟分支就传 null）');
  }
  if (!GIT_REF_PATTERN.test(gitRef)) {
    throw new ValidationError(
      'gitRef',
      `必须是 night-shift/ 开头的分支名，斜杠后还要有名字（当前值：${gitRef}）；`
        + 'main、master 或其他前缀不行',
    );
  }
  if (gitRef.includes('..')) {
    throw new ValidationError('gitRef', `不能包含 ..（当前值：${gitRef}）`);
  }
  if (gitRef.includes('//') || gitRef.endsWith('/')) {
    throw new ValidationError('gitRef', `不能包含空路径段（当前值：${gitRef}）`);
  }
  return gitRef;
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

function rowToTask(row, dependsOn = [], blockedBy = []) {
  if (row === undefined) return null;
  return {
    id: row.id,
    repo: row.repo,
    source: row.source ?? null,
    gitRef: row.git_ref ?? null,
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
    notBefore: row.not_before,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    dependsOn,
    blockedBy,
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
    // #12 迁移（版本 4）的 runs.kind / runs.diagnosis，#16 详情页靠这里透传：
    // kind 为空则类型列不显示，diagnosis 有值才展开。两边都留，不重复键。
    kind: row.kind,
    diagnosis: row.diagnosis,
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
