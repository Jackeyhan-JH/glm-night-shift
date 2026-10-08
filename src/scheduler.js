// 调度器（issue #9）：把任务存储（#3）、高峰/额度闸门（#4）、执行器（#7 runTask）
// 和 Git 集成（#8）串成一条流水线：定时看队列 → 额度与高峰允许时领任务 →
// 建缓存/worktree → 跑 Claude → 跑测试 → 提交 → 推送 → 开 PR → 清 worktree，
// 全程处理失败重试、超时、限流退避、取消（别的进程改库）与停机。
// 普通失败且还有重试次数时，先跑一次失败诊断（#12 src/diagnose.js）再把任务放回
// 队列；下次领取时把诊断附进重试的 prompt。
//
// 时间：所有「现在」都取注入的 clock（quota/gate/notBefore/pausedUntil/执行器日志
// 时间戳），只有轮询间隔（pollSeconds）与取消轮询（cancelPollMs）用真实定时器。
// 时钟经 src/clock.js 的 systemClock() 注入，端到端测试靠 NIGHT_SHIFT_NOW 模拟高峰。
//
// 健壮性：tick() 串行（两次重叠的调用排队执行，绝不超发），永不让异常逃出轮询；
// 单个任务流水线里的任何一步抛错都按「普通失败」兜住，绝不拖垮调度循环。
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { isPeak, getStatus } from './peak.js';
import { usage as quotaUsage, canStart, multiplierFor } from './quota.js';
import * as gateModule from './gate.js';
import { formatLocalMinute } from './format.js';
import { runTask, runEvents } from './runner.js';
import { diagnose as diagnoseTask } from './diagnose.js';
import * as gitModule from './git.js';
import { scanFollowReviews } from './follow.js';
import { pollPrOutcomes } from './pr-status.js';
import {
  InvalidTransitionError,
  claimNextTask,
  claimTaskById,
  finishTask,
  getRun,
  getTask,
  getUserPaused,
  listRuns,
  recoverStaleRunning,
} from './tasks.js';

/** 额度统计回看的运行条数上限（7 天窗口内的运行数远低于此即可）。 */
const USAGE_RUN_LIMIT = 10_000;
/** 找「最近一条带诊断的运行」时回看的运行条数上限（#12）。 */
const DIAGNOSIS_LOOKUP_LIMIT = 1000;
const MS_PER_WEEK = 7 * 24 * 60 * 60_000;
/** 「测试失败」错误信息里保留的输出末尾字符数（按码点截断）。 */
const TEST_ERROR_TAIL_CHARS = 500;
/** pushBranch 被 --force-with-lease 拒绝（远端被别人动过）时的 stderr 特征。 */
const STALE_INFO_PATTERN = /stale info/i;

/**
 * 建一个调度器。所有部件都可注入（测试用假 runner / 假 git / 可调时钟）。
 *
 * @param {object} options
 * @param {import('node:sqlite').DatabaseSync} options.db 任务库（与命令行/看板共享同一文件）
 * @param {object} options.config 配置（loadConfig 的结果；用 concurrency / pollSeconds /
 *   plan / weekStart / safetyRatio / allowPeak / maxAttempts / rateLimitBackoffMinutes /
 *   keepFailedWorktrees / timeoutMinutes / killGraceSeconds / difficulty /
 *   autoDiagnose / diagnoseModel / remoteUrlTemplate / ghBin / oneTaskPerRepo /
 *   autoFollowReviews / followPollMinutes / prStatus / prStatusPollMinutes …）
 * @param {string} options.home 数据目录（仓库缓存、worktree、日志都在它下面）
 * @param {() => Date} [options.clock] 取「现在」；缺省真实时间，测试注入可调时钟
 * @param {Function} [options.runner] 执行器，缺省 #7 的 runTask（签名见其 JSDoc）
 * @param {object} [options.git] Git 集成模块，缺省 #8 的 src/git.js（测试注入假替身，
 *   只需提供 ensureRepoCache / defaultBranch / createWorktree / runTestCommand /
 *   commitAll / pushBranch / createPr / removeWorktree / prTitle / buildPrBody）
 * @param {object} [options.gate] 高峰/额度闸门模块，缺省 src/gate.js（只需提供
 *   startDecision；测试注入假替身以覆盖「领取后二次确认不通过」的退回路径）
 * @param {Function} [options.diagnoser] 失败诊断函数，缺省 #12 的 src/diagnose.js 的
 *   diagnose（测试可注入假替身）
 * @param {number} [options.cancelPollMs=1000] 轮询「运行中任务是否在库里被取消」的间隔
 * @param {object} [options.env=process.env] 子进程环境变量的基底，**原样**（不做任何
 *   清洗）传给 runner 的 `env` 参数和 git.createPr / findOpenPr 的 `env` 选项。
 *   生产环境的 claude 正是靠 ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN 等变量连
 *   GLM，在这里剥掉它们会让执行器失去凭据；需要隔离时由调用方（如测试的
 *   fakeEnv()）先构造好再传入。git.js 内部的 git 命令仍走它自己的 process.env。
 * @returns {object} 调度器：{ events, start, tick, stop, runNow, status }
 *   （各方法的语义见下方 JSDoc）
 * @throws {TypeError} 任一参数缺失或类型不符（db/config/home/env 非对象、home 非非空
 *   字符串、clock/runner 非函数、concurrency 非正整数、pollSeconds / cancelPollMs /
 *   rateLimitBackoffMinutes / followPollMinutes / prStatusPollMinutes 非正数、
 *   oneTaskPerRepo / autoFollowReviews / prStatus 非布尔）
 */
export function createScheduler({
  db, config, home,
  clock = () => new Date(), runner = runTask, git = gitModule, gate = gateModule,
  diagnoser = diagnoseTask,
  cancelPollMs = 1000, env = process.env,
} = {}) {
  assertObject(db, 'db');
  assertObject(config, 'config');
  if (typeof home !== 'string' || home.trim() === '') {
    throw new TypeError(`home 必须是非空字符串（数据目录），收到：${describe(home)}`);
  }
  if (typeof clock !== 'function') throw new TypeError(`clock 必须是函数，收到：${describe(clock)}`);
  if (typeof runner !== 'function') throw new TypeError(`runner 必须是函数，收到：${describe(runner)}`);
  if (typeof diagnoser !== 'function') throw new TypeError(`diagnoser 必须是函数，收到：${describe(diagnoser)}`);
  assertObject(git, 'git');
  if (typeof cancelPollMs !== 'number' || !Number.isFinite(cancelPollMs) || cancelPollMs <= 0) {
    throw new TypeError(`cancelPollMs 必须是正的有限数字，收到：${describe(cancelPollMs)}`);
  }
  assertObject(env, 'env');
  assertPositiveNumber(config.concurrency, 'config.concurrency', true);
  assertPositiveNumber(config.pollSeconds, 'config.pollSeconds');
  assertPositiveNumber(config.rateLimitBackoffMinutes, 'config.rateLimitBackoffMinutes');
  // #47：oneTaskPerRepo 非布尔在创建调度器时就得报出来（loadConfig 的整体校验不管这个键）
  if (typeof config.oneTaskPerRepo !== 'boolean') {
    throw new TypeError(`config.oneTaskPerRepo 必须是布尔值，收到：${describe(config.oneTaskPerRepo)}`);
  }
  // #49：自动跟进的两个新键同理（缺键 = undefined，同样过不了这里的类型检查）
  if (typeof config.autoFollowReviews !== 'boolean') {
    throw new TypeError(`config.autoFollowReviews 必须是布尔值，收到：${describe(config.autoFollowReviews)}`);
  }
  assertPositiveNumber(config.followPollMinutes, 'config.followPollMinutes');
  // #56：PR 状态查询的两个新键同理（缺键 = undefined，同样过不了这里的类型检查）
  if (typeof config.prStatus !== 'boolean') {
    throw new TypeError(`config.prStatus 必须是布尔值，收到：${describe(config.prStatus)}`);
  }
  assertPositiveNumber(config.prStatusPollMinutes, 'config.prStatusPollMinutes');

  const events = new EventEmitter();
  /** 运行中的任务：taskId -> { controller, task }。controller 用于取消与停机中止。 */
  const running = new Map();
  let started = false;
  let stopping = false;
  let stopPromise = null;
  let resolveStop = null;
  /** 限流全局暂停到该时刻（Date）为止；整个账号被限流，所有任务都等它。 */
  let pausedUntil = null;
  /** 最近一次判定的拦截原因（status() 用），null = 未被拦。 */
  let blocked = null;
  /** blocked 事件去重：同一 (reason, retryAt) 只发一次；有任务被领取时清空。 */
  let lastBlockedKey = null;
  /** 最近一次自动跟进扫描的时刻（#49；取 clock() 的时间，不是墙钟）。null = 还没查过。 */
  let lastFollowAt = null;
  /** 最近一次 PR 状态查询的时刻（#56；同样取 clock() 的时间，与 lastFollowAt 互相独立）。 */
  let lastPrStatusAt = null;
  let pollTimer = null;
  let cancelTimer = null;
  let tickChain = Promise.resolve();

  // ---------------------------------------------------------------- 对外方法

  const scheduler = {
    events,

    /**
     * 启动：先把库里遗留的 running 任务放回队列（recoverStaleRunning，上次进程没跑完的），
     * 之后每隔 config.pollSeconds 秒跑一轮 tick()。重复调用无害（已在运行就什么都不做）；
     * stop() 之后可以再次 start()（会清掉停机状态）。轮询定时器保持 ref——服务进程靠它
     * 常驻；stop() 会清掉。
     * @returns {number[]} 本次恢复（放回队列）的任务 id，升序
     */
    start() {
      if (started) return [];
      const recovered = recoverStaleRunning(db);
      const intervalMs = config.pollSeconds * 1000;
      started = true;
      stopping = false;
      if (resolveStop !== null) {
        // 上一轮优雅停止还没收尾就又 start 了：旧 stop() 的等待者立即放行（被重启取代）
        const resolve = resolveStop;
        stopPromise = null;
        resolveStop = null;
        resolve();
      }
      pollTimer = setInterval(() => {
        // tick() 自身已兜住所有异常，这里再兜一层，绝不让异常逃出定时器
        tick().catch((err) => console.error('[night-shift] tick() 意外出错：', err));
      }, intervalMs);
      ensureCancelPolling();
      return recovered;
    },

    /**
     * 手动跑一轮调度（测试直接调它，不碰定时器）。返回本轮**领取并开始执行**的任务 id
     * 数组——被闸门二次确认退回的任务不算（它没进入流水线，仍是 queued）。
     * 调用会串行排队：两次重叠的 tick 绝不会超发（并发上限以 running 为准）。
     * 自身不抛错（内部异常记 console.error 后按空轮返回），返回 Promise<number[]>。
     * 正在停止（stop 后）或处于限流全局暂停期时什么都不领。
     * @returns {Promise<number[]>}
     */
    tick,

    /**
     * 停止领新任务，等运行中的任务收尾。
     * - `force: false`（缺省，优雅）：只停轮询，运行中的任务自然跑完（Promise 等它们）；
     * - `force: true`（强制）：对运行中的任务 `abort('shutdown')`，执行器杀掉子进程、
     *   记 `error = 'interrupted'`，任务放回 queued 且退还这次尝试（attempts − 1）。
     * 对正在优雅停止的调度器再调 `stop({ force: true })` 会升级为强制；两次调用的
     * Promise 都在全部收尾后 resolve。
     * @param {object} [options]
     * @param {boolean} [options.force=false]
     * @returns {Promise<void>}
     */
    stop,

    /**
     * 点名立刻跑一个任务：无视高峰、额度、限流暂停、手动暂停（#38 的 userPaused）、
     * not_before 与并发上限（用户显式要求「现在就跑」），走完整流水线，返回最终任务
     * 对象（Promise）。
     * 任务会在 running 里登记（stop / 取消轮询 / status 都能看到它）。
     * id 接受数字或数字字符串（"12"）；只领 queued 的任务。
     * **不绕过任务依赖**（#11）：依赖还没全部 succeeded 时 claimTaskById 抛
     * DependencyBlockedError（InvalidTransitionError 的子类，err.blockedBy 列出未完成的依赖），
     * 任务原样留在队列、不扣次数、不启动 claude——上游产出还不存在时硬跑只会白花额度。
     * 正在停止（stop() 之后、再次 start() 之前）时拒绝：调度器已承诺不再执行任务，
     * 此时点名跑会跟停机收尾抢任务。先 start() 重启调度器再 runNow。
     * @param {number|string} taskId 正整数或其字符串形式
     * @returns {Promise<import('./tasks.js').TaskRow>} 流水线结束后的任务（终态或重新排队）
     * @throws {TypeError} taskId 不是正整数（或数字字符串）
     * @throws {Error} 调度器正在停止（stop 后未重启）
     * @throws {import('./tasks.js').NotFoundError} 任务不存在
     * @throws {import('./tasks.js').DependencyBlockedError} 任务在等依赖（见上）
     * @throws {InvalidTransitionError} 任务当前不是 queued（如已 succeeded、或已被
     *   tick 领走正在 running——原子领取保证同一任务绝不会被执行两次）
     */
    async runNow(taskId) {
      const id = normalizeTaskId(taskId);
      if (stopping) {
        throw new Error(`调度器正在停止，runNow 被拒绝（任务 ${id} 未领取；重启调度器后再试）`);
      }
      const task = claimTaskById(db, id); // 非 queued 或在等依赖都抛 InvalidTransitionError（后者是子类 DependencyBlockedError）
      return processTask(task);
    },

    /**
     * 调度器当前状态（给 #14 的 /api/status 和 #10 命令行用）。
     * @returns {{ running: number[], stopping: boolean, pausedUntil: Date | null,
     *   blocked: null | { reason: 'peak'|'five-hour'|'weekly'|'rate-limit', retryAt: Date | null },
     *   userPaused: boolean }}
     *   pausedUntil 只在暂停仍生效（now < pausedUntil）时非 null；blocked 是最近一轮
     *   调度判定的拦截原因，队列为空/正常领取时为 null。userPaused 是手动暂停标记
     *   （#38），每次从库里现读、不在进程里缓存，与 pausedUntil 互相独立。
     */
    status() {
      let activePause = null;
      try {
        const now = nowDate();
        if (pausedUntil !== null && now < pausedUntil) activePause = pausedUntil;
      } catch {
        activePause = pausedUntil; // 时钟坏了也照实报告暂停时刻，别让 status() 抛错
      }
      let userPaused = false;
      try {
        userPaused = getUserPaused(db);
      } catch (err) {
        // 读库失败（连接被关等）按未暂停报告并记日志，status() 一如既往不抛错
        console.error('[night-shift] 读取手动暂停标记失败（按未暂停报告）：', err);
      }
      return {
        running: [...running.keys()],
        stopping,
        pausedUntil: activePause,
        blocked: activePause !== null
          ? { reason: 'rate-limit', retryAt: activePause }
          : blocked,
        userPaused,
      };
    },
  };

  // ---------------------------------------------------------------- tick 与领取

  async function tick() {
    const round = tickChain.then(doTickSafely);
    tickChain = round.then(() => {}, () => {});
    return round;
  }

  /** tick 的兜底：任何异常（含时钟非法）记日志后按空轮返回，绝不炸到定时器。 */
  async function doTickSafely() {
    try {
      return await doTick();
    } catch (err) {
      console.error('[night-shift] tick() 失败，本轮跳过：', err);
      return [];
    }
  }

  async function doTick() {
    if (stopping) return [];
    const now = nowDate();
    // #49 自动跟进：放在限流退避 / 手动暂停的早退**之前**——那两种期间扫描照做
    // （只入队、不领取），查不查这轮由 maybeFollowReviews 按配置 / 高峰 / 间隔自判。
    await maybeFollowReviews(now);
    // #56 PR 状态查询：同一位置（早退之前），但独立于跟进——高峰也查（这点与 #49
    // 相反）、只写 pr_outcome 不入队；查不查这轮由 maybePollPrStatus 按配置 / 间隔自判。
    await maybePollPrStatus(now);
    if (pausedUntil !== null && now < pausedUntil) {
      setBlocked({ reason: 'rate-limit', retryAt: pausedUntil });
      return [];
    }
    // 手动暂停（#38）：库里 meta.userPaused 为 1 时本轮不领任何新任务（用户说
    // 「先别领」）。与上面的限流退避互相独立、可同时生效；也故意不写 blocked——
    // 那是闸门/限流的拦截原因，人主动按的暂停不算「被拦」。正在跑的任务不走这里，
    // 照常收尾；runNow 点名的也不走这里（见其 JSDoc）。
    if (getUserPaused(db)) return [];
    const claimed = [];
    while (running.size < config.concurrency) {
      // 每次领取前重取时钟与用量：上一轮刚起的任务已经以 running run 行计入用量
      const nowEach = nowDate();
      const usageNow = usageAt(nowEach);
      const precheck = canStart(usageNow, {
        nextCost: multiplierFor('glm-5.3', nowEach),
        safetyRatio: config.safetyRatio,
      });
      if (!precheck.ok) {
        setBlocked({ reason: precheck.reason, retryAt: precheck.resetsAt });
        break;
      }
      const peakOnly = isPeak(nowEach) && !config.allowPeak;
      setBlocked(peakOnly
        ? { reason: 'peak', retryAt: getStatus(nowEach).nextSwitch }
        : null);
      const task = claimNextTask(db, {
        allowPeakOnly: peakOnly,
        oneTaskPerRepo: config.oneTaskPerRepo, // #47：true 时同一仓库不并发领
        now: nowEach,
      });
      if (task === null) {
        // 队列空，或（#47）剩下的都是「等同仓库正在跑的」任务：都不是被拦，按 pollSeconds 再等
        if (!peakOnly) setBlocked(null);
        break;
      }
      // 闸门按任务实际模型再确认一次；不通过就放回队列（不扣次数）并停止本轮。
      // 注意：前面的预检已按 glm-5.3（倍率最高的模型）算过，正常配置下这里的二次确认
      // 不会比预检更严（模型倍率只会更低），这一步是防御性不变量——万一配置/模型表
      // 让单任务成本超过预检成本，也要保证任务原样退回而不是被误扣次数。
      const decision = gate.startDecision({
        now: nowEach,
        model: config.difficulty?.[task.difficulty]?.model,
        allowPeak: task.allowPeak,
        configAllowPeak: config.allowPeak,
        usage: usageNow,
        safetyRatio: config.safetyRatio,
      });
      if (!decision.ok) {
        try {
          finishTask(db, task.id, { status: 'queued', refundAttempt: true });
        } catch (err) {
          if (!(err instanceof InvalidTransitionError && err.from === 'canceled')) throw err;
          // 任务刚被别的进程取消：随它去，本轮照旧停止
        }
        setBlocked({ reason: decision.reason, retryAt: decision.retryAt });
        break;
      }
      claimed.push(task.id);
      processTask(task).catch((err) => {
        // processTask 自身承诺不 reject；这行只是兜底，防实现失误变成 unhandled rejection
        console.error('[night-shift] 任务流水线意外失败：', err);
      });
    }
    return claimed;
  }

  /**
   * 自动跟进扫描（#49）：autoFollowReviews 开着时，每隔 followPollMinutes 在**非高峰**
   * 做一次 follow --all 那种扫描（判定与入队共用 src/follow.js 的同一份规则）。
   * - 默认关闭时任何一轮都不为这件事碰 gh；
   * - 高峰不查，也**不**把「刚查过」记上（高峰一结束的下一轮就可以查）；
   * - 间隔用 clock() 的时间差算；从未查过时第一次符合条件的非高峰 tick 立刻查；
   * - 一旦查了（成败都算）就更新 lastFollowAt，失败也不会每轮都打；
   * - gh 失败只记一条日志、本轮不再扫其余父任务，绝不影响随后的领取。
   * 手动暂停 / 限流退避期间调用方不会走到领取，但这里的扫描照做（可以入队）。
   * @param {Date} now 本轮 tick 的时刻（clock() 的结果）
   */
  async function maybeFollowReviews(now) {
    if (config.autoFollowReviews !== true) return;
    if (isPeak(now)) return; // 高峰：连 gh 都不调，也不刷新 lastFollowAt
    if (lastFollowAt !== null
      && now.getTime() - lastFollowAt.getTime() < config.followPollMinutes * 60_000) {
      return;
    }
    lastFollowAt = now; // 这次算查过：成败都至少隔 followPollMinutes 再来
    let outcome;
    try {
      outcome = await scanFollowReviews(db, { ghBin: config.ghBin, env, config });
    } catch (err) {
      // 扫描自身炸了（读库失败等）：记日志后照常返回，绝不让异常逃出 tick
      console.error('[night-shift] 自动跟进扫描意外失败：', err);
      return;
    }
    for (const item of outcome.failed) {
      console.error(`[night-shift] 自动跟进 #${item.parentId} 失败（继续扫其余父任务）：${item.message}`);
    }
    if (outcome.ghError !== null) {
      console.error(`[night-shift] 自动跟进扫描遇到 gh 失败，本轮不再扫其余父任务：${outcome.ghError}`);
    }
  }

  /**
   * PR 状态查询（#56）：prStatus 开着时，每隔 prStatusPollMinutes 做一轮
   * pollPrOutcomes（查已成功任务的 PR state、写 pr_outcome，逻辑全在 src/pr-status.js）。
   * 与 #49 自动跟进的关键差别：**高峰也查**，而且查过就把「刚查过」记上（不因 isPeak
   * 跳过）；手动暂停 / 限流退避期间照查（只写列），调用方随后的早退照旧不领取、不入队。
   * - 默认关闭（prStatus !== true）时任何一轮都不为这件事调 gh；
   * - 间隔用 clock() 的时间差算；从未查过时第一次符合条件的 tick 立刻查（含高峰）；
   * - 在真正调 gh 之前更新 lastPrStatusAt：成败都算查过，失败也不会每 tick 再打
   *   （gh 失败由 pollPrOutcomes 记一条日志并停掉本轮，不影响随后的领取）。
   * @param {Date} now 本轮 tick 的时刻（clock() 的结果）
   */
  async function maybePollPrStatus(now) {
    if (config.prStatus !== true) return;
    if (lastPrStatusAt !== null
      && now.getTime() - lastPrStatusAt.getTime() < config.prStatusPollMinutes * 60_000) {
      return;
    }
    lastPrStatusAt = now; // 这次算查过：成败都至少隔 prStatusPollMinutes 再来（高峰也一样）
    try {
      await pollPrOutcomes(db, { ghBin: config.ghBin, env, now });
    } catch (err) {
      // 查询自身炸了（读库失败等）：记日志后照常返回，绝不让异常逃出 tick
      console.error('[night-shift] PR 状态查询意外失败：', err);
    }
  }

  /** 统计当前用量：最近 7 天的运行（running 的 run 行按倍率现算，也计入）。 */
  function usageAt(now) {
    const runs = listRuns(db, { since: new Date(now.getTime() - MS_PER_WEEK), limit: USAGE_RUN_LIMIT });
    return quotaUsage(runs, now, { plan: config.plan, weekStart: config.weekStart });
  }

  // ---------------------------------------------------------------- 单任务流水线

  /**
   * 登记并执行一个已领取的任务（tick 领到的与 runNow 点名的都走这里）。
   * 同步登记 running / 发 claim 事件后再异步跑流水线，保证并发计数立即生效。
   * 返回的 Promise 永不 reject，resolve 值是流水线结束后的任务对象；无论流水线
   * 怎么炸，running 登记总会在收尾里清掉（任务绝不会因此永久占着并发名额）。
   */
  function processTask(task) {
    const controller = new AbortController();
    running.set(task.id, { controller, task });
    lastBlockedKey = null; // 有任务被领取：清空 blocked 事件去重
    try {
      events.emit('claim', { taskId: task.id });
    } catch (err) {
      // 监听器抛错不该拦住任务执行（EventEmitter 会同步向上抛）
      console.error(`[night-shift] claim 事件监听器出错（任务 ${task.id} 照常执行）：`, err);
    }
    ensureCancelPolling();
    let donePayload = null;
    return runPipeline(task, controller)
      .then(({ finalTask, done }) => {
        donePayload = done;
        return finalTask;
      })
      .catch((err) => {
        // runPipeline 自身承诺不 reject；这层兜底保证实现失误（如收尾读库抛错）也
        // 绝不把任务永久留在 running：按剩余次数放回队列或落终态，退还这次尝试。
        console.error(`[night-shift] 任务 ${task.id} 流水线意外中断：`, err);
        try {
          finishTask(db, task.id, {
            status: task.attempts < task.maxAttempts ? 'queued' : 'failed',
            lastError: `internal: ${err instanceof Error ? err.message : String(err)}`,
            refundAttempt: true,
          });
        } catch (finishErr) {
          console.error(`[night-shift] 记录任务 ${task.id} 的中断结果时出错：`, finishErr);
        }
        let current = task;
        try {
          current = getTask(db, task.id) ?? task;
        } catch {
          // 读库也失败：用领取时的快照
        }
        donePayload = {
          taskId: task.id,
          status: current.status,
          prUrl: current.prUrl ?? null,
          error: current.lastError ?? null,
        };
        return current;
      })
      .finally(() => {
        running.delete(task.id);
        if (running.size === 0) {
          if (stopping && resolveStop !== null) {
            const resolve = resolveStop;
            stopPromise = null;
            resolveStop = null;
            resolve();
          }
          teardownCancelPollIfIdle();
        }
        // 名额释放之后再发 done（见 runPipeline 末尾的说明）
        if (donePayload !== null) {
          try {
            events.emit('done', donePayload);
          } catch (err) {
            console.error(`[night-shift] done 事件监听器出错（任务 ${task.id} 已收尾）：`, err);
          }
        }
      });
  }

  async function runPipeline(task, controller) {
    let worktree = null; // createWorktree 的结果（stage 事件与清理都要用）
    let outcome = null; // 'succeeded' | 'failed' | 'queued' | 'canceled'
    let finalTask = getTask(db, task.id) ?? task;
    let currentStage = null; // 出错时按阶段给 lastError 归类前缀

    /** 发某阶段的 stage 事件再执行 fn；错误原样抛出（由外层统一兜底）。 */
    const stage = (name, fn) => Promise.resolve().then(() => {
      currentStage = name;
      events.emit('stage', { taskId: task.id, stage: name });
      return fn();
    });

    /** 结束任务；任务已被别的进程取消时不覆盖 canceled，按取消收尾。 */
    const finish = (status, fields = {}) => {
      try {
        finalTask = finishTask(db, task.id, { status, ...fields });
        outcome = status;
      } catch (err) {
        if (err instanceof InvalidTransitionError && err.from === 'canceled') {
          outcome = 'canceled';
          finalTask = getTask(db, task.id) ?? finalTask;
          return;
        }
        throw err;
      }
    };

    /**
     * 普通失败：还有尝试次数就（可选，#12）先诊断再排回队列，否则落终态 failed。
     * diagnoseRun 是刚结束的运行结果——只有执行器阶段的失败（failed / timeout）才
     * 诊断：有失败运行与它的日志可看。限流 / 停机中断 / 取消 / 没有改动走各自专门
     * 的收尾路径（不诊断）；最后一次失败（次数用尽）也不诊断（issue #12）。
     */
    const failNormal = async (lastError, { diagnoseRun = null } = {}) => {
      if (task.attempts >= task.maxAttempts) {
        finish('failed', { lastError });
        return;
      }
      if (diagnoseRun !== null && config.autoDiagnose === true) {
        await maybeDiagnose(diagnoseRun);
      }
      finish('queued', { lastError });
    };

    /**
     * 失败自动诊断（#12）：取失败运行的完整行 → 过一遍闸门（按 diagnoseModel 与任务的
     * allowPeak；被高峰 / 额度拦下就跳过，原因记进失败运行的日志）→ 发 diagnose 阶段
     * 事件并跑诊断。这时任务仍是 running（failNormal 在诊断结束后才排队），看板能看到
     * 它在诊断。诊断自身的任何意外都不影响重试：记日志后照常返回。
     */
    const maybeDiagnose = async (runOutcome) => {
      const failedRun = getRun(db, runOutcome.runId);
      // run 行不在（注入的假 runner 不写库等）：没有失败日志可看，无从诊断
      if (failedRun === null || failedRun.kind !== 'task') return;
      const nowEach = nowDate();
      const decision = gate.startDecision({
        now: nowEach,
        model: config.diagnoseModel,
        allowPeak: task.allowPeak,
        configAllowPeak: config.allowPeak,
        usage: usageAt(nowEach),
        safetyRatio: config.safetyRatio,
      });
      if (!decision.ok) {
        logDiagnosisSkip(failedRun, decision.reason, decision.retryAt);
        return;
      }
      try {
        await stage('diagnose', () => diagnoser({
          task,
          failedRun,
          config,
          db,
          home,
          signal: controller.signal,
          clock,
          env,
        }));
      } catch (err) {
        // 诊断失败（超时 / 出错 / 限流）不影响重试：run 行由 diagnose 如实记录，
        // runs.diagnosis 留空，任务照常排回队列
        console.error(`[night-shift] 任务 ${task.id} 的诊断未完成（不影响重试）：`, err);
      }
    };

    /** 任务是否已在库里被别的进程（命令行/看板）取消。 */
    const canceledInDb = () => getTask(db, task.id)?.status === 'canceled';

    try {
      pipeline: {
        // 1. 仓库缓存 → 默认分支 → worktree（createWorktree 只吃现成缓存）
        worktree = await stage('worktree', async () => {
          const cacheDir = await git.ensureRepoCache({ home, repo: task.repo, config });
          const baseBranch = await git.defaultBranch(cacheDir);
          return git.createWorktree({ home, repo: task.repo, task, baseBranch });
        });

        // 2. 执行器（#12：最近一条带诊断的运行文本作为 extraPrompt 附进重试的 prompt）
        const run = await stage('run', () => runner({
          task,
          workdir: worktree.path,
          config,
          db,
          home,
          signal: controller.signal,
          attempt: task.attempts,
          extraPrompt: latestDiagnosis(task.id),
          clock,
          env,
        }));

        if (run.status === 'canceled' || canceledInDb()) {
          outcome = 'canceled'; // 用户取消：保持 canceled，不 finishTask
          finalTask = getTask(db, task.id) ?? finalTask;
          break pipeline;
        }
        if (run.status === 'failed' && run.rateLimited) {
          // 限流是整个账号的：退避这一单任务 + 全局暂停到同一时刻，退还这次尝试
          const retryAt = new Date(nowDate().getTime() + config.rateLimitBackoffMinutes * 60_000);
          pausedUntil = retryAt;
          setBlocked({ reason: 'rate-limit', retryAt });
          finish('queued', {
            // 「本地时间」= 进程所在时区（formatLocalMinute 用 Date 的本地 getter 渲染，
            // 跟随 TZ 环境变量；测试用同一函数算期望值，断言与机器时区无关）
            lastError: `被限流，${formatLocalMinute(retryAt.toISOString())} 后重试`,
            notBefore: retryAt,
            refundAttempt: true,
          });
          break pipeline;
        }
        if (run.status === 'failed' && run.error === 'interrupted') {
          // 停机中断：放回队列、退还尝试，不写 notBefore（重启后立刻可跑）
          finish('queued', { lastError: '停机中断，已放回队列', refundAttempt: true });
          break pipeline;
        }
        if (run.status !== 'succeeded') {
          // 普通失败 / 超时：还有次数 → 先诊断（可配置）再排回队列
          await failNormal(`run: ${run.error ?? String(run.status)}`, { diagnoseRun: run });
          break pipeline;
        }

        // 3. 测试命令
        const testResult = await stage('test', () => git.runTestCommand({
          worktree: worktree.path,
          command: task.testCommand,
          config,
        }));
        if (!testResult.ok) {
          await failNormal(`测试失败：${tailByCodePoints(testResult.output, TEST_ERROR_TAIL_CHARS)}`);
          break pipeline;
        }
        if (canceledInDb()) {
          outcome = 'canceled';
          finalTask = getTask(db, task.id) ?? finalTask;
          break pipeline;
        }

        // 4. 提交；没有改动直接 failed（不重试——重跑也不会有改动）
        const commit = await stage('commit', () => git.commitAll({
          worktree: worktree.path,
          message: git.prTitle(task),
          config,
          baseSha: worktree.baseSha,
        }));
        if (!commit.changed) {
          finish('failed', { lastError: '没有改动' });
          break pipeline;
        }
        if (canceledInDb()) {
          outcome = 'canceled';
          finalTask = getTask(db, task.id) ?? finalTask;
          break pipeline;
        }

        // 5. 推送（--force-with-lease 撞上 stale info 时重新 fetch 一次再推）
        await stage('push', () => pushWithStaleRetry(task, worktree));
        if (canceledInDb()) {
          outcome = 'canceled';
          finalTask = getTask(db, task.id) ?? finalTask;
          break pipeline;
        }

        // 6. 开 PR（已有 open PR 时 gh 那边幂等返回）→ 任务成功
        const pr = await stage('pr', () => git.createPr({
          repo: task.repo,
          branch: worktree.branch,
          base: worktree.baseBranch,
          title: git.prTitle(task),
          body: git.buildPrBody({
            task,
            run: {
              summary: run.summary,
              model: run.model,
              effort: run.effort,
              peak: run.peak,
              durationMs: run.durationMs,
              quotaUnits: run.quotaUnits,
              attempt: task.attempts,
            },
            test: { command: task.testCommand, ...testResult },
          }),
          config,
          env,
        }));
        finish('succeeded', { prUrl: pr.url, branch: worktree.branch });
      }
    } catch (err) {
      // 任何一步抛错都按普通失败兜住：执行器阶段用 run: 前缀，git/测试阶段用 git: 前缀
      const prefix = currentStage === 'run' ? 'run: ' : 'git: ';
      const lastError = `${prefix}${err instanceof Error ? err.message : String(err)}`;
      try {
        await failNormal(lastError);
      } catch (finishErr) {
        // 连失败都写不进去（库坏了等）：如实报告，别让收尾再炸一次
        console.error(`[night-shift] 记录任务 ${task.id} 的失败结果时出错：`, finishErr);
        outcome = outcome ?? 'failed';
      }
    }

    // 7. 清理 worktree（失败的在 keepFailedWorktrees 为 true 时保留现场）
    if (worktree !== null && !(outcome === 'failed' && config.keepFailedWorktrees === true)) {
      try {
        await stage('cleanup', () => git.removeWorktree({ home, repo: task.repo, worktree: worktree.path }));
      } catch (err) {
        console.error(`[night-shift] 清理任务 ${task.id} 的 worktree 失败（不影响任务结果）：`, err);
      }
    }

    finalTask = getTask(db, task.id) ?? finalTask;
    // done 事件不在这里发：processTask 先释放 running 名额再发，保证监听者收到 done 时
    // status().running 已不含该任务、紧接着的 tick() 也能立刻补位。
    return {
      finalTask,
      done: {
        taskId: task.id,
        status: outcome ?? finalTask.status,
        prUrl: finalTask.prUrl ?? null,
        error: finalTask.lastError ?? null,
      },
    };
  }

  /**
   * pushBranch 撞上 stale info（我们 fetch 之后有人动了远端分支，--force-with-lease
   * 刻意拒绝覆盖）：重新 ensureRepoCache（fetch 刷新跟踪 ref）后再推一次；第二次仍
   * 失败就按普通失败走（调用方以 git: 前缀记录）。
   */
  async function pushWithStaleRetry(task, worktree) {
    const opts = { worktree: worktree.path, branch: worktree.branch };
    try {
      return await git.pushBranch(opts);
    } catch (err) {
      if (!isStaleInfoError(err)) throw err;
      await git.ensureRepoCache({ home, repo: task.repo, config });
      return git.pushBranch(opts);
    }
  }

  // ---------------------------------------------------------------- 停止与取消轮询

  function stop({ force = false } = {}) {
    stopping = true;
    started = false; // 允许之后再次 start()
    if (pollTimer !== null) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    if (force) {
      for (const { controller } of running.values()) {
        if (!controller.signal.aborted) controller.abort('shutdown');
      }
    }
    if (running.size === 0) {
      teardownCancelPollIfIdle();
      return Promise.resolve();
    }
    // 优雅停止期间仍要响应别的进程取消任务
    ensureCancelPolling();
    if (stopPromise === null) {
      stopPromise = new Promise((resolve) => {
        resolveStop = resolve;
      });
    }
    return stopPromise;
  }

  /** 取消轮询：库里状态变成 canceled 的运行中任务，立即 abort（执行器杀进程记 canceled）。 */
  function ensureCancelPolling() {
    if (cancelTimer !== null) return;
    cancelTimer = setInterval(pollCancels, cancelPollMs);
    // 不独自拖住进程：运行中的子进程会拖住事件循环，轮询照常触发；全都结束后自然清掉
    cancelTimer.unref();
  }

  function teardownCancelPollIfIdle() {
    // 调度器没在跑（从没 start 或已 stop）且没有运行中的任务：取消轮询没有对象，停掉
    if ((!started || stopping) && running.size === 0 && cancelTimer !== null) {
      clearInterval(cancelTimer);
      cancelTimer = null;
    }
  }

  function pollCancels() {
    if (running.size === 0) {
      teardownCancelPollIfIdle();
      return;
    }
    for (const [id, entry] of running) {
      if (entry.controller.signal.aborted) continue;
      let status = null;
      try {
        status = getTask(db, id)?.status ?? null;
      } catch (err) {
        console.error(`[night-shift] 轮询任务 ${id} 的取消状态失败：`, err);
        continue;
      }
      if (status === 'canceled') entry.controller.abort(); // 无 reason：执行器记 canceled
    }
  }

  // ---------------------------------------------------------------- 小工具

  /**
   * 诊断被闸门拦下（高峰 / 额度）时，把原因补记进失败运行日志的末尾（meta 行，与
   * 执行器的日志格式一致），并照发 runEvents 的 log 事件——跳过了诊断就没有新的 run
   * 行可写，失败运行自己的日志是唯一能留痕、看板也看得到的地方。
   */
  function logDiagnosisSkip(failedRun, reason, retryAt) {
    const reasonText = { peak: '高峰期', 'five-hour': '五小时额度', weekly: '周额度' }[reason]
      ?? String(reason);
    const line = `诊断被跳过：${reasonText}`
      + (retryAt instanceof Date && !Number.isNaN(retryAt.getTime())
        ? `（${retryAt.toISOString()} 后可再试）`
        : '');
    const ts = nowDate().toISOString();
    if (typeof failedRun.logPath === 'string' && failedRun.logPath !== '') {
      try {
        fs.appendFileSync(failedRun.logPath, `${ts} [meta] ${line}\n`);
      } catch (err) {
        console.error(`[night-shift] 补记诊断跳过原因到 ${failedRun.logPath} 失败：`, err);
      }
    }
    try {
      runEvents.emit('log', {
        taskId: failedRun.taskId, runId: failedRun.id, stream: 'meta', line, ts,
      });
    } catch (err) {
      console.error('[night-shift] 诊断跳过日志事件的监听器出错：', err);
    }
  }

  /**
   * 任务最近一条带诊断文本的运行（#12）：领取后传给 runner 的 extraPrompt，附进重试
   * 的 prompt。没有诊断（首次运行 / 诊断失败）返回 null。
   */
  function latestDiagnosis(taskId) {
    try {
      const withDiag = listRuns(db, { taskId, limit: DIAGNOSIS_LOOKUP_LIMIT })
        .find((run) => run.diagnosis !== null && run.diagnosis !== undefined);
      return withDiag === undefined ? null : withDiag.diagnosis;
    } catch (err) {
      console.error(`[night-shift] 读取任务 ${taskId} 的历史诊断失败（本次不附带）：`, err);
      return null;
    }
  }

  function nowDate() {
    const d = clock();
    if (!(d instanceof Date) || Number.isNaN(d.getTime())) {
      throw new TypeError('clock() 必须返回合法的 Date');
    }
    return d;
  }

  /** 更新拦截状态；blocked 事件按 (reason, retryAt) 去重，只在变化时发。 */
  function setBlocked(next) {
    blocked = next;
    if (next === null) return;
    const key = `${next.reason}|${next.retryAt === null || next.retryAt === undefined
      ? '' : new Date(next.retryAt).getTime()}`;
    if (key === lastBlockedKey) return;
    lastBlockedKey = key;
    events.emit('blocked', { reason: next.reason, retryAt: next.retryAt ?? null });
  }

  return scheduler;
}

/** pushBranch 的失败是不是 --force-with-lease 的 stale info 拒绝（message 或 stderr）。 */
function isStaleInfoError(err) {
  if (err === null || typeof err !== 'object') return false;
  return STALE_INFO_PATTERN.test(String(err.message ?? '')) || STALE_INFO_PATTERN.test(String(err.stderr ?? ''));
}

/** runNow 的任务 id：接受正整数或其字符串形式，其余抛 TypeError。 */
function normalizeTaskId(value) {
  const n = typeof value === 'number'
    ? value
    : typeof value === 'string' && value.trim() !== '' ? Number(value.trim()) : NaN;
  if (!Number.isInteger(n) || n < 1) {
    throw new TypeError(`runNow 的 taskId 必须是正整数或数字字符串，收到：${describe(value)}`);
  }
  return n;
}

/** 取文本末尾最多 max 个 Unicode 码点（不把中文/emoji 切成半个）。 */
function tailByCodePoints(text, max) {
  const chars = [...String(text ?? '')];
  return chars.length <= max ? chars.join('') : chars.slice(-max).join('');
}

function assertObject(value, name) {
  if (value === null || typeof value !== 'object') {
    throw new TypeError(`createScheduler 缺 ${name} 参数（对象），收到：${describe(value)}`);
  }
}

function assertPositiveNumber(value, name, integer = false) {
  const ok = typeof value === 'number' && Number.isFinite(value) && value > 0
    && (!integer || Number.isInteger(value));
  if (!ok) {
    throw new TypeError(`config.${name} 必须是${integer ? '正整数' : '正的有限数字'}，收到：${describe(value)}`);
  }
}

function describe(value) {
  try {
    const json = JSON.stringify(value);
    if (json !== undefined) return json;
  } catch {
    // 循环引用等，落到 String() 兜底
  }
  return String(value);
}
