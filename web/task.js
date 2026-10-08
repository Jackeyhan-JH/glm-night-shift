// 任务详情与实时日志页（issue #16）：task.html?id=<id>。
//
// 分两层：
// - 顶部导出的纯函数（runStatusLabel / kindLabel / …）不碰 DOM，node:test 可直接
//   import 单测（test/web-task.test.js）；
// - createPage() 装配整个页面。document / location / EventSource / 定时器全部从
//   options 注入（浏览器里缺省取全局对象），测试传桩实现即可驱动同一段代码。
//
// 安全约定（#16 规格）：除顶部导航（navHtml() 拼的静态串）这一处 innerHTML 外，
// 一切来自数据的文本只经 textContent / setAttribute 进 DOM，绝不用 innerHTML——
// prompt、日志里的 HTML 一律按文字显示，不可能被解析执行。
import {
  api,
  fmtDuration,
  fmtTime,
  fmtUnits,
  navHtml,
  statusLabel,
} from './common.js';
import {
  MAX_LOG_LINES,
  capLines,
  parseLogLine,
  simplifyLogText,
  splitLogText,
} from './log-lib.js';

/** 任务在 running 时刷新任务信息的间隔（毫秒）；日志的实时性由 SSE 负责。 */
const REFRESH_MS = 5000;
/** SSE 断开后重连的等待（毫秒）。浏览器 EventSource 自带重连，但我们主动关掉它
 * （服务器重连后会从头重放日志文件，直接让它重连会整页重复），改成自己清空重接。 */
const STREAM_RETRY_MS = 3000;
/** 判断「贴近底部」的余量（像素）：滚动位置离底部不超过它就算贴底，恢复自动滚动。 */
const NEAR_BOTTOM_PX = 40;

// ---------------------------------------------------------------- 纯展示函数

const RUN_STATUS_LABELS = {
  running: '执行中',
  succeeded: '成功',
  failed: '失败',
  timeout: '超时',
  canceled: '已取消',
};

/** 运行状态的中文标签（比任务的五状态多一个 timeout）；未知状态原样返回。 */
export function runStatusLabel(status) {
  return RUN_STATUS_LABELS[status] ?? status;
}

/**
 * 运行类型的中文标签（#12 的 runs.kind 列）：task → 执行、diagnosis → 诊断；
 * 没有 kind（旧数据）或为空 → null（页面上不显示该列内容）；其他值原样显示。
 */
export function kindLabel(kind) {
  if (kind === undefined || kind === null || kind === '') return null;
  if (kind === 'task') return '执行';
  if (kind === 'diagnosis') return '诊断';
  return String(kind);
}

/** 任务难度的中文标签；未知值原样返回。 */
export function difficultyLabel(difficulty) {
  const labels = { easy: '简单', medium: '中等', hard: '困难' };
  return labels[difficulty] ?? difficulty;
}

/** 错误全文的第一行（运行列表里错误列只放第一行；null/空 → ''）。 */
export function firstErrorLine(error) {
  if (error === null || error === undefined || error === '') return '';
  return String(error).split('\n')[0];
}

/**
 * ?id=<id> 查询串 → 任务 id；缺失 / 非正整数 → null（页面按「任务不存在」处理）。
 * @param {string} search location.search（含开头的 ? 也可以没有）
 */
export function parseTaskId(search) {
  const raw = new URLSearchParams(String(search ?? '')).get('id');
  if (raw === null || raw === '') return null;
  const id = Number(raw);
  return Number.isInteger(id) && id >= 1 ? id : null;
}

// ---------------------------------------------------------------- 页面装配

/**
 * 建任务详情页。浏览器里不传参（见文件末尾的自动引导）；测试传 doc / location /
 * EventSource / timers 桩。返回 page 对象：refs 暴露关键节点（测试断言用），
 * busy 是最近一次异步操作的 Promise（测试等待用）。
 * @param {object} [options]
 * @param {Document} [options.doc]
 * @param {{ search: string }} [options.location]
 * @param {typeof EventSource} [options.EventSource]
 * @param {object} [options.timers] { setInterval, clearInterval, setTimeout, clearTimeout }
 */
export function createPage(options = {}) {
  const doc = options.doc ?? globalThis.document;
  const where = options.location ?? globalThis.location;
  const EventSourceCtor = options.EventSource ?? globalThis.EventSource;
  const timers = options.timers ?? globalThis;
  if (doc === undefined || doc === null) throw new Error('createPage 需要 document');
  if (where === undefined || where === null) throw new Error('createPage 需要 location');

  const state = {
    id: parseTaskId(where.search),
    task: null,
    runs: [],
    selectedRunId: null,
    logMode: 'raw', // 'raw' 原始 | 'simple' 精简
    rawLines: [],   // 当前选中运行的原始日志行（页面上最多保留 MAX_LOG_LINES 行）
    lineEls: [],    // 与已渲染行对应的节点（精简模式下被隐藏的行没有节点）
    autoScroll: true,
    stream: null,   // 打开中的 EventSource（没有则 null）
    streamDone: false, // 收到过 done 事件（其后连接关闭触发的 error 要忽略）
    retryTimer: null,
    refreshTimer: null,
  };
  let loadSeq = 0; // 已结束运行日志的加载序号：切换运行后丢弃过期的响应

  // ---- 静态骨架（只建一次；refresh 只更新内容，不打断正在直播的日志区） ----
  doc.getElementById('nav').innerHTML = navHtml('/'); // 静态串，全页唯一一处 innerHTML
  const app = doc.getElementById('app');
  app.textContent = '';
  const root = doc.createElement('div');
  root.className = 'task-page';
  app.appendChild(root);

  // 任务信息卡
  const infoCard = doc.createElement('section');
  infoCard.className = 'card';
  const taskHead = doc.createElement('div');
  taskHead.className = 'task-head';
  const headTitle = doc.createElement('h2');
  const headBadge = doc.createElement('span');
  const actions = doc.createElement('div');
  actions.className = 'actions';
  const cancelBtn = doc.createElement('button');
  cancelBtn.textContent = '取消';
  const retryBtn = doc.createElement('button');
  retryBtn.textContent = '重试';
  const actionMsg = doc.createElement('span');
  actionMsg.className = 'action-msg';
  actions.appendChild(cancelBtn);
  actions.appendChild(retryBtn);
  actions.appendChild(actionMsg);
  taskHead.appendChild(headTitle);
  taskHead.appendChild(headBadge);
  taskHead.appendChild(actions);
  const fields = doc.createElement('dl');
  fields.className = 'fields';
  const promptFold = doc.createElement('details');
  promptFold.className = 'fold';
  const promptSummary = doc.createElement('summary');
  promptSummary.textContent = '提示词全文（点击展开 / 收起）';
  const promptBody = doc.createElement('pre');
  promptBody.className = 'prompt-body';
  promptFold.appendChild(promptSummary);
  promptFold.appendChild(promptBody);
  infoCard.appendChild(taskHead);
  infoCard.appendChild(fields);
  infoCard.appendChild(promptFold);

  // 运行列表卡
  const runsCard = doc.createElement('section');
  runsCard.className = 'card';
  const runsTitle = doc.createElement('h3');
  const runsTable = doc.createElement('table');
  runsTable.className = 'runs-table';
  const runsHead = doc.createElement('thead');
  const runsHeadRow = doc.createElement('tr');
  for (const name of ['尝试', '类型', '模型', '思考强度', '高峰', '状态', '开始时间', '耗时', '额度', '轮数', '错误']) {
    const th = doc.createElement('th');
    th.textContent = name;
    runsHeadRow.appendChild(th);
  }
  runsHead.appendChild(runsHeadRow);
  const runsTBody = doc.createElement('tbody');
  runsTable.appendChild(runsHead);
  runsTable.appendChild(runsTBody);
  runsCard.appendChild(runsTitle);
  runsCard.appendChild(runsTable);

  // 日志卡
  const logCard = doc.createElement('section');
  logCard.className = 'card';
  const logToolbar = doc.createElement('div');
  logToolbar.className = 'log-toolbar';
  const logLabel = doc.createElement('span');
  logLabel.className = 'log-label';
  const rawBtn = doc.createElement('button');
  rawBtn.textContent = '原始';
  rawBtn.className = 'primary'; // 缺省原始模式
  const simpleBtn = doc.createElement('button');
  simpleBtn.textContent = '精简';
  const rawLogLink = doc.createElement('a');
  rawLogLink.textContent = '原始日志';
  rawLogLink.setAttribute('target', '_blank');
  rawLogLink.setAttribute('rel', 'noopener noreferrer');
  const grow = doc.createElement('span');
  grow.className = 'grow';
  const jumpBtn = doc.createElement('button');
  jumpBtn.textContent = '回到底部';
  jumpBtn.style.display = 'none';
  logToolbar.appendChild(logLabel);
  logToolbar.appendChild(rawBtn);
  logToolbar.appendChild(simpleBtn);
  logToolbar.appendChild(rawLogLink);
  logToolbar.appendChild(grow);
  logToolbar.appendChild(jumpBtn);
  const logView = doc.createElement('div');
  logView.className = 'log-view';
  logView.textContent = '还没有运行记录';
  logCard.appendChild(logToolbar);
  logCard.appendChild(logView);

  root.appendChild(infoCard);
  root.appendChild(runsCard);
  root.appendChild(logCard);

  // ---- 事件 ----
  logView.addEventListener('scroll', () => {
    // 贴近底部 → 恢复自动滚动；被翻离底部（用户往上翻）→ 暂停并露出「回到底部」。
    const nearBottom = logView.scrollHeight - logView.scrollTop - logView.clientHeight <= NEAR_BOTTOM_PX;
    state.autoScroll = nearBottom;
    jumpBtn.style.display = nearBottom ? 'none' : '';
  });
  jumpBtn.addEventListener('click', () => {
    state.autoScroll = true;
    jumpBtn.style.display = 'none';
    logView.scrollTop = logView.scrollHeight;
  });
  rawBtn.addEventListener('click', () => { setLogMode('raw'); });
  simpleBtn.addEventListener('click', () => { setLogMode('simple'); });
  cancelBtn.addEventListener('click', () => {
    page.busy = runAction(cancelBtn, `/api/tasks/${state.id}/cancel`);
  });
  retryBtn.addEventListener('click', () => {
    page.busy = runAction(retryBtn, `/api/tasks/${state.id}/retry`);
  });

  // ---- 数据加载 ----

  /** 拉任务详情（含 runs）并重渲染；404 → 任务不存在页。 */
  async function doRefresh() {
    if (state.id === null) {
      renderNotFound(null);
      return;
    }
    let payload;
    try {
      payload = await api(`/api/tasks/${state.id}`);
    } catch (err) {
      closeStream();
      stopRefreshTimer();
      if (err.status === 404) renderNotFound(state.id);
      else renderFatal(err?.message ?? '加载失败');
      return;
    }
    state.task = payload;
    state.runs = Array.isArray(payload.runs) ? payload.runs : [];
    renderInfo();
    renderRuns();
    manageRefreshTimer();
    if (state.selectedRunId === null && state.runs.length > 0) {
      await selectRunInner(state.runs[0].id); // 默认选中最新一次（列表已按新到旧排序）
    } else {
      updateLogHeader(state.runs.find((r) => r.id === state.selectedRunId) ?? null);
    }
  }

  /**
   * 取消 / 重试：调对应 API（空 JSON 体——服务端的 POST 防护要求 JSON Content-Type），
   * 成功后整页刷新信息；失败把后端的 error 文本显示在按钮旁。
   */
  async function runAction(btn, path) {
    btn.disabled = true;
    actionMsg.textContent = '';
    try {
      await api(path, { method: 'POST', body: {} });
      await doRefresh();
    } catch (err) {
      actionMsg.textContent = err?.message ?? String(err);
    } finally {
      btn.disabled = false;
    }
  }

  /** 选中一次运行：清空日志区，运行中开 SSE 直播，已结束直接取日志全文。 */
  async function selectRunInner(runId) {
    closeStream();
    state.selectedRunId = runId;
    state.rawLines = [];
    state.lineEls = [];
    state.autoScroll = true;
    jumpBtn.style.display = 'none';
    logView.textContent = '';
    renderRuns(); // 只为了刷新选中行高亮
    const run = state.runs.find((r) => r.id === runId) ?? null;
    updateLogHeader(run);
    if (run === null) return;
    if (run.status === 'running') {
      openStream(run.id);
    } else {
      await loadFinishedLog(run.id);
    }
  }

  /** 已结束的运行：GET /api/runs/:id/log（纯文本），整段按行进日志区。 */
  async function loadFinishedLog(runId) {
    const seq = ++loadSeq;
    let text = null;
    try {
      const res = await fetch(`/api/runs/${runId}/log`);
      if (res.ok) text = await res.text();
    } catch {
      text = null; // 网络错误：按没有日志处理
    }
    if (seq !== loadSeq || state.selectedRunId !== runId) return; // 等待期间已切走
    if (text === null) {
      logView.textContent = '这次运行没有日志文件';
      return;
    }
    appendLines(splitLogText(text));
  }

  // ---- SSE 实时日志 ----

  function openStream(runId) {
    if (typeof EventSourceCtor !== 'function') return;
    state.streamDone = false;
    const es = new EventSourceCtor(`/api/runs/${runId}/stream`);
    state.stream = es;
    es.addEventListener('log', (ev) => {
      if (state.stream !== es) return;
      appendLines([String(ev.data ?? '')]);
    });
    es.addEventListener('done', () => {
      if (state.stream !== es) return;
      state.streamDone = true;
      closeStream(); // 收到 done：关闭连接……
      page.busy = doRefresh(); // ……并刷新任务信息（状态徽章 / 运行列）
    });
    es.addEventListener('error', () => {
      if (state.stream !== es || state.streamDone) return; // done 后的断开不算错误
      closeStream();
      scheduleStreamRetry(runId);
    });
  }

  function closeStream() {
    if (state.stream !== null) {
      try {
        state.stream.close();
      } catch {
        // 已关闭的连接再 close：忽略
      }
      state.stream = null;
    }
    if (state.retryTimer !== null) {
      timers.clearTimeout(state.retryTimer);
      state.retryTimer = null;
    }
  }

  /** 断线重连：先清空日志区再重开（服务器重连后会从头重放整个日志文件）。 */
  function scheduleStreamRetry(runId) {
    state.retryTimer = timers.setTimeout(() => {
      state.retryTimer = null;
      const run = state.runs.find((r) => r.id === runId);
      if (run !== undefined && run.status === 'running' && state.selectedRunId === runId) {
        state.rawLines = [];
        state.lineEls = [];
        logView.textContent = '';
        openStream(runId);
      }
    }, STREAM_RETRY_MS);
  }

  // ---- 日志区渲染 ----

  /** 追加若干行：先进缓冲、超过上限丢最旧的，再把幸存的新行渲染出来。 */
  function appendLines(lines) {
    if (lines.length === 0) return;
    const prev = state.rawLines.length;
    // 逐个 push 而不是 push(...lines)：已结束运行的日志是一次性取回的整段文本，
    // 行数可达十万级，spread 传参会撞引擎参数上限（RangeError），循环没有这个限制。
    for (const line of lines) state.rawLines.push(line);
    state.rawLines = capLines(state.rawLines, MAX_LOG_LINES);
    const dropped = prev + lines.length - state.rawLines.length;
    if (dropped > 0) {
      // 精简模式下隐藏的行没有节点，这里按「丢最旧的 N 个节点」近似——结果仍是
      // 最旧的行先消失、节点数不超过缓冲里的可见行数，与逐行对应无关紧要。
      const dropEls = Math.min(dropped, state.lineEls.length);
      for (let i = 0; i < dropEls; i++) state.lineEls[i].remove();
      state.lineEls.splice(0, dropEls);
    }
    const visible = dropped <= prev ? lines : lines.slice(dropped - prev);
    for (const line of visible) makeLineEl(line);
    stickToBottom();
  }

  /** 渲染一行；精简模式下要隐藏的行返回且不建节点。 */
  function makeLineEl(rawLine) {
    const { stream, text } = parseLogLine(rawLine);
    let shown = rawLine;
    if (state.logMode === 'simple') {
      const simplified = simplifyLogText(text);
      if (simplified === '') return null;
      shown = stream === null ? simplified : `[${stream}] ${simplified}`;
    }
    const el = doc.createElement('div');
    el.className = stream === null ? 'log-line log-plain' : `log-line log-${stream}`;
    el.textContent = shown;
    logView.appendChild(el);
    state.lineEls.push(el);
    return el;
  }

  /** 原始 / 精简切换：从缓冲重建整个日志区（缓冲已封顶，重建量有界）。 */
  function setLogMode(mode) {
    state.logMode = mode;
    rawBtn.className = mode === 'raw' ? 'primary' : '';
    simpleBtn.className = mode === 'simple' ? 'primary' : '';
    logView.textContent = '';
    state.lineEls = [];
    for (const line of state.rawLines) makeLineEl(line);
    stickToBottom();
  }

  function stickToBottom() {
    if (state.autoScroll) logView.scrollTop = logView.scrollHeight;
  }

  function updateLogHeader(run) {
    if (run === null) {
      logLabel.textContent = '日志';
      rawLogLink.style.display = 'none';
      return;
    }
    const kind = kindLabel(run.kind);
    const live = run.status === 'running' ? ' · 实时' : '';
    logLabel.textContent = `日志 · 运行 #${run.id} · 第 ${run.attempt} 次`
      + `${kind === null ? '' : ` · ${kind}`} · ${runStatusLabel(run.status)}${live}`;
    rawLogLink.setAttribute('href', `/api/runs/${run.id}/log`);
    rawLogLink.style.display = '';
  }

  // ---- 任务信息 / 运行列表渲染 ----

  function renderInfo() {
    const task = state.task;
    doc.title = `任务 #${task.id} · ${task.title}`;
    headTitle.textContent = `任务 #${task.id}：${task.title}`;
    headBadge.className = `badge badge-${task.status}`;
    headBadge.textContent = statusLabel(task.status);
    cancelBtn.style.display = task.status === 'queued' || task.status === 'running' ? '' : 'none';
    retryBtn.style.display = task.status === 'failed' || task.status === 'canceled' ? '' : 'none';

    fields.textContent = '';
    const addText = (label, value) => {
      const dt = doc.createElement('dt');
      dt.textContent = label;
      const dd = doc.createElement('dd');
      dd.textContent = value;
      fields.appendChild(dt);
      fields.appendChild(dd);
    };
    addText('仓库', task.repo);
    addText('难度', difficultyLabel(task.difficulty));
    addText('优先级', String(task.priority));
    addText('允许高峰', task.allowPeak ? '是' : '否');
    addText('尝试次数', `${task.attempts}/${task.maxAttempts}`);
    addText('测试命令', task.testCommand ?? '-');
    addText('创建时间', fmtTime(task.createdAt));
    addText('开始时间', fmtTime(task.startedAt));
    addText('结束时间', fmtTime(task.finishedAt));
    addText('分支', task.branch ?? '-');
    // PR 链接：prUrl 是库里的数据，只把 http(s) 地址放进 href——javascript: 之类
    // 的伪协议挂到 <a href> 上点一下就执行，和 innerHTML 是同一类注入面。
    const safePrUrl = typeof task.prUrl === 'string' && /^https?:\/\//i.test(task.prUrl)
      ? task.prUrl : null;
    if (safePrUrl !== null) {
      const dt = doc.createElement('dt');
      dt.textContent = 'PR';
      const dd = doc.createElement('dd');
      const link = doc.createElement('a');
      link.setAttribute('href', safePrUrl);
      link.setAttribute('target', '_blank'); // 新标签页打开
      link.setAttribute('rel', 'noopener noreferrer');
      link.textContent = safePrUrl;
      dd.appendChild(link);
      fields.appendChild(dt);
      fields.appendChild(dd);
    } else {
      addText('PR', task.prUrl === null || task.prUrl === undefined || task.prUrl === ''
        ? '-' : task.prUrl); // 非 http(s) 的值不做成链接，按文本原样显示
    }
    if (Array.isArray(task.dependsOn) && task.dependsOn.length > 0) {
      const dt = doc.createElement('dt');
      dt.textContent = '依赖';
      const dd = doc.createElement('dd');
      dd.className = 'dep-links';
      for (const depId of task.dependsOn) {
        const link = doc.createElement('a');
        link.setAttribute('href', `/task.html?id=${depId}`);
        link.textContent = `#${depId}`;
        dd.appendChild(link);
      }
      fields.appendChild(dt);
      fields.appendChild(dd);
    }
    if (typeof task.lastError === 'string' && task.lastError !== '') {
      const dt = doc.createElement('dt');
      dt.textContent = '最近错误';
      const dd = doc.createElement('dd');
      dd.className = 'last-error';
      dd.textContent = task.lastError; // 多行原样显示（CSS pre-wrap 保留换行）
      fields.appendChild(dt);
      fields.appendChild(dd);
    }
    promptBody.textContent = task.prompt; // 按文本插入，换行由 pre 保留
  }

  function renderRuns() {
    runsTitle.textContent = `运行记录（${state.runs.length} 次）`;
    runsTBody.textContent = '';
    if (state.runs.length === 0) {
      const tr = doc.createElement('tr');
      const td = doc.createElement('td');
      td.setAttribute('colspan', '11');
      td.className = 'muted';
      td.textContent = '还没有运行记录';
      tr.appendChild(td);
      runsTBody.appendChild(tr);
      return;
    }
    for (const run of state.runs) {
      const tr = doc.createElement('tr');
      tr.className = run.id === state.selectedRunId ? 'run-row selected' : 'run-row';
      tr.addEventListener('click', () => {
        page.busy = selectRunInner(run.id);
      });
      const cells = [
        String(run.attempt),
        kindLabel(run.kind) ?? '',
        run.model,
        run.effort,
        run.peak ? '是' : '否',
        null, // 状态徽章占位
        fmtTime(run.startedAt),
        fmtDuration(run.durationMs),
        fmtUnits(run.quotaUnits),
        run.numTurns === null || run.numTurns === undefined ? '-' : String(run.numTurns),
        firstErrorLine(run.error),
      ];
      for (const [i, cell] of cells.entries()) {
        const td = doc.createElement('td');
        if (cell === null) {
          const badge = doc.createElement('span');
          badge.className = `badge badge-${run.status}`;
          badge.textContent = runStatusLabel(run.status);
          td.appendChild(badge);
        } else {
          td.textContent = cell;
          if (i === cells.length - 1) td.className = 'error-col'; // 错误第一行超宽省略
        }
        tr.appendChild(td);
      }
      runsTBody.appendChild(tr);
      if (typeof run.diagnosis === 'string' && run.diagnosis !== '') {
        // 诊断全文：可展开（<details> 原生折叠，不需要 JS）
        const diagTr = doc.createElement('tr');
        diagTr.className = 'diag-row';
        const td = doc.createElement('td');
        td.setAttribute('colspan', '11');
        const fold = doc.createElement('details');
        fold.className = 'fold';
        const summary = doc.createElement('summary');
        summary.textContent = '诊断（点击展开 / 收起）';
        const body = doc.createElement('pre');
        body.className = 'diag-body';
        body.textContent = run.diagnosis;
        fold.appendChild(summary);
        fold.appendChild(body);
        td.appendChild(fold);
        diagTr.appendChild(td);
        runsTBody.appendChild(diagTr);
      }
    }
  }

  // ---- 整页状态 ----

  function renderNotFound(id) {
    root.textContent = '';
    const box = doc.createElement('div');
    box.className = 'notfound';
    const p = doc.createElement('p');
    p.textContent = id === null ? '任务不存在（地址里没有有效的 id）' : `任务 #${id} 不存在`;
    const back = doc.createElement('a');
    back.setAttribute('href', '/');
    back.textContent = '返回首页';
    box.appendChild(p);
    box.appendChild(back);
    root.appendChild(box);
  }

  function renderFatal(message) {
    root.textContent = '';
    const box = doc.createElement('div');
    box.className = 'card';
    const p = doc.createElement('p');
    p.className = 'error';
    p.textContent = `加载任务失败：${message}`;
    const back = doc.createElement('p');
    const link = doc.createElement('a');
    link.setAttribute('href', '/');
    link.textContent = '返回首页';
    back.appendChild(link);
    box.appendChild(p);
    box.appendChild(back);
    root.appendChild(box);
  }

  /** running 时每 5 秒刷新任务信息（日志由 SSE 负责）；离开 running 停掉定时器。 */
  function manageRefreshTimer() {
    const running = state.task !== null && state.task.status === 'running';
    if (running && state.refreshTimer === null) {
      state.refreshTimer = timers.setInterval(() => {
        page.busy = doRefresh();
      }, REFRESH_MS);
    } else if (!running && state.refreshTimer !== null) {
      timers.clearInterval(state.refreshTimer);
      state.refreshTimer = null;
    }
  }

  function stopRefreshTimer() {
    if (state.refreshTimer !== null) {
      timers.clearInterval(state.refreshTimer);
      state.refreshTimer = null;
    }
  }

  const page = {
    /** 关键节点，测试断言用；页面逻辑不该依赖从这里读。 */
    refs: {
      root, app, fields, promptFold, promptBody, cancelBtn, retryBtn, actionMsg,
      runsTBody, logLabel, logView, rawBtn, simpleBtn, rawLogLink, jumpBtn, headBadge,
    },
    /** 最近一次异步操作（refresh / 选运行 / 取消重试）的 Promise，测试等待用。 */
    busy: null,
    get id() { return state.id; },
    get selectedRunId() { return state.selectedRunId; },
    get logMode() { return state.logMode; },
    /** 渲染导航并拉第一屏数据。 */
    init() {
      page.busy = doRefresh();
      return page;
    },
    refresh() {
      page.busy = doRefresh();
      return page.busy;
    },
    selectRun(runId) {
      page.busy = selectRunInner(runId);
      return page.busy;
    },
    setLogMode,
    /** 关掉 SSE / 定时器（测试收尾用；浏览器里页面卸载时连接自然断）。 */
    destroy() {
      closeStream();
      stopRefreshTimer();
    },
  };
  return page;
}

// 浏览器里自动引导；node:test import 本模块时没有 document / location，不会执行。
if (globalThis.document !== undefined && globalThis.location !== undefined) {
  createPage().init();
}
