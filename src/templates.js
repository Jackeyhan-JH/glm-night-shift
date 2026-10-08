// 任务模板（issue #13）：仓库内置 templates/ 目录 + <home>/templates/ 用户自定义
// （同名覆盖内置）。文件格式：首行 --- 开始的简单 front-matter（每行一条
// 「key: value」，在第一个冒号处切分——值里可以有全角冒号，零依赖自己解析），
// 其后是带 {{变量}} 占位符的提示词正文。
//
// renderTemplate 声明了 fetchIssue 时会 spawn gh 拉 issue 标题/正文，因此是异步的
// （返回 Promise），调用方必须 await。
//
// 本模块（及其依赖 tasks.js / config.js）不碰 node:sqlite，静态引入是安全的
// （时机说明见 src/warnings.js）。
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DIFFICULTIES, NotFoundError, ValidationError } from './tasks.js';

/** 仓库内置模板目录（经 import.meta.url 解析，npm link / 任意 cwd 下都能找到）。 */
export const BUILTIN_TEMPLATES_DIR = fileURLToPath(new URL('../templates', import.meta.url));

/** fetchIssue 自动提供、不能在 vars 里声明的保留变量名。 */
const RESERVED_VARS = ['issue_title', 'issue_body'];

/** 变量名：字母或下划线开头，后接字母/数字/下划线。 */
const VAR_NAME_PATTERN = /^[A-Za-z_]\w*$/;

/** 模板名（即文件名去掉 .md）：非空、不以点开头、不含路径分隔符——杜绝
 *  --template ../x 之类的目录穿越，同时不限制字符集（中文等名字与列表所见一致）。 */
function isValidTemplateName(name) {
  return typeof name === 'string' && name !== '' && !name.startsWith('.') && !/[\\/]/.test(name);
}

/** {{ 变量 }} 占位符：内侧允许任意空白；名字按 \w 匹配，其余花括号组合原样保留。 */
const PLACEHOLDER_PATTERN = /\{\{\s*(\w+)\s*\}\}/g;

/** <home>/templates；没给 home 就没有用户模板。 */
function userTemplatesDir(home) {
  return home ? path.join(home, 'templates') : null;
}

/**
 * 列出全部模板：内置 + 用户，同名时用户覆盖内置，按名字排序（码点序）。
 * @param {object} [options]
 * @param {string} [options.home] 数据目录（NIGHT_SHIFT_HOME）；用户模板在其 templates/ 下
 * @returns {Array<{name: string, description: string, difficulty: ?string,
 *   testCommand: ?string, vars: Array<{name: string, required: boolean, default: ?string}>,
 *   source: 'builtin'|'user', path: string}>}
 *   difficulty 未设置时为 null（JSON 输出保持键存在）；default 仅可选变量有（`名字?`
 *   为空串），必填变量为 null。
 * @throws {ValidationError} 任一模板的 front-matter 不合法（信息带文件路径与行号）
 */
export function listTemplates({ home } = {}) {
  const byName = new Map();
  // 用户模板后放进去：同名时覆盖内置。
  for (const tpl of [
    ...readTemplatesFrom(BUILTIN_TEMPLATES_DIR, 'builtin'),
    ...readTemplatesFrom(userTemplatesDir(home), 'user'),
  ]) {
    byName.set(tpl.name, tpl);
  }
  return [...byName.values()]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map(({ name, description, difficulty, testCommand, vars, source, path: filePath }) => ({
      name,
      description,
      difficulty: difficulty ?? null,
      testCommand,
      vars,
      source,
      path: filePath,
    }));
}

/**
 * 按名字加载单个模板：先找 <home>/templates/<名>.md，再找内置 templates/<名>.md。
 * @param {string} name 模板名（文件名去掉 .md）
 * @param {object} [options]
 * @param {string} [options.home] 数据目录
 * @returns {{name, source, path, raw, description, difficulty, testCommand, title, vars,
 *   fetchIssue, body}} loadTemplate 的完整返回：title / fetchIssue / difficulty 未设置时
 *   为 undefined，testCommand 为 string|null，body 是未渲染的提示词正文，raw 是文件原文
 * @throws {ValidationError} 模板名不合法（含路径分隔符等），或 front-matter 格式错误
 *   （信息带文件路径与行号）
 * @throws {NotFoundError} 模板不存在
 */
export function loadTemplate(name, { home } = {}) {
  if (!isValidTemplateName(name)) {
    throw new ValidationError('template', `模板名不合法（非空、不以点开头、不含路径分隔符；当前值：${name}）`);
  }
  const candidates = [];
  const userDir = userTemplatesDir(home);
  if (userDir !== null) candidates.push({ file: path.join(userDir, `${name}.md`), source: 'user' });
  candidates.push({ file: path.join(BUILTIN_TEMPLATES_DIR, `${name}.md`), source: 'builtin' });
  for (const { file, source } of candidates) {
    if (!fs.existsSync(file)) continue;
    return parseTemplateFile(name, file, source);
  }
  throw new NotFoundError(name, '模板');
}

/**
 * 渲染模板：代入变量、整理正文；声明了 fetchIssue 时先用 gh 拉 issue 标题/正文。
 * **可能异步**（要 spawn gh），返回 Promise，调用方必须 await。
 *
 * 校验（都抛 ValidationError，信息列出变量名）：
 * - 传了模板未声明的变量（防拼错，如 --var isue=1）；
 * - 缺少必填变量（`名字?` / `名字=默认值` 视为可选，缺省为空串/默认值）；
 * - 正文或标题里用了未声明、也不是 issue_title / issue_body 的 {{变量}}。
 *
 * 代入规则：`{{ 名字 }}` 内侧允许空白；值原样插入，不递归展开值里的 {{ }}；
 * 渲染后 3 个及以上连续换行压缩成 1 个空行、首尾去空白。
 *
 * @param {object} template loadTemplate 的返回值
 * @param {Record<string, string>} vars 调用方提供的变量值
 * @param {object} [options]
 * @param {string} [options.repo] `owner/name`；fetchIssue 模板必须给（gh --repo 用）
 * @param {{ghBin?: string}} [options.config] 生效配置（只读 ghBin），缺省用裸 `gh`
 * @param {object} [options.env=process.env] 传给 gh 子进程的环境变量
 * @returns {Promise<{prompt: string, title: ?string, difficulty: ?string, testCommand: ?string}>}
 *   title 为模板没写（或渲染后为空）时的 null；difficulty / testCommand 是模板默认值，
 *   是否采用由调用方决定（命令行的显式参数优先）
 * @throws {ValidationError} 变量校验失败（见上）
 * @throws {Error} gh 执行失败（信息带 gh 的 stderr）或输出不是合法 JSON
 */
export async function renderTemplate(template, providedVars = {}, { repo, config, env = process.env } = {}) {
  const declaredVars = template.vars ?? [];
  const declared = new Map();
  for (const v of declaredVars) declared.set(v.name, v);

  const unknown = Object.keys(providedVars).filter((key) => !declared.has(key));
  if (unknown.length > 0) {
    throw new ValidationError('vars', `传了模板未声明的变量（防止拼错）：${unknown.join('、')}`);
  }
  const missing = declaredVars
    .filter((v) => v.required && !Object.hasOwn(providedVars, v.name))
    .map((v) => v.name);
  if (missing.length > 0) {
    throw new ValidationError('vars', `缺少必填变量：${missing.join('、')}`);
  }

  // null 原型：变量名叫 __proto__ 时也按普通键处理（不会被原型链吃掉）。
  const values = Object.create(null);
  for (const v of declaredVars) {
    values[v.name] = Object.hasOwn(providedVars, v.name)
      ? String(providedVars[v.name])
      : (v.default ?? '');
  }

  if (template.fetchIssue !== undefined) {
    if (typeof repo !== 'string' || repo === '') {
      throw new ValidationError('repo', `fetchIssue 模板需要 --repo <owner/name>（当前值：${repo}）`);
    }
    const number = values[template.fetchIssue];
    if (number === '') {
      throw new ValidationError(template.fetchIssue, 'fetchIssue 使用的变量不能为空');
    }
    const issue = await fetchIssue(config?.ghBin ?? 'gh', number, repo, env);
    values.issue_title = issue.title;
    values.issue_body = issue.body;
  }

  // issue_title / issue_body 恒为已知名字：没 fetchIssue 时按空串代入（规格如此）。
  const known = new Set([...declared.keys(), ...RESERVED_VARS]);
  const prompt = squeezeBlankLines(substitute(template.body, values, known));
  if (prompt === '') {
    throw new ValidationError('prompt', '模板正文渲染后为空');
  }
  const title = template.title === undefined ? null : substitute(template.title, values, known).trim();
  return {
    prompt,
    title: title === '' ? null : title,
    difficulty: template.difficulty ?? null,
    testCommand: template.testCommand ?? null,
  };
}

// ---------------------------------------------------------------- 解析

/** 读取 dir 下全部 *.md 并解析；目录不存在返回空数组，其他读取错误抛中文原因。 */
function readTemplatesFrom(dir, source) {
  if (dir === null) return [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if (err && err.code === 'ENOENT') return [];
    throw new Error(`无法读取模板目录 ${dir}：${err.message}`);
  }
  const out = [];
  for (const entry of entries) {
    if (!entry.isFile() || entry.name.startsWith('.') || !entry.name.endsWith('.md')) continue;
    out.push(parseTemplateFile(entry.name.slice(0, -3), path.join(dir, entry.name), source));
  }
  return out;
}

/**
 * 读文件并解析 front-matter 与正文。front-matter 规则：
 * - 第 1 行必须是 ---；之后每行一条「key: value」，在第一个冒号处切分（值可含全角冒号）；
 * - 值整体 trim，空值（`testCommand:`）为 null；未知键忽略（容错），格式错误的行报错；
 * - 再一个 --- 行结束；正文是其后的一切（渲染时才 trim / 压缩空行）。
 */
function parseTemplateFile(name, filePath, source) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    throw new Error(`无法读取模板文件 ${filePath}：${err.message}`);
  }
  const lines = raw.split(/\r?\n/);
  if (lines[lines.length - 1] === '') lines.pop(); // 文件末尾换行产生的空串不是真的行
  const fail = (reason) => new ValidationError('front-matter', `${reason}（文件：${filePath}）`);

  if (lines[0] === undefined || lines[0].trim() !== '---') {
    throw fail(`第 1 行必须是 ---（当前值：${lines[0] === undefined ? '' : lines[0]}）`);
  }
  const meta = {};
  let closing = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      closing = i;
      break;
    }
    const colon = lines[i].indexOf(':');
    const key = colon === -1 ? '' : lines[i].slice(0, colon).trim();
    if (key === '') {
      throw fail(`第 ${i + 1} 行必须是「key: value」形式（当前值：${lines[i]}）`);
    }
    meta[key] = lines[i].slice(colon + 1).trim() || null;
  }
  if (closing === -1) {
    throw fail(`front-matter 没有结束的 ---（读到第 ${lines.length} 行）`);
  }
  const body = lines.slice(closing + 1).join('\n');
  if (body.trim() === '') {
    throw fail(`第 ${closing + 2} 行起缺少提示词正文`);
  }

  const template = {
    name,
    source,
    path: filePath,
    raw,
    description: meta.description ?? '',
    difficulty: undefined,
    testCommand: null,
    title: undefined,
    vars: [],
    fetchIssue: undefined,
    body,
  };
  if (meta.difficulty != null) {
    if (!DIFFICULTIES.includes(meta.difficulty)) {
      throw new ValidationError(
        'difficulty',
        `必须是 ${DIFFICULTIES.join(' | ')} 之一（文件：${filePath}，当前值：${meta.difficulty}）`,
      );
    }
    template.difficulty = meta.difficulty;
  }
  if (meta.testCommand != null) template.testCommand = meta.testCommand;
  if (meta.title != null) template.title = meta.title;
  if (meta.vars != null) template.vars = parseVarsSpec(meta.vars, filePath);
  if (meta.fetchIssue != null) {
    if (!template.vars.some((v) => v.name === meta.fetchIssue)) {
      throw new ValidationError(
        'fetchIssue',
        `必须引用 vars 里声明过的变量（文件：${filePath}，当前值：${meta.fetchIssue}）`,
      );
    }
    template.fetchIssue = meta.fetchIssue;
  }
  return template;
}

/**
 * `vars: 名字, 名字?, 名字=默认值`：逗号分隔，容忍空项（尾逗号）。
 * `名字?` 可选、缺省空串；`名字=默认值` 可选、缺省取默认值（默认值在第一个 = 后，
 * 可含空格）；二者可连写（`名字?=默认值`）。变量名须匹配 /^[A-Za-z_]\w*$/，不能是
 * issue_title / issue_body（fetchIssue 的保留名），不能重复声明。
 */
function parseVarsSpec(spec, filePath) {
  const vars = [];
  const seen = new Set();
  for (const item of spec.split(',')) {
    const trimmed = item.trim();
    if (trimmed === '') continue;
    let name = trimmed;
    let def = null;
    let hasDefault = false;
    const eq = name.indexOf('=');
    if (eq !== -1) {
      def = name.slice(eq + 1).trim();
      hasDefault = true;
      name = name.slice(0, eq);
    }
    let optional = hasDefault;
    if (name.endsWith('?')) {
      optional = true;
      name = name.slice(0, -1);
    }
    if (!VAR_NAME_PATTERN.test(name)) {
      throw new ValidationError(
        'vars',
        `变量名不合法：${name === '' ? trimmed : name}（文件：${filePath}；须字母/下划线开头，后接字母/数字/下划线）`,
      );
    }
    if (RESERVED_VARS.includes(name)) {
      throw new ValidationError('vars', `变量 ${name} 是保留名，由 fetchIssue 自动提供，不能声明（文件：${filePath}）`);
    }
    if (seen.has(name)) {
      throw new ValidationError('vars', `变量 ${name} 声明了多次（文件：${filePath}）`);
    }
    seen.add(name);
    vars.push({ name, required: !optional, default: optional ? def ?? '' : null });
  }
  return vars;
}

// ---------------------------------------------------------------- 渲染辅助

/** 代入占位符；发现未声明的名字先收集、替换完后一起报（信息列出全部变量名）。 */
function substitute(text, values, known) {
  const unknown = [];
  const rendered = String(text).replace(PLACEHOLDER_PATTERN, (whole, name) => {
    if (!known.has(name)) {
      if (!unknown.includes(name)) unknown.push(name);
      return whole; // 报错前保持原文，方便定位
    }
    return values[name] ?? ''; // 值原样插入，replace 不会重扫插入的内容
  });
  if (unknown.length > 0) {
    throw new ValidationError('vars', `模板里用了未声明的变量：${unknown.join('、')}`);
  }
  return rendered;
}

/** 渲染后整理：CR 归一成 LF、3 个及以上连续换行压成 1 个空行、首尾去空白。 */
function squeezeBlankLines(text) {
  return String(text).replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** `<ghBin> issue view <n> --repo <repo> --json title,body`，参数走数组不经 shell。 */
async function fetchIssue(ghBin, number, repo, env) {
  const args = ['issue', 'view', number, '--repo', repo, '--json', 'title,body'];
  const res = await spawnCapture(ghBin, args, env);
  if (res.code !== 0) {
    throw new Error(`gh issue view ${number} 失败（退出码 ${res.code}）：${res.stderr.trim()}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(res.stdout);
  } catch (err) {
    throw new Error(`gh issue view ${number} 的输出不是合法 JSON：${err.message}`);
  }
  return {
    title: typeof parsed.title === 'string' ? parsed.title : '',
    body: typeof parsed.body === 'string' ? parsed.body : '',
  };
}

/** spawn 并收集 stdout/stderr/退出码；启动/执行失败 reject（信息带原因）。 */
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
