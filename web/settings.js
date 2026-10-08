// 设置页（#61）：打开先 GET /api/config 把当前值填进表单，保存时 PATCH 这七个键。
// 后端写盘后只在页面上提醒「重启后才生效」——不重启进程、不请求任何重启接口、
// 也不 import 调度器（配置只在进程启动时读一次，这是约定，不是热更新）。
// 纯函数与常量在 /settings-lib.js（node:test 可直接 import）；本文件只做 DOM 与请求。
import { api, navHtml } from '/common.js';
import { SAVE_OK_TEXT, buildPatch } from '/settings-lib.js';

const $ = (selector) => document.querySelector(selector);

/** 从表单控件收七个键的当前值（布尔取 checked，数字取输入文本，交给 buildPatch 转数字）。 */
function readForm() {
  return {
    allowPeak: $('#s-allow-peak').checked,
    concurrency: $('#s-concurrency').value,
    oneTaskPerRepo: $('#s-one-per-repo').checked,
    autoFollowReviews: $('#s-auto-follow').checked,
    followPollMinutes: $('#s-follow-poll').value,
    prStatus: $('#s-pr-status').checked,
    prStatusPollMinutes: $('#s-pr-poll').value,
  };
}

/** GET /api/config 的七个键填进表单（数字键转回文本）。 */
function fillForm(config) {
  $('#s-allow-peak').checked = config.allowPeak === true;
  $('#s-concurrency').value = String(config.concurrency);
  $('#s-one-per-repo').checked = config.oneTaskPerRepo === true;
  $('#s-auto-follow').checked = config.autoFollowReviews === true;
  $('#s-follow-poll').value = String(config.followPollMinutes);
  $('#s-pr-status').checked = config.prStatus === true;
  $('#s-pr-poll').value = String(config.prStatusPollMinutes);
}

function showError(err) {
  const el = $('#settings-error');
  el.textContent = `保存失败：${err instanceof Error ? err.message : String(err)}`;
  el.hidden = false;
}

function showSaved() {
  $('#settings-error').hidden = true;
  const el = $('#settings-saved');
  el.textContent = SAVE_OK_TEXT; // 整句原样写在页面上（可见，不是只打控制台）
}

async function load() {
  try {
    fillForm(await api('/api/config'));
    const el = $('#settings-error');
    el.hidden = true;
    el.textContent = '';
  } catch (err) {
    const el = $('#settings-error');
    el.textContent = `加载失败：${err instanceof Error ? err.message : String(err)}`;
    el.hidden = false;
  }
}

async function save(evt) {
  evt.preventDefault();
  $('#settings-saved').textContent = ''; // 失败时不留上一句成功提示
  try {
    await api('/api/config', { method: 'PATCH', body: buildPatch(readForm()) });
    showSaved();
  } catch (err) {
    showError(err); // 后端的 error 文本（含字段名与收到的值）
  }
}

$('#settings-form').addEventListener('submit', save);
$('#nav').innerHTML = navHtml('/settings.html');
load();
