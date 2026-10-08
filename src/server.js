// 看板后端（issue #14）：node:http 实现的只听本机的小服务——任务的增删查与操作、
// 运行日志全文 / SSE 实时跟踪、高峰与额度状态、近几天的用量统计、任务模板接口（#15），
// 顺带托管 web/ 静态页。
// 零依赖；不加载 node:sqlite（连接由调用方 openDb 后传入），SSE 只依赖「runs.log_path
// 指向的日志文件每行一条」的约定（见 #7），不依赖执行器。
//
// 安全模型（没有登录，靠这三条 + 只听 127.0.0.1）：
// - 所有 POST 必须 Content-Type: application/json（浏览器跨站表单无法伪造该头）→ 415；
// - 带 Origin 且其 host:port 与 Host 头不一致的 POST → 403（拦跨站 fetch/iframe）；
// - 请求体超过 1MB → 413，停止读取不无限缓冲。
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { systemClock } from './clock.js';
import { getStatus } from './peak.js';
import { multiplierFor, toDate, usage } from './quota.js';
import { HISTORY_DAYS_MAX, HISTORY_DAYS_MIN, hourlyUsage } from './stats.js';
import {
  InvalidTransitionError,
  NotFoundError,
  ValidationError,
  cancelTask,
  createTask,
  getRun,
  getTask,
  getUserPaused,
  listRuns,
  listTasks,
  retryTask,
  setUserPaused,
} from './tasks.js';
import { listTemplates, loadTemplate, renderTemplate } from './templates.js';

/** web/ 静态文件根目录（src/server.js 的上一级里的 web/）。 */
const WEB_ROOT = path.resolve(fileURLToPath(new URL('../web', import.meta.url)));
/** src/ 里允许浏览器按路径只读取用的模块白名单（issue #17：额度页在浏览器里
 *  import /src/peak.js 复用高峰纯函数算高峰带与未来时段，不把这些结果塞进 /api/status）。
 *  只此一个路径——其余 src/** 一律不暴露。 */
const SRC_FILES = new Map([
  ['/src/peak.js', path.resolve(fileURLToPath(new URL('./peak.js', import.meta.url)))],
]);
/** POST 请求体上限（issue 规格：1MB）。 */
const MAX_BODY_BYTES = 1024 * 1024;
/** SSE：轮询兜底间隔（fs.watch 在网络盘 / 部分文件系统上不发事件，也是发现日志文件被创建、运行结束的手段）。 */
const SSE_POLL_MS = 500;
/** SSE：保活注释行间隔。 */
const SSE_PING_MS = 15_000;
/** listRuns 的“要全部”上限：7～30 天窗口 / 一个任务的全部运行都远小于它，避免默认 100 条悄悄截断。 */
const HUGE_LIMIT = 1_000_000;

const MIME_TYPES = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.json', 'application/json; charset=utf-8'],
  ['.png', 'image/png'],
]);

/** POST /api/tasks 允许的请求体字段（createTask 的可选输入；未知字段 → 400 点名字段）。
 * #15 增加 dependsOn / template / vars（见 renderTemplateBody）。 */
const TASK_BODY_FIELDS = new Set([
  'repo', 'prompt', 'title', 'difficulty', 'priority', 'testCommand', 'allowPeak', 'maxAttempts',
  'dependsOn', 'template', 'vars',
]);

/**
 * 带HTTP 语义的错误：处理器主动抛出，按 status / field 回给客户端。
 * （领域错误 ValidationError / NotFoundError / InvalidTransitionError 由 tasks.js 抛，统一映射。）
 */
class HttpError extends Error {
  /**
   * @param {number} status HTTP 状态码
   * @param {string} message 中文说明（进响应的 error 字段）
   * @param {string} [field] 出问题的字段名（进响应的 field 字段）
   */
  constructor(status, message, field) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.field = field;
  }
}

/**
 * 建看板服务（未监听）。调用方 `server.listen(port, config.host)`。
 * @param {object} options
 * @param {import('node:sqlite').DatabaseSync} options.db openDb() 的连接（多进程共享同一文件库）
 * @param {object} options.config loadConfig() 的生效配置（用到 plan / weekStart / maxAttempts / host）
 * @param {string} [options.home] 数据目录（预留：目前日志路径都来自 runs.log_path 绝对路径）
 * @param {() => Date} [options.clock=systemClock()] 时钟（测试用 NIGHT_SHIFT_NOW 固定时间）
 * @param {{ status: () => object }} [options.scheduler=null] 调度器（#18 传入；有则 /api/status 带上它的 status()）
 * @param {object} [options.env=process.env] 传给 gh 子进程的环境变量（模板 fetchIssue 用；
 *   测试用它注入 FAKE_GH_* 开关，见 test/server-templates.test.js）
 * @returns {import('node:http').Server} 未监听的 http.Server；额外挂了 sseConnections
 *   getter（当前存活的 SSE 连接数，测试断言断开清理用）
 */
export function createServer({ db, config, home, clock = systemClock(), scheduler = null, env = process.env } = {}) {
  if (db === undefined || db === null) throw new Error('createServer 需要 db（openDb 的返回值）');
  if (config === undefined || config === null) throw new Error('createServer 需要 config（loadConfig 的返回值）');
  const deps = { db, config, home, clock, scheduler, env };

  let sseConnections = 0;
  const bumpSse = (delta) => { sseConnections += delta; };
  const routes = buildRoutes(deps, bumpSse); // 闭包捕获 deps，整个 server 生命周期共用

  const server = http.createServer((req, res) => {
    Promise.resolve()
      .then(() => handleRequest(req, res, routes))
      .catch((err) => sendMappedError(res, err));
  });
  // 测试用：当前存活的 SSE 连接数（客户端断开后应回到 0）。
  Object.defineProperty(server, 'sseConnections', { get: () => sseConnections });
  return server;
}

// ---------------------------------------------------------------- 路由

/**
 * 路由表。路径里的 :id 用 `(\d+)` 捕获：非数字 id 视为「没有这个资源」→ 404。
 * 方法不匹配（路径命中但动词不对）→ 405 + Allow。
 */
function buildRoutes(deps, bumpSse) {
  return [
    { method: 'GET', pattern: /^\/api\/tasks$/, handler: (ctx) => {
      const status = nonEmpty(ctx.query.get('status'));
      const limitRaw = nonEmpty(ctx.query.get('limit'));
      // 空字符串参数按未传处理；非法值交给 store 校验（ValidationError → 400 带字段名）。
      sendJson(ctx.res, 200, listTasks(deps.db, {
        status,
        limit: limitRaw === undefined ? undefined : Number(limitRaw),
      }));
    } },
    { method: 'POST', pattern: /^\/api\/tasks$/, handler: async (ctx) => {
      for (const key of Object.keys(ctx.body)) {
        if (!TASK_BODY_FIELDS.has(key)) {
          throw new HttpError(400, `未知字段：${key}（允许：${[...TASK_BODY_FIELDS].join(' | ')}）`, key);
        }
      }
      if (ctx.body.template !== undefined && ctx.body.prompt !== undefined) {
        throw new HttpError(400, 'template 与 prompt 不能同时提供：prompt 由模板渲染生成', 'template');
      }
      if (ctx.body.vars !== undefined && !isPlainObject(ctx.body.vars)) {
        throw new HttpError(400, `vars 必须是「变量名: 值」的对象（当前值：${JSON.stringify(ctx.body.vars)}）`, 'vars');
      }
      const fields = ctx.body.template === undefined
        ? ctx.body
        : await renderTemplateBody(deps, ctx.body);
      const task = createTask(deps.db, {
        ...fields,
        maxAttempts: fields.maxAttempts ?? deps.config.maxAttempts, // 缺省取配置
      });
      sendJson(ctx.res, 201, task);
    } },
    { method: 'GET', pattern: /^\/api\/templates$/, handler: (ctx) => {
      // listTemplates 的结果去掉 path（服务端文件绝对路径，页面用不上，不往外发）。
      sendJson(ctx.res, 200, listTemplates({ home: deps.home }).map((tpl) => ({
        name: tpl.name,
        description: tpl.description,
        difficulty: tpl.difficulty,
        testCommand: tpl.testCommand,
        vars: tpl.vars,
        source: tpl.source,
      })));
    } },
    { method: 'GET', pattern: /^\/api\/tasks\/(\d+)$/, handler: (ctx) => {
      const id = parseId(ctx.params[0], '任务');
      const task = getTask(deps.db, id);
      if (task === null) throw new NotFoundError(id);
      sendJson(ctx.res, 200, { ...task, runs: listRuns(deps.db, { taskId: id, limit: HUGE_LIMIT }) });
    } },
    { method: 'POST', pattern: /^\/api\/tasks\/(\d+)\/cancel$/, handler: (ctx) => {
      sendJson(ctx.res, 200, cancelTask(deps.db, parseId(ctx.params[0], '任务')));
    } },
    { method: 'POST', pattern: /^\/api\/tasks\/(\d+)\/retry$/, handler: (ctx) => {
      sendJson(ctx.res, 200, retryTask(deps.db, parseId(ctx.params[0], '任务')));
    } },
    { method: 'GET', pattern: /^\/api\/runs\/(\d+)\/log$/, handler: (ctx) => {
      const run = requireRun(deps.db, parseId(ctx.params[0], '运行记录'));
      if (!run.logPath) throw new HttpError(404, '这次运行没有日志文件');
      let text;
      try {
        text = fs.readFileSync(run.logPath);
      } catch {
        throw new HttpError(404, `日志文件不存在：${run.logPath}`);
      }
      ctx.res.writeHead(200, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Length': text.length,
      });
      ctx.res.end(text);
    } },
    { method: 'GET', pattern: /^\/api\/runs\/(\d+)\/stream$/, handler: (ctx) => {
      handleStream(ctx, deps, bumpSse, parseId(ctx.params[0], '运行记录'));
    } },
    // 手动暂停 / 恢复领取（#38）：只写库里的 meta.userPaused，不要求调度器对象存在
    // （serve-api 没有调度器也能暂停）；空 body {} 即可，走与其他 POST 相同的防护。
    { method: 'POST', pattern: /^\/api\/scheduler\/pause$/, handler: (ctx) => {
      setUserPaused(deps.db, true);
      sendJson(ctx.res, 200, { userPaused: true });
    } },
    { method: 'POST', pattern: /^\/api\/scheduler\/resume$/, handler: (ctx) => {
      setUserPaused(deps.db, false);
      sendJson(ctx.res, 200, { userPaused: false });
    } },
    { method: 'GET', pattern: /^\/api\/status$/, handler: (ctx) => {
      const now = deps.clock();
      // 用量窗口取最早需要的起点：滚动 7 天与 weekStart 周期起点里更早的那个。
      const runs = listRuns(deps.db, { since: usageWindowStart(now, deps.config.weekStart), limit: HUGE_LIMIT });
      const peakStatus = getStatus(now);
      sendJson(ctx.res, 200, {
        now: now.toISOString(),
        peak: {
          peak: peakStatus.peak,
          nextChange: peakStatus.nextSwitch.toISOString(),
          multipliers: {
            'glm-5.3': multiplierFor('glm-5.3', now),
            'glm-5.3-flash': multiplierFor('glm-5.3-flash', now),
          },
        },
        usage: usage(runs, now, { plan: deps.config.plan, weekStart: deps.config.weekStart }),
        plan: deps.config.plan,
        // 额度页判定「超过安全阈值标黄」用的阈值（issue #17；与配置里的 safetyRatio 同源）。
        safetyRatio: deps.config.safetyRatio,
        runningCount: countTasks(deps.db, 'running'),
        queuedCount: countTasks(deps.db, 'queued'),
        // 顶层的手动暂停标记（#38）：从库里现读（缺行 = false），不从 scheduler 的
        // status() 抄——serve-api 没有 scheduler 时也要能看到暂停状态。
        userPaused: getUserPaused(deps.db),
        // scheduler 字段原样放调度器的 status()（有 userPaused 等全部字段），不包装。
        scheduler: deps.scheduler === null || deps.scheduler === undefined
          ? null
          : deps.scheduler.status(),
      });
    } },
    { method: 'GET', pattern: /^\/api\/usage\/history$/, handler: (ctx) => {
      const daysRaw = nonEmpty(ctx.query.get('days'));
      let days = 7;
      if (daysRaw !== undefined) {
        days = Number(daysRaw);
        if (!Number.isInteger(days) || days < HISTORY_DAYS_MIN || days > HISTORY_DAYS_MAX) {
          throw new ValidationError('days', `必须是 ${HISTORY_DAYS_MIN}～${HISTORY_DAYS_MAX} 的整数（当前值：${daysRaw}）`);
        }
      }
      const now = deps.clock();
      const from = new Date(Math.floor(now.getTime() / 3_600_000) * 3_600_000 - (days * 24 - 1) * 3_600_000);
      const runs = listRuns(deps.db, { since: from, limit: HUGE_LIMIT });
      sendJson(ctx.res, 200, hourlyUsage(runs, now, days));
    } },
  ];
}

// ---------------------------------------------------------------- 模板建任务（#15）

/**
 * POST /api/tasks 带 template 时的字段预处理：renderTemplate 生成 prompt（可能要 spawn
 * gh 拉 issue，故异步），显式给出的 title / difficulty / testCommand 优先于模板默认值
 * （命令行 add --template 同一套语义，见 src/cli/task-commands.js）。
 *
 * 渲染失败统一 400：ValidationError 保留自带 field（vars / template / repo / prompt，
 * 如「缺少必填变量：issue」）；模板不存在归到 template 字段；gh 执行失败这类意外错误
 * 也归到 template 字段（issue 规格：field 为 vars 或 template）。
 * @param {object} deps createServer 的依赖集（home / config / env）
 * @param {object} body 已通过字段白名单的请求体（template 与 prompt 互斥已在上游保证）
 * @returns {Promise<object>} createTask 的输入（template / vars 已剥离，prompt 已生成）
 */
async function renderTemplateBody(deps, body) {
  const { template, vars, ...rest } = body;
  let rendered;
  try {
    rendered = await renderTemplate(loadTemplate(template, { home: deps.home }), vars ?? {}, {
      repo: rest.repo,
      config: deps.config,
      env: deps.env,
    });
  } catch (err) {
    if (err instanceof ValidationError) throw err;
    if (err instanceof NotFoundError) {
      throw new HttpError(400, `模板 ${template} 不存在（可用模板见 GET /api/templates）`, 'template');
    }
    throw new HttpError(400, `模板 ${template} 渲染失败：${err.message}`, 'template');
  }
  return {
    ...rest,
    prompt: rendered.prompt,
    title: rest.title ?? rendered.title,
    difficulty: rest.difficulty ?? rendered.difficulty,
    testCommand: rest.testCommand ?? rendered.testCommand,
  };
}

/** JSON 里的「普通对象」：非 null 非数组的对象（vars 的形状检查）。 */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function handleRequest(req, res, routes) {
  let url;
  try {
    url = new URL(req.url, 'http://localhost');
  } catch {
    return sendJson(res, 404, { error: '路径不合法' });
  }
  const pathname = decodePath(url.pathname);
  if (pathname === null) return sendJson(res, 404, { error: '路径不合法' });

  const matched = routes.filter((route) => route.pattern.test(pathname));
  if (matched.length > 0) {
    const route = matched.find((r) => r.method === req.method);
    if (route === undefined) {
      res.setHeader('Allow', [...new Set(matched.map((r) => r.method))].join(', '));
      return sendJson(res, 405, { error: `不支持的方法：${req.method}` });
    }
    const ctx = {
      req, res, query: url.searchParams,
      params: pathname.match(route.pattern).slice(1),
    };
    if (req.method === 'POST') {
      if (!guardPost(req, res)) return;
      ctx.body = await readJsonBody(req, res); // 已应答（413/400）时为 null
      if (ctx.body === null) return;
    }
    await route.handler(ctx);
    return;
  }

  // 没命中 API 路由：/api/** 一律 404 JSON，其余交给静态托管（只允许 GET/HEAD）。
  if (pathname === '/api' || pathname.startsWith('/api/')) {
    return sendJson(res, 404, { error: `未知接口：${req.method} ${pathname}` });
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return sendJson(res, 405, { error: `不支持的方法：${req.method}` });
  }
  serveStatic(req, res, pathname);
}

// ---------------------------------------------------------------- POST 防护与请求体

/** 所有 POST 的前置检查：Content-Type 必须 application/json（415），Origin 与 Host 不一致拒绝（403）。 */
function guardPost(req, res) {
  const contentType = req.headers['content-type'] ?? '';
  const mediaType = contentType.split(';')[0].trim().toLowerCase();
  if (mediaType !== 'application/json') {
    sendJson(res, 415, { error: 'POST 请求必须带 Content-Type: application/json' });
    return false;
  }
  const origin = req.headers.origin;
  if (origin !== undefined && origin !== '') {
    // 只比对 host:port（协议不参与）：Origin 解析不出（如字符串 "null"）视为不一致，拒绝。
    let originHost = null;
    try {
      originHost = new URL(origin).host;
    } catch {
      originHost = null;
    }
    const hostHeader = String(req.headers.host ?? '').trim().toLowerCase();
    if (originHost === null || originHost !== hostHeader) {
      sendJson(res, 403, { error: 'Origin 与 Host 不一致，已拒绝该跨站请求' });
      return false;
    }
  }
  return true;
}

/** 读请求体：超 1MB 立即停读（不无限缓冲）。 */
function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    let total = 0;
    let settled = false;
    const finish = (value) => { if (!settled) { settled = true; resolve(value); } };
    req.on('data', (chunk) => {
      if (settled) return;
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        req.pause();
        finish({ tooLarge: true });
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => finish({ text: Buffer.concat(chunks).toString('utf8') }));
    req.on('error', () => finish({ text: '' })); // 连接中断：当空体处理，后续解析自然报 400
    // 客户端中途断开不一定触发 error：close 兜底（正常流程里它在 end 之后，finish 幂等）
    req.on('close', () => finish({ text: '' }));
  });
}

/**
 * POST 请求体 → JSON 对象。已应答时返回 null（调用方直接 return）。
 * 空请求体按 {} 处理（cancel / retry 这类操作型 POST 不需要体）。
 */
async function readJsonBody(req, res) {
  const raw = await readBody(req);
  if (raw.tooLarge) {
    sendJson(res, 413, { error: `请求体超过 ${MAX_BODY_BYTES / 1024}KB 上限` });
    // 响应发完再掐断连接：既让客户端拿到 413，又不陪着上传方无限读下去。
    res.once('finish', () => req.destroy());
    return null;
  }
  if (raw.text === '') return {};
  let parsed;
  try {
    parsed = JSON.parse(raw.text);
  } catch {
    sendJson(res, 400, { error: '请求体不是合法 JSON' });
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    sendJson(res, 400, { error: '请求体必须是 JSON 对象' });
    return null;
  }
  return parsed;
}

// ---------------------------------------------------------------- SSE 实时日志

/**
 * GET /api/runs/:id/stream：先把日志文件已有内容逐行发出（event: log），再跟踪新增
 * （fs.watch 低延迟 + 500ms 轮询兜底，只读上次偏移之后的新字节）；库里这次运行已结束
 * 且文件读完时补发末尾不完整的一行，然后 event: done（data: {"status":…}）并关闭。
 * 每 15s 发一行 `: ping` 注释保活；日志文件尚未创建 / log_path 还没写时等待。
 * 客户端断开（res close）清理 watcher 与全部定时器。
 */
function handleStream({ req, res }, deps, bumpSse, runId) {
  requireRun(deps.db, runId); // 不存在 → NotFoundError → 404 JSON（还没写过响应头）

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  bumpSse(1);

  const state = { logPath: '', offset: 0, partial: Buffer.alloc(0) };
  let watcher = null;
  let pollTimer = null;
  let pingTimer = null;
  let closed = false;

  const send = (event, data) => {
    if (!closed) res.write(`event: ${event}\ndata: ${data}\n\n`);
  };

  const cleanup = () => {
    if (closed) return;
    closed = true;
    bumpSse(-1);
    if (pollTimer !== null) clearInterval(pollTimer);
    if (pingTimer !== null) clearInterval(pingTimer);
    if (watcher !== null) watcher.close();
    watcher = null;
  };
  res.on('close', cleanup); // 客户端断开或自己 end() 都会走到

  /** 读 logPath 里 offset 之后的新字节，按 \n 切成完整行发出；不完整的尾部留在 partial。 */
  const readNewLines = () => {
    if (closed || state.logPath === '') return;
    let size;
    try {
      size = fs.statSync(state.logPath).size;
    } catch {
      return; // 文件还没创建：等轮询/下一次 watch 事件
    }
    if (size < state.offset) { // 文件被截断重写：从头再读，避免永远错过内容
      state.offset = 0;
      state.partial = Buffer.alloc(0);
    }
    if (size === state.offset) return;
    let buf;
    try {
      const fd = fs.openSync(state.logPath, 'r');
      try {
        buf = Buffer.alloc(size - state.offset);
        const { bytesRead } = fs.readSync(fd, buf, 0, buf.length, state.offset);
        buf = buf.subarray(0, bytesRead);
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return; // 读失败（正被原子替换等）：留给下一次轮询
    }
    state.offset += buf.length;
    // 只按字节 0x0a 切行、整行再按 utf-8 解码：多字节字符跨读取也不会被劈坏。
    state.partial = Buffer.concat([state.partial, buf]);
    let start = 0;
    for (;;) {
      const nl = state.partial.indexOf(0x0a, start);
      if (nl === -1) break;
      send('log', state.partial.subarray(start, nl).toString('utf8'));
      start = nl + 1;
    }
    state.partial = state.partial.subarray(start);
  };

  /** 文件已存在且还没 watcher 时挂上（文件未创建时先靠轮询，出现后再 watch）。 */
  const ensureWatcher = () => {
    if (watcher !== null || closed || state.logPath === '') return;
    try {
      watcher = fs.watch(state.logPath, () => readNewLines());
    } catch {
      return; // ENOENT 等：轮询兜底，下轮再试
    }
    watcher.on('error', () => {
      if (watcher !== null) watcher.close();
      watcher = null; // 删除/替换：回到轮询，下轮重建
    });
  };

  const finishStream = (finalStatus) => {
    readNewLines(); // 结束前把最后一批字节读完
    if (state.partial.length > 0) { // 末尾没有换行的不完整行也发出去
      send('log', state.partial.toString('utf8'));
      state.partial = Buffer.alloc(0);
    }
    send('done', JSON.stringify({ status: finalStatus }));
    cleanup();
    res.end();
  };

  const poll = () => {
    if (closed) return;
    const row = getRun(deps.db, runId); // 每轮重读：log_path 可能稍后才写、状态会被执行器更新
    if (row === null) { // 运行记录被删（任务级联删除）：按 unknown 收尾
      finishStream('unknown');
      return;
    }
    if (state.logPath === '' && row.logPath) state.logPath = row.logPath;
    readNewLines();
    ensureWatcher();
    if (row.status !== 'running') finishStream(row.status);
  };

  // 先建定时器、再跑第一次 poll：连接时运行就已结束的话 poll → finishStream → cleanup
  // 会清掉这两个定时器；顺序反了（poll 先行）会漏掉尚未赋值的定时器句柄，泄漏到进程结束。
  // safePoll 兜底：停机时 db 可能先于本连接被关闭（closeAllConnections 的 close 事件
  // 是异步的），轮询打到已关闭的库会抛错——吞掉并安静收流，不能让 interval 回调把进程打崩。
  const safePoll = () => {
    try {
      poll();
    } catch {
      try {
        cleanup();
        res.end();
      } catch {
        // 响应也已不可写：到此为止
      }
    }
  };
  pollTimer = setInterval(safePoll, SSE_POLL_MS);
  pingTimer = setInterval(() => {
    if (!closed) res.write(': ping\n\n');
  }, SSE_PING_MS);
  poll(); // 先把已有内容发出去（含“连接时运行就已结束”的立即收尾）
}

// ---------------------------------------------------------------- 静态文件

/** 解析静态文件路径；越出 web/、含反斜杠/空字节、目录 → null（404）。 */
function resolveStaticPath(pathname) {
  if (pathname.includes('\0') || pathname.includes('\\')) return null;
  let relative = pathname.slice(1);
  if (relative === '') relative = 'index.html'; // / → web/index.html
  const resolved = path.resolve(WEB_ROOT, relative);
  if (resolved !== WEB_ROOT && !resolved.startsWith(`${WEB_ROOT}${path.sep}`)) return null;
  return resolved;
}

function serveStatic(req, res, pathname) {
  // 白名单里的 src/ 模块直接按绝对路径取；其余仍按 web/ 内的相对路径解析（越界 → 404）。
  const filePath = SRC_FILES.get(pathname) ?? resolveStaticPath(pathname);
  let data = null;
  if (filePath !== null) {
    try {
      data = fs.readFileSync(filePath); // 目录会抛 EISDIR → 404（不做目录列表）
    } catch {
      data = null;
    }
  }
  if (data === null) return sendJson(res, 404, { error: `文件不存在：${pathname}` });
  res.writeHead(200, {
    'Content-Type': MIME_TYPES.get(path.extname(filePath).toLowerCase()) ?? 'application/octet-stream',
    'Content-Length': data.length,
  });
  res.end(req.method === 'HEAD' ? undefined : data); // HEAD 只回头与元信息
}

/** URL 路径的百分号解码；非法编码或解出空字节 → null。 */
function decodePath(pathname) {
  try {
    const decoded = decodeURIComponent(pathname);
    return decoded.includes('\0') ? null : decoded;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- 辅助

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

/** 统一错误映射：HttpError → 自带状态码；ValidationError → 400；NotFoundError → 404；InvalidTransitionError → 409；其余 → 500（不泄露堆栈）。 */
function sendMappedError(res, err) {
  if (res.headersSent) {
    res.destroy(); // 流式响应中途出错：只能断开，没法再改状态码
    return;
  }
  if (err instanceof HttpError) {
    sendJson(res, err.status, err.field === undefined ? { error: err.message } : { error: err.message, field: err.field });
    return;
  }
  if (err instanceof ValidationError) {
    sendJson(res, 400, { error: err.message, field: err.field });
    return;
  }
  if (err instanceof NotFoundError) {
    sendJson(res, 404, { error: err.message });
    return;
  }
  if (err instanceof InvalidTransitionError) {
    sendJson(res, 409, { error: err.message });
    return;
  }
  // 意外错误只进服务端日志，响应里给固定文案。
  console.error(`[server] 未处理错误：${reqMethodOf(res)} ${err?.stack ?? err}`);
  sendJson(res, 500, { error: '服务器内部错误' });
}

function reqMethodOf(res) {
  return res.req?.method ?? '?';
}

/** 路径参数里的 id：路由保证是纯数字，这里只挡超范围的（防绑定 SQLite 时溢出）。 */
function parseId(raw, kind) {
  const id = Number(raw);
  if (!Number.isSafeInteger(id) || id < 1) throw new HttpError(404, `${kind} ${raw} 不存在`);
  return id;
}

function requireRun(db, id) {
  const run = getRun(db, id);
  if (run === null) throw new NotFoundError(id, '运行记录');
  return run;
}

function countTasks(db, status) {
  return db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE status = ?').get(status).n;
}

/** 查询参数：空字符串按未传。 */
function nonEmpty(value) {
  return value === null || value === '' ? undefined : value;
}

/**
 * /api/status 的用量统计需要的最早起点：滚动 7 天窗口与 weekStart 周期起点（下单时间
 * 起 7 天一周期，取 now 所在周期的起点）里更早的那个。多取不影响结果（usage 自带窗口裁剪）。
 */
function usageWindowStart(now, weekStart) {
  const rolling = new Date(now.getTime() - 7 * 24 * 3_600_000);
  if (weekStart === null || weekStart === undefined || weekStart === '') return rolling;
  const weekStartTs = toDate(weekStart, 'weekStart').getTime();
  const cycleStart = weekStartTs + Math.floor((now.getTime() - weekStartTs) / (7 * 24 * 3_600_000)) * 7 * 24 * 3_600_000;
  return cycleStart < rolling.getTime() ? new Date(cycleStart) : rolling;
}
