// src/db.js：打开、PRAGMA、迁移与约束。任务 / run 的领域行为见 tasks.test.js。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { openDb, SCHEMA_VERSION, MIGRATIONS } from '../src/db.js';
import { DatabaseSync } from 'node:sqlite';
import { makeTempHome } from './helpers.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test(':memory: 建出 tasks / runs 两张表和四个索引，user_version 为 1', () => {
  const db = openDb();
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all().map((row) => row.name);
    assert.deepEqual(tables, ['runs', 'tasks']);
    const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%' ORDER BY name")
      .all().map((row) => row.name);
    assert.deepEqual(indexes, ['idx_runs_list', 'idx_runs_open', 'idx_tasks_claim', 'idx_tasks_list']);
    assert.equal(userVersion(db), SCHEMA_VERSION);
    assert.equal(SCHEMA_VERSION, 1);
  } finally {
    db.close();
  }
});

test('MIGRATIONS 是连续的迁移函数列表，SCHEMA_VERSION 与长度一致', () => {
  assert.ok(Array.isArray(MIGRATIONS));
  assert.equal(MIGRATIONS.length, SCHEMA_VERSION);
  for (const migration of MIGRATIONS) assert.equal(typeof migration, 'function');
});

test('文件库：递归创建缺失的父目录，开 WAL、外键和 busy_timeout', (t) => {
  const file = path.join(makeTempHome(t), 'a', 'b', 'night-shift.db');
  const db = openDb(file);
  t.after(() => db.close());
  assert.ok(fs.existsSync(file), '应创建数据库文件');
  assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
  assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
  assert.ok(db.prepare('PRAGMA busy_timeout').get().timeout >= 5000); // 结果列名是 timeout
});

test('外键约束生效：runs.task_id 指向不存在的任务时插入失败', (t) => {
  const db = openDb(':memory:');
  t.after(() => db.close());
  assert.throws(
    () => db.prepare(`
      INSERT INTO runs (task_id, attempt, model, effort, log_path, started_at)
      VALUES (999, 1, 'm', 'low', '/tmp/x.log', '2026-01-01T00:00:00.000Z')
    `).run(),
    /FOREIGN KEY/,
  );
});

test('CHECK 约束生效：非法 status / difficulty 进不了库', (t) => {
  const db = openDb(':memory:');
  t.after(() => db.close());
  db.prepare(`
    INSERT INTO tasks (repo, title, prompt, max_attempts, created_at, updated_at)
    VALUES ('a/b', 't', 'p', 2, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
  `).run();
  assert.throws(
    () => db.prepare("UPDATE tasks SET status = 'paused'").run(),
    /CHECK/,
  );
  assert.throws(
    () => db.prepare("UPDATE tasks SET difficulty = 'extreme'").run(),
    /CHECK/,
  );
  assert.throws(
    () => db.prepare('UPDATE tasks SET allow_peak = 2').run(),
    /CHECK/,
  );
});

test('关掉再打开同一文件：数据还在，user_version 仍为 1，迁移不重跑', (t) => {
  const file = path.join(makeTempHome(t), 'night-shift.db');
  const db1 = openDb(file);
  const now = new Date().toISOString();
  db1.prepare(`
    INSERT INTO tasks (repo, title, prompt, priority, max_attempts, created_at, updated_at)
    VALUES ('a/b', 't', 'p', 7, 3, ?, ?)
  `).run(now, now);
  db1.close();

  const db2 = openDb(file); // 迁移若重跑，裸 CREATE TABLE 会立刻报错
  t.after(() => db2.close());
  assert.equal(userVersion(db2), 1);
  const row = db2.prepare('SELECT repo, priority FROM tasks').get();
  assert.equal(row.repo, 'a/b');
  assert.equal(row.priority, 7);
});

test('user_version 比代码认识的版本新时，openDb 报清晰错误且不动数据', (t) => {
  const file = path.join(makeTempHome(t), 'night-shift.db');
  const db1 = openDb(file);
  db1.exec('PRAGMA user_version = 42');
  db1.close();

  assert.throws(
    () => openDb(file),
    (err) => err instanceof Error && err.message.includes('42') && err.message.includes(String(SCHEMA_VERSION)),
  );
  // 失败后文件还是老样子，版本号也没被改掉
  const raw = new DatabaseSync(file);
  assert.equal(userVersion(raw), 42);
  raw.close();
});

test('非法路径参数直接报错（undefined 走默认 :memory: 不报）', () => {
  for (const bad of ['', 123, null]) {
    assert.throws(() => openDb(bad), /数据库路径/, `openDb(${String(bad)}) 应报错`);
  }
  openDb().close(); // 不传参数 = :memory:
});

function userVersion(db) {
  return db.prepare('PRAGMA user_version').get().user_version;
}

test('验收: engines.node 为 >=22.13（node:sqlite 从 22.13 起无需开关），且不引入任何依赖', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  assert.equal(pkg.engines.node, '>=22.13');
  assert.ok(!('dependencies' in pkg), '不应有 dependencies');
  assert.ok(!('devDependencies' in pkg), '不应有 devDependencies');
});

test('4 个 worker 同时首次打开同一文件库：迁移只跑一次，人人都能打开并写入', async (t) => {
  const file = path.join(makeTempHome(t), 'night-shift.db');
  const dbUrl = pathToFileURL(path.join(repoRoot, 'src', 'db.js')).href;
  // 模拟调度器 / 看板 / CLI 多个进程同时冷启动：谁先抢到写锁谁迁移，
  // 其余 worker 必须看到已提交的 user_version 并跳过，而不是重跑 CREATE TABLE 报错。
  const source = `
    const { parentPort, workerData } = require('node:worker_threads');
    (async () => {
      const { openDb } = await import(workerData.dbUrl);
      const db = openDb(workerData.file);
      const now = new Date().toISOString();
      db.prepare(
        "INSERT INTO tasks (repo, title, prompt, max_attempts, created_at, updated_at) VALUES ('w/w', 'w', 'w', 2, ?, ?)"
      ).run(now, now);
      db.close();
      parentPort.postMessage({ ok: true });
    })().catch((err) => parentPort.postMessage({ ok: false, error: err.message }));
  `;
  const results = await Promise.all(Array.from({ length: 4 }, () => new Promise((resolve) => {
    const worker = new Worker(source, { eval: true, workerData: { file, dbUrl } });
    worker.on('message', (message) => resolve(message));
    worker.on('error', (err) => resolve({ ok: false, error: `worker 崩溃：${err.message}` }));
  })));
  for (const result of results) assert.deepEqual(result, { ok: true }, '每个 worker 都应成功打开并写入');

  const db = openDb(file);
  t.after(() => db.close());
  assert.equal(userVersion(db), SCHEMA_VERSION);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n, 4);
});
