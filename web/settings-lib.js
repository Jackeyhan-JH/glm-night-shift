// 设置页（#61）的纯函数模块：不碰 DOM、不碰 fetch，node:test 能直接 import
// （见 test/settings.test.js）。SAVE_OK_TEXT 是保存成功后页面必须原样显示的那句提醒。
// 后端读写的也只是这七个键（src/config.js 的 SETTINGS_KEYS 同一份清单）。

/** 保存成功后写在页面上的整句（配置只在进程启动时读一次，正在跑的要重启才生效）。 */
export const SAVE_OK_TEXT = '已写入配置。正在运行的看板要重启后才按新值运行。';

/** 页面可编辑的七个键（与 GET / PATCH /api/config 的字段一一对应）。 */
export const SETTINGS_FIELDS = Object.freeze([
  'allowPeak',
  'concurrency',
  'oneTaskPerRepo',
  'autoFollowReviews',
  'followPollMinutes',
  'prStatus',
  'prStatusPollMinutes',
]);

/**
 * 表单当前值 → PATCH /api/config 的请求体（只带这七个键，不多带）。
 * 布尔键取 true/false；数字键把输入文本转 Number（空串 / 非法文本得 0 或 NaN，
 * 后端会 400 点名字段并把文本带回页面——不在前端另写一套校验规则）。
 * @param {object} form 七个键的表单当前值：布尔键为 boolean，数字键为 string。
 * @returns {object} 七个键的请求体（数字键为 number 或 NaN）。
 */
export function buildPatch(form) {
  return {
    allowPeak: form.allowPeak === true,
    concurrency: Number(form.concurrency),
    oneTaskPerRepo: form.oneTaskPerRepo === true,
    autoFollowReviews: form.autoFollowReviews === true,
    followPollMinutes: Number(form.followPollMinutes),
    prStatus: form.prStatus === true,
    prStatusPollMinutes: Number(form.prStatusPollMinutes),
  };
}
