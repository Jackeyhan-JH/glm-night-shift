// 任务详情页日志区的解析与精简（issue #16）：纯函数、不碰 DOM / fetch，node:test
// 直接 import 单测（见 test/web-log-lib.test.js），浏览器里由 web/task.js 使用。
//
// 日志文件每行一条（#7 的约定）：`<UTC ISO 时间戳> [stdout|stderr|meta] 内容`。
// 旧数据 / 手写的测试数据里也可能出现没有时间戳的 `[stdout] 内容` 形式，两种都认。

/** 页面上保留的日志行数上限（#16 规格：超过 5000 行只保留最后 5000 行）。 */
export const MAX_LOG_LINES = 5000;

/**
 * 只保留最后 max 行（不修改入参；未超限时原数组原样返回）。
 * @param {string[]} lines
 * @param {number} [max=MAX_LOG_LINES]
 * @returns {string[]}
 */
export function capLines(lines, max = MAX_LOG_LINES) {
  if (!Array.isArray(lines) || lines.length <= max) return lines;
  return lines.slice(lines.length - max);
}

/**
 * 日志文件全文 → 行数组：按 \n 切、去掉每行行尾的 \r（CRLF 容错）；
 * 结尾因最后一个换行产生的空串不算一行（中间的空行保留）。
 * @param {string} text
 * @returns {string[]}
 */
export function splitLogText(text) {
  const lines = String(text).split('\n').map((line) => line.replace(/\r$/, ''));
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

// 无时间戳形式：`[stdout] 内容`（tag 后至多吞一个空格，正文自己带的缩进保留）。
const NO_TS_RE = /^\[(stdout|stderr|meta)\] ?(.*)$/;
// 真实形式：`2026-10-08T07:00:00.000Z [stdout] 内容`。时间戳必须以数字开头，
// 免得普通的 stdout 文本行（如 `hello [stderr] world`）被误认成带时间戳的行。
const WITH_TS_RE = /^(\d\S*) \[(stdout|stderr|meta)\] ?(.*)$/;

/**
 * 解析一行日志。
 * @param {string} rawLine 原始行（不含换行符）
 * @returns {{ ts: ?string, stream: ?('stdout'|'stderr'|'meta'), text: string }}
 *   ts：行首的时间戳（没有则 null）；stream：识别出的流（认不出则 null，整行按
 *   原文显示）；text：去掉前缀后的内容
 */
export function parseLogLine(rawLine) {
  const line = String(rawLine).replace(/\r$/, '');
  let m = line.match(NO_TS_RE);
  if (m !== null) return { ts: null, stream: m[1], text: m[2] };
  m = line.match(WITH_TS_RE);
  if (m !== null) return { ts: m[1], stream: m[2], text: m[3] };
  return { ts: null, stream: null, text: line };
}

/**
 * stdout 一行内容的「精简」（#16 规格：精简模式只显示 assistant 文本、tool 名称和
 * result；解析逻辑放本模块，node:test 里测）。
 *
 * 规则：
 * - 非 JSON（或 JSON 但不是对象）→ 原样返回；
 * - `{"type":"assistant", "message":{"content":[…]}}` → 拼接 content 里的 text 块
 *   文本与 tool_use 块的 `工具 <名称>`，其余块（thinking 等）跳过；
 * - `{"type":"result", …}` → `result num_turns=N is_error=… result=…`（result 文本
 *   压成一行、超长截断）；
 * - 其他 type（system / user 等）→ 返回 ''，表示该行在精简模式下隐藏；
 * - 空字符串也返回 ''（精简模式下空行不显示）。
 *
 * @param {string} text parseLogLine 拿到的 text（不含 [stream] 前缀）
 * @returns {string} 精简后的显示文本；'' = 该行隐藏
 */
export function simplifyLogText(text) {
  const str = String(text);
  let value;
  try {
    value = JSON.parse(str);
  } catch {
    return str; // 非 JSON 行原样返回
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return str;
  if (value.type === 'assistant') return assistantSummary(value.message?.content);
  if (value.type === 'result') return resultSummary(value);
  return '';
}

/** assistant 行的 content 块 → 精简文本；不是数组（形状对不上）时无可提取，隐藏。 */
function assistantSummary(content) {
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string') {
      if (block.text !== '') parts.push(block.text);
    } else if (block.type === 'tool_use' && typeof block.name === 'string') {
      parts.push(`工具 ${block.name}`);
    }
  }
  return parts.join(' ');
}

/** result 行 → `result num_turns=N is_error=… result=…`。 */
function resultSummary(value) {
  const parts = [`num_turns=${value.num_turns ?? '?'}`];
  if (value.is_error !== undefined) parts.push(`is_error=${value.is_error}`);
  if (typeof value.result === 'string' && value.result !== '') {
    parts.push(`result=${oneLine(value.result, 200)}`);
  }
  return `result ${parts.join(' ')}`;
}

/** 压成一行（空白折成一个空格）并按码点截断到 max 个字符，超长加 …。 */
function oneLine(text, max) {
  const flat = text.replace(/\s+/g, ' ').trim();
  return [...flat].length <= max ? flat : `${[...flat].slice(0, max).join('')}…`;
}
