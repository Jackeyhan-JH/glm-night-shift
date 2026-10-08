// web/log-lib.js 的单元测试（issue #16 验收项）：纯函数，node:test 直接 import。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_LOG_LINES,
  capLines,
  parseLogLine,
  simplifyLogText,
  splitLogText,
} from '../web/log-lib.js';

const ASSISTANT_HI = '[stdout] {"type":"assistant","message":{"content":[{"type":"text","text":"hi"}]}}';
const RESULT_LINE = '[stdout] {"type":"result","subtype":"success","is_error":false,'
  + '"duration_ms":1234,"num_turns":3,"result":"全部测试通过","session_id":"abc","total_cost_usd":0.1}';

test('验收: [stdout] assistant JSON 行精简结果为 hi', () => {
  const { stream, text } = parseLogLine(ASSISTANT_HI);
  assert.equal(stream, 'stdout');
  assert.equal(simplifyLogText(text), 'hi');
});

test('验收: type: result 行精简后含 num_turns', () => {
  const { text } = parseLogLine(RESULT_LINE);
  const simplified = simplifyLogText(text);
  assert.ok(simplified.includes('num_turns'), `应含 num_turns，实际：${simplified}`);
  assert.ok(simplified.includes('num_turns=3'));
  assert.equal(simplified, 'result num_turns=3 is_error=false result=全部测试通过');
});

test('验收: 非 JSON 行原样返回', () => {
  const plain = '普通文本行，不是 JSON';
  assert.equal(simplifyLogText(plain), plain);
  assert.equal(simplifyLogText('42'), '42'); // 合法 JSON 但不是对象：也算非 claude 行，原样
  assert.equal(simplifyLogText('[1,2]'), '[1,2]');
  assert.equal(simplifyLogText('null'), 'null');
});

test('验收: [stderr] 行被识别为 stderr', () => {
  assert.equal(parseLogLine('[stderr] boom').stream, 'stderr');
  assert.equal(parseLogLine('2026-10-08T07:00:00.000Z [stderr] boom').stream, 'stderr');
  assert.equal(parseLogLine('[meta] 结束 status=succeeded').stream, 'meta');
  assert.equal(parseLogLine('[stdout] x').stream, 'stdout');
});

test('parseLogLine：真实日志格式（时间戳前缀）拆出 ts / stream / text；tag 后至多吞一个空格', () => {
  const parsed = parseLogLine('2026-10-08T07:00:00.123Z [stdout] {"type":"result"}');
  assert.equal(parsed.ts, '2026-10-08T07:00:00.123Z');
  assert.equal(parsed.stream, 'stdout');
  assert.equal(parsed.text, '{"type":"result"}');

  const indented = parseLogLine('[stdout]  缩进两格');
  assert.equal(indented.text, ' 缩进两格'); // 只吞一个空格，正文缩进保留

  const noPrefix = parseLogLine('裸行（日志被截断 / 旧格式）');
  assert.equal(noPrefix.ts, null);
  assert.equal(noPrefix.stream, null);
  assert.equal(noPrefix.text, '裸行（日志被截断 / 旧格式）');

  // 开头不是数字的行不会被误认成「带时间戳」
  const tricky = parseLogLine('hello [stderr] world');
  assert.equal(tricky.stream, null);
  assert.equal(tricky.text, 'hello [stderr] world');

  assert.equal(parseLogLine('[stdout] x\r').text, 'x', '行尾 CR 容错');
});

test('精简：tool_use 只显示工具名；system / user 等其他类型返回空串（隐藏）；thinking 块跳过', () => {
  const tool = '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"ls"}}]}}';
  assert.equal(simplifyLogText(tool), '工具 Bash');

  const mixed = '{"type":"assistant","message":{"content":[{"type":"thinking","thinking":"…"},'
    + '{"type":"text","text":"先看文件"},{"type":"tool_use","name":"Read"},{"type":"text","text":""}]}}';
  assert.equal(simplifyLogText(mixed), '先看文件 工具 Read');

  assert.equal(simplifyLogText('{"type":"system","subtype":"init","session_id":"x"}'), '');
  assert.equal(simplifyLogText('{"type":"user","message":{"content":[{"type":"tool_result","content":"ok"}]}}'), '');
  assert.equal(simplifyLogText(''), '');

  // 形状对不上的 assistant（content 不是数组）也按无可提取处理
  assert.equal(simplifyLogText('{"type":"assistant","message":{"content":"hi"}}'), '');
});

test('精简：result 的长文本压成一行并截断', () => {
  const long = 'x'.repeat(300);
  const simplified = simplifyLogText(`{"type":"result","num_turns":1,"result":"${long}"}`);
  assert.ok(simplified.startsWith('result num_turns=1 result='));
  assert.ok(simplified.length < 300);
  assert.ok(simplified.endsWith('…'));
  // 多行 result 折成一个空格
  const multiline = simplifyLogText('{"type":"result","num_turns":2,"result":"第一行\\n第二行"}');
  assert.equal(multiline, 'result num_turns=2 result=第一行 第二行');
  // 缺 num_turns 的畸形行也不炸
  assert.equal(simplifyLogText('{"type":"result"}'), 'result num_turns=?');
});

test('capLines：只保留最后 max 行，不改入参；未超限原样返回', () => {
  assert.equal(MAX_LOG_LINES, 5000);
  const lines = ['a', 'b', 'c', 'd'];
  assert.deepEqual(capLines(lines, 3), ['b', 'c', 'd']);
  assert.deepEqual(lines, ['a', 'b', 'c', 'd'], '入参不被修改');
  assert.equal(capLines(lines, 10), lines);
  const many = Array.from({ length: 5010 }, (_, i) => `line-${i}`);
  const capped = capLines(many);
  assert.equal(capped.length, 5000);
  assert.equal(capped[0], 'line-10');
  assert.equal(capped[4999], 'line-5009');
});

test('splitLogText：按 \\n 切、去行尾 CR、结尾换行不产生空行、中间空行保留', () => {
  assert.deepEqual(splitLogText('a\nb\nc\n'), ['a', 'b', 'c']);
  assert.deepEqual(splitLogText('a\nb\nc'), ['a', 'b', 'c']); // 末尾没有换行也保最后一行
  assert.deepEqual(splitLogText('a\n\nb'), ['a', '', 'b']);
  assert.deepEqual(splitLogText('a\r\nb\r\n'), ['a', 'b']);
  assert.deepEqual(splitLogText(''), []);
  assert.deepEqual(splitLogText('\n'), ['']); // 单独一个换行 = 一行空行
});
