// PR 状态查询（issue #56 记下 PR 已合并或已关闭）：只这一份查询与写入逻辑，调度器
// （src/scheduler.js 的 maybePollPrStatus）只负责门闩与间隔，不内联到这里以外。
// 任务变成 succeeded 只表示 PR 开出来了；这里定期用 `gh pr view --json state,mergedAt`
// 查已成功任务的 PR state（MERGED/CLOSED/OPEN → merged/closed/open），写进 tasks.pr_outcome。
// 只写这一列（外加 updated_at），**不改**任务的 status / attempts / pr_url / branch /
// finished_at——成功仍是成功。merged / closed 之后不再查；open 每轮间隔到了还要查。
//
// 与 #49 自动跟进（src/follow.js）的差别：那边复用 follow --all 的评审规则、非高峰才扫；
// 这边只看 state，高峰也查（调度器侧的门闩决定，这里不管高峰）。prUrl → PR 编号的解析
// 与 follow 完全一致，但 follow.js 不导出这两段，按约定原样复制过来、两边保持同步。
//
// ⚠️ 本文件只依赖 node:child_process 与调用方传入的 db 连接（裸 SQL），不静态引入
// src/tasks.js——它由调度器一侧加载，没有 CLI 的 SQLite 警告问题（见 src/warnings.js）。
import { spawn } from 'node:child_process';

/** gh pr view 的 state → 写入 pr_outcome 的值；大小写敏感，其余值一律不写。 */
const OUTCOME_OF_STATE = { MERGED: 'merged', CLOSED: 'closed', OPEN: 'open' };

/** spawn 并收集 stdout/stderr/退出码（参数走数组不经 shell）；启动失败 reject。
 *  与 src/follow.js 的 spawnCapture 同款（那边不导出，复制保持一致）。 */
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

/** 从 prUrl 解析 PR 编号：优先末尾的 /pull/<数字>，否则取最后一个数字段；解析不出 null。
 *  与 src/follow.js 的 prNumberFromUrl 逐字一致（那边不导出；改动时两边同步）。 */
function prNumberFromUrl(url) {
  const pull = /\/pull\/(\d+)/.exec(url);
  if (pull !== null) return Number(pull[1]);
  const tail = /(\d+)[^\d]*$/.exec(url);
  return tail === null ? null : Number(tail[1]);
}

/**
 * `gh pr view <编号> --repo <仓库> --json state,mergedAt`（#56；注意与 follow 的
 * `--json reviewDecision,reviews,url,headRefName` 不是同一条命令）。退出码非 0 或进程
 * 启动失败是 **gh 失败**（ghError: true，调用方本轮停止）；退出码 0 但 stdout 不是 JSON
 * 对象只是这一条的**坏结果**（ghError: false，调用方跳过该任务继续下一条）。
 * @returns {Promise<{ghError: boolean, view?: object, message?: string}>}
 */
async function viewPrState(pullNumber, repo, { ghBin, env }) {
  const args = ['pr', 'view', String(pullNumber), '--repo', repo, '--json', 'state,mergedAt'];
  let res;
  try {
    res = await spawnCapture(ghBin, args, env);
  } catch (err) {
    return { ghError: true, message: err.message };
  }
  if (res.code !== 0) {
    return { ghError: true, message: `gh pr view 失败（退出码 ${res.code}）：${res.stderr.trim()}` };
  }
  let parsed;
  try {
    parsed = JSON.parse(res.stdout);
  } catch (err) {
    return { ghError: false, message: `gh pr view 的输出不是合法 JSON：${err.message}` };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ghError: false, message: `gh pr view 的输出不是 JSON 对象：${res.stdout.slice(0, 400) || '（空）'}` };
  }
  return { ghError: false, view: parsed };
}

/**
 * 查一轮 PR 状态并写入 pr_outcome（#56）。对象：status = 'succeeded'、pr_url 非空、且
 * pr_outcome 是 NULL 或 open 的任务（merged / closed 不再查），按 id 升序。逐条调 gh：
 * - prUrl 解析不出 PR 编号：记日志跳过（不算 gh 失败），继续下一条；
 * - gh 失败（退出码非 0 / 启动失败）：记**一条**日志，本轮到此为止（后面的任务不再查）；
 * - state 不是字符串、或不是 OPEN/MERGED/CLOSED（大小写敏感）：记日志跳过、不写列，
 *   继续其余任务；
 * - 其余按映射写入，UPDATE 带 `status = 'succeeded' AND (pr_outcome IS NULL OR
 *   pr_outcome = 'open')` 守卫，不覆盖已是 merged/closed 的行，也不碰其他任何列
 *   （updated_at 用传入的 now）。
 * 间隔与「prStatus 开关」的门闩在调度器侧（maybePollPrStatus）：这里被调到就是该查了。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {object} options
 * @param {string} options.ghBin gh 可执行文件（配置的 ghBin）
 * @param {object} options.env gh 子进程环境变量（调度器的 env，原样传给 spawn）
 * @param {Date} options.now 本轮 tick 的时刻（调度器注入的 clock()），updated_at 用它的 ISO 串
 * @returns {Promise<{checked: number, written: number, aborted: boolean}>}
 *   checked = 本轮的候选条数；written = 实际写入的行数；aborted = 是否因 gh 失败中止
 */
export async function pollPrOutcomes(db, { ghBin, env, now }) {
  const rows = db.prepare(`
    SELECT id, repo, pr_url FROM tasks
    WHERE status = 'succeeded'
      AND pr_url IS NOT NULL AND pr_url != ''
      AND (pr_outcome IS NULL OR pr_outcome = 'open')
    ORDER BY id ASC
  `).all();
  let written = 0;
  for (const row of rows) {
    const pullNumber = prNumberFromUrl(row.pr_url);
    if (pullNumber === null) {
      console.error(`[night-shift] 无法从任务 #${row.id} 的 prUrl 解析 PR 编号，跳过本轮：${row.pr_url}`);
      continue;
    }
    const res = await viewPrState(pullNumber, row.repo, { ghBin, env });
    if (res.ghError) {
      // gh 本身失败：整轮停止。调用方在调这里之前已把「刚查过」记上，间隔内不会重试。
      console.error(`[night-shift] 查询任务 #${row.id} 的 PR 状态失败，本轮停止查询：${res.message}`);
      return { checked: rows.length, written, aborted: true };
    }
    if (res.view === undefined) {
      // 退出码 0 但 stdout 不是 JSON 对象：只算这一条的坏结果，跳过、继续下一条
      console.error(`[night-shift] 任务 #${row.id} 的 PR 状态无法解析，不写入 pr_outcome：${res.message}`);
      continue;
    }
    const state = res.view.state;
    const outcome = typeof state === 'string' ? OUTCOME_OF_STATE[state] : undefined;
    if (outcome === undefined) {
      // 大小写敏感（merged 不算 MERGED）；缺 state / 非字符串同理：只跳过这一条
      console.error(
        `[night-shift] 任务 #${row.id} 的 PR state 无法识别（收到：${JSON.stringify(state) ?? 'undefined'}），不写入 pr_outcome`,
      );
      continue;
    }
    const updated = db.prepare(`
      UPDATE tasks
      SET pr_outcome = ?, updated_at = ?
      WHERE id = ? AND status = 'succeeded' AND (pr_outcome IS NULL OR pr_outcome = 'open')
    `).run(outcome, now.toISOString(), row.id);
    written += updated.changes;
  }
  return { checked: rows.length, written, aborted: false };
}
