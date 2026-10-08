// 调度器事件 → 终端一行一条的中文日志（格式由 issue #10 规定）。start（#10）与
// serve（#18）共用这一份，保证两个命令的调度事件输出逐字一致：
//   [HH:MM] 领取 #<id> <title>
//   [HH:MM] #<id> 成功：<prUrl> / 失败：<lastError> / 放回队列：<lastError> / 已取消…
//   [HH:MM] 暂停领取：<原因>，<本地时间> 后恢复
// 只依赖 format.js / tasks.js（都不加载 node:sqlite），可以被 CLI 模块静态引入。
import { formatLocalMinute } from '../format.js';
import { getTask } from '../tasks.js';

/** blocked 事件的 reason → 中文原因（与 src/scheduler.js 的四种拦截原因一一对应）。 */
const BLOCK_REASONS = {
  peak: '高峰期',
  'five-hour': '5 小时额度已满',
  weekly: '每周额度已满',
  'rate-limit': '被限流',
};

const p2 = (n) => String(n).padStart(2, '0');

/** 本地时区 HH:MM（事件行的 [HH:MM] 前缀）。 */
function localHourMinute(date) {
  return `${p2(date.getHours())}:${p2(date.getMinutes())}`;
}

/**
 * 把调度器事件接到 write（一行一条，格式见上）。clock 与调度器用同一个，保证
 * 时间戳口径一致。监听器自身绝不抛错打断调度（读库失败就只报 id）。
 * @param {object} scheduler createScheduler 的返回值
 * @param {import('node:sqlite').DatabaseSync} db 任务库（claim 时查标题）
 * @param {() => Date} clock 取「现在」
 * @param {(line: string) => void} write 已带换行的整行写出（如 ctx.stdout.write）
 */
export function attachSchedulerLog(scheduler, { db, clock, write }) {
  const say = (line) => write(`${line}\n`);
  const at = () => `[${localHourMinute(clock())}]`;

  scheduler.events.on('claim', ({ taskId }) => {
    let title = '';
    try {
      title = getTask(db, taskId)?.title ?? '';
    } catch {
      // 读库失败就只报 id，别拦着任务执行
    }
    say(`${at()} 领取 #${taskId}${title === '' ? '' : ` ${title}`}`);
  });
  scheduler.events.on('done', ({ taskId, status, prUrl, error }) => {
    if (status === 'succeeded') say(`${at()} #${taskId} 成功：${prUrl}`);
    else if (status === 'queued') say(`${at()} #${taskId} 放回队列：${error}`);
    else if (status === 'canceled') say(`${at()} #${taskId} 已取消${error === null ? '' : `：${error}`}`);
    else say(`${at()} #${taskId} 失败：${error}`);
  });
  scheduler.events.on('blocked', ({ reason, retryAt }) => {
    // 同一 (原因, 恢复时刻) 调度器只发一次，这里每条都如实打印
    const when = retryAt === null || retryAt === undefined
      ? '恢复时间未知'
      : `${formatLocalMinute(new Date(retryAt).toISOString())} 后恢复`;
    say(`${at()} 暂停领取：${BLOCK_REASONS[reason] ?? reason}，${when}`);
  });
}
