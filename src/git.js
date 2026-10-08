// Git / gh 集成（issue #8）：仓库缓存、worktree、提交推送与开 PR，供 #9 的调度器按序调用。
// 约定：git 一律 spawn('git', [参数数组])，不经过 shell；子进程环境带 GIT_TERMINAL_PROMPT=0
// （绝不交互等输入）。失败抛 GitError，message 里带完整命令、退出码和 stderr 末尾。
// gh 的调用与 git 同构（参数数组 + 单独的可执行文件路径），失败也复用 GitError，
// 此时 command 以 gh 的可执行文件路径开头。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_CONFIG } from './config.js';

/** GitError.stderr 只保留末尾这么多个字符（命令输出可能很长）。 */
const STDERR_TAIL_CHARS = 2000;
/** runTestCommand 输出缓冲只保留末尾这么多字节。 */
const OUTPUT_CAP_BYTES = 64 * 1024;
/** 测试进程退出后，等输出管道收尾的最长时间（后台孙进程可能还占着管道）。 */
const CLOSE_GRACE_MS = 500;
/** 超时 SIGTERM 之后，升级为 SIGKILL 前的宽限期。 */
const KILL_GRACE_MS = 2000;

/**
 * 外部命令（git / gh）失败时抛出的错误。
 * message 的组成为：命令行 + 退出码 + stderr（或 stdout）末尾，方便日志直接落盘。
 */
export class GitError extends Error {
  /**
   * @param {string} message
   * @param {object} info
   * @param {string} info.command 人可读的命令行，如 `git worktree add -B …`
   * @param {string[]} [info.args] 去掉可执行文件后的参数
   * @param {number|null} [info.exitCode] 退出码；进程没跑起来或被信号杀死时为 null
   * @param {string} [info.stderr] stderr（自动只保留末尾 2000 字符）
   */
  constructor(message, { command, args = [], exitCode = null, stderr = '' } = {}) {
    super(message);
    this.name = 'GitError';
    this.command = command;
    this.args = args.slice();
    this.exitCode = exitCode;
    this.stderr = typeof stderr === 'string' ? stderr.slice(-STDERR_TAIL_CHARS) : '';
  }
}

function commandLine(bin, args) {
  return [bin, ...args].map(quoteArg).join(' ');
}

/** 错误信息里给参数加引号：含空白/引号/非 ASCII 的参数（提交说明、标题……）照原样拼会难以阅读。 */
function quoteArg(arg) {
  return /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`;
}

/** 拼一个「命令失败」的 GitError：命令 + 退出码 + stderr（stdout 兜底）末尾。 */
function commandFailed(bin, args, exitCode, stderr, stdout) {
  const command = commandLine(bin, args);
  const tail = (typeof stderr === 'string' && stderr.trim() !== '' && stderr)
    || (typeof stdout === 'string' && stdout.trim() !== '' && stdout)
    || '';
  const reason = exitCode === null ? '被信号终止' : `退出码 ${exitCode}`;
  const message = `命令失败（${reason}）：${command}${tail === '' ? '' : `\n${tail.slice(-STDERR_TAIL_CHARS)}`}`;
  return new GitError(message, { command, args, exitCode, stderr });
}

/** 拼一个「进程没跑起来」的 GitError（可执行文件不存在、cwd 不存在等）。 */
function launchFailed(bin, args, cause, cwd) {
  const command = commandLine(bin, args);
  const where = cwd ? `（工作目录 ${cwd}）` : '';
  const message = `无法启动 ${bin}${where}：${cause && cause.message ? cause.message : String(cause)}（命令：${command}）`;
  return new GitError(message, { command, args, exitCode: null, stderr: '' });
}

// 这些 GIT_* 环境变量会强行覆盖「按 cwd 发现仓库」的规则：夜班进程若不小心带上
// （比如从别的 git 脚本里启动），所有「在缓存目录里跑」的 git 命令会操作到完全错误的
// 仓库上，且往往不报错。一律剥掉；身份/配置类变量（GIT_AUTHOR_*、GIT_CONFIG_*）保留。
const GIT_DISCOVERY_ENV_KEYS = [
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_NAMESPACE',
];

/**
 * 内部通用的子进程执行器：spawn(bin, args)，参数数组、无 shell、忽略 stdin，
 * 子进程环境 = process.env 去掉 GIT_DISCOVERY_ENV_KEYS 后再叠加 env。
 * 退出码非 0 抛 GitError，成功返回 { stdout, stderr }。
 */
function runProcess(bin, args, { cwd, env } = {}) {
  return new Promise((resolve, reject) => {
    const childEnv = { ...process.env };
    for (const key of GIT_DISCOVERY_ENV_KEYS) delete childEnv[key];
    Object.assign(childEnv, env);
    let child;
    try {
      child = spawn(bin, args, {
        cwd,
        env: childEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      reject(launchFailed(bin, args, err, cwd));
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
    let settled = false;
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      reject(launchFailed(bin, args, err, cwd));
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      if (code === 0) resolve({ stdout, stderr });
      else reject(commandFailed(bin, args, code, stderr, stdout));
    });
  });
}

/** 内部 git 执行器：额外加 GIT_TERMINAL_PROMPT=0，任何凭据询问直接失败而不是挂住。 */
function runGit(args, { cwd, env } = {}) {
  return runProcess('git', args, { cwd, env: { ...env, GIT_TERMINAL_PROMPT: '0' } });
}

/** 内部 gh 执行器：禁掉 gh 的交互提示和自动更新检查。 */
function runGh(bin, args, { env } = {}) {
  return runProcess(bin, args, { env: { ...env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1' } });
}

// —— 同一仓库缓存的串行锁 ——
// #9 会并发跑多个任务，同一个 repo 缓存上的操作（克隆/拉取/worktree/推送）必须排队，
// 否则 fetch 与 worktree add 互相踩、坏缓存恢复会重复克隆。锁只在进程内有效，足够：
// 一个夜班进程就是唯一写这些缓存的进程。
// key 一律经 lockKey() 归一化：ensureRepoCache/createWorktree/removeWorktree 用
// repoCacheDir(home, repo) 算 key，pushBranch 从 worktree 反推缓存目录算 key——
// 同一个缓存目录必须落到同一个 key 上，序列化才成立。
const repoLocks = new Map(); // key（归一化后的缓存目录路径）-> 队尾 Promise（永不 reject）

/** 把 fn 排进 key 的队列里执行；fn 抛出的错误原样传给调用方，不影响后续排队。 */
function withLock(key, fn) {
  const previous = repoLocks.get(key) ?? Promise.resolve();
  const result = previous.then(() => fn());
  const tail = result.then(() => {}, () => {}); // 队尾永不 reject，后续操作不被上一次失败卡死
  repoLocks.set(key, tail);
  tail.then(() => {
    if (repoLocks.get(key) === tail) repoLocks.delete(key); // 没人排队了就回收，避免 Map 无限增长
  });
  return result;
}

// —— 路径工具 ——

/** realpath；路径不存在时返回 null（供锁 key / 删除守卫降级用）。 */
function realpathOrNull(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

/**
 * child 是否严格位于 parent 之内（按 path.resolve 判定；等于 parent、越出（..）
 * 或是绝对路径拼接都算不在内）。注意 '..foo' 这种合法目录名不算越出。
 */
function isStrictlyInside(child, parent) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

/**
 * 同一个目录 → 同一个锁 key：resolve 之后再 realpath（解掉符号链接）。
 * macOS 的 /tmp、用户把 NIGHT_SHIFT_HOME 放进符号链接目录时，resolve 和 realpath
 * 是两个字符串，不归一就会出现两把锁、序列化失效。目录还不存在（首次克隆前）时
 * 退回 resolve 结果——此时并发调用拿到的是同一个原始字符串，仍然互斥。
 */
function lockKey(dir) {
  return realpathOrNull(dir) ?? path.resolve(dir);
}

/**
 * 删除守卫：rm -rf 只允许删 parentDir 严格之内的路径，双重判定（resolve 与 realpath，
 * 连「parentDir 之内的符号链指向别处」也拦下），不满足就直接抛错，先于任何删除动作。
 */
function assertDeleteInside(target, parentDir, what) {
  if (!isStrictlyInside(target, parentDir)) {
    throw new Error(`拒绝删除${what}：${target} 不在 ${parentDir} 之内`);
  }
  const targetReal = realpathOrNull(target);
  const parentReal = realpathOrNull(parentDir) ?? path.resolve(parentDir);
  if (targetReal !== null && !isStrictlyInside(targetReal, parentReal)) {
    throw new Error(`拒绝删除${what}：${target} 经符号链接解析后在 ${parentDir} 之外（${targetReal}）`);
  }
}

/** 通用参数校验：非空字符串（纯空白也算空）。 */
function assertNonEmptyString(value, what) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${what}必须是非空字符串，当前：${JSON.stringify(value)}`);
  }
}

// —— 仓库标识与地址 ——

const REPO_RE = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/;

/** 校验并拆分 owner/name；不是这个形状就抛错（值会原样进错误信息）。 */
function parseRepo(repo) {
  const value = typeof repo === 'string' ? repo.trim() : repo;
  const match = typeof value === 'string' ? REPO_RE.exec(value) : null;
  if (!match) {
    throw new Error(`非法仓库标识 ${JSON.stringify(repo)}：应为 owner/name`);
  }
  return { owner: match[1], name: match[2], full: value };
}

/**
 * 仓库远端地址：把 config.remoteUrlTemplate 里的 {repo} {owner} {name} 全部替换掉。
 * config 缺省或不带该键时用 DEFAULT_CONFIG 的默认模板（GitHub https 地址）。
 * @returns {string} 例如 'https://github.com/a/b.git' 或 '/tmp/x/a__b.git'
 */
export function remoteUrl(repo, config = {}) {
  const { owner, name, full } = parseRepo(repo);
  const template = config.remoteUrlTemplate ?? DEFAULT_CONFIG.remoteUrlTemplate;
  if (typeof template !== 'string' || template === '') {
    throw new Error(`remoteUrlTemplate 必须是非空字符串，当前：${JSON.stringify(config.remoteUrlTemplate)}`);
  }
  return template.replaceAll('{repo}', full).replaceAll('{owner}', owner).replaceAll('{name}', name);
}

/**
 * 仓库缓存目录：<home>/repos/<owner>__<name>。owner/name 拼成一段是为了
 * 不在文件系统里多造一层目录，同时避免 owner 相同就互相混淆。
 */
export function repoCacheDir(home, repo) {
  assertNonEmptyString(home, 'repoCacheDir 的 home');
  const { owner, name } = parseRepo(repo);
  return path.join(home, 'repos', `${owner}__${name}`);
}

/**
 * 判断目录是否是一个「就在 dir 本身」的可用缓存形态：
 * - `rev-parse --show-toplevel` 必须解析到 dir 自己——否则 dir 只是某个更大仓库
 *   工作区里的子目录（NIGHT_SHIFT_HOME 恰好放在别人的 checkout 里时会出现），
 *   后续的 set-url / fetch / worktree 操作会误伤那个父仓库；
 * - `--absolute-git-dir` 必须是 dir/.git——排除裸仓库和别人仓库的 linked worktree
 *   （它们与主仓库共享远端配置和远端跟踪 ref）。
 * 命令失败（目录不存在、半截克隆……）或任一条件不满足都算不可用。
 */
async function isUsableCache(dir) {
  try {
    const { stdout } = await runGit(['rev-parse', '--show-toplevel', '--absolute-git-dir'], { cwd: dir });
    const [topLevel, gitDir] = stdout.trim().split('\n');
    const real = realpathOrNull(dir);
    return real !== null
      && realpathOrNull(topLevel) === real
      && realpathOrNull(gitDir) === realpathOrNull(path.join(real, '.git'));
  } catch {
    return false;
  }
}

/** origin 的当前地址；目录不是可用仓库或没有 origin 时返回 null。 */
async function originUrl(dir) {
  try {
    const { stdout } = await runGit(['remote', 'get-url', 'origin'], { cwd: dir });
    return stdout.trim();
  } catch {
    return null;
  }
}

/** 把 dir 变成指向 url 的可用缓存（无则克隆，坏则重建，好则按需改地址并拉取）。 */
async function syncRepoCache(home, dir, url) {
  const usable = await isUsableCache(dir);
  const currentUrl = usable ? await originUrl(dir) : null;
  if (!usable || currentUrl === null) {
    // 不存在、半截克隆，或是没有 origin 远端的怪形态：整个删掉重克隆最稳。
    // rm -rf 前过删除守卫：只允许删 <home>/repos/ 之内的路径。
    const target = path.resolve(dir);
    assertDeleteInside(target, path.join(home, 'repos'), '仓库缓存');
    fs.rmSync(target, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(target), { recursive: true });
    await runGit(['clone', '--no-checkout', url, target]);
    return;
  }
  if (currentUrl !== url) {
    await runGit(['remote', 'set-url', 'origin', url], { cwd: dir });
  }
  await runGit(['fetch', 'origin', '--prune'], { cwd: dir });
}

/**
 * 确保仓库缓存存在且最新：首次克隆（--no-checkout，只当对象库用），之后 fetch --prune。
 * 远端地址与模板算出的不一致（配置改过）时自动 `git remote set-url` 改指。
 * 同一缓存的并发调用会排队执行。返回缓存目录。
 */
export async function ensureRepoCache({ home, repo, config = {} }) {
  const dir = repoCacheDir(home, repo); // 一并校验 home / repo
  const url = remoteUrl(repo, config);
  return withLock(lockKey(dir), async () => {
    await syncRepoCache(home, dir, url);
    return dir;
  });
}

/**
 * 远端默认分支名：`git ls-remote --symref origin HEAD` 输出的 `ref: refs/heads/<name>\tHEAD`。
 * 输出解析不出分支名（比如空仓库）时抛 GitError，并附上原始输出。
 */
export async function defaultBranch(cacheDir) {
  const args = ['ls-remote', '--symref', 'origin', 'HEAD'];
  const { stdout } = await runGit(args, { cwd: cacheDir });
  for (const line of stdout.split('\n')) {
    const match = /^ref: refs\/heads\/(\S+)\tHEAD\s*$/.exec(line);
    if (match) return match[1];
  }
  const command = commandLine('git', args);
  throw new GitError(
    `无法从 ${command} 的输出解析默认分支，原始输出：\n${stdout.trim() === '' ? '（空）' : stdout.slice(-400)}`,
    { command, args, exitCode: 0, stderr: '' },
  );
}

/**
 * 标题转 slug：小写，非 [a-z0-9] 的连续字符换成 '-'，去首尾 '-'，最长 40 字符，
 * 结果为空（全中文/全标点标题）时用 'task'。
 */
export function slugify(title) {
  const slug = String(title ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/[\uD800-\uDFFF]$/, '') // 40 字符边界可能切在代理对中间，去掉半个字符
    .replace(/-+$/, '');
  return slug === '' ? 'task' : slug;
}

/**
 * 任务对应的分支名：`night-shift/<id>-<slug>`。只允许 night-shift/ 命名空间
 * （pushBranch 也只推这个空间），便于人工识别和批量清理。
 * task.id 只认正整数（number）：字符串 "12" 之类一律拒绝，避免同一个任务因
 * 调用方传入形态不同而生成两个不同的 worktree/分支。
 */
export function branchName(task) {
  const id = task?.id;
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error(`branchName 需要 task.id 为正整数（number），当前：${JSON.stringify(id)}`);
  }
  return `night-shift/${id}-${slugify(task?.title)}`;
}

/**
 * worktree 私有 git 目录里记录基线 sha 的文件名（<git-dir>/night-shift-base）。
 * createWorktree 写入，commitAll 读取，用来判断「Claude 自己提交过」。
 */
const BASE_SHA_FILE = 'night-shift-base';

async function recordBaseSha(worktree, sha) {
  try {
    const { stdout } = await runGit(['rev-parse', '--git-dir'], { cwd: worktree });
    // 链接式 worktree 里 --git-dir 返回主仓库 .git/worktrees/<name>（绝对路径），
    // 但保险起见按相对路径也解析一遍
    const gitDir = path.resolve(worktree, stdout.trim());
    fs.writeFileSync(path.join(gitDir, BASE_SHA_FILE), `${sha}\n`);
  } catch {
    // 记不下来不致命：commitAll 还有 @{upstream}..HEAD 兜底
  }
}

async function recordedBaseSha(worktree) {
  try {
    const { stdout } = await runGit(['rev-parse', '--git-dir'], { cwd: worktree });
    const gitDir = path.resolve(worktree, stdout.trim());
    const content = fs.readFileSync(path.join(gitDir, BASE_SHA_FILE), 'utf8').trim();
    return /^[0-9a-f]{40,64}$/.test(content) ? content : null;
  } catch {
    return null;
  }
}

/**
 * 为任务建 worktree：路径 <home>/worktrees/task-<id>，分支 night-shift/<id>-<slug>，
 * 从 origin/<baseBranch> 检出（-B：重试时分支已存在就强制重置到最新基线）。
 *
 * 只在**已存在的**缓存上干活，自己不克隆、不 fetch、不改 origin 地址——按规格，
 * #9 以 ensureRepoCache → defaultBranch → createWorktree 的顺序调用；缓存不可用
 * （没建过、被删了、半截克隆）就直接抛错。否则像 ensureRepoCache 那样带默认
 * GitHub 模板去 fetch，本地裸远端的缓存会被悄悄 re-point 到 github.com 并联网。
 *
 * 残留的同路径 worktree（上次没删干净）先 `worktree remove --force`，删不动再物理
 * 删目录（只允许删 <home>/worktrees/ 之内）。同一缓存上的并发调用排队执行。
 * @returns {{ path: string, branch: string, baseBranch: string, baseSha: string }}
 */
export async function createWorktree({ home, repo, task, baseBranch } = {}) {
  const branch = branchName(task); // 一并校验 task.id 为正整数
  assertNonEmptyString(baseBranch, 'createWorktree 的 baseBranch');
  const cacheDir = repoCacheDir(home, repo); // 一并校验 home / repo
  const worktreePath = path.join(home, 'worktrees', `task-${task.id}`);
  const worktreesRoot = path.join(home, 'worktrees');
  return withLock(lockKey(cacheDir), async () => {
    if (!(await isUsableCache(cacheDir))) {
      throw new Error(`仓库缓存不存在或不可用：${cacheDir}（请先调用 ensureRepoCache）`);
    }
    await runGit(['worktree', 'prune'], { cwd: cacheDir });
    if (fs.existsSync(worktreePath)) {
      try {
        await runGit(['worktree', 'remove', '--force', worktreePath], { cwd: cacheDir });
      } catch {
        // git 元数据里已经没有它（缓存重建过等）：物理删目录再清一次元数据。
        // 删除守卫在动手之前：只允许删 <home>/worktrees/ 之内的路径。
        assertDeleteInside(worktreePath, worktreesRoot, '残留 worktree');
        fs.rmSync(worktreePath, { recursive: true, force: true });
        await runGit(['worktree', 'prune'], { cwd: cacheDir });
      }
    }
    await runGit(['worktree', 'add', '-B', branch, worktreePath, `origin/${baseBranch}`], { cwd: cacheDir });
    const baseSha = (await runGit(['rev-parse', 'HEAD'], { cwd: worktreePath })).stdout.trim();
    await recordBaseSha(worktreePath, baseSha);
    return { path: worktreePath, branch, baseBranch, baseSha };
  });
}

/** git diff --cached --quiet：退出码 1 = 有暂存改动（约定俗成的「有差异」信号）。 */
async function hasStagedChanges(dir) {
  try {
    await runGit(['diff', '--cached', '--quiet'], { cwd: dir });
    return false;
  } catch (err) {
    if (err instanceof GitError && err.exitCode === 1) return true;
    throw err;
  }
}

async function headSha(dir) {
  try {
    return (await runGit(['rev-parse', 'HEAD'], { cwd: dir })).stdout.trim();
  } catch {
    return null;
  }
}

/** HEAD 比 @{upstream} 多出的提交数；没有上游或 git 报错时按 0 算。 */
async function commitsAheadOfUpstream(dir) {
  try {
    const { stdout } = await runGit(['rev-list', '--count', '@{upstream}..HEAD'], { cwd: dir });
    const count = Number.parseInt(stdout.trim(), 10);
    return Number.isFinite(count) ? count : 0;
  } catch {
    return 0;
  }
}

/**
 * 暂存全部改动（git add -A）并在有改动时提交。
 * - config.gitAuthorName / gitAuthorEmail 有值时用 `-c user.name=… -c user.email=…`
 *   覆盖提交身份；都没有就落回机器自己的 git 身份（环境变量或全局配置）。
 * - 不传 --no-verify：仓库自带的 git 钩子照常执行（提交被钩子挡下会抛 GitError）。
 * - 提交说明走 `-m`，参数数组传递，不经 shell，无需转义。
 * changed 判定（满足其一）：
 *   1. 本次真的提交了（工作区有暂存改动）；
 *   2. HEAD 已不等于基线 sha —— Claude 在 worktree 里自己 commit 过。
 *      基线优先级：显式传入的 baseSha > createWorktree 记录的 night-shift-base
 *      > 兜底「HEAD 领先 @{upstream} 的提交数 > 0」。
 * @returns {{ changed: boolean, sha: string|null }} changed 时 sha 为提交后的完整 HEAD sha
 */
export async function commitAll({ worktree, message, config = {}, baseSha } = {}) {
  assertNonEmptyString(worktree, 'commitAll 的 worktree 路径');
  if (typeof message !== 'string' || message.trim() === '') {
    throw new Error(`commitAll 需要非空的提交说明，当前：${JSON.stringify(message)}`);
  }
  const base = typeof baseSha === 'string' && baseSha.trim() !== ''
    ? baseSha.trim()
    : await recordedBaseSha(worktree);
  await runGit(['add', '-A'], { cwd: worktree });
  let committed = false;
  if (await hasStagedChanges(worktree)) {
    await commit(worktree, message, config);
    committed = true;
  }
  const head = await headSha(worktree);
  const moved = base !== null
    ? head !== null && head !== base
    : (await commitsAheadOfUpstream(worktree)) > 0;
  const changed = committed || moved;
  return { changed, sha: changed ? head : null };
}

async function commit(worktree, message, config) {
  const args = [];
  const env = {};
  // 同时给 -c 和 GIT_AUTHOR_*/GIT_COMMITTER_* 环境变量：git 解析提交身份时
  // 环境变量优先于 -c，只给 -c 的话机器上残留的 GIT_AUTHOR_* 会盖掉显式配置。
  if (config.gitAuthorName) {
    args.push('-c', `user.name=${config.gitAuthorName}`);
    env.GIT_AUTHOR_NAME = config.gitAuthorName;
    env.GIT_COMMITTER_NAME = config.gitAuthorName;
  }
  if (config.gitAuthorEmail) {
    args.push('-c', `user.email=${config.gitAuthorEmail}`);
    env.GIT_AUTHOR_EMAIL = config.gitAuthorEmail;
    env.GIT_COMMITTER_EMAIL = config.gitAuthorEmail;
  }
  args.push('commit', '-m', message);
  await runGit(args, { cwd: worktree, env });
}

/** 输出尾部缓冲：只保留末尾 OUTPUT_CAP_BYTES 字节，内存有界。 */
function tailBuffer() {
  const chunks = [];
  let total = 0;
  return {
    push(chunk) {
      chunks.push(chunk);
      total += chunk.length;
      while (total > OUTPUT_CAP_BYTES) {
        const drop = total - OUTPUT_CAP_BYTES;
        const first = chunks[0];
        if (first.length <= drop) {
          chunks.shift();
          total -= first.length;
        } else {
          chunks[0] = first.subarray(drop);
          total -= drop;
        }
      }
    },
    text() {
      const whole = Buffer.concat(chunks);
      // 头部可能正好卡在被截断的多字节 UTF-8 序列中间：跳过开头的续字节（最多 3 个），
      // 避免解码出 U+FFFD 替换字符
      let start = 0;
      while (start < 3 && start < whole.length && (whole[start] & 0xc0) === 0x80) start += 1;
      return whole.subarray(start).toString('utf8');
    },
  };
}

/**
 * 在 worktree 里跑测试命令：`sh -c <command>`，独立进程组（detached），stdin 忽略。
 * - command 为 null/undefined/纯空白：不跑任何东西，返回 { ok: true, skipped: true }。
 * - 超时（timeoutMs 显式给出，否则 config.testTimeoutMinutes 分钟，默认 15）：
 *   先 SIGTERM 整个进程组（连 sh 的孙进程一起），宽限后仍存活再 SIGKILL 整组。
 * - 测试命令**不允许留下任何进程**：正常退出也一样——resolve 前对整个进程组
 *   SIGTERM、宽限后 SIGKILL，后台孙进程（`xxx &`）一并清掉（孙进程自己 setsid
 *   换进程组的拦不住）。所有善后定时器都 unref，不会独自把事件循环拖住。
 * - 进程退出后若输出管道还被后台孙进程占着，最多再等 CLOSE_GRACE_MS 就收尾；
 *   收尾时销毁管道，仍在写管道的孙进程会收到 EPIPE。
 * - output 是 stdout+stderr 合并（按到达顺序交错）后的最后 64KiB，按 UTF-8 解码。
 * - 启动失败（sh 不存在、worktree 不存在）不抛错，ok:false，错误信息在 output 里。
 * @returns {{ ok: boolean, skipped: boolean, exitCode: number|null, timedOut: boolean,
 *             durationMs: number, output: string }}
 *          exitCode 被信号杀死时为 null；ok 仅在退出码 0 且未超时时为 true。
 */
export async function runTestCommand({ worktree, command, timeoutMs, config = {} } = {}) {
  if (command === null || command === undefined || String(command).trim() === '') {
    return { ok: true, skipped: true };
  }
  assertNonEmptyString(worktree, 'runTestCommand 的 worktree 路径');
  const minutes = config?.testTimeoutMinutes ?? DEFAULT_CONFIG.testTimeoutMinutes;
  const timeout = timeoutMs === null || timeoutMs === undefined
    ? minutes * 60000
    : Number(timeoutMs);
  if (!Number.isFinite(timeout) || timeout <= 0) {
    throw new Error(`runTestCommand 的超时必须大于 0（timeoutMs=${JSON.stringify(timeoutMs)}，testTimeoutMinutes=${JSON.stringify(minutes)}）`);
  }

  return new Promise((resolve) => {
    const startedAt = performance.now();
    let child;
    try {
      child = spawn('sh', ['-c', String(command)], {
        cwd: worktree,
        detached: true, // 独立进程组：超时/收尾能把 sh 和它的子孙一起杀掉
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      resolve(failedToLaunch(err, startedAt));
      return;
    }

    const out = tailBuffer();
    child.stdout.on('data', out.push);
    child.stderr.on('data', out.push);
    child.stdout.on('error', () => {});
    child.stderr.on('error', () => {});

    let timedOut = false;
    let launchErr = null;
    let settled = false;
    let closeGraceTimer = null;

    const killGroup = (signal) => {
      if (typeof child.pid !== 'number') return;
      try {
        process.kill(-child.pid, signal);
      } catch {
        // 进程组已经不在了，没事
      }
    };

    // 清理整个进程组：先 SIGTERM，宽限期后仍存活再 SIGKILL。定时器 unref——
    // 事件循环活着时照常触发，但绝不独自拖住进程。
    const killGroupEscalating = () => {
      killGroup('SIGTERM');
      const killTimer = setTimeout(() => killGroup('SIGKILL'), KILL_GRACE_MS);
      killTimer.unref();
    };

    const settle = (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(termTimer);
      if (closeGraceTimer !== null) clearTimeout(closeGraceTimer);
      // 主动收尾时关掉管道：还占着写端的孙进程会收到 EPIPE 而退出
      child.stdout.destroy();
      child.stderr.destroy();
      killGroupEscalating(); // 正常退出也清场：`xxx &` 留下的后台进程不能活着
      resolve({
        ok: launchErr === null && !timedOut && exitCode === 0,
        skipped: false,
        exitCode,
        timedOut,
        durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
        output: launchErr === null ? out.text() : failedToLaunchOutput(launchErr),
      });
    };

    const termTimer = setTimeout(() => {
      timedOut = true;
      killGroupEscalating();
    }, timeout);
    termTimer.unref();

    child.on('error', (err) => {
      if (settled) return;
      launchErr = err;
      settle(null);
    });
    child.on('exit', (code) => {
      if (settled) return;
      if (timedOut || launchErr !== null) {
        settle(code); // 超时杀掉 / 没起来：立刻收尾，不再等管道
        return;
      }
      // 正常退出：等 'close'（管道里剩余输出到齐），最多 CLOSE_GRACE_MS。
      closeGraceTimer = setTimeout(() => settle(code), CLOSE_GRACE_MS);
      closeGraceTimer.unref();
    });
    child.on('close', (code) => {
      if (!settled) settle(code);
    });
  });
}

function failedToLaunchOutput(err) {
  return `无法运行测试命令：${err && err.message ? err.message : String(err)}`;
}

function failedToLaunch(err, startedAt) {
  return {
    ok: false,
    skipped: false,
    exitCode: null,
    timedOut: false,
    durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
    output: failedToLaunchOutput(err),
  };
}

/**
 * worktree 所属的仓库缓存目录：linked worktree 的 `--git-common-dir` 指向共享的
 * <缓存>/.git，取上一级即缓存目录本身。取不到（worktree 不存在等）返回 null，
 * 调用方退回按 worktree 路径加锁——随后的 push 自己会以更清晰的错误失败。
 */
async function worktreeCacheDir(worktree) {
  try {
    const { stdout } = await runGit(['rev-parse', '--git-common-dir'], { cwd: worktree });
    const commonDir = stdout.trim();
    if (commonDir === '') return null;
    return lockKey(path.dirname(path.resolve(worktree, commonDir)));
  } catch {
    return null;
  }
}

/**
 * 推送 worktree 的当前提交到远端同名分支。
 * - `--force-with-lease`（不带参数）：以缓存里的远端跟踪 ref 为准——重试覆盖时
 *   只有远端仍停在我们见过的位置上才允许，防止抹掉别人的提交。缓存重新克隆/重新
 *   fetch 后跟踪 ref 与远端一致，覆盖旧分支总是成功；有人在我们上次 fetch 之后
 *   动过远端分支则被拒（stale info）——这是刻意的保护，再跑一次 ensureRepoCache
 *   （fetch 刷新跟踪 ref）即可恢复可推。
 * - push 会更新共享缓存仓库里的远端跟踪 ref，因此与 fetch / worktree 操作排
 *   同一条队列（从 worktree 反推出的缓存目录，与 ensureRepoCache 用的锁 key 归一）。
 * - 只接受 night-shift/ 开头的分支名，其他一律拒绝（防止误推 main 等长期分支）。
 * @returns {{ branch: string, sha: string|null }}
 */
export async function pushBranch({ worktree, branch }) {
  if (typeof branch !== 'string' || !branch.startsWith('night-shift/')) {
    throw new Error(`只允许推送 night-shift/ 命名空间下的分支，当前：${JSON.stringify(branch)}`);
  }
  assertNonEmptyString(worktree, 'pushBranch 的 worktree 路径');
  const key = (await worktreeCacheDir(worktree)) ?? lockKey(worktree);
  return withLock(key, async () => {
    await runGit(['push', '--force-with-lease', 'origin', `HEAD:refs/heads/${branch}`], { cwd: worktree });
    return { branch, sha: await headSha(worktree) };
  });
}

// —— gh：查/开 PR ——

function ghBinOf(config = {}) {
  return config.ghBin ?? DEFAULT_CONFIG.ghBin;
}

/**
 * 查远端仓库上该分支是否已有 open 状态的 PR（重试时不重复开）。
 * `<ghBin> pr list --repo <repo> --head <branch> --state open --json url`，
 * 解析 JSON 数组取第一个 url；没有返回 null。gh 退出码非 0 或输出不是
 * JSON 数组时抛 GitError（message 带 stdout/stderr 片段）。
 * env 会叠加进 gh 子进程环境（测试里用来传 FAKE_GH_* 变量并剥掉真实凭据）。
 */
export async function findOpenPr({ repo, branch, config = {}, env } = {}) {
  parseRepo(repo); // 校验 owner/name 形状
  assertNonEmptyString(branch, 'findOpenPr 的 branch');
  const ghBin = ghBinOf(config);
  const args = ['pr', 'list', '--repo', repo, '--head', branch, '--state', 'open', '--json', 'url'];
  const { stdout, stderr } = await runGh(ghBin, args, { env });
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    parsed = undefined;
  }
  if (!Array.isArray(parsed)) {
    throw new GitError(
      `${commandLine(ghBin, args)} 的输出不是 JSON 数组：\n${stdout.slice(-400) || '（空）'}${stderr.trim() === '' ? '' : `\n${stderr.slice(-STDERR_TAIL_CHARS)}`}`,
      { command: commandLine(ghBin, args), args, exitCode: 0, stderr },
    );
  }
  const hit = parsed.find((item) => item && typeof item.url === 'string' && item.url !== '');
  return hit === undefined ? null : hit.url;
}

/**
 * 开 PR。先 findOpenPr：已有 open PR 就直接返回它（existed: true，重试幂等）；
 * 否则把 body 写进临时文件（os.tmpdir() 下的独立目录，用完必删——gh 启动失败、
 * 退出非 0、取不到地址等所有路径都走同一个 finally），执行
 * `<ghBin> pr create --repo … --head … --base … --title … --body-file <file>`，
 * 从 stdout 取最后一个 https://…/pull/<数字> 地址。title/base 含空格、Unicode
 * 或以 '-' 开头都安全：参数数组不经 shell，'--title' 的下一个 token 一律是值。
 * 退出码非 0（runGh 抛错）或取不到地址都抛 GitError（带 stderr）。
 * @returns {{ url: string, existed: boolean }}
 */
export async function createPr({ repo, branch, base, title, body, config = {}, env } = {}) {
  parseRepo(repo); // 校验 owner/name 形状
  assertNonEmptyString(branch, 'createPr 的 branch');
  assertNonEmptyString(base, 'createPr 的 base');
  assertNonEmptyString(title, 'createPr 的 title');

  const existing = await findOpenPr({ repo, branch, config, env });
  if (existing !== null) return { url: existing, existed: true };

  const ghBin = ghBinOf(config);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'night-shift-pr-'));
  try {
    const bodyFile = path.join(tmpDir, 'body.md');
    fs.writeFileSync(bodyFile, typeof body === 'string' ? body : '', 'utf8');
    const args = [
      'pr', 'create',
      '--repo', repo,
      '--head', branch,
      '--base', base,
      '--title', title,
      '--body-file', bodyFile,
    ];
    const { stdout, stderr } = await runGh(ghBin, args, { env });
    const urls = stdout.match(/https:\/\/\S+\/pull\/\d+/g);
    const url = urls === null ? null : urls[urls.length - 1];
    if (url === null) {
      const command = commandLine(ghBin, args);
      throw new GitError(
        `命令成功但没有输出 PR 地址：${command}\n${stderr.slice(-STDERR_TAIL_CHARS) || stdout.slice(-STDERR_TAIL_CHARS)}`,
        { command, args, exitCode: 0, stderr },
      );
    }
    return { url, existed: false };
  } finally {
    // 临时目录清不掉（如 EBUSY）不应吞掉真正的失败原因；os.tmpdir() 系统终会回收
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // 忽略
    }
  }
}

/** PR 标题约定：`night-shift: <任务标题>`。 */
export function prTitle(task) {
  const title = String(task?.title ?? '').trim();
  return `night-shift: ${title === '' ? '未命名任务' : title}`;
}

// —— PR 正文（纯函数） ——

const PR_BODY_MAX_CHARS = 65536; // GitHub 的硬上限，超了会 422
const PROMPT_CAP_CHARS = 20000;
const SUMMARY_CAP_CHARS = 20000;
const TEST_OUTPUT_MAX_LINES = 40;
const TEST_OUTPUT_MAX_CHARS = 16000;
const COMMAND_CAP_CHARS = 2000;
const PR_FOOTER = '\n---\n\n由 GLM 夜班自动创建\n';

/**
 * 毫秒耗时转人类可读：1 小时 2 分 3 秒 / 45 秒 / <1 秒。
 * 非数字或负数返回「未知」，不足 1 秒返回「<1 秒」。
 */
export function formatDuration(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '未知';
  if (ms < 1000) return '<1 秒';
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const parts = [];
  if (hours > 0) parts.push(`${hours} 小时`);
  if (minutes > 0) parts.push(`${minutes} 分`);
  if (seconds > 0 || parts.length === 0) parts.push(`${seconds} 秒`);
  return parts.join(' ');
}

/**
 * 组装 PR 正文（Markdown）：任务 prompt（引用块）、运行摘要、模型/思考强度/高峰/
 * 耗时/额度/尝试次数、测试命令与结果（失败时附最后 40 行输出，折叠块），最后一行固定为
 * 「由 GLM 夜班自动创建」。所有字段都可能缺失：task/run/test 传 null 也不抛错，
 * 缺的东西用占位文本。整体长度压在 GitHub 的 65536 字符限制之下（超长字段截断并注明）。
 * @param {object} options
 * @param {{ prompt?: string, title?: string, attempts?: number,
 *           testCommand?: string }} [options.task]
 * @param {{ summary?: string, model?: string, effort?: string, peak?: boolean,
 *           durationMs?: number, quotaUnits?: number, attempt?: number }} [options.run]
 * @param {{ command?: string, ok?: boolean, skipped?: boolean, exitCode?: number|null,
 *           timedOut?: boolean, output?: string }} [options.test] runTestCommand 的结果
 *           外加 command 字段（或退回 task.testCommand）
 */
export function buildPrBody({ task, run, test } = {}) {
  const promptRaw = typeof task?.prompt === 'string' ? task.prompt : '';
  const summary = run?.summary == null || String(run.summary).trim() === ''
    ? '（无运行摘要）'
    : truncateEnd(String(run.summary), SUMMARY_CAP_CHARS, '…（摘要过长，已截断）');

  const lines = [];
  lines.push(quoteBlock(promptRaw === '' ? null : truncateEnd(promptRaw, PROMPT_CAP_CHARS, '…（prompt 过长，已截断）')), '');
  lines.push('## 运行摘要', '', summary, '');
  lines.push('## 运行信息', '');
  lines.push(`- 模型：${plainValue(run?.model)}`);
  lines.push(`- 思考强度：${plainValue(run?.effort)}`);
  lines.push(`- 高峰时段：${run?.peak === true ? '是' : run?.peak === false ? '否' : '未知'}`);
  lines.push(`- 耗时：${formatDuration(run?.durationMs)}`);
  lines.push(`- 估算额度：${run?.quotaUnits == null ? '未知' : String(run.quotaUnits)}`);
  lines.push(`- 尝试次数：${attemptText(run?.attempt, task?.attempts)}`, '');
  lines.push('## 测试', '', ...testLines(task, test));
  return appendFooter(`${lines.join('\n')}\n`);
}

function plainValue(value) {
  if (value == null) return '未知';
  const text = String(value).trim();
  return text === '' ? '未知' : text;
}

function attemptText(attempt, total) {
  const a = Number(attempt);
  if (!Number.isInteger(a) || a < 1) return '未知';
  const t = Number(total);
  return Number.isInteger(t) && t >= 1 ? `第 ${a} / ${t} 次` : `第 ${a} 次`;
}

/** prompt 引用块：每行加 `> ` 前缀，空行只有 `>`。 */
function quoteBlock(text) {
  const raw = typeof text === 'string' && text.trim() !== '' ? text : '（任务未提供 prompt）';
  return raw.split('\n').map((line) => (line.trim() === '' ? '>' : `> ${line}`)).join('\n');
}

function truncateEnd(text, max, note) {
  if (text.length <= max) return text;
  return `${text.slice(0, max).replace(/[\uD800-\uDFFF]$/, '')}\n${note}`;
}

function inlineCode(command) {
  const text = truncateEnd(String(command), COMMAND_CAP_CHARS, '…（命令过长，已截断）');
  return text.includes('`') ? `\`\` ${text} \`\`` : `\`${text}\``;
}

/** 测试小节：命令 + 结果（通过 / 失败（exit N / 超时 / 异常终止）/ 未配置）。 */
function testLines(task, test) {
  const fromTest = typeof test?.command === 'string' && test.command.trim() !== '' ? test.command : null;
  const fromTask = typeof task?.testCommand === 'string' && task.testCommand.trim() !== '' ? task.testCommand : null;
  const command = fromTest ?? fromTask;
  const result = test ?? {};
  if (command === null || result.skipped === true) {
    return [`- 命令：${command === null ? '（未配置）' : inlineCode(command)}`, '- 结果：未配置'];
  }

  let verdict;
  if (result.ok === true) verdict = '通过';
  else if (result.timedOut === true) verdict = '失败（超时）';
  else if (typeof result.exitCode === 'number') verdict = `失败（exit ${result.exitCode}）`;
  else verdict = '失败（异常终止）';

  const lines = [`- 命令：${inlineCode(command)}`, `- 结果：${verdict}`];
  if (result.ok !== true && typeof result.output === 'string' && result.output.trim() !== '') {
    const { text, lineCount } = outputTail(result.output);
    const fence = fenceFor(text);
    lines.push('', '<details>', `<summary>测试输出（最后 ${lineCount} 行）</summary>`, '', fence, text, fence, '', '</details>');
  }
  return lines;
}

/** 测试输出只留最后 40 行 / 16000 字符。 */
function outputTail(output) {
  const lines = output.replace(/\n+$/, '').split('\n');
  const kept = lines.length > TEST_OUTPUT_MAX_LINES ? lines.slice(-TEST_OUTPUT_MAX_LINES) : lines;
  let text = kept.join('\n');
  if (text.length > TEST_OUTPUT_MAX_CHARS) {
    text = `…（输出过长，已截断）\n${text.slice(text.length - TEST_OUTPUT_MAX_CHARS)}`;
  }
  return { text, lineCount: kept.length };
}

/** 围栏要比内容里最长的反引号串还长，否则 Markdown 会提前闭合。 */
function fenceFor(text) {
  let longest = 0;
  let current = 0;
  for (const ch of text) {
    if (ch === '`') {
      current += 1;
      if (current > longest) longest = current;
    } else {
      current = 0;
    }
  }
  return '`'.repeat(Math.max(3, longest + 1));
}

/** 正文超长时截掉中段说明性内容可以牺牲，但页脚必须原样留在最后。 */
function appendFooter(main) {
  if (main.length + PR_FOOTER.length <= PR_BODY_MAX_CHARS) return main + PR_FOOTER;
  const note = '…（正文过长，已截断）\n';
  const keep = Math.max(0, PR_BODY_MAX_CHARS - PR_FOOTER.length - note.length);
  return `${main.slice(0, keep).replace(/[\uD800-\uDFFF]$/, '')}${note}${PR_FOOTER}`;
}

// —— 清理 ——

/**
 * 删掉任务的 worktree（--force，未提交的改动也一并丢弃）并清 worktree 元数据；
 * 分支保留（远端还有，PR 还挂着）。目录本来就不存在：什么都不做，不报错。
 *
 * 删除守卫先于一切动作：只允许删 <home>/worktrees/ 严格之内的路径，别的路径
 * （包括 <home>/worktrees 本身、'..' 越界、指向外部的符号链接）直接抛错——
 * rm -rf 绝不落到调用方随手传进来的任意路径上。
 *
 * 缓存不可用（没了、坏了，或 home 在别人的 checkout 里被误认）：只物理删目录，
 * 不对父仓库跑 worktree remove/prune。返回 undefined。
 */
export async function removeWorktree({ home, repo, worktree } = {}) {
  assertNonEmptyString(worktree, 'removeWorktree 的 worktree 路径');
  const cacheDir = repoCacheDir(home, repo); // 一并校验 home / repo
  const worktreesRoot = path.join(home, 'worktrees');
  return withLock(lockKey(cacheDir), async () => {
    const usable = await isUsableCache(cacheDir);
    if (fs.existsSync(worktree)) {
      assertDeleteInside(worktree, worktreesRoot, 'worktree'); // 守卫先于一切删除动作
      if (usable) {
        try {
          await runGit(['worktree', 'remove', '--force', worktree], { cwd: cacheDir });
        } catch {
          // git 元数据里没有它（缓存被重建过等）：直接删目录
          fs.rmSync(worktree, { recursive: true, force: true });
        }
      } else {
        fs.rmSync(worktree, { recursive: true, force: true });
      }
    }
    // 目录已不存在时也 prune 一次：目录被手动删过的场合，元数据还挂在 worktree list 里
    if (usable) {
      await runGit(['worktree', 'prune'], { cwd: cacheDir });
    }
  });
}
