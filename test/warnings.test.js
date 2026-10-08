// src/warnings.js 单元测试：只吞 node:sqlite 那一条实验性警告，其余原样转发。
// Node 22 下的真实端到端验证（CLI 子进程 stderr）在 test/cli.test.js 里。
import test from 'node:test';
import assert from 'node:assert/strict';
import { installSqliteWarningFilter, isSqliteExperimentalWarning } from '../src/warnings.js';

// Node 22.13 实测的 node:sqlite 警告原文。
const SQLITE_MESSAGE = 'SQLite is an experimental feature and might change at any time';

/** 假 process：emitWarning 被调用时记录参数，返回值固定 'ok' 便于断言透传。 */
function fakeProcess() {
  const forwarded = [];
  return {
    forwarded,
    emitWarning(warning, ...rest) {
      forwarded.push({ warning, rest });
      return 'ok';
    },
  };
}

test('isSqliteExperimentalWarning：只认 ExperimentalWarning 类型且消息提到 SQLite', () => {
  assert.equal(isSqliteExperimentalWarning(SQLITE_MESSAGE, 'ExperimentalWarning'), true);
  assert.equal(isSqliteExperimentalWarning('sqlite 相关', 'ExperimentalWarning'), true);
  assert.equal(isSqliteExperimentalWarning('别的实验性功能', 'ExperimentalWarning'), false);
  assert.equal(isSqliteExperimentalWarning(SQLITE_MESSAGE, 'DeprecationWarning'), false);
  assert.equal(isSqliteExperimentalWarning(undefined, 'ExperimentalWarning'), false);
  assert.equal(isSqliteExperimentalWarning(null, 'ExperimentalWarning'), false);
});

test('过滤：SQLite 实验性警告被吞掉（三种签名形态），其他警告原样转发', () => {
  const p = fakeProcess();
  installSqliteWarningFilter(p);

  // 形态一：node:sqlite 实际用的 —— (message, type, code, ctor)
  assert.equal(p.emitWarning(SQLITE_MESSAGE, 'ExperimentalWarning', undefined, Object), undefined);
  // 形态二：(message, options)
  assert.equal(p.emitWarning('SQLite 的又一条', { type: 'ExperimentalWarning' }), undefined);
  // 形态三：(Error)，name 是 ExperimentalWarning
  const asError = new Error('sqlite 报的实验性错误');
  asError.name = 'ExperimentalWarning';
  assert.equal(p.emitWarning(asError), undefined);
  assert.equal(p.forwarded.length, 0, '这三条都不该被转发');

  // 其他警告必须照常：别的 ExperimentalWarning、废弃警告、无类型普通警告；返回值透传。
  assert.equal(p.emitWarning('custom', 'ExperimentalWarning'), 'ok');
  assert.equal(p.emitWarning('废弃了', 'DeprecationWarning', 'DEP0001'), 'ok');
  assert.equal(p.emitWarning('普通警告'), 'ok');
  assert.deepEqual(p.forwarded.map((f) => f.warning), ['custom', '废弃了', '普通警告']);
  assert.deepEqual(p.forwarded[1].rest, ['DeprecationWarning', 'DEP0001']);
});

test('幂等：同一 target 重复安装不会叠加包装', () => {
  const p = fakeProcess();
  installSqliteWarningFilter(p);
  installSqliteWarningFilter(p);
  assert.equal(p.emitWarning(SQLITE_MESSAGE, 'ExperimentalWarning'), undefined);
  p.emitWarning('x');
  assert.equal(p.forwarded.length, 1);
});

test('没有 emitWarning 的 target：安装是安全的空操作', () => {
  const p = {};
  installSqliteWarningFilter(p);
  assert.equal(p.emitWarning, undefined);
});
