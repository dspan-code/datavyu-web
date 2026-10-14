/* 注意：本文件用 IIFE 包住。
 * 原因：index.html 用的是 classic <script>，所有脚本共享同一个全局词法作用域，
 * 两个文件里都写 `const api = ...` 会直接抛出 SyntaxError「Identifier 'api' has already been declared」，
 * 而且整个脚本会被静默丢弃（页面看起来只是「没反应」）。这个坑已经踩过一次，记在这里。
 * Node 端的 CommonJS 分支（module.exports）行为不变。
 */
(function () {
"use strict";

/* util.js —— 时间码 / 转义 / 杂项（三种转义规则各不相同，见逆向报告 §5.4） */

const CELL_TYPES = ["MATRIX", "TEXT", "NOMINAL"];

/* --------------------------------------------------------------- 时间码 */

// long 毫秒 -> hh:mm:ss:mmm（与 DatavyuCell.convertMStoTimestamp 一致）
function msToTimestamp(ms) {
  const neg = ms < 0;
  let v = Math.abs(Math.round(ms));
  const mmm = v % 1000;
  v = (v - mmm) / 1000;
  const ss = v % 60;
  v = (v - ss) / 60;
  const mm = v % 60;
  const hh = (v - mm) / 60;
  const p = (n, w = 2) => String(n).padStart(w, "0");
  return (neg ? "-" : "") + `${p(hh)}:${p(mm)}:${p(ss)}:${p(mmm, 3)}`;
}

// hh:mm:ss:mmm -> 毫秒。只有一段的字符串按纯毫秒处理（convertTimestampToMS）
function timestampToMs(s) {
  if (s === null || s === undefined) return 0;
  const t = String(s).trim();
  if (t === "") return 0;
  const neg = t.startsWith("-");
  const body = neg ? t.slice(1) : t;
  const parts = body.split(":");
  let ms;
  if (parts.length === 1) {
    ms = Number(parts[0]);
  } else if (parts.length === 4) {
    ms = Number(parts[0]) * 3600000 + Number(parts[1]) * 60000 + Number(parts[2]) * 1000 + Number(parts[3]);
  } else if (parts.length === 3) {
    // 宽容一点：允许 mm:ss:mmm
    ms = Number(parts[0]) * 60000 + Number(parts[1]) * 1000 + Number(parts[2]);
  } else if (parts.length === 2) {
    ms = Number(parts[0]) * 1000 + Number(parts[1]);
  } else {
    ms = NaN;
  }
  if (!Number.isFinite(ms)) return 0;
  return neg ? -ms : ms;
}

/* ----------------------------------------------------------------- 转义 */

// #4 的列名/子码名：\\ , - \n \r 前加反斜杠
const ESC_CSV_CHARS = "\\,-\n\r";
// #4 的 cell 值：\\ ( ) \n \r - , | 前加反斜杠
const ESC_ARG_CHARS = "\\()\n\r-,|";

// 两者共同：删除 \u0000-\u0001（escapeString 末尾的 replaceAll）
function stripControl(s) {
  return String(s).replace(/[\u0000-\u0001]/g, "");
}

function escapeWith(s, chars) {
  let out = "";
  for (const ch of stripControl(s)) {
    if (chars.includes(ch)) out += "\\";
    out += ch;
  }
  return out;
}

function unescapeWith(s, chars) {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\\" && i + 1 < s.length && chars.includes(s[i + 1])) {
      out += s[++i];
    } else if (s[i] === "\\" && i + 1 < s.length && (s[i + 1] === "\\" || s[i + 1] === "n" || s[i + 1] === "r")) {
      out += s[i + 1] === "n" ? "\n" : s[i + 1] === "r" ? "\r" : "\\";
      i++;
    } else {
      out += s[i];
    }
  }
  return out;
}

const escapeCSV = (s) => escapeWith(s, ESC_CSV_CHARS);
const unescapeCSV = (s) => unescapeWith(s, ESC_CSV_CHARS);
const escapeCSVArgument = (s) => escapeWith(s, ESC_ARG_CHARS);
const unescapeCSVArgument = (s) => unescapeWith(s, ESC_ARG_CHARS);
// CSV 值：双引号包裹，内部 " -> ""
const escapeCSVQuotes = (s) => `"${String(s).replace(/"/g, '""')}"`;

/* --------------------------------------------------------------- 其它 */

let _uidSeed = 0;
function uid(prefix = "id") {
  _uidSeed += 1;
  return `${prefix}_${Date.now().toString(36)}_${_uidSeed.toString(36)}`;
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

// 把秒或毫秒输入统一成毫秒
function toMs(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : 0;
}

const api = {
  CELL_TYPES,
  msToTimestamp,
  timestampToMs,
  escapeCSV,
  unescapeCSV,
  escapeCSVArgument,
  unescapeCSVArgument,
  escapeCSVQuotes,
  stripControl,
  uid,
  clamp,
  toMs,
};

if (typeof module !== "undefined" && module.exports) module.exports = api;
if (typeof globalThis !== "undefined") {
  globalThis.DVY = globalThis.DVY || {};
  globalThis.DVY.util = api;
}
})();
