// 数据库打开与迁移。零依赖，只用 node:sqlite（Node 22.13+ 起无需开关）。
// 后续 issue（#9、#11、#12…）加表 / 加列时，只在 MIGRATIONS 末尾追加一个迁移函数：
// SCHEMA_VERSION 由 MIGRATIONS.length 算出，不用手工 +1。绝不改写已有迁移
// （旧库靠 user_version 判断跳过它们）；rebase 后版本号按列表位置自然顺延。
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * 打开（或创建）数据库并跑到最新 schema：
 * - `path` 为文件路径时递归创建父目录；`':memory:'` 原样传给 node:sqlite。
 * - 打开 WAL（多连接 / 调度器与看板可同时读写同一文件）、外键约束、busy_timeout，
 *   busy_timeout 让两个写连接短暂争锁时自动等待而不是立刻报 SQLITE_BUSY。
 * - 用 `PRAGMA user_version` 做版本迁移：整个升级在单个 IMMEDIATE 事务里执行（版本号
 *   也在锁内读，两个进程同时冷启动同一空库也只有一方真正迁移），成功才提交；
 *   重复打开不会重跑（迁移里是裸 CREATE TABLE，重跑必报错）。
 * - 库的 user_version 比代码认识的版本新（新版程序降级打开旧库）：直接抛错，不猜。
 *
 * @param {string} [dbPath=':memory:'] 数据库文件路径，或 ':memory:'
 * @returns {import('node:sqlite').DatabaseSync} 打开并迁移到最新版本的连接
 * @throws {Error} 路径不是非空字符串；无法打开 / 迁移失败（message 带路径与版本）；
 *   或库的 user_version 比代码认识的版本新（旧版程序打开了新版库）
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
  db.exec('BEGIN IMMEDIATE');
  let current;
  try {
    // 版本要在写锁内读：调度器和看板是两个进程，同时首次打开同一个空库时，
    // 后抢到锁的那个会看到先到者已提交的 user_version 并跳过，而不是重跑 CREATE TABLE。
    current = userVersion(db);
    if (current > SCHEMA_VERSION) {
      throw new Error(
        `数据库 ${dbPath} 的 user_version 是 ${current}，比本程序支持的最新版本 ${SCHEMA_VERSION} 新；`
          + '请先升级 night-shift 再打开它。',
      );
    }
    for (; current < SCHEMA_VERSION; current++) {
      try {
        MIGRATIONS[current](db);
      } catch (err) {
        throw new Error(`迁移数据库到版本 ${current + 1} 失败（${dbPath}）：${err.message}`);
      }
      // PRAGMA 赋值不能带参数，current+1 由 SCHEMA_VERSION 推出、必是整数，可以安全内插。
      db.exec(`PRAGMA user_version = ${current + 1}`);
    }
    db.exec('COMMIT');
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // 事务已不在（比如 COMMIT 报错前其实已提交）：保留原始错误，别让它被覆盖
    }
    throw err;
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
  /**
   * 版本 2：tasks 加 not_before（issue #9 调度器）。
   * - 限流退避的最早重试时刻（UTC ISO 字符串，与其他时间列一样字典序即时间序；
   *   写入方 finishTask 会先规范化成 UTC ISO，比较才可靠）。NULL = 立刻可领。
   * - claimNextTask 跳过 not_before > now 的任务；retryTask 重置任务时清空它。
   * - idx_tasks_not_before 帮「队列里有不少退避任务」时的领取过滤缩小扫描面。
   */
  (db) => {
    db.exec(`
      ALTER TABLE tasks ADD COLUMN not_before TEXT NULL;
      CREATE INDEX idx_tasks_not_before ON tasks (not_before);
    `);
  },
  // 版本 3：任务依赖表 task_deps（issue #11；与 #9 并行开发，合并时顺延到 not_before 之后）。
  // task_id 的任务要等 depends_on 的任务全部 succeeded 才能被领取；依赖失败 / 取消会沿边级联（见 src/tasks.js）。
  // PRIMARY KEY (task_id, depends_on) 天然去重并覆盖「按任务查它依赖谁」的正向扫描；
  // idx_task_deps_depends_on 覆盖反向扫描「谁依赖了它」（级联失败、blockedBy 统计）。
  (db) => {
    db.exec(`
      CREATE TABLE task_deps (
        task_id    INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
        depends_on INTEGER REFERENCES tasks(id),
        PRIMARY KEY (task_id, depends_on)
      );
      CREATE INDEX idx_task_deps_depends_on ON task_deps (depends_on);
    `);
  },
  // 版本 4：runs 加 kind / diagnosis（issue #12 失败自动诊断）。kind 区分普通执行（task）
  // 与失败诊断（diagnosis）运行——诊断也是一次真实调用，同样写 quota_units 参与额度统计；
  // diagnosis 存诊断文本，写在**被诊断的那次失败运行**行上（诊断运行自己的行保持 NULL）。
  // 已有行由 DEFAULT 'task' 回填，CHECK 只拦住今后的脏值。
  (db) => {
    db.exec(`
      ALTER TABLE runs ADD COLUMN kind TEXT NOT NULL DEFAULT 'task'
                       CHECK (kind IN ('task', 'diagnosis'));
      ALTER TABLE runs ADD COLUMN diagnosis TEXT NULL;
    `);
  },
  // 版本 5：tasks 加 source（issue #39 按 GitHub issue 批量入队）。来源标识（如
  // `github:a/b#12`），可空：手工 add 的任务没有来源。idx_tasks_source 只是查找
  // 索引、不 UNIQUE——import 遇到同一来源是跳过已有任务，重复本身不是错误。
  (db) => {
    db.exec(`
      ALTER TABLE tasks ADD COLUMN source TEXT NULL;
      CREATE INDEX idx_tasks_source ON tasks (source);
    `);
  },
  // 版本 6：meta 键值表（issue #38 手动暂停；与 #39 并行，合并时顺延到 source 之后）。
  // 目前只有一个键：userPaused（'1' / '0'，缺行 = 未暂停），调度器每轮领取前读它。
  // 只 CREATE TABLE、不插入行——「没有这行」就是默认的未暂停状态，语义见
  // src/tasks.js 的 getUserPaused / setUserPaused。
  // 它与调度器内存里的限流退避（pausedUntil）互相独立：这里是「人说不领」，那是
  // 「限流说要缓一缓」，两个可以同时生效。
  (db) => {
    db.exec(`
      CREATE TABLE meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  },
  // 版本 7：tasks 加 git_ref（issue #48 按 PR 评审在原分支跟进）。可空：普通任务没有
  // 跟随的分支，为 null；follow 命令建的跟进任务把它设成父任务成功时推送的
  // night-shift/<id>-<slug> 分支，createWorktree 据此从 origin/<git_ref> 检出，
  // 让改动落回原分支、复用原 PR（见 src/git.js 的 createWorktree）。
  (db) => {
    db.exec(`
      ALTER TABLE tasks ADD COLUMN git_ref TEXT NULL;
    `);
  },
  // 版本 8：tasks 加 pr_outcome（issue #56 记下 PR 已合并或已关闭）。可空文本，合法值
  // 只有调用方写入的 open / merged / closed，未查过是 NULL——不加 CHECK（旧测试的插入
  // 路径不被约束绊住）、不建索引（查询按 status 过滤后量级很小）。调度器开 prStatus 时
  // 定期用 gh pr view 查已成功任务的 PR state 并写这里（见 src/pr-status.js）；只记录
  // 结论，任务的 status / attempts / pr_url / branch / finished_at 一概不动。
  (db) => {
    db.exec(`
      ALTER TABLE tasks ADD COLUMN pr_outcome TEXT NULL;
    `);
  },
];

/**
 * 代码认识的最新 schema 版本（= MIGRATIONS 长度）。加新迁移后自动 +1。
 */
export const SCHEMA_VERSION = MIGRATIONS.length;

/**
 * 迁移函数列表：MIGRATIONS[v] 把 user_version 为 v 的库升到 v+1（v 从 0 起）。
 * 只允许在末尾追加，不要改写已发布的迁移（版本号按位置顺延，rebase 后自然重编号）；
 * 整个升级在单个 IMMEDIATE 事务里跑，两个进程同时首次打开同一个库也只会有一方真正执行迁移。
 * @type {Array<(db: import('node:sqlite').DatabaseSync) => void>}
 */
export { MIGRATIONS };
