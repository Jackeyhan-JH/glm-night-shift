// 队列与操作页（issue #15）：状态条（含 #38 的手动暂停/恢复按钮）、三个标签（排队中 /
// 运行中 / 历史）、每行取消/重试、新增任务表单（模板下拉 + 按模板动态生成变量输入 +
// 依赖多选）。#46：排队中的行多了「修改」，复用新增表单装进任务值、提交改走 PATCH。
// #50：状态条附近多了「从 GitHub 导入」「清理磁盘」两个入口（先预览后确认）与表格
// 上方的仓库筛选（浏览器内过滤，不发 repo 参数）。#62：成功任务的状态徽章旁边补一个
// PR 结果标签（已合并 / 已关闭，用 DOM textContent 画，不进 innerHTML）。DOM 与网络
// 都在这里，纯函数（分组、提示文本、表单转请求体、筛选、预览文案……）在 queue-lib.js。
//
// 每 5 秒轮询刷新；document.visibilityState 不是 visible 时暂停，切回来立即刷一次。
// 刷新只重绘状态条 / 标签 / 仓库筛选 / 表格 / 依赖下拉的选项，不重建表单其余输入、
// 也不动两个面板——正在填写的内容不会被轮询打断。所有异步都就地捕获，页面不会往
// 控制台抛未处理异常。
import { api, fmtTime, navHtml, statusLabel } from '/common.js';
import {
  REPO_FILTER_ALL,
  cleanupBody,
  cleanupDoneText,
  cleanupPreviewText,
  depHint,
  editBody,
  escapeHtml,
  filterTasksByRepo,
  firstLine,
  formModeView,
  formToBody,
  groupTasks,
  importBody,
  importDoneText,
  importPreviewText,
  pauseToggleView,
  prOutcomeLabel,
  repoFilterOptions,
  statusBarText,
  taskRowActions,
  taskToForm,
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
  repoFilter: document.getElementById('repo-filter'),
  form: document.getElementById('add-form'),
  heading: document.getElementById('form-heading'),
  submitBtn: document.getElementById('form-submit'),
  cancelEdit: document.getElementById('cancel-edit'),
  formError: document.getElementById('form-error'),
  repo: document.getElementById('f-repo'),
  templateSelect: document.getElementById('f-template'),
  templateVarsField: document.getElementById('template-vars-field'),
  templateVars: document.getElementById('template-vars'),
  promptRow: document.getElementById('prompt-row'),
  prompt: document.getElementById('f-prompt'),
  difficulty: document.getElementById('f-difficulty'),
  allowPeak: document.getElementById('f-allow-peak'),
  depends: document.getElementById('f-depends'),
  // #50：导入 / 清理两个面板（面板本身在 HTML 里只建一次）
  importToggle: document.getElementById('import-toggle'),
  importPanel: document.getElementById('import-panel'),
  importRepo: document.getElementById('i-repo'),
  importLabel: document.getElementById('i-label'),
  importDifficulty: document.getElementById('i-difficulty'),
  importPreview: document.getElementById('i-preview'),
  importConfirm: document.getElementById('i-confirm'),
  importCancel: document.getElementById('i-cancel'),
  importError: document.getElementById('import-error'),
  importResult: document.getElementById('import-result'),
  cleanupToggle: document.getElementById('cleanup-toggle'),
  cleanupPanel: document.getElementById('cleanup-panel'),
  cleanupPreview: document.getElementById('c-preview'),
  cleanupConfirm: document.getElementById('c-confirm'),
  cleanupCancel: document.getElementById('c-cancel'),
  cleanupResult: document.getElementById('cleanup-result'),
};

// 状态条 = 文本 span + 暂停/恢复按钮（#38）。按钮只建一次，轮询刷新只改文本与
// 文案——之前用 textContent 渲染整条状态条，会把按钮冲掉，不能再那么写。
const statusText = document.createElement('span');
const pauseToggle = document.createElement('button');
pauseToggle.type = 'button';
pauseToggle.id = 'pause-toggle';
els.statusbar.append(statusText, pauseToggle);

/** 页面状态：最近一次拉到的任务 / 模板 / 状态、当前标签与仓库筛选（#50）。 */
const state = {
  tasks: [],
  templates: [],
  status: null,
  activeTab: 'queued',
  repoFilter: REPO_FILTER_ALL,
};

/** 正在编辑的任务 id（#46）；null = 表单是「新增任务」模式。轮询刷新不重绘表单，
 * 填到一半的编辑不会被冲掉（与新增一致）。 */
let editingId = null;

// ---------------------------------------------------------------- 数据与渲染

/** 拉状态条与任务列表并重绘（表单与两个面板不动）。失败抛给调用方（轮询里静默吞掉）。 */
async function refresh() {
  const [status, tasks] = await Promise.all([
    api('/api/status'),
    api(`/api/tasks?limit=${TASKS_LIMIT}`),
  ]);
  state.status = status;
  state.tasks = Array.isArray(tasks) ? tasks : [];
  renderStatusBar();
  renderRepoFilter();
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

/**
 * 仓库筛选（#50）：选项 = 当前已拉到的任务里出现过的仓库 +「全部」。选中的仓库还
 * 在选项里时保持选中（轮询不重置）；不在了（任务翻出这一页）才回到「全部」。选项
 * 没变时只同步选中值，不重建 <option>——用户正展开着下拉时不被打断。
 */
function renderRepoFilter() {
  const options = repoFilterOptions(state.tasks);
  if (!options.includes(state.repoFilter)) state.repoFilter = REPO_FILTER_ALL;
  const current = [...els.repoFilter.options].map((o) => o.value);
  if (current.length !== options.length || current.some((v, i) => v !== options[i])) {
    els.repoFilter.innerHTML = options.map((repo) => {
      const label = repo === REPO_FILTER_ALL ? '全部' : repo;
      return `<option value="${escapeHtml(repo)}">${escapeHtml(label)}</option>`;
    }).join('');
  }
  els.repoFilter.value = state.repoFilter;
}

/** 仓库筛选后的任务（#50）：标签数量与表格行都基于这一份，三个标签都生效。 */
function visibleTasks() {
  return filterTasksByRepo(state.tasks, state.repoFilter);
}

function renderTabs() {
  const groups = groupTasks(visibleTasks());
  els.tabs.innerHTML = TABS.map(({ key, label }) => {
    const active = key === state.activeTab;
    return `<button type="button" role="tab" aria-selected="${active}" data-tab="${key}"` +
      ` class="tab${active ? ' active' : ''}">${label} <span class="tab-count">${groups[key].length}</span></button>`;
  }).join('');
}

function renderTable() {
  const groups = groupTasks(visibleTasks());
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
  appendPrOutcomeLabels(tasks);
}

/**
 * PR 结果标签（#62）：表格用 innerHTML 画完后，按行把「已合并 / 已关闭」补到状态
 * 单元格里（徽章旁边，不是新列）。文案用 createElement + textContent 设置——不进
 * 任何 innerHTML / 模板字符串；prOutcomeLabel 返回空串（open / 没查过 / 值不认识）
 * 的一行一个节点都不建（连空格也不加），行文本里不会出现这两个词。行序 = tasks 序。
 */
function appendPrOutcomeLabels(tasks) {
  const rows = els.table.querySelectorAll('tbody tr');
  tasks.forEach((task, i) => {
    const label = prOutcomeLabel(task);
    if (label === '') return; // 不建空 span，也不加空格
    const cell = rows[i]?.cells[1];
    if (cell === undefined) return; // 行与任务对不上时宁可不显示（正常不会发生）
    const span = document.createElement('span');
    span.className = 'pr-outcome';
    span.textContent = label;
    // 徽章是 inline-block 的胶囊，直接接文本会粘成「成功已合并」：先补一个空格文本节点。
    cell.append(document.createTextNode(' '), span);
  });
}

/** 一行任务：ID、状态徽章、难度、优先级、仓库、标题（进详情页）、创建时间、操作。 */
function rowHtml(task) {
  const action = taskRowActions(task); // 排队中：取消+修改；运行中：取消；历史：重试
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

/** 表格里的取消/重试/修改（事件委托；表格每 5 秒重绘，不能把监听挂在按钮上）。 */
async function onTableClick(event) {
  const button = event.target.closest('button[data-action]');
  if (button === null) return;
  const id = Number(button.dataset.id);
  if (button.dataset.action === 'edit') {
    enterEdit(id); // 修改不发请求：把任务值装进下面的表单，提交时才 PATCH
    return;
  }
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

// ---------------------------------------------------------------- 编辑排队中的任务（#46）

/**
 * 点排队中行的「修改」：把该任务的值装进现有新增表单（不另做第二个表单），表单切到
 * 编辑模式（标题/按钮文案由 renderFormMode 统一切换）。任务已不在排队中（轮询间隙
 * 被领取/取消）时不进编辑，页面错误条提示。
 */
function enterEdit(id) {
  const task = state.tasks.find((t) => t.id === id);
  if (task === undefined || task.status !== 'queued') {
    showPageError(`任务 #${id} 已不在排队中，不能修改`);
    return;
  }
  editingId = id;
  fillForm(taskToForm(task));
  renderFormMode();
  clearFormErrors();
}

/** 任务值 → 现有表单各输入（进入编辑模式）。先切回「不用模板」布局再填，否则
 * onTemplateChange 会用模板默认值覆盖难度。 */
function fillForm(form) {
  els.templateSelect.value = form.template;
  onTemplateChange();
  els.repo.value = form.repo;
  els.form.elements.title.value = form.title;
  els.prompt.value = form.prompt;
  els.difficulty.value = form.difficulty;
  els.form.elements.priority.value = form.priority;
  els.form.elements.testCommand.value = form.testCommand;
  els.allowPeak.checked = form.allowPeak;
  els.form.elements.maxAttempts.value = form.maxAttempts;
  // 依赖下拉先按最新列表重建选项，再选中该任务当前的依赖（已经 succeeded 的依赖
  // 不在选项里选不中，正好编辑提交也不发 dependsOn，见 queue-lib 的 editBody）。
  renderDependOptions();
  const selected = new Set(form.dependsOn);
  for (const option of els.depends.options) option.selected = selected.has(option.value);
}

/** 按编辑/新增模式切换表单文案：标题、提交按钮、「取消编辑」的显隐。编辑时仓库与
 * 模板锁住（都是创建后不能改的字段，只读展示，editBody 也不会把它们发出去）。 */
function renderFormMode() {
  const view = formModeView(editingId === null ? null : { id: editingId });
  els.heading.textContent = view.heading;
  els.submitBtn.textContent = view.submitLabel;
  els.cancelEdit.hidden = !view.cancelEditVisible;
  els.repo.readOnly = view.editing;
  els.templateSelect.disabled = view.editing;
}

/** 回到新增模式：清表单、恢复文案与可编辑性（保存成功或点「取消编辑」都会走到）。 */
function exitEdit() {
  editingId = null;
  resetForm();
  renderFormMode();
  clearFormErrors();
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
    if (editingId === null) {
      await api('/api/tasks', { method: 'POST', body: formToBody(collectForm()) });
    } else {
      // 编辑：PATCH 到该任务；editBody 不带 repo 等禁改字段（见 queue-lib.js）。
      await api(`/api/tasks/${editingId}`, { method: 'PATCH', body: editBody(collectForm()) });
    }
    exitEdit(); // 保存成功：表单回到「新增任务」（下次提交又是 POST）
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

// ---------------------------------------------------------------- 从 GitHub 导入（#50）

/** 导入面板的原始输入（值多为字符串；转请求体交给 queue-lib 的 importBody）。 */
function importFormValues() {
  return {
    repo: els.importRepo.value,
    label: els.importLabel.value,
    difficulty: els.importDifficulty.value,
  };
}

function showImportError(message) {
  els.importError.textContent = message;
  els.importError.hidden = false;
}

function hideImportError() {
  els.importError.hidden = true;
}

/** 预览（dry-run）：写出将新增 / 将跳过的数量；成功后才亮出「确认导入」。 */
async function onImportPreview(event) {
  event.preventDefault();
  hideImportError();
  const form = importFormValues();
  if (String(form.repo).trim() === '') {
    showImportError('仓库必填：owner/name');
    return;
  }
  els.importPreview.disabled = true;
  try {
    const result = await api('/api/import', { method: 'POST', body: importBody(form, true) });
    els.importResult.textContent = importPreviewText(result);
    els.importResult.hidden = false;
    els.importConfirm.hidden = false;
  } catch (err) {
    showImportError(err.message);
  } finally {
    els.importPreview.disabled = false;
  }
}

/** 确认导入（dry-run=false，同一 repo/label/difficulty）：完成后刷新表格。 */
async function onImportConfirm() {
  const form = importFormValues();
  els.importConfirm.disabled = true;
  try {
    const result = await api('/api/import', { method: 'POST', body: importBody(form, false) });
    els.importResult.textContent = importDoneText(result);
    els.importResult.hidden = false;
    els.importConfirm.hidden = true; // 要再导先重新预览（列表可能已变）
    hideImportError();
    hidePageError();
    await refresh(); // 新任务出现在排队表格里
  } catch (err) {
    showImportError(err.message);
  } finally {
    els.importConfirm.disabled = false;
  }
}

// ---------------------------------------------------------------- 清理磁盘（#50）

/** 预览（dry-run）：列出将删除的路径；成功后才亮出「确认删除」。 */
async function onCleanupPreview() {
  els.cleanupPreview.disabled = true;
  try {
    const result = await api('/api/cleanup', { method: 'POST', body: cleanupBody(true) });
    els.cleanupResult.textContent = cleanupPreviewText(result);
    els.cleanupResult.hidden = false;
    els.cleanupConfirm.hidden = false;
  } catch (err) {
    showPageError(err.message);
  } finally {
    els.cleanupPreview.disabled = false;
  }
}

/** 确认删除（dry-run=false）：failed 为 true 时其余已删、有的没删掉，走页面错误条。 */
async function onCleanupConfirm() {
  els.cleanupConfirm.disabled = true;
  try {
    const result = await api('/api/cleanup', { method: 'POST', body: cleanupBody(false) });
    if (result !== null && typeof result === 'object' && result.failed === true) {
      showPageError('有的没删掉，其余已经删了');
    } else {
      hidePageError();
    }
    els.cleanupResult.textContent = cleanupDoneText(result);
    els.cleanupResult.hidden = false;
    els.cleanupConfirm.hidden = true; // 要再删先重新预览
  } catch (err) {
    showPageError(err.message);
  } finally {
    els.cleanupConfirm.disabled = false;
  }
}

// ---------------------------------------------------------------- 启动

els.nav.innerHTML = navHtml('/');
els.templateSelect.addEventListener('change', onTemplateChange);
els.form.addEventListener('submit', onSubmit);
els.cancelEdit.addEventListener('click', exitEdit); // 放弃编辑：表单回到新增模式，不发请求
els.tabs.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-tab]');
  if (button === null) return;
  state.activeTab = button.dataset.tab;
  renderTabs();
  renderTable();
});
els.repoFilter.addEventListener('change', () => {
  state.repoFilter = els.repoFilter.value;
  renderTabs();
  renderTable();
});
els.table.addEventListener('click', (event) => {
  onTableClick(event).catch((err) => showPageError(err.message));
});
// #50：两个面板的开合与预览/确认。面板本身只建一次（HTML），轮询不重建。
els.importToggle.addEventListener('click', () => {
  els.importPanel.hidden = !els.importPanel.hidden;
});
els.importPanel.addEventListener('submit', (event) => {
  onImportPreview(event).catch((err) => showImportError(err.message));
});
els.importConfirm.addEventListener('click', () => {
  onImportConfirm().catch((err) => showImportError(err.message));
});
els.importCancel.addEventListener('click', () => {
  els.importPanel.hidden = true;
});
els.cleanupToggle.addEventListener('click', () => {
  els.cleanupPanel.hidden = !els.cleanupPanel.hidden;
});
els.cleanupPreview.addEventListener('click', () => {
  onCleanupPreview().catch((err) => showPageError(err.message));
});
els.cleanupConfirm.addEventListener('click', () => {
  onCleanupConfirm().catch((err) => showPageError(err.message));
});
els.cleanupCancel.addEventListener('click', () => {
  els.cleanupPanel.hidden = true;
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
