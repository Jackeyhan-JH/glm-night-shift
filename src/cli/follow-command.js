// follow 子命令（issue #48）：任务成功开出 PR 之后，评审要求修改（CHANGES_REQUESTED）
// 时在**原来的 night-shift 分支**上入队一条跟进任务——gitRef 指向父任务的分支，
// createWorktree 会从 origin/<gitRef> 检出，push / 开 PR 沿用现有逻辑推回原分支、
// 复用原来那个 PR（不新开第二个）。这批只做命令：调度器不会自动轮询 PR，也没有
// autoFollowReviews 配置；想跟进就手动跑 follow（或 follow --all）。
//
// ⚠️ 与 task-commands.js / cleanup-command.js 同理：本文件（及其静态依赖）绝不能
// import src/db.js 或 src/tasks.js——db.js 是唯一加载 node:sqlite 的模块，静态引入
// 会让入口来不及先装 SQLite 警告过滤（时机说明见 src/warnings.js）。openDb 与
// tasks.js 的函数一律走 run() 里的动态 import。
import path from 'node:path';
import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';
import { loadConfig, resolveHome } from '../config.js';

/** follow 生成的标题按 Unicode 码点截断到 80（与 import 一致，不加省略号）。 */
const TITLE_CODE_POINTS = 80;
/** 评审正文（说明的开头部分）按 Unicode 码点截断到 8000。 */
const REVIEW_BODY_CODE_POINTS = 8000;
/** reviewDecision 的「评审要求修改」值；APPROVED / COMMENTED / 空等其他值都不跟。 */
const CHANGES_REQUESTED = 'CHANGES_REQUESTED';
/** 评审列表里没有 CHANGES_REQUESTED 条目但结论已是 CHANGES_REQUESTED 时用的评审 id。 */
const DECISION_REVIEW_ID = 'decision';
/** follow --all 扫描 succeeded 任务时的列表上限（listTasks 只认正整数）。 */
const LIST_LIMIT = 100_000;

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
 * gh pr view <编号> --repo <repo> --json reviewDecision,reviews,url,headRefName：
 * 退出码非 0 或 stdout 不是 JSON 对象时抛中文错误（调用方按运行时错误退出 1，不建任务）。
 * gh 用配置里的 ghBin，参数数组不经 shell，子进程环境用调用方传入的 env。
 */
async function viewPr(pullNumber, repo, { ghBin, env }) {
  const args = [
    'pr', 'view', String(pullNumber), '--repo', repo,
    '--json', 'reviewDecision,reviews,url,headRefName',
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
 * 单个任务的 follow 判定与入队（follow <id> 与 follow --all 共用）。
 * 返回三选一的结果对象：
 * - { kind: 'created', id, parentId, branch, source }：已入队（createTask 的返回）；
 * - { kind: 'skipped', parentId, message }：没有待处理的修改请求 / 已经入队，退出 0；
 * - { kind: 'failed', parentId, message }：状态不满足 / gh 失败等，按失败上报。
 * 状态校验失败、gh 失败在这里抛 Error（follow <id> 的语义：退出 1，不建任务）；
 * --all 传入 throwOnError: false 时改为返回 failed 结果，继续下一条。
 */
async function followTask(db, parent, { ghBin, env, config, throwOnError = true }) {
  const fail = (message) => {
    if (throwOnError) throw new Error(message);
    return { kind: 'failed', parentId: parent.id, message };
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

  let view;
  try {
    view = await viewPr(pullNumber, parent.repo, { ghBin, env });
  } catch (err) {
    return fail(`任务 #${parent.id} 的 gh pr view 失败：${err.message}`);
  }
  if (view.reviewDecision !== CHANGES_REQUESTED) {
    return { kind: 'skipped', parentId: parent.id, message: '没有待处理的修改请求' };
  }
  const { reviewId, body } = pickReview(view);
  const source = `pr-review:${parent.repo}#${pullNumber}:${reviewId}`;
  const { findTaskBySource, createTask } = await import('../tasks.js');
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
  const trimmedBody = body.trim();
  let task;
  try {
    task = createTask(db, {
      repo: parent.repo,
      title: takeCodePoints(`跟进 #${parent.id}：${parent.title}`, TITLE_CODE_POINTS),
      prompt: trimmedBody === '' ? tailLine : `${takeCodePoints(trimmedBody, REVIEW_BODY_CODE_POINTS)}\n${tailLine}`,
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
    // gitRef 等字段没过校验（父任务的 branch 形状怪异）等：单条按失败处理，--all 继续。
    return fail(`任务 #${parent.id} 的跟进任务入队失败：${err instanceof Error ? err.message : String(err)}`);
  }
  return { kind: 'created', id: task.id, parentId: parent.id, branch, source };
}

export const followCommand = {
  summary: '按 PR 评审在原分支入队跟进任务',
  usage: '用法：night-shift follow <id> | night-shift follow --all [--json]',
  async run(args, ctx) {
    const { values, positionals } = parseArgs({
      args,
      options: {
        all: { type: 'boolean' },
        json: { type: 'boolean' },
      },
      allowPositionals: true,
    });
    const usage = followCommand.usage;
    if (values.json && !values.all) {
      throw new ctx.UsageError('--json 只能与 --all 一起使用', { usage });
    }
    if (values.all) {
      if (positionals.length > 0) {
        throw new ctx.UsageError(`不能同时给 <id> 与 --all（当前参数：${positionals.join(' ')}）`, { usage });
      }
      return runFollowAll(ctx, { jsonOut: values.json === true });
    }
    if (positionals.length === 0) {
      throw new ctx.UsageError('缺少必填参数：<id>（或使用 --all）', { usage });
    }
    if (positionals.length > 1) {
      throw new ctx.UsageError(`参数过多：${positionals.join(' ')}（只需要 <id>）`, { usage });
    }
    const raw = positionals[0];
    if (!/^\d+$/.test(raw) || Number(raw) < 1) {
      throw new ctx.UsageError(`<id> 必须是正整数（当前值：${raw}）`, { usage });
    }
    return runFollowOne(ctx, Number(raw));
  },
};

/** 打开 <home>/night-shift.db（不存在则自动创建）；失败抛中文原因带路径的错。 */
async function openDbAt(ctx) {
  const { openDb } = await import('../db.js'); // 动态 import：给警告过滤留出安装时间
  const dbPath = path.join(resolveHome(ctx.env), 'night-shift.db');
  try {
    return openDb(dbPath);
  } catch (err) {
    throw new Error(`无法打开数据库 ${dbPath}：${err.message}`);
  }
}

/** follow <id>：单条判定。gh 用配置的 ghBin；输出原句，退出码见 JSDoc。 */
async function runFollowOne(ctx, id) {
  const config = loadConfig({ home: resolveHome(ctx.env), env: ctx.env });
  const db = await openDbAt(ctx);
  let result;
  try {
    const { getTask } = await import('../tasks.js');
    const parent = getTask(db, id);
    if (parent === null) throw new Error(`任务 #${id} 不存在`);
    result = await followTask(db, parent, { ghBin: config.ghBin, env: ctx.env, config });
  } finally {
    db.close();
  }
  if (result.kind === 'skipped') {
    ctx.stdout.write(`${result.message}\n`);
    return 0;
  }
  ctx.stdout.write(`已入队 #${result.id}，在分支 ${result.branch} 上改\n`);
  return 0;
}

/**
 * follow --all：对每条 succeeded 且有 prUrl 的任务做与 follow <id> 同一套判定。
 * 单条失败（gh 失败、分支不合法……）记下来继续下一条，已入队的保留；只要有一条
 * 失败退出码就是 1，全部跳过或全部成功是 0。--json 时 stdout 只有一个 JSON 值：
 * { created, skipped, failed }。
 */
async function runFollowAll(ctx, { jsonOut }) {
  const config = loadConfig({ home: resolveHome(ctx.env), env: ctx.env });
  const db = await openDbAt(ctx);
  const created = [];
  const skipped = [];
  const failed = [];
  try {
    const { listTasks } = await import('../tasks.js');
    const candidates = listTasks(db, { status: 'succeeded', limit: LIST_LIMIT })
      .filter((task) => task.prUrl != null);
    for (const parent of candidates) {
      // 单条失败不中断：记进 failed 继续；成功 / 跳过的照常收集。
      const result = await followTask(db, parent, {
        ghBin: config.ghBin,
        env: ctx.env,
        config,
        throwOnError: false,
      });
      if (result.kind === 'created') {
        created.push({ id: result.id, parentId: result.parentId, branch: result.branch, source: result.source });
      } else if (result.kind === 'skipped') {
        skipped.push({ parentId: result.parentId, message: result.message });
      } else {
        failed.push({ parentId: result.parentId, message: result.message });
      }
    }
  } finally {
    db.close();
  }
  if (jsonOut) {
    ctx.stdout.write(`${JSON.stringify({ created, skipped, failed })}\n`);
    return failed.length > 0 ? 1 : 0;
  }
  // 每个结果一行，用 follow <id> 的原句（前面带父任务号便于分辨），不另打摘要。
  for (const item of created) {
    ctx.stdout.write(`#${item.parentId} 已入队 #${item.id}，在分支 ${item.branch} 上改\n`);
  }
  for (const item of skipped) {
    ctx.stdout.write(`#${item.parentId} ${item.message}\n`);
  }
  for (const item of failed) {
    ctx.stdout.write(`#${item.parentId} 失败：${item.message}\n`);
  }
  return failed.length > 0 ? 1 : 0;
}
