// 失败自动诊断（issue #12）：任务普通失败且还有重试次数时，先用便宜的 flash 模型看一眼
// 失败日志，产出简短的「原因 + 修复建议」，写进失败运行的 runs.diagnosis；下次重试时
// 调度器把它作为 extraPrompt 附进任务 prompt（见 runner.buildPrompt 的「上次失败的诊断」）。
//
// 执行复用 #7 的 invokeClaude（进程组控制、逐行日志、runEvents、判定规则都一样）：
// 诊断本身也是一次运行——startRun 一条 kind = 'diagnosis' 的记录（attempt 与失败运行
// 相同、effort = 'low'），quotaUnits 按 runCost({ model: diagnoseModel, startedAt }) 计入
// 额度。与任务运行的两点刻意差异：
// - 只读：argv **不带** --dangerously-skip-permissions，也不设 MAX_THINKING_TOKENS；
// - 隔离：工作目录是 <home>/tmp/diag-<runId> 临时空目录（绝不在任务 worktree 里跑，
//   免得诊断模型顺手改文件 / 污染 git 状态），结束后删掉。
//
// 诊断失败（超时、出错、限流）不影响重试：run 行如实记录失败、runs.diagnosis 留空，
// diagnose 照常返回（diagnosis 为 null），调度器照常把任务放回队列。
import fs from 'node:fs';
import path from 'node:path';
import { invokeClaude, truncateByCodePoints } from './runner.js';
import { setRunDiagnosis } from './tasks.js';

/** 诊断调用的旗标：与任务运行相比，只读（无 --dangerously-skip-permissions）且限轮次。 */
const DIAGNOSE_ARGS = ['--output-format', 'stream-json', '--verbose', '--max-turns', '3'];
/** 任务 prompt 进诊断 prompt 的字符上限（按 Unicode 码点）。 */
export const TASK_PROMPT_MAX_CHARS = 1000;
/** 诊断文本的字符上限（按 Unicode 码点；result 行文本超长时截断）。 */
export const DIAGNOSIS_MAX_CHARS = 2000;
/** 失败日志带进诊断 prompt 的行数（取末尾）。 */
export const LOG_TAIL_LINES = 200;
/** 读日志末尾时最多回看的字节量（日志再大也只读这一段，诊断不用看全量）。 */
const LOG_TAIL_MAX_BYTES = 512 * 1024;

/**
 * 读文本文件的末尾 maxLines 行（不带尾随空行）。文件大于 maxBytes 时只读末尾 maxBytes
 * 字节——开头被截断的那半行丢弃（内容不完整还可能切坏多字节字符，留着只会误导）。
 * 文件不存在 / 不可读返回 ''（诊断照常进行，prompt 里注明日志不可读）。
 * @param {string} file 日志文件路径
 * @param {number} [maxLines=LOG_TAIL_LINES]
 * @returns {string}
 */
export function readLogTail(file, maxLines = LOG_TAIL_LINES) {
  let fd;
  try {
    const { size } = fs.statSync(file);
    const length = Math.min(size, LOG_TAIL_MAX_BYTES);
    const buffer = Buffer.alloc(length);
    fd = fs.openSync(file, 'r');
    fs.readSync(fd, buffer, 0, length, size - length);
    const lines = buffer.toString('utf8').split('\n');
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop(); // 尾随换行
    if (length < size && lines.length > 0) lines.shift(); // 起头是被拦腰截断的半行
    return lines.slice(-maxLines).join('\n');
  } catch {
    return '';
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // 关不上（fd 已失效等）：忽略，别为读日志的清理报错拦住诊断
      }
    }
  }
}

/**
 * 组装诊断 prompt（导出供测试）。固定说明（回答格式、字数上限、不要改文件）+ 任务
 * prompt 前 1000 字符 + 失败运行 error 与任务 lastError + 失败日志最后 200 行。
 * @param {{prompt: string}} task
 * @param {{error?: ?string}} failedRun 失败的那次运行（error 为 null 时也如实展示）
 * @param {string} logTail readLogTail 的结果（'' 表示日志不可读 / 为空）
 * @returns {string}
 */
export function buildDiagnosePrompt(task, failedRun, logTail) {
  const promptHead = truncateByCodePoints(String(task.prompt ?? ''), TASK_PROMPT_MAX_CHARS);
  return [
    '下面是一次自动编码任务的失败记录。请用中文简短回答，不超过 300 字：',
    '原因：<一句话>',
    '建议：<最多 5 条，每条一行>',
    '不要修改任何文件。',
    '',
    '## 任务提示词（前 1000 字）',
    promptHead === '' ? '（无）' : promptHead,
    '',
    '## 失败信息',
    `运行错误：${failedRun.error ?? '（无）'}`,
    `任务最近错误：${task.lastError ?? '（无）'}`,
    '',
    `## 运行日志（最后 ${LOG_TAIL_LINES} 行）`,
    logTail === '' ? '（日志为空或不可读）' : logTail,
  ].join('\n');
}

/**
 * 跑一次失败诊断。流程：读失败日志末尾 → 组装 prompt → 建临时空目录 → invokeClaude
 * （kind = 'diagnosis'）→ 删临时目录 → 成功时把 result 文本（≤2000 字符）写进失败运行
 * 的 runs.diagnosis。
 *
 * 自身不因诊断失败抛异常（超时 / 出错 / 限流都算一次正常的 failed / timeout 结果，
 * run 行与日志照常产生，diagnosis 为 null）；只有参数错误才 reject（task / failedRun /
 * config 缺失或明显不可用，如 diagnoseModel 非空字符串、timeout 非正数）。
 *
 * @param {object} options
 * @param {object} options.task 任务对象（id / prompt / lastError）
 * @param {object} options.failedRun 被诊断的失败运行（id / attempt / error / logPath）；
 *   诊断文本写到它的 runs.diagnosis 行上
 * @param {object} options.config 配置（用 diagnoseModel / diagnoseTimeoutMinutes /
 *   killGraceSeconds / claudeBin）
 * @param {import('node:sqlite').DatabaseSync} options.db
 * @param {string} options.home 数据目录；临时工作目录在 `<home>/tmp/diag-<failedRun.id>`
 * @param {AbortSignal} [options.signal] 触发即取消诊断（调度器停机 / 任务被取消时）
 * @param {() => Date} [options.clock] 取「现在」（高峰判断、额度倍率、日志时间戳）
 * @param {object} [options.env=process.env] 子进程环境变量的基底（claude 连 GLM 要用；
 *   浅拷贝后删掉 MAX_THINKING_TOKENS——诊断不开思考）
 * @returns {Promise<{run: object, diagnosis: ?string}>}
 *   run 是 invokeClaude 的结果对象（见其 JSDoc）；diagnosis 是写进失败运行的诊断文本，
 *   诊断未成功（或结果为空）时为 null。
 * @throws {TypeError|Error} 参数缺失 / 类型不符；或写 runs.diagnosis 失败（库坏等）——
 *   调用方（调度器）兜住即可，重试不受影响
 */
export async function diagnose({
  task, failedRun, config, db, home, signal, clock = () => new Date(), env = process.env,
} = {}) {
  assertDiagnoseArgs({ task, failedRun, config, db, home, signal, clock, env });

  const promptText = buildDiagnosePrompt(task, failedRun, readLogTail(failedRun.logPath));
  // 临时空目录：不在任务 worktree 里跑（见模块头）。failedRun.id 前置已知，目录名确定。
  const diagDir = path.join(home, 'tmp', `diag-${failedRun.id}`);
  fs.mkdirSync(diagDir, { recursive: true });
  // 诊断不开思考：外层环境里若真设了 MAX_THINKING_TOKENS，不删就会被 claude 继承。
  const childEnv = { ...env };
  delete childEnv.MAX_THINKING_TOKENS;
  try {
    const run = await invokeClaude({
      taskId: task.id,
      attempt: failedRun.attempt,
      kind: 'diagnosis',
      model: config.diagnoseModel,
      effort: 'low',
      promptText,
      extraArgs: DIAGNOSE_ARGS,
      childEnv,
      workdir: diagDir,
      timeoutMs: config.diagnoseTimeoutMinutes * 60_000,
      killGraceMs: config.killGraceSeconds * 1000,
      config,
      db,
      home,
      signal,
      clock,
    });
    let diagnosis = null;
    if (run.status === 'succeeded' && run.summary !== null && run.summary.trim() !== '') {
      diagnosis = truncateByCodePoints(run.summary, DIAGNOSIS_MAX_CHARS);
      setRunDiagnosis(db, failedRun.id, diagnosis);
    }
    return { run, diagnosis };
  } finally {
    // 临时目录用完就删（失败也要删）：空的，没什么可留的现场。
    try {
      fs.rmSync(diagDir, { recursive: true, force: true });
    } catch (err) {
      console.error(`[night-shift] 删除诊断临时目录 ${diagDir} 失败（不影响诊断结果）：`, err);
    }
  }
}

// ---------------------------------------------------------------- 参数校验

function assertDiagnoseArgs({ task, failedRun, config, db, home, signal, clock, env }) {
  if (task === null || typeof task !== 'object') {
    throw new TypeError(`diagnose 缺 task 参数（任务对象），收到：${describe(task)}`);
  }
  if (!Number.isInteger(task.id) || task.id < 1) {
    throw new TypeError(`task.id 必须是正整数，收到：${describe(task.id)}`);
  }
  if (task.prompt === undefined || task.prompt === null
      || typeof task.prompt !== 'string' || task.prompt.trim() === '') {
    throw new TypeError(`task.prompt 必须是非空字符串，收到：${describe(task.prompt)}`);
  }
  if (failedRun === null || typeof failedRun !== 'object') {
    throw new TypeError(`diagnose 缺 failedRun 参数（失败的运行对象），收到：${describe(failedRun)}`);
  }
  if (!Number.isInteger(failedRun.id) || failedRun.id < 1) {
    throw new TypeError(`failedRun.id 必须是正整数，收到：${describe(failedRun.id)}`);
  }
  if (!Number.isInteger(failedRun.attempt) || failedRun.attempt < 1) {
    throw new TypeError(`failedRun.attempt 必须是正整数，收到：${describe(failedRun.attempt)}`);
  }
  if (config === null || typeof config !== 'object') {
    throw new TypeError(`diagnose 缺 config 参数（配置对象），收到：${describe(config)}`);
  }
  if (typeof config.claudeBin !== 'string' || config.claudeBin.trim() === '') {
    throw new TypeError(`config.claudeBin 必须是非空字符串，收到：${describe(config.claudeBin)}`);
  }
  if (typeof config.diagnoseModel !== 'string' || config.diagnoseModel.trim() === '') {
    throw new TypeError(`config.diagnoseModel 必须是非空字符串，收到：${describe(config.diagnoseModel)}`);
  }
  const timeout = config.diagnoseTimeoutMinutes;
  if (typeof timeout !== 'number' || !Number.isFinite(timeout) || timeout <= 0) {
    throw new TypeError(`config.diagnoseTimeoutMinutes 必须是正的有限数字，当前值：${String(timeout)}`);
  }
  if (db === null || typeof db !== 'object') {
    throw new TypeError(`diagnose 缺 db 参数（node:sqlite DatabaseSync），收到：${describe(db)}`);
  }
  if (typeof home !== 'string' || home.trim() === '') {
    throw new TypeError(`home 必须是非空字符串（数据目录），收到：${describe(home)}`);
  }
  if (signal !== undefined && signal !== null
      && (typeof signal !== 'object' || typeof signal.addEventListener !== 'function')) {
    throw new TypeError(`signal 必须是 AbortSignal，收到：${describe(signal)}`);
  }
  if (typeof clock !== 'function') {
    throw new TypeError(`clock 必须是函数，收到：${describe(clock)}`);
  }
  if (env === null || typeof env !== 'object') {
    throw new TypeError(`env 必须是环境变量对象，收到：${describe(env)}`);
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
