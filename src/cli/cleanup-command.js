// cleanup 子命令（issue #40）：清理已结束任务（succeeded / failed / canceled）遗留的
// worktree 目录与超过保留期的运行日志。只动磁盘：不删任务 / runs 行，不删 repos/ 缓存，
// 不动分支；queued / running 任务的 worktree 与日志一律不碰。
//
// ⚠️ 与 task-commands.js 同理：本文件（及其静态依赖）绝不能 import src/db.js——它是
// 唯一加载 node:sqlite 的模块，静态引入会让入口来不及先装 SQLite 警告过滤（时机说明
// 见 src/warnings.js）。openDb 一律走 run() 里的动态 import。
//
// 与调度器自己的清理（src/scheduler.js → src/git.js removeWorktree）刻意分开：那边
// git 失败时会退回物理删目录并吞掉错误；本命令是用户手动跑的批量清理，必须把每个
// 失败原样报出来（git 的 stderr + 哪个路径失败）、继续处理剩下的目标、最后退出码 1。
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';
import { resolveHome } from '../config.js';

const DAY_MS = 86_400_000;
/** --logs-older-than 缺省值（天）。 */
const DEFAULT_LOGS_DAYS = 14;
/** worktree 只清这些终态任务（注意 canceled 不是 cancelled）。 */
const FINISHED_TASK_STATUSES = ['succeeded', 'failed', 'canceled'];
/** 这些状态的任务仍在用各自的 worktree / 日志，一律不碰。 */
const ACTIVE_TASK_STATUSES = ['queued', 'running'];

export const cleanupCommand = {
  summary: '清理已结束任务的 worktree 和过期日志',
  usage: '用法：night-shift cleanup [--dry-run] [--logs-older-than <天数>] [--json]',
  async run(args, ctx) {
    const { values } = parseArgs({
      args,
      options: {
        'dry-run': { type: 'boolean' },
        'logs-older-than': { type: 'string' },
        json: { type: 'boolean' },
      },
    });
    const dryRun = values['dry-run'] === true;
    const jsonOut = values.json === true;
    let logDays = DEFAULT_LOGS_DAYS;
    if (values['logs-older-than'] !== undefined) {
      const raw = values['logs-older-than'];
      // 只接受 ≥0 的整数（负数 / 小数 / 非数字都是用法错误，退出码 2）。
      if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
        throw new ctx.UsageError(`--logs-older-than 必须是不小于 0 的整数（当前值：${raw}）`, {
          usage: cleanupCommand.usage,
        });
      }
      logDays = Number(raw);
    }

    const home = resolveHome(ctx.env);
    const { openDb } = await import('../db.js'); // 动态 import：给警告过滤留出安装时间
    const dbPath = path.join(home, 'night-shift.db');
    let db;
    try {
      db = openDb(dbPath);
    } catch (err) {
      throw new Error(`无法打开数据库 ${dbPath}：${err.message}`);
    }

    // report：这次真正删掉（dry-run 则是将删）的路径 + 是否出现过失败（失败也继续，
    // 全部处理完统一以退出码 1 结束）。
    const report = { worktrees: [], logs: [], failed: false };
    try {
      await cleanupWorktrees(db, { home, dryRun, report, stderr: ctx.stderr });
      // --logs-older-than 0：这次完全不处理日志（不列、不删）。
      if (logDays > 0) {
        cleanupLogs(db, { home, days: logDays, dryRun, report, stderr: ctx.stderr });
      }
    } finally {
      db.close();
    }

    if (jsonOut) {
      ctx.stdout.write(`${JSON.stringify({ worktrees: report.worktrees, logs: report.logs })}\n`);
    } else if (dryRun) {
      for (const p of [...report.worktrees, ...report.logs]) ctx.stdout.write(`${p}\n`);
    } else {
      ctx.stdout.write(`worktree：删除 ${report.worktrees.length} 个\n`);
      ctx.stdout.write(`日志：删除 ${report.logs.length} 个\n`);
    }
    return report.failed ? 1 : 0;
  },
};

// ---------------------------------------------------------------- worktree

/**
 * 逐个删除已结束任务的 <home>/worktrees/task-<id>（id 升序）。目录不存在就跳过；
 * 删除守卫（resolve 与 realpath 都必须严格在 <home>/worktrees/ 之内）不过的记失败。
 * 真删走 git：从 worktree 自己的仓库删（rev-parse --git-common-dir 找主仓库，
 * 再在主仓库里 worktree remove --force），git 失败不退回物理删目录。
 */
async function cleanupWorktrees(db, { home, dryRun, report, stderr }) {
  const worktreesRoot = path.resolve(home, 'worktrees');
  const realRoot = realpathOrNull(worktreesRoot) ?? worktreesRoot;
  const ids = db.prepare(
    `SELECT id FROM tasks WHERE status IN (${FINISHED_TASK_STATUSES.map(() => '?').join(', ')})
     ORDER BY id ASC`,
  ).all(...FINISHED_TASK_STATUSES).map((row) => row.id);
  for (const id of ids) {
    const candidate = path.resolve(worktreesRoot, `task-${id}`);
    if (!isStrictlyInside(candidate, worktreesRoot)) {
      stderr.write(`拒绝删除 worktree：${candidate} 不在 ${worktreesRoot} 之内\n`);
      report.failed = true;
      continue;
    }
    const real = realpathOrNull(candidate);
    if (real === null) continue; // 目录不存在：不算删除，也不算失败
    if (!isStrictlyInside(real, realRoot)) {
      stderr.write(
        `拒绝删除 worktree：${candidate} 经符号链接解析后在 ${worktreesRoot} 之外（${real}）\n`,
      );
      report.failed = true;
      continue;
    }
    if (dryRun) {
      report.worktrees.push(real);
      continue;
    }
    if (await removeWorktreeViaGit(candidate, stderr)) {
      if (fs.existsSync(candidate)) { // git 退出 0 但目录还在：按失败计，不进「删除 n 个」
        stderr.write(`清理 worktree 失败：${candidate}（git 成功退出但目录仍存在）\n`);
        report.failed = true;
      } else {
        report.worktrees.push(real);
      }
    } else {
      report.failed = true;
    }
  }
}

/**
 * 用 git 删一个 worktree：先 `git -C <worktree> rev-parse --git-common-dir` 找到它所属
 * 的主仓库（common dir 以 /.git 结尾时主仓库就是它的 dirname），再在主仓库里执行
 * `git worktree remove --force <绝对路径>`（分支与远端不动，不 prune）。
 * 失败时把 git 的 stderr 原样打到 stderr，再补一行中文点明哪个路径失败。
 * @returns {Promise<boolean>} 是否删除成功（false 时错误信息已写到 stderr）
 */
async function removeWorktreeViaGit(worktree, stderr) {
  const probed = await runGit(['-C', worktree, 'rev-parse', '--git-common-dir']);
  if (!probed.ok) {
    emitGitFailure(stderr, probed, worktree);
    return false;
  }
  const commonDirRaw = probed.stdout.trim();
  const commonDir = path.resolve(worktree, commonDirRaw.replace(/\/+$/, ''));
  if (!commonDir.endsWith(`${path.sep}.git`)) {
    stderr.write(`清理 worktree 失败：无法从 ${worktree} 确定所属主仓库（git-common-dir=${commonDirRaw}）\n`);
    return false;
  }
  const removed = await runGit(
    ['-C', path.dirname(commonDir), 'worktree', 'remove', '--force', worktree],
  );
  if (!removed.ok) {
    emitGitFailure(stderr, removed, worktree);
    return false;
  }
  return true;
}

/** git 失败的统一输出：git 自己的 stderr 原样照发，再一行中文点名失败的路径。 */
function emitGitFailure(stderr, result, worktree) {
  const tail = result.stderr ?? '';
  if (tail.trim() !== '') stderr.write(tail.endsWith('\n') ? tail : `${tail}\n`);
  stderr.write(`清理 worktree 失败：${worktree}\n`);
}

// ---------------------------------------------------------------- 日志

/**
 * 删除 <home>/logs/ 下（递归）修改时间早于 days 天、名字以 .log 结尾（大小写敏感）
 * 的文件。例外：queued / running 任务的日志必须留下——按目录名（<logs>/task-<id>/ 之下
 * 且该任务是活跃状态）或 runs.log_path 精确匹配判定。非 .log 文件、logs 目录本身不删。
 */
function cleanupLogs(db, { home, days, dryRun, report, stderr }) {
  const logsRoot = path.resolve(home, 'logs');
  const realLogsRoot = realpathOrNull(logsRoot);
  if (realLogsRoot === null) return; // logs 目录不存在：没有日志可清
  const cutoff = Date.now() - days * DAY_MS; // 严格早于 cutoff 才算到龄（正好 N 天不删）

  const activeIds = new Set(db.prepare(
    `SELECT id FROM tasks WHERE status IN (${ACTIVE_TASK_STATUSES.map(() => '?').join(', ')})`,
  ).all(...ACTIVE_TASK_STATUSES).map((row) => row.id));
  const activeRunLogPaths = new Set(db.prepare(`
    SELECT r.log_path AS logPath
    FROM runs r JOIN tasks t ON t.id = r.task_id
    WHERE t.status IN (${ACTIVE_TASK_STATUSES.map(() => '?').join(', ')}) AND r.log_path != ''
  `).all(...ACTIVE_TASK_STATUSES).map((row) => path.resolve(row.logPath)));

  const found = []; // 到龄的 .log：{ file（发现的路径，unlink 用它）, real（输出 / 判界用） }
  const seen = new Set(); // realpath 去重：符号链接可能让同一个文件被走到两次
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.name.endsWith('.log')) continue; // 非 .log 一律不碰
      let stat;
      try {
        stat = fs.statSync(full);
      } catch {
        continue; // 竞态下文件没了：跳过
      }
      if (!stat.isFile()) continue;
      if (!(stat.mtimeMs < cutoff)) continue;
      const real = realpathOrNull(full);
      if (real === null || seen.has(real)) continue;
      seen.add(real);
      found.push({ file: full, real });
    }
  };
  walk(logsRoot);

  for (const { file, real } of found) {
    if (!isStrictlyInside(real, realLogsRoot)) {
      stderr.write(`拒绝删除日志：${file} 经符号链接解析后在 ${logsRoot} 之外（${real}）\n`);
      report.failed = true;
      continue;
    }
    if (isActiveLog(file, real, { logsRoot, activeIds, activeRunLogPaths })) continue;
    if (dryRun) {
      report.logs.push(real);
      continue;
    }
    try {
      fs.unlinkSync(file);
    } catch (err) {
      stderr.write(`删除日志失败 ${file}：${err.message}\n`);
      report.failed = true;
      continue;
    }
    report.logs.push(real);
  }
  report.logs.sort(compareByBytes); // 输出按路径字节序升序
}

/** 日志是否属于还在跑 / 还在排队的任务（到龄也必须留下）。 */
function isActiveLog(file, real, { logsRoot, activeIds, activeRunLogPaths }) {
  // <logs>/task-<id>/… 之下且该任务是 queued / running。
  const firstSegment = path.relative(logsRoot, file).split(path.sep)[0];
  const match = /^task-(\d+)$/.exec(firstSegment);
  if (match !== null && activeIds.has(Number(match[1]))) return true;
  // 或该文件的绝对路径等于某条活跃任务 runs.log_path。
  return activeRunLogPaths.has(path.resolve(file)) || activeRunLogPaths.has(real);
}

// ---------------------------------------------------------------- 辅助

/** 字符串按字节序比较（ASCII 路径与字典序一致；排序参数给 Array#sort 用）。 */
function compareByBytes(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * child 是否严格位于 parent 之内（按 path.resolve 判定；等于 parent、越出（..）
 * 或是绝对路径拼接都算不在内）。与 src/git.js 的同名实现一致（那边未导出）。
 */
function isStrictlyInside(child, parent) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

/** realpath；路径不存在时返回 null。 */
function realpathOrNull(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

// 与 src/git.js 同一组「会强行覆盖按 cwd 发现仓库规则」的 GIT_* 变量：夜班进程若从
// 别的 git 脚本里启动而不小心带上，`git -C` 会操作到完全错误的仓库。一律剥掉。
const GIT_DISCOVERY_ENV_KEYS = [
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_NAMESPACE',
];

/**
 * spawn('git', args)（参数数组、不经 shell、忽略 stdin，环境加 GIT_TERMINAL_PROMPT=0）。
 * 不抛错：结果带 ok（退出码是否 0）/ stdout / stderr，失败处理交给调用方。
 */
function runGit(args, { cwd } = {}) {
  return new Promise((resolve) => {
    const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
    for (const key of GIT_DISCOVERY_ENV_KEYS) delete env[key];
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    let child;
    try {
      child = spawn('git', args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      done({ ok: false, stdout: '', stderr: String(err?.message ?? err) });
      return;
    }
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.stdout.on('error', () => {});
    child.stderr.on('error', () => {});
    child.on('error', (err) => {
      done({ ok: false, stdout, stderr: `${stderr}${err.message}` });
    });
    child.on('close', (code) => {
      done({ ok: code === 0, stdout, stderr });
    });
  });
}
