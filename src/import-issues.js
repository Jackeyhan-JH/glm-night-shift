// 按 GitHub issue 批量入队的共享逻辑（issue #39 建、#50 从命令行抽出来）：spawn gh
// 拉 issue 列表（fetchIssues）、逐条去重入队或 dry-run 预览（enqueueIssues）。命令行
// （src/cli/task-commands.js 的 importCommand）与看板后端（src/server.js 的
// POST /api/import）都走这里，保证 added / skipped 的形状、source 的拼法、gh 失败的
// 错误句子两边逐字一致。
//
// ⚠️ 本文件静态 import src/tasks.js（建任务 / 按 source 查重），tasks.js 不碰
// node:sqlite；本文件绝不 import src/db.js——连接由调用方 openDb 后传入。命令文件
// 在 run() 里动态 import 本文件（时机说明见 src/warnings.js）；server.js 本来就在
// 任务模块一侧，静态 import 没问题。
import { spawn } from 'node:child_process';
import { createTask, findTaskBySource } from './tasks.js';

/** repo 的格式（与 store 层同一约定；CLI / HTTP 都在入口先拦下，gh 不带脏值）。 */
export const IMPORT_REPO_PATTERN = /^[\w.-]+\/[\w.-]+$/;
/** state 允许的值（透传给 gh issue list）。 */
export const IMPORT_STATES = ['open', 'closed', 'all'];
/** --limit / limit 的缺省值。 */
export const IMPORT_DEFAULT_LIMIT = 50;
/** difficulty 的缺省值。 */
export const IMPORT_DEFAULT_DIFFICULTY = 'medium';
/** import 生成的标题按 Unicode 码点截断到 80（不加省略号）。 */
export const IMPORT_TITLE_CODE_POINTS = 80;

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

/**
 * 解析并校验 gh issue list 的输出：必须是 JSON 数组，且每项 number 是正整数、
 * title 是字符串（body 缺省 / null 当空串，调用方处理）。不合法抛中文错误，
 * 一个任务都不会写。
 */
function parseIssueList(stdout) {
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch (err) {
    throw new Error(`gh issue list 的输出不是合法 JSON：${err.message}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`gh issue list 的输出不是 JSON 数组：${stdout.slice(0, 400) || '（空）'}`);
  }
  for (const [index, issue] of parsed.entries()) {
    if (!Number.isSafeInteger(issue?.number) || issue.number < 1) {
      throw new Error(`gh issue list 第 ${index + 1} 项的 number 不是正整数：${JSON.stringify(issue)}`);
    }
    if (typeof issue?.title !== 'string') {
      throw new Error(`gh issue list 第 ${index + 1} 项的 title 不是字符串：${JSON.stringify(issue)}`);
    }
  }
  return parsed;
}

/**
 * `gh issue list` 拉一个仓库的 issue 列表（先于任何入库动作，gh 失败时不会建任务）。
 * @param {object} options
 * @param {string} options.repo owner/name（调用方已校验格式）
 * @param {string} [options.label] 标签；缺省时 gh 参数里不带 --label（与 CLI 一致）
 * @param {string} [options.state='open'] open | closed | all
 * @param {number} [options.limit=50]
 * @param {string} options.ghBin gh 可执行文件（生效配置）
 * @param {object} options.env gh 子进程的环境变量
 * @returns {Promise<Array<object>>} gh 输出的 issue 数组（已校验形状）
 * @throws {Error} gh 非零退出（错误句子与命令行同一句）或输出不合法
 */
export async function fetchIssues({
  repo, label, state = 'open', limit = IMPORT_DEFAULT_LIMIT, ghBin, env,
}) {
  // gh 参数走数组不经 shell；--label 缺省时不传。
  const ghArgs = ['issue', 'list', '--repo', repo, '--state', state];
  if (label !== undefined && label !== null) ghArgs.push('--label', label);
  ghArgs.push('--json', 'number,title,body', '--limit', String(limit));
  const res = await spawnCapture(ghBin, ghArgs, env);
  if (res.code !== 0) {
    throw new Error(`gh issue list 失败（退出码 ${res.code}）：${res.stderr.trim()}`);
  }
  return parseIssueList(res.stdout);
}

/**
 * 把 issue 列表逐条入队（或 dry-run 只预览）：已有同 source 任务（任意状态）就跳过，
 * 不重复入队。
 * @param {object} options
 * @param {import('node:sqlite').DatabaseSync} options.db
 * @param {string} options.repo
 * @param {Array<object>} options.issues fetchIssues 的返回
 * @param {string} [options.difficulty='medium']
 * @param {boolean} [options.dryRun=false] true 时不写库，added 里是预览对象
 * @param {number} options.maxAttempts 建任务用的缺省尝试次数（生效配置，与 add 一致）
 * @returns {{ added: Array<object>, skipped: Array<object>, lines: string[] }}
 *   added：dry-run 时 {issue,title,source,prompt,repo,difficulty}，正式时 createTask
 *   返回的整行任务；skipped：{issue,taskId,status}（dry-run 本批重复为 taskId:null）；
 *   lines：人类可读输出的一行一条（末尾的合计行由调用方拼）。
 */
export function enqueueIssues({
  db, repo, issues, difficulty = IMPORT_DEFAULT_DIFFICULTY, dryRun = false, maxAttempts,
}) {
  const tailLine = `在仓库 ${repo} 完成这个 issue。不要 push，不要切分支。`;
  const added = [];
  const skipped = [];
  const lines = [];
  const previewed = new Set(); // dry-run 里本批将新增的 source（还没落库，重复时单独提示）
  for (const issue of issues) {
    const source = `github:${repo}#${issue.number}`;
    const title = [...`修复 #${issue.number}：${issue.title}`]
      .slice(0, IMPORT_TITLE_CODE_POINTS).join('');
    const body = typeof issue.body === 'string' ? issue.body.trim() : '';
    const prompt = body === '' ? tailLine : `${body}\n${tailLine}`;
    // 已有同 source 的任务（任意状态）就跳过，不重复入队。
    const existing = findTaskBySource(db, source);
    if (existing !== null) {
      skipped.push({ issue: issue.number, taskId: existing.id, status: existing.status });
      lines.push(`跳过 #${issue.number}：已有任务 #${existing.id}（${existing.status}）`);
      continue;
    }
    if (dryRun) {
      if (previewed.has(source)) {
        skipped.push({ issue: issue.number, taskId: null, status: null });
        lines.push(`将跳过 #${issue.number}：本批重复`);
        continue;
      }
      previewed.add(source);
      added.push({ issue: issue.number, title, source, prompt, repo, difficulty });
      lines.push(`将新增 ${title}`);
      continue;
    }
    // 正式运行里本批重复走上面的 findTaskBySource（刚插入的行就能查到）。
    const task = createTask(db, {
      repo,
      title,
      prompt,
      source,
      difficulty,
      priority: 0,
      allowPeak: false,
      maxAttempts, // 与 add 的缺省一致
    });
    added.push(task);
    lines.push(`新增 #${task.id} ${task.title}`);
  }
  return { added, skipped, lines };
}
