/* 注意：本文件用 IIFE 包住。
 * 原因：index.html 用的是 classic <script>，所有脚本共享同一个全局词法作用域，
 * 两个文件里都写 `const api = ...` 会直接抛出 SyntaxError「Identifier 'api' has already been declared」，
 * 而且整个脚本会被静默丢弃（页面看起来只是「没反应」）。这个坑已经踩过一次，记在这里。
 * Node 端的 CommonJS 分支（module.exports）行为不变。
 */
(function () {
"use strict";

/* db4.js —— Datavyu 的 "#4" 数据库文本格式（.opf 里的 db 条目 / 导出的 CSV 共用）
 *
 * 格式（逆向报告 §5.3，逐条对齐 org.datavyu.models.db 的 exportAsCSV/saveAsCSV）：
 *
 *   #4
 *   <列名> (TEXT,true,)
 *   hh:mm:ss:mmm,hh:mm:ss:mmm,<serialize 后的值>
 *   ...
 *   gesture (MATRIX,true,)-code01|NOMINAL,code02|TEXT
 *   00:00:01:000,00:00:02:000,(look,at\, me)
 *
 * 三个必须记住的坑：
 *   1. <visible> 是 !isHidden()，true = 可见
 *   2. 列头必须「从右往左」匹配，因为列名本身可能含 " ("（( 不在 escapeCSV 的转义集里）
 *   3. 矩阵列的 cell 值序列化成 (子值,子值)，逗号是分隔符但值里的逗号会写成 \,
 */

const U = (() => {
  if (typeof require === "function" && typeof module !== "undefined") return require("./util.js");
  return globalThis.DVY.util;
})();
const M = (() => {
  if (typeof require === "function" && typeof module !== "undefined") return require("./model.js");
  return globalThis.DVY.model;
})();
const { escapeCSV, unescapeCSV, escapeCSVArgument, unescapeCSVArgument, timestampToMs, msToTimestamp } = U;
const { Database, Column, Cell, Value, MatrixValue } = M;

// 贪婪匹配，从右往左定位 " (TYPE,BOOL,)"：列名里的 " (" 因此不会被误切
const COLUMN_HEADER_RE = /^(.*) \((MATRIX|TEXT|NOMINAL),(true|false),\)(?:-(.*))?$/;

/* ------------------------------------------------------------------ 解析 */

/** 按逗号切分但不切被 \ 转义的逗号（#4 的行内字段切割） */
function splitEscaped(line) {
  const out = [];
  let cur = "";
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "\\" && i + 1 < line.length) {
      cur += ch + line[i + 1];
      i++;
    } else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

/** 切矩阵值 "(a,b,c)"：按未被转义的逗号切，再各自反转义 */
function splitMatrix(inner) {
  return splitEscaped(inner).map((s) => unescapeCSVArgument(s));
}

function parseDb4(text) {
  const db = new Database("untitled");
  if (text == null) return db;
  const lines = String(text).split("\n");
  let i = 0;
  // 第一行必须是 #4（允许 BOM / 前后空白）
  while (i < lines.length && lines[i].replace(/^\uFEFF/, "").trim() === "") i++;
  if (i < lines.length && lines[i].replace(/^\uFEFF/, "").trim() === "#4") i++;

  let current = null;
  for (; i < lines.length; i++) {
    // 必须先切掉行尾 \r，否则它会被当成列名/值的一部分（原版文件在 Windows 上很常见）
    let line = lines[i];
    if (line.endsWith("\r")) line = line.slice(0, -1);
    if (line.trim() === "") continue;

    const m = COLUMN_HEADER_RE.exec(line);
    if (m) {
      const [, rawName, type, visible, codeSpec] = m;
      const name = unescapeCSV(rawName);
      let codes = null;
      let codeTypes = null;
      if (type === "MATRIX") {
        codes = [];
        codeTypes = [];
        for (const s of (codeSpec || "").split(",")) {
          if (s === "") continue;
          // 子码写成 <子码名>|<子码类型>，名字同样用 escapeCSV
          const bar = s.lastIndexOf("|");
          if (bar < 0) {
            codes.push(unescapeCSV(s));
            codeTypes.push("NOMINAL");
          } else {
            codes.push(unescapeCSV(s.slice(0, bar)));
            codeTypes.push(s.slice(bar + 1) || "NOMINAL");
          }
        }
        if (!codes.length) {
          codes = ["code01"];
          codeTypes = ["NOMINAL"];
        }
      }
      const col = new Column(name, type, codes, codeTypes);
      col.hidden = visible === "false"; // true = 可见
      db.columns.push(col);
      current = col;
      continue;
    }

    if (!current) continue; // 无主的行（旧文件残留）直接忽略
    const fields = splitEscaped(line);
    if (fields.length < 2) continue;
    const onset = timestampToMs(unescapeCSV(fields[0]));
    const offset = timestampToMs(unescapeCSV(fields[1]));
    const rawVal = fields.slice(2).join(","); // 值里未转义的逗号理论上不该有，兜一下
    let value;
    if (current.type === "MATRIX") {
      const bare = rawVal.replace(/\\[()]/g, (s) => s[1]);
      const inner = bare.startsWith("(") && bare.endsWith(")") ? bare.slice(1, -1) : bare;
      const vals = splitMatrix(inner);
      const mv = new MatrixValue(current.codes, []);
      for (let k = 0; k < current.codes.length; k++) mv.values[k] = vals[k] ?? "";
      value = mv;
    } else {
      value = new Value(unescapeCSVArgument(rawVal));
    }
    current.addCell(new Cell(onset, offset, value));
  }
  return db;
}

/* ------------------------------------------------------------------ 序列化 */

function columnHeader(col) {
  // StringUtils.escapeCSV(列名) + " (" + 类型 + "," + !isHidden() + "," + ")"
  let h = `${escapeCSV(col.name)} (${col.type},${col.hidden ? "false" : "true"},)`;
  if (col.type === "MATRIX") {
    h += "-" + col.codes.map((c, i) => `${escapeCSV(c)}|${(col.codeTypes && col.codeTypes[i]) || "NOMINAL"}`).join(",");
  }
  return h;
}

function writeDb4(db) {
  const out = ["#4"];
  for (const col of db.columns) {
    out.push(columnHeader(col));
    for (const cell of col.cells) {
      const v = cell.value ? cell.value.serialize() : "";
      out.push(`${msToTimestamp(cell.onset)},${msToTimestamp(cell.offset)},${v}`);
    }
  }
  return out.join("\n") + "\n";
}

/* ------------------------------------------------------------ 每行一个 cell 的 CSV */

/** 列按 VariableSort 排序（原版按名字，忽略大小写，稳定） */
function sortedColumns(db) {
  return db.columns
    .slice()
    .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()) || a.name.localeCompare(b.name));
}

/**
 * ExportDatabaseFileC.exportAsCells
 * 注意原版行为（逆向报告 §5.1、缺陷 5）：
 *   - 表头最后会 trim() 掉一个逗号
 *   - 数据行每行末尾都多一个逗号
 *   - 第一列是循环下标 i（不是 cell 自己的 ordinal）
 * 我们**保持兼容**（方便和原版对拍），但额外提供 strict 模式去掉行尾逗号。
 */
function writeCellsCsv(db, opts = {}) {
  const cols = sortedColumns(db);
  let header = "";
  for (const col of cols) {
    header += `${col.name}.ordinal,${col.name}.onset,${col.name}.offset,`;
    if (col.type === "MATRIX") for (const code of col.codes) header += `${col.name}.${code},`;
    else header += `${col.name}.value,`;
  }
  header = header.trim().replace(/,$/, "");

  const rows = [header];
  const max = cols.reduce((a, c) => Math.max(a, c.cells.length), 0);
  for (let i = 0; i < max; i++) {
    const rowParts = [];
    for (const col of cols) {
      const cell = col.cells[i];
      if (cell) {
        rowParts.push(String(i), msToTimestamp(cell.onset), msToTimestamp(cell.offset));
        if (col.type === "MATRIX") {
          for (let k = 0; k < col.codes.length; k++) rowParts.push(U.escapeCSVQuotes(cell.value ? cell.value.get(k) : ""));
        } else {
          rowParts.push(U.escapeCSVQuotes(cell.value ? cell.value.toString() : ""));
        }
      } else {
        const arglen = col.type === "MATRIX" ? col.codes.length + 3 : 4;
        for (let k = 0; k < arglen; k++) rowParts.push("");
      }
    }
    // 原版数据行末尾一定多一个逗号（表头却被 trim）；strict 模式去掉它
    rows.push(opts.strict ? rowParts.join(",") : rowParts.join(",") + ",");
  }
  return rows.join("\n") + "\n";
}

/** 读回「每行一个 cell」的 CSV */
function parseCellsCsv(text) {
  const db = new Database("untitled");
  const rows = parseCsv(String(text));
  if (!rows.length) return db;
  const header = rows[0].map((h) => h.trim());

  // 表头 -> 每个列名对应哪些字段下标
  const order = [];
  const byCol = new Map();
  header.forEach((h, idx) => {
    const dot = h.lastIndexOf(".");
    if (dot < 0) return;
    const colName = h.slice(0, dot);
    const field = h.slice(dot + 1);
    if (!byCol.has(colName)) {
      byCol.set(colName, {});
      order.push(colName);
    }
    byCol.get(colName)[field] = idx;
  });

  for (const name of order) {
    const f = byCol.get(name);
    const codeFields = Object.keys(f).filter((k) => !["ordinal", "onset", "offset", "value"].includes(k));
    const type = codeFields.length ? "MATRIX" : "TEXT";
    // cell CSV 不编码子码类型，这里只能统一按 NOMINAL 还原（属于该格式的已知信息损失）
    const col = new Column(name, type, codeFields.length ? codeFields : null);
    db.columns.push(col);
  }

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    for (const name of order) {
      const col = db.getColumn(name);
      const f = byCol.get(name);
      const num = (i) => (i === undefined || row[i] === undefined || row[i].trim() === "" ? null : row[i].trim());
      const onsetS = num(f.onset);
      const offsetS = num(f.offset);
      if (onsetS === null && offsetS === null) continue;
      const onset = timestampToMs(onsetS || "0");
      const offset = timestampToMs(offsetS || "0");
      let value;
      if (col.type === "MATRIX") {
        const mv = new MatrixValue(col.codes, [], col.codeTypes);
        // 字段顺序必须按表头出现顺序（byCol 里的 idx 可能不连续）
        col.codes.forEach((c, k) => mv.set(k, f[c] === undefined ? "" : row[f[c]] ?? ""));
        value = mv;
      } else {
        value = new Value(f.value === undefined ? "" : row[f.value] ?? "");
      }
      col.addCell(new Cell(onset, offset, value));
    }
  }
  return db;
}

/* ---------------------------------------------------------------- 逐帧 CSV */

/**
 * ExportDatabaseFileC.exportByFrame（本地 1.3.8 版本，与上游 v1.3.4 的实现不同）
 *   - 表头：framenum,time, + 每列 <列名>.ordinal,<列名>.onset,<列名>.offset[,码...]
 *   - framenum 从 1 开始
 *   - 循环上界 last_time + 1000/fps（原版会多出一行，这里提供 inclusiveEnd 开关）
 *   - 该帧包含某 cell 时，ordinal 字段写 currentIndex[i]+1
 */
function writeFrameCsv(db, opts = {}) {
  const fps = Number(opts.fps) > 1 ? Number(opts.fps) : 30;
  const step = 1000 / fps;
  const cols = sortedColumns(db);
  const extra = !!opts.inclusiveEnd; // 是否复刻原版多一帧的行为

  let header = "framenum,time,";
  for (const col of cols) {
    header += `${col.name}.ordinal,${col.name}.onset,${col.name}.offset,`;
    if (col.type === "MATRIX") for (const code of col.codes) header += `${col.name}.${code},`;
    else header += `${col.name}.value,`;
  }
  header = header.replace(/,$/, "");

  const range = db.timeRange;
  const rows = [header];
  if (!cols.length) return rows.join("\n") + "\n";
  const limit = range.end + (extra ? step : 0);
  let frame = 1;
  for (let t = range.start; t <= limit + 1e-9; t += step) {
    let row = `${frame},${Math.round(t)},`;
    for (const col of cols) {
      const cells = col.sorted();
      const hit = cells.findIndex((c) => c.onset <= t && c.offset >= t);
      if (hit >= 0) {
        const c = cells[hit];
        row += `${hit + 1},${msToTimestamp(c.onset)},${msToTimestamp(c.offset)},`;
        if (col.type === "MATRIX") for (let k = 0; k < col.codes.length; k++) row += `${U.escapeCSVQuotes(c.value.get(k))},`;
        else row += `${U.escapeCSVQuotes(c.value.toString())},`;
      } else {
        row += ",".repeat(col.type === "MATRIX" ? col.codes.length + 3 : 4);
      }
    }
    rows.push(row.replace(/,$/, ""));
    frame++;
  }
  return rows.join("\n") + "\n";
}

/* ------------------------------------------------------------- CSV 词法 */

/** 标准 CSV 解析（支持双引号包裹、"" 转义、字段内换行） */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  const s = String(text).replace(/^\uFEFF/, "");
  while (i < s.length) {
    const ch = s[i];
    if (inQuotes) {
      if (ch === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (ch === ",") {
      row.push(field);
      field = "";
      i++;
      continue;
    }
    if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i++;
      continue;
    }
    if (ch === "\r") {
      i++;
      continue;
    }
    field += ch;
    i++;
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => !(r.length === 1 && r[0].trim() === ""));
}

const api = {
  parseDb4,
  writeDb4,
  columnHeader,
  writeCellsCsv,
  parseCellsCsv,
  writeFrameCsv,
  parseCsv,
  splitEscaped,
  sortedColumns,
};

if (typeof module !== "undefined" && module.exports) module.exports = api;
if (typeof globalThis !== "undefined") {
  globalThis.DVY = globalThis.DVY || {};
  globalThis.DVY.db4 = api;
}
})();
