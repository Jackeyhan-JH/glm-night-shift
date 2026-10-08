// 调度器锁（issue #18 产品评论）：一个数据目录同一时刻只允许一个调度器进程。
// pausedUntil（限流暂停）和 blocked 只在进程内存里，多个进程共用一个库时不会共享，
// 所以 serve / start 启动时都要先拿 <home>/scheduler.lock，拿不到就退出 1。
//
// 锁文件内容：第一行持锁进程 pid（整数），可带第二行说明。判定规则：
// - pid 不存在（进程已死 / pid 读不出）→ 过期锁，接管（崩溃后不能卡死）；
// - pid 活着但 /proc/<pid>/cmdline 不含 night-shift（别的程序碰巧占了文件）→ 同样接管；
// - pid 活着且像本程序 → 被持有，抛 SchedulerLockHeldError（信息含对方 pid）。
// 正常退出（优雅与强制都是退出 0）时删掉自己的锁；删前重读内容，只删仍写着
// 自己 pid 的那份——绝不删掉后继者接管后写的锁。
import fs from 'node:fs';
import path from 'node:path';

/** 锁文件名（数据目录下）。 */
const LOCK_NAME = 'scheduler.lock';
/** 过期锁「删掉重试」的次数上限：防两个进程同时接管时无限互删。 */
const ACQUIRE_ATTEMPTS = 5;

/** 锁被别的活着的本程序进程持有时抛出；message 含「已有调度器在运行（pid …）」。 */
export class SchedulerLockHeldError extends Error {
  /**
   * @param {number} pid 持锁进程的 pid
   * @param {string} file 锁文件路径
   */
  constructor(pid, file) {
    super(`已有调度器在运行（pid ${pid}），同一数据目录只允许一个调度器进程（锁文件 ${file}）`);
    this.name = 'SchedulerLockHeldError';
    this.pid = pid;
  }
}

/** 锁文件路径（导出给测试与排障）。 */
export function schedulerLockPath(home) {
  return path.join(home, LOCK_NAME);
}

/**
 * 获取调度器锁。拿不到（被活着的本程序进程持有）抛 SchedulerLockHeldError；
 * 锁过期（pid 已死 / 不是本程序）则删掉重试后接管。
 * @param {string} home 数据目录（需已存在）
 * @returns {{ file: string, pid: number, release: () => boolean }} 锁句柄；
 *   release 幂等，只在锁文件仍写着本进程 pid 时删除，返回是否真的删了。
 */
export function acquireSchedulerLock(home) {
  const file = schedulerLockPath(home);
  for (let attempt = 0; attempt < ACQUIRE_ATTEMPTS; attempt++) {
    try {
      // wx：只在文件不存在时创建，存在则 EEXIST——这是「拿到 / 没拿到」的原子判定。
      fs.writeFileSync(file, lockContent(), { flag: 'wx' });
      return makeHandle(file);
    } catch (err) {
      if (err === null || typeof err !== 'object' || err.code !== 'EEXIST') throw err;
    }
    // 以读到的这份内容为准判定持有者；过期（pid 死了 / 不是本程序）就删掉重抢。
    const snapshot = readRaw(file);
    const holder = parsePid(snapshot);
    if (holder !== null && isLiveNightShift(holder)) {
      throw new SchedulerLockHeldError(holder, file);
    }
    // 删之前确认文件内容没被并发接管者换掉（缩小读与删之间的窗口；不是原子操作，
    // 但竞争窗口远小于整段启动流程，且后继者的锁同样要过 wx 创建这一关）。
    if (snapshot !== null && readRaw(file) === snapshot) {
      try {
        fs.unlinkSync(file);
      } catch (err) {
        if (err === null || typeof err !== 'object' || err.code !== 'ENOENT') throw err;
      }
    }
    // 回到循环顶再抢一次 wx；连续抢不到 ACQUIRE_ATTEMPTS 次就报错。
  }
  throw new Error(`无法获取调度器锁 ${file}：重试 ${ACQUIRE_ATTEMPTS} 次仍被占用`);
}

/** 锁文件内容：pid 一行 + 一行说明（解析只看第一行）。 */
function lockContent() {
  return `${process.pid}\nnight-shift scheduler lock\n`;
}

/**
 * pid 是否活着且像本程序（/proc/<pid>/cmdline 含 night-shift）。
 * @param {number} pid
 */
export function isLiveNightShift(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  let cmdline = null;
  try {
    cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
  } catch {
    return false; // 进程不存在（ESRCH）或不可读：当作不持有
  }
  if (!cmdline.includes('night-shift')) return false;
  try {
    process.kill(pid, 0); // 只探测存在性，不发信号
  } catch {
    return false; // 读到 cmdline 的瞬间进程退了：也当不持有
  }
  return true;
}

/** 读锁文件全文；读不到返回 null。 */
function readRaw(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/** 锁文件第一行的 pid；文件不在 / 内容不认识 → null（视为可接管）。 */
function parsePid(raw) {
  if (raw === null) return null;
  const first = raw.split('\n', 1)[0].trim();
  if (!/^\d+$/.test(first)) return null;
  return Number(first);
}

function makeHandle(file) {
  let released = false;
  return {
    file,
    pid: process.pid,
    release() {
      if (released) return false;
      released = true;
      if (parsePid(readRaw(file)) !== process.pid) return false; // 已被后继者接管：不动它的锁
      try {
        fs.unlinkSync(file);
        return true;
      } catch (err) {
        if (err !== null && typeof err === 'object' && err.code === 'ENOENT') return false;
        throw err;
      }
    },
  };
}
