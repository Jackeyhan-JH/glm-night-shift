// 队列与操作页（issue #15）：状态条（含 #38 的手动暂停/恢复按钮）、三个标签（排队中 /
// 运行中 / 历史）、每行取消/重试、新增任务表单（模板下拉 + 按模板动态生成变量输入 +
// 依赖多选）。DOM 与网络都在这里，纯函数（分组、提示文本、表单转请求体……）在 queue-lib.js。
//
// 每 5 秒轮询刷新；document.visibilityState 不是 visible 时暂停，切回来立即刷一次。
// 刷新只重绘状态条 / 标签 / 表格 / 依赖下拉的选项，不重建表单其余输入——正在填写的
// 内容不会被轮询打断。所有异步都就地捕获，页面不会往控制台抛未处理异常。
import { api, fmtTime, navHtml, statusLabel } from '/common.js';
import {
  depHint,
  escapeHtml,
  firstLine,
  formToBody,
  groupTasks,
  pauseToggleView,
  statusBarText,
} from '/queue-lib.js';

/** 轮询间隔（issue 规格：5 秒）。 */
const POLL_MS = 5000;
/** 一次拉全部任务再在客户端分组（/api/tasks 默认 limit=100 不够历史标签用）。 */
const TASKS_LIMIT = 1000;

/** 三个标签的顺序与文案；key 与 groupTasks 的返回键一致。 */
const TABS = [
  { key: 'queued', label: '排队中' },
  { key: 'running', label: '运行中' },
  { key: 'history', label: '历史' },
];

const TABLE_COLUMNS = ['ID', '状态', '难度', '优先级', '仓库', '标题', '创建时间', '操作'];

const els = {
  nav: document.getElementById('nav'),
  pageError: document.getElementById('page-error'),
  statusbar: document.getElementById('statusbar'),
  tabs: document.getElementById('tabs'),
  table: document.getElementById('task-table'),
  form: document.getElementById('add-form'),
  formError: document.getElementById('form-error'),
  templateSelect: document.getElementById('f-template'),
  templateVarsField: document.getElementById('template-vars-field'),
  templateVars: document.getElementById('template-vars'),
  promptRow: document.getElementById('prompt-row'),
  prompt: document.getElementById('f-prompt'),
  difficulty: document.getElementById('f-difficulty'),
  allowPeak: document.getElementById('f-allow-peak'),
  depends: document.getElementById('f-depends'),
};

// 状态条 = 文本 span + 暂停/恢复按钮（#38）。按钮只建一次，轮询刷新只改文本与
// 文案——之前用 textContent 渲染整条状态条，会把按钮冲掉，不能再那么写。
const statusText = document.createElement('span');
const pauseToggle = document.createElement('button');
pauseToggle.type = 'button';
pauseToggle.id = 'pause-toggle';
els.statusbar.append(statusText, pauseToggle);

/** 页面状态：最近一次拉到的任务 / 模板 / 状态与当前标签。 */
const state = { tasks: [], templates: [], status: null, activeTab: 'queued' };

// ---------------------------------------------------------------- 数据与渲染

/** 拉状态条与任务列表并重绘（表单不动）。失败抛给调用方（轮询里静默吞掉）。 */
async function refresh() {
  const [status, tasks] = await Promise.all([
    api('/api/status'),
    api(`/api/tasks?limit=${TASKS_LIMIT}`),
  ]);
  state.status = status;
  state.tasks = Array.isArray(tasks) ? tasks : [];
  renderStatusBar();
  renderTabs();
  renderTable();
  renderDependOptions();
}

function renderStatusBar() {
  const view = pauseToggleView(state.status);
  const text = statusBarText(state.status);
  statusText.textContent = view.pausedText === '' ? text : `${text} · ${view.pausedText}`;
  pauseToggle.textContent = view.buttonLabel;
}

function renderTabs() {
  const groups = groupTasks(state.tasks);
  els.tabs.innerHTML = TABS.map(({ key, label }) => {
    const active = key === state.activeTab;
    return `<button type="button" role="tab" aria-selected="${active}" data-tab="${key}"` +
      ` class="tab${active ? ' active' : ''}">${label} <span class="tab-count">${groups[key].length}</span></button>`;
  }).join('');
}

function renderTable() {
  const groups = groupTasks(state.tasks);
  const tasks = groups[state.activeTab] ?? [];
  if (tasks.length === 0) {
    els.table.innerHTML = '<div class="card empty-hint">这个标签下还没有任务</div>';
    return;
  }
  const head = TABLE_COLUMNS
    .map((c) => `<th${c === '优先级' ? ' class="num"' : ''}>${c}</th>`)
    .join('');
  els.table.innerHTML = `<div class="table-card"><table>` +
    `<thead><tr>${head}</tr></thead><tbody>${tasks.map(rowHtml).join('')}</tbody></table></div>`;
}

/** 一行任务：ID、状态徽章、难度、优先级、仓库、标题（进详情页）、创建时间、操作。 */
function rowHtml(task) {
  const action = task.status === 'queued' || task.status === 'running'
    ? `<button type="button" class="row-action" data-action="cancel" data-id="${task.id}">取消</button>`
    : `<button type="button" class="row-action" data-action="retry" data-id="${task.id}">重试</button>`;
  return `<tr>` +
    `<td>#${task.id}</td>` +
    `<td><span class="badge badge-${escapeHtml(task.status)}">${statusLabel(task.status)}</span></td>` +
    `<td>${escapeHtml(task.difficulty ?? '-')}</td>` +
    `<td class="num">${task.priority ?? 0}</td>` +
    `<td>${escapeHtml(task.repo)}</td>` +
    `<td><a href="/task.html?id=${task.id}">${escapeHtml(task.title)}</a>${subLineHtml(task)}</td>` +
    `<td>${fmtTime(task.createdAt)}</td>` +
    `<td>${action}</td>` +
    `</tr>`;
}

/** 标题下的补充行：排队中且依赖未完成 → 「等 #1 #2」；成功 → PR 链接；
 * 失败/取消 → lastError 第一行（title 属性放全文，悬停可看）。 */
function subLineHtml(task) {
  if (task.status === 'queued') {
    const hint = depHint(task.blockedBy);
    return hint === '' ? '' : `<div class="task-sub">${escapeHtml(hint)}</div>`;
  }
  if (task.status === 'succeeded' && task.prUrl) {
    return `<div class="task-sub"><a href="${escapeHtml(task.prUrl)}" target="_blank" rel="noopener">PR 链接</a></div>`;
  }
  if ((task.status === 'failed' || task.status === 'canceled') && task.lastError) {
    return `<div class="task-sub error-text" title="${escapeHtml(task.lastError)}">` +
      `${escapeHtml(firstLine(task.lastError))}</div>`;
  }
  return '';
}

/** 依赖多选的选项 = 当前排队中/运行中的任务；重绘保留已选中的项。 */
function renderDependOptions() {
  const groups = groupTasks(state.tasks);
  const options = [...groups.queued, ...groups.running];
  const selected = new Set([...els.depends.selectedOptions].map((o) => o.value));
  els.depends.innerHTML = options
    .map((t) => `<option value="${t.id}"${selected.has(String(t.id)) ? ' selected' : ''}>` +
      `#${t.id} ${escapeHtml(t.title)}</option>`)
    .join('');
}

// ---------------------------------------------------------------- 行内操作

/** 表格里的取消/重试（事件委托；表格每 5 秒重绘，不能把监听挂在按钮上）。 */
async function onTableClick(event) {
  const button = event.target.closest('button[data-action]');
  if (button === null) return;
  const id = Number(button.dataset.id);
  if (button.dataset.action === 'cancel'
      && !window.confirm(`确定取消任务 #${id}？运行中的任务会被中止。`)) {
    return;
  }
  button.disabled = true;
  try {
    // body:{} 只为带上 Content-Type: application/json（服务端对所有 POST 都要求它）。
    await api(`/api/tasks/${id}/${button.dataset.action}`, { method: 'POST', body: {} });
    hidePageError();
    await refresh();
  } catch (err) {
    showPageError(err.message);
  } finally {
    button.disabled = false; // refresh 已重绘时这句落在旧节点上，无害
  }
}

function showPageError(message) {
  els.pageError.textContent = `操作失败：${message}`;
  els.pageError.hidden = false;
}

function hidePageError() {
  els.pageError.hidden = true;
}

// ---------------------------------------------------------------- 手动暂停/恢复（#38）

/** 状态条按钮：按当前状态发 pause / resume，成功后刷新状态条；失败走页面错误条。 */
async function onPauseToggleClick() {
  const { paused } = pauseToggleView(state.status);
  pauseToggle.disabled = true;
  try {
    // body:{} 只为带上 Content-Type: application/json（服务端对所有 POST 都要求它）。
    await api(`/api/scheduler/${paused ? 'resume' : 'pause'}`, { method: 'POST', body: {} });
    hidePageError();
    await refresh();
  } catch (err) {
    showPageError(err.message);
  } finally {
    pauseToggle.disabled = false;
  }
}

// ---------------------------------------------------------------- 新增任务表单

/** 拉模板列表并填进下拉（「不用模板」在 HTML 里，追加在后面）。 */
async function loadTemplates() {
  const templates = await api('/api/templates');
  state.templates = Array.isArray(templates) ? templates : [];
  els.templateSelect.innerHTML = '<option value="">不用模板</option>' +
    state.templates.map((t) => `<option value="${escapeHtml(t.name)}">` +
      `${escapeHtml(t.name)}${t.description ? `：${escapeHtml(t.description)}` : ''}</option>`).join('');
}

/** 模板下拉变化：切换变量输入区 / 提示词框，难度默认取模板的（没写按 medium）。 */
function onTemplateChange() {
  const name = els.templateSelect.value;
  const template = name === ''
    ? null
    : (state.templates.find((t) => t.name === name) ?? null);
  renderVarsInputs(template);
  els.difficulty.value = template?.difficulty ?? 'medium';
  const usingTemplate = template !== null;
  els.templateVarsField.hidden = !usingTemplate;
  els.promptRow.hidden = usingTemplate;
  els.prompt.required = !usingTemplate;
  if (usingTemplate) els.prompt.value = ''; // 隐藏的提示词不参与提交，清掉避免误会
}

/** 按模板的 vars 声明生成输入框：必填的标 *，有默认值的预填。 */
function renderVarsInputs(template) {
  if (template === null) {
    els.templateVars.innerHTML = '';
    return;
  }
  els.templateVars.innerHTML = template.vars.map(({ name, required, default: def }) =>
    `<label class="field">` +
    `<span class="field-label">${escapeHtml(name)}${required ? ' <b class="req">*</b>' : ''}</span>` +
    `<input name="var-${escapeHtml(name)}" data-var-name="${escapeHtml(name)}"` +
    `${required ? ' required' : ''} value="${escapeHtml(def ?? '')}">` +
    `</label>`).join('');
}

/** 从 DOM 收集表单原始数据（值多为字符串；交给 queue-lib 的 formToBody 规整成请求体）。 */
function collectForm() {
  const vars = {};
  for (const input of els.templateVars.querySelectorAll('input[data-var-name]')) {
    vars[input.dataset.varName] = input.value;
  }
  const valueOf = (name) => els.form.elements[name]?.value ?? '';
  return {
    repo: valueOf('repo'),
    template: els.templateSelect.value,
    vars,
    prompt: els.prompt.value,
    title: valueOf('title'),
    difficulty: els.difficulty.value,
    priority: valueOf('priority'),
    testCommand: valueOf('testCommand'),
    allowPeak: els.allowPeak.checked,
    maxAttempts: valueOf('maxAttempts'),
    dependsOn: [...els.depends.selectedOptions].map((o) => o.value),
  };
}

async function onSubmit(event) {
  event.preventDefault();
  clearFormErrors();
  if (!els.form.checkValidity()) {
    els.form.reportValidity(); // 浏览器原生的必填提示（仓库/提示词/必填变量）
    return;
  }
  try {
    await api('/api/tasks', { method: 'POST', body: formToBody(collectForm()) });
    resetForm();
    hideFormError();
    hidePageError();
    await refresh();
  } catch (err) {
    // 有 field 的错误显示在对应字段旁；没有对应字段（或无 field）落在表单底部的错误条。
    if (!showFieldError(err.field, err.message)) showFormError(err.message);
  }
}

/** 提交成功后清空表单：回到「不用模板」布局、依赖选项按最新列表重建。 */
function resetForm() {
  els.form.reset();
  onTemplateChange(); // 下拉回到「不用模板」：清变量区、显示提示词框、难度回 medium
  renderDependOptions();
}

/** 错误文案显示到 data-error-for 与 field 同名的元素旁；没有对应字段返回 false。 */
function showFieldError(field, message) {
  if (typeof field !== 'string' || field === '') return false;
  for (const el of els.form.querySelectorAll('[data-error-for]')) {
    if (el.dataset.errorFor === field) {
      el.textContent = message;
      el.hidden = false;
      return true;
    }
  }
  return false;
}

function clearFormErrors() {
  for (const el of els.form.querySelectorAll('[data-error-for]')) {
    el.hidden = true;
    el.textContent = '';
  }
  hideFormError();
}

function showFormError(message) {
  els.formError.textContent = message;
  els.formError.hidden = false;
}

function hideFormError() {
  els.formError.hidden = true;
}

// ---------------------------------------------------------------- 启动

els.nav.innerHTML = navHtml('/');
els.templateSelect.addEventListener('change', onTemplateChange);
els.form.addEventListener('submit', onSubmit);
els.tabs.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-tab]');
  if (button === null) return;
  state.activeTab = button.dataset.tab;
  renderTabs();
  renderTable();
});
els.table.addEventListener('click', (event) => {
  onTableClick(event).catch((err) => showPageError(err.message));
});
pauseToggle.addEventListener('click', () => {
  onPauseToggleClick().catch((err) => showPageError(err.message));
});
// 切回页面立即刷新；隐藏期间跳过轮询（visibilitychange 与 interval 双保险）。
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') refresh().catch(() => {});
});
setInterval(() => {
  // 轮询失败不打扰（下一轮会重试）；首次加载的失败才显示出来。
  if (document.visibilityState === 'visible') refresh().catch(() => {});
}, POLL_MS);

loadTemplates().catch((err) => showFormError(err.message));
refresh().catch((err) => showPageError(err.message));
