'use strict';

/**
 * active-window.js —— 活跃时间窗口校验（唯一的时间节奏控制）。
 *
 * 规则：
 *   - start/end 均为 "HH:mm" 格式；均缺省（空）视为「全天」= 永不拦截。
 *   - 支持跨零点（如 23:00 ~ 07:00，end < start 即视为跨天）。
 *   - 跨度硬限制 MAX_ACTIVE_SPAN_HOURS = 16 小时，超限视为非法配置（UI 拒绝保存 + 加载时校验）。
 *   - 窗口外仅拦截「领取新任务」(/api/next)，进行中的任务允许完成。
 */

const config = require('./config');

const SPAN_FRAG_RE = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

function toMinutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

/** 计算窗口跨度（小时）；跨零点时 end < start 会 +24h。返回 -1 表示格式非法。 */
function spanHours(start, end) {
  if (!SPAN_FRAG_RE.test(start) || !SPAN_FRAG_RE.test(end)) return -1;
  const s = toMinutes(start);
  const e = toMinutes(end);
  let span = e - s;
  if (span <= 0) span += 24 * 60; // 跨零点或恰好相等视为跨天
  return span / 60;
}

/**
 * 校验活跃窗口合法性。
 * @returns {{ok:boolean, reason?:string, spanHours?:number}}
 */
function validateWindow(start, end) {
  const s = String(start || '').trim();
  const e = String(end || '').trim();
  if (s === '' && e === '') return { ok: true, spanHours: 0 }; // 全天
  if (s === '' || e === '') {
    return { ok: false, reason: '开始时间和结束时间必须同时填写或同时留空（留空 = 全天不限制）' };
  }
  if (!SPAN_FRAG_RE.test(s) || !SPAN_FRAG_RE.test(e)) {
    return { ok: false, reason: '时间格式必须为 HH:mm（24 小时制）' };
  }
  const span = spanHours(s, e);
  if (span > config.maxActiveSpanHours) {
    return { ok: false, reason: `活跃窗口跨度超过 ${config.maxActiveSpanHours} 小时上限`, spanHours: span };
  }
  return { ok: true, spanHours: span };
}

/**
 * 判断当前时刻是否处于活跃窗口内。
 * @param {string} start HH:mm 或空
 * @param {string} end   HH:mm 或空
 * @param {Date} now 参考时间（缺省为当前时间，使用容器 TZ）
 */
function isWithinWindow(start, end, now = new Date()) {
  const s = String(start || '').trim();
  const e = String(end || '').trim();
  if (s === '' && e === '') return true;
  if (!SPAN_FRAG_RE.test(s) || !SPAN_FRAG_RE.test(e)) return false; // 非法视为窗口外（保守拦截）

  const current = now.getHours() * 60 + now.getMinutes();
  const startMin = toMinutes(s);
  const endMin = toMinutes(e);

  if (startMin === endMin) return false; // 跨天但零点时长，视为永不在窗口
  if (startMin < endMin) {
    // 同一天区间
    return current >= startMin && current < endMin;
  }
  // 跨零点区间
  return current >= startMin || current < endMin;
}

module.exports = {
  validateWindow,
  isWithinWindow,
  spanHours,
};
