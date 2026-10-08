// 数据库打开与迁移。零依赖，只用 node:sqlite（Node 22.13+ 起无需开关）。
// 后续 issue 加表 / 加列时，只在 MIGRATIONS 末尾追加一个函数并把 SCHEMA_VERSION 同步 +1，
// 不要改写已发布的迁移（旧库靠 user_version 判断跳过它们）。
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * 打开（或创建）数据库并跑到最新 schema：
 * - `path` 为文件路径时递归创建父目录；`':memory:'` 原样传给 node:sqlite。
 * - 打开 WAL（多连接 / 调度器与看板可同时读写同一文件）、外键约束、busy_timeout，
 *   busy_timeout 让两个写连接短暂争锁时自动等待而不是立刻报 SQLITE_BUSY。
 * - 用 `PRAGMA user_version` 做版本迁移：每个迁移在 IMMEDIATE 事务里执行，
 *   成功才把版本号写进去；重复打开不会重跑（迁移里是裸 CREATE TABLE，重跑必报错）。
 * - 库的 user_version 比代码认识的版本新（新版程序降级打开旧库）：直接抛错，不猜。
 *
 * @param {string} dbPath 数据库文件路径，或 ':memory:'
 * @returns {import('node:sqlite').DatabaseSync}
 */
export function openDb(dbPath = ':memory:') {
  if (typeof dbPath !== 'string' || dbPath === '') {
    throw new Error(`数据库路径必须是非空字符串，当前值：${String(dbPath)}`);
  }
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  }
  const db = new DatabaseSync(dbPath);
  try {
    // 顺序有讲究：busy_timeout 最先（journal_mode 转 WAL 也要抢写锁，没超时会立刻
    // SQLITE_BUSY）；这几个 PRAGMA 都不能在事务里改，全设在迁移之前。
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec('PRAGMA journal_mode = WAL'); // :memory: 库保持 memory 模式，同样无害
    db.exec('PRAGMA foreign_keys = ON');
    migrate(db, dbPath);
    return db;
  } catch (err) {
    db.close();
    throw err;
  }
}

function migrate(db, dbPath) {
  const current = userVersion(db);
  if (current > SCHEMA_VERSION) {
    throw new Error(
      `数据库 ${dbPath} 的 user_version 是 ${current}，比本程序支持的最新版本 ${SCHEMA_VERSION} 新；`
        + '请先升级 night-shift 再打开它。',
    );
  }
  for (let v = current; v < SCHEMA_VERSION; v++) {
    db.exec('BEGIN IMMEDIATE');
    try {
      MIGRATIONS[v](db);
      // PRAGMA 赋值不能带参数，v+1 由 SCHEMA_VERSION 推出、必是整数，可以安全内插。
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec('COMMIT');
    } catch (err) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // 事务已不在（比如 COMMIT 报错前其实已提交）：保留原始错误，别让它被覆盖
      }
      throw new Error(`迁移数据库到版本 ${v + 1} 失败（${dbPath}）：${err.message}`);
    }
  }
}

/** 读 `PRAGMA user_version`（每连接独立调用，不用缓存语句对象）。 */
function userVersion(db) {
  return db.prepare('PRAGMA user_version').get().user_version;
}

/**
 * 版本 1：tasks 与 runs 两张表（issue #3）。
 * - 时间一律存 UTC ISO 字符串（约定见 #1），比较时按字典序即时间序。
 * - 布尔存 0/1 并用 CHECK 收紧；状态列用 CHECK 枚举，脏数据进不了库。
 * - tasks.idx_tasks_claim 覆盖领取排序（priority DESC, created_at ASC, id ASC），
 *   idx_tasks_list 覆盖按状态的列表排序（created_at DESC）；
 *   id 参与排序是为了同一毫秒创建的任务也有确定的先后（FIFO）。
 */
const MIGRATIONS = [
  (db) => {
    db.exec(`
      CREATE TABLE tasks (
        id           INTEGER PRIMARY KEY,
        repo         TEXT    NOT NULL,
        title        TEXT    NOT NULL,
        prompt       TEXT    NOT NULL,
        difficulty   TEXT    NOT NULL DEFAULT 'medium'
                     CHECK (difficulty IN ('easy', 'medium', 'hard')),
        priority     INTEGER NOT NULL DEFAULT 0,
        test_command TEXT,
        allow_peak   INTEGER NOT NULL DEFAULT 0 CHECK (allow_peak IN (0, 1)),
        status       TEXT    NOT NULL DEFAULT 'queued'
                     CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'canceled')),
        attempts     INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        max_attempts INTEGER NOT NULL CHECK (max_attempts >= 1),
        branch       TEXT,
        pr_url       TEXT,
        last_error   TEXT,
        created_at   TEXT    NOT NULL,
        updated_at   TEXT    NOT NULL,
        started_at   TEXT,
        finished_at  TEXT
      );
      CREATE INDEX idx_tasks_claim ON tasks (status, priority DESC, created_at ASC, id ASC);
      CREATE INDEX idx_tasks_list  ON tasks (status, created_at DESC, id DESC);

      CREATE TABLE runs (
        id          INTEGER PRIMARY KEY,
        task_id     INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        attempt     INTEGER NOT NULL CHECK (attempt >= 1),
        model       TEXT    NOT NULL,
        effort      TEXT    NOT NULL,
        peak        INTEGER NOT NULL DEFAULT 0 CHECK (peak IN (0, 1)),
        status      TEXT    NOT NULL DEFAULT 'running'
                    CHECK (status IN ('running', 'succeeded', 'failed', 'timeout', 'canceled')),
        exit_code   INTEGER,
        num_turns   INTEGER,
        prompts     REAL    NOT NULL DEFAULT 1,
        quota_units REAL,
        log_path    TEXT    NOT NULL,
        started_at  TEXT    NOT NULL,
        finished_at TEXT,
        duration_ms INTEGER,
        error       TEXT
      );
      CREATE INDEX idx_runs_list ON runs (task_id, started_at DESC, id DESC);
      CREATE INDEX idx_runs_open ON runs (status);
    `);
  },
];

/**
 * 代码认识的最新 schema 版本（= MIGRATIONS 长度）。加新迁移后自动 +1。
 */
export const SCHEMA_VERSION = MIGRATIONS.length;

export { MIGRATIONS };
