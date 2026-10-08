// src/db.js：打开、PRAGMA、迁移与约束。任务 / run 的领域行为见 tasks.test.js。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { openDb, SCHEMA_VERSION, MIGRATIONS } from '../src/db.js';
import { getUserPaused, setUserPaused } from '../src/tasks.js';
import { DatabaseSync } from 'node:sqlite';
import { makeTempHome } from './helpers.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test(':memory: 建出 tasks / runs 两张表和 v1 的四个索引，user_version 等于迁移步数', () => {
  const db = openDb();
  try {
    // 后续 issue 会再加表 / 加索引，这里只断言 v1 建的东西存在，不做排他性比较
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all().map((row) => row.name);
    for (const name of ['runs', 'tasks']) assert.ok(tables.includes(name), `应有表 ${name}`);
    const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%' ORDER BY name")
      .all().map((row) => row.name);
    for (const name of ['idx_runs_list', 'idx_runs_open', 'idx_tasks_claim', 'idx_tasks_list']) {
      assert.ok(indexes.includes(name), `应有索引 ${name}`);
    }
    assert.equal(userVersion(db), MIGRATIONS.length); // 不写死数字：版本号 = 迁移步数
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

test('关掉再打开同一文件：数据还在，user_version 等于迁移步数，迁移不重跑', (t) => {
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
  assert.equal(userVersion(db2), MIGRATIONS.length);
  const row = db2.prepare('SELECT repo, priority FROM tasks').get();
  assert.equal(row.repo, 'a/b');
  assert.equal(row.priority, 7);
});

test('验收: 打开旧库（建到追加 meta 前一步的 schema）自动补上 meta 表，任务还在，缺 userPaused 行 = 未暂停', (t) => {
  const file = path.join(makeTempHome(t), 'night-shift.db');
  // 模拟升级现场：用 MIGRATIONS.slice(0, -1) 建到「追加 meta 之前」的 schema，
  // user_version 设成那时的迁移步数，库里还有一行老任务。
  const prior = MIGRATIONS.slice(0, -1);
  const raw = new DatabaseSync(file);
  for (const migrateStep of prior) migrateStep(raw);
  raw.exec(`PRAGMA user_version = ${prior.length}`);
  const now = new Date().toISOString();
  raw.prepare(`
    INSERT INTO tasks (repo, title, prompt, priority, max_attempts, created_at, updated_at)
    VALUES ('a/b', '老任务', 'p', 7, 3, ?, ?)
  `).run(now, now);
  raw.close();

  const db = openDb(file);
  t.after(() => db.close());
  assert.equal(userVersion(db), prior.length + 1, 'user_version 应为迁移前 + 1');
  assert.equal(userVersion(db), MIGRATIONS.length);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all().map((row) => row.name);
  assert.ok(tables.includes('meta'), '应有 meta 表');
  // 迁移只建表不插行：userPaused 缺行就是「未暂停」
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM meta WHERE key = 'userPaused'").get().n, 0);
  assert.equal(getUserPaused(db), false, '缺行读出来是未暂停');
  const row = db.prepare('SELECT repo, title, priority FROM tasks').get();
  assert.equal(row.repo, 'a/b', '原有任务还在');
  assert.equal(row.title, '老任务');
  assert.equal(row.priority, 7);
});

test('meta.userPaused 读写：缺行为 false，写 1 读 true，写回 0 读 false（UPSERT 幂等）', (t) => {
  const db = openDb(':memory:');
  t.after(() => db.close());
  assert.equal(getUserPaused(db), false, '新库缺行 = 未暂停');
  setUserPaused(db, true);
  assert.equal(getUserPaused(db), true);
  assert.equal(db.prepare("SELECT value FROM meta WHERE key = 'userPaused'").get().value, '1');
  setUserPaused(db, true); // 幂等：重复写同值不报错
  setUserPaused(db, false);
  assert.equal(getUserPaused(db), false);
  assert.equal(db.prepare("SELECT value FROM meta WHERE key = 'userPaused'").get().value, '0');
});

test('user_version 比代码认识的版本新时，openDb 报清晰错误且不动数据', (t) => {
  const file = path.join(makeTempHome(t), 'night-shift.db');
  const future = MIGRATIONS.length + 1; // 不管以后加到多少步，“比代码新”都成立
  const db1 = openDb(file);
  db1.exec(`PRAGMA user_version = ${future}`);
  db1.close();

  assert.throws(
    () => openDb(file),
    (err) => err instanceof Error && err.message.includes(String(future)) && err.message.includes(String(SCHEMA_VERSION)),
  );
  // 失败后文件还是老样子，版本号也没被改掉
  const raw = new DatabaseSync(file);
  assert.equal(userVersion(raw), future);
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

test('版本 5 的迁移：tasks.source 可空列 + 非唯一索引 idx_tasks_source', () => {
  const db = openDb(':memory:');
  try {
    const columns = db.prepare('PRAGMA table_info(tasks)').all().map((row) => row.name);
    assert.ok(columns.includes('source'), '应有 source 列');
    const sourceColumn = db.prepare('PRAGMA table_info(tasks)').all().find((row) => row.name === 'source');
    assert.equal(sourceColumn.notnull, 0, 'source 列可空');
    // 非唯一索引：同 source 的多行都能进库（import 重复是跳过，不是报错）
    const now = '2026-01-01T00:00:00.000Z';
    const insert = db.prepare(`
      INSERT INTO tasks (repo, title, prompt, max_attempts, source, created_at, updated_at)
      VALUES ('a/b', 't', 'p', 2, ?, ?, ?)
    `);
    insert.run('github:a/b#12', now, now);
    insert.run('github:a/b#12', now, now);
    const indexes = db.prepare("SELECT name, sql FROM sqlite_master WHERE type='index' AND name = 'idx_tasks_source'")
      .all();
    assert.equal(indexes.length, 1, '应有索引 idx_tasks_source');
    assert.ok(!/unique/i.test(indexes[0].sql), 'idx_tasks_source 不是 UNIQUE');
  } finally {
    db.close();
  }
});
