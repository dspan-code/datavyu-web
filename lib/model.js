/* 注意：本文件用 IIFE 包住。
 * 原因：index.html 用的是 classic <script>，所有脚本共享同一个全局词法作用域，
 * 两个文件里都写 `const api = ...` 会直接抛出 SyntaxError「Identifier 'api' has already been declared」，
 * 而且整个脚本会被静默丢弃（页面看起来只是「没反应」）。这个坑已经踩过一次，记在这里。
 * Node 端的 CommonJS 分支（module.exports）行为不变。
 */
(function () {
"use strict";

/* model.js —— 数据模型：Database / Column / Cell + 撤销栈
 *
 * 对应 Datavyu 的 org.datavyu.models.db：
 *   Database  ~ Datastore（variables:列的有序集合）
 *   Column    ~ Variable（rootNode: Argument，Type = MATRIX|TEXT|NOMINAL）
 *   Cell      ~ Cell（onset/offset 毫秒 + 值）
 *
 * 有意做的三处改进（都是原版的坑，见逆向报告 §6）：
 *   1. 列名唯一性检查在这里做，重名直接报错而不是静默覆盖
 *   2. cell 值统一走字符串，矩阵列是字符串数组 —— 不引入不可逆的 <code01> 占位符
 *   3. 所有改动都过 apply()（带 undo/redo），不存在原版「逐字符写库无法取消」的问题
 */

const U = (() => {
  if (typeof require === "function" && typeof module !== "undefined") return require("./util.js");
  return globalThis.DVY.util;
})();
const { CELL_TYPES, timestampToMs, msToTimestamp, uid, clamp } = U;

/* ------------------------------------------------------------------ 值对象 */

// TEXT / NOMINAL 列的值
class Value {
  constructor(str = "") {
    this.str = String(str ?? "");
  }
  toString() {
    return this.str;
  }
  serialize() {
    return U.escapeCSVArgument(this.str);
  }
  clone() {
    return new Value(this.str);
  }
  isEmpty() {
    return this.str === "";
  }
}

// MATRIX 列的值：子码与值一一对应
class MatrixValue {
  constructor(codes = [], values = [], codeTypes = null) {
    this.codes = codes.slice();
    this.codeTypes = codeTypes ? codeTypes.slice() : this.codes.map(() => "NOMINAL");
    this.values = values.slice();
    while (this.values.length < this.codes.length) this.values.push("");
  }
  toString() {
    // 界面显示成 (a, b, c)，与 DatavyuMatrixValue 一致
    return `(${this.values.join(",")})`;
  }
  serialize() {
    return `(${this.values.map((v) => U.escapeCSVArgument(v)).join(",")})`;
  }
  get(i) {
    return this.values[i] ?? "";
  }
  set(i, v) {
    this.values[i] = String(v ?? "");
  }
  clone() {
    return new MatrixValue(this.codes, this.values, this.codeTypes);
  }
  isEmpty() {
    return this.values.every((v) => v === "");
  }
}

/* -------------------------------------------------------------------- Cell */

class Cell {
  constructor(onset = 0, offset = 0, value = null) {
    this.id = uid("cell");
    this.onset = Math.round(onset);
    this.offset = Math.round(offset);
    this.value = value;
  }
  get duration() {
    return this.offset - this.onset;
  }
  contains(ms) {
    return this.onset <= ms && ms <= this.offset;
  }
  get onsetString() {
    return msToTimestamp(this.onset);
  }
  get offsetString() {
    return msToTimestamp(this.offset);
  }
  clone() {
    return new Cell(this.onset, this.offset, this.value ? this.value.clone() : null);
  }
  toJSON() {
    return { id: this.id, onset: this.onset, offset: this.offset, value: this.value ? this.value.clone() : null };
  }
}

/* ------------------------------------------------------------------ Column */

class Column {
  constructor(name, type = "TEXT", codes = null, codeTypes = null) {
    this.id = uid("col");
    this.name = String(name);
    this.type = CELL_TYPES.includes(type) ? type : "TEXT";
    this.hidden = false;
    this.cells = [];
    // MATRIX 列才有子码；TEXT/NOMINAL 列的子码列表是空的。
    // codeTypes 是每个子码的声明类型（#4 里写成 <子码名>|<类型>），保存时必须原样写回。
    this.codes = this.type === "MATRIX" ? (codes && codes.length ? codes.slice() : ["code01"]) : [];
    this.codeTypes =
      this.type === "MATRIX"
        ? codeTypes && codeTypes.length === this.codes.length
          ? codeTypes.slice()
          : this.codes.map(() => "NOMINAL")
        : [];
  }

  makeValue() {
    return this.type === "MATRIX"
      ? new MatrixValue(this.codes, this.codes.map(() => ""), this.codeTypes)
      : new Value("");
  }

  /** 按 onset 排序后的副本（Datavyu 里 cell 显示总是按时间顺序） */
  sorted() {
    return this.cells.slice().sort((a, b) => a.onset - b.onset || a.offset - b.offset);
  }

  addCell(cell) {
    this.cells.push(cell);
    return cell;
  }

  removeCell(id) {
    const i = this.cells.findIndex((c) => c.id === id);
    if (i >= 0) return this.cells.splice(i, 1)[0];
    return null;
  }

  getCell(id) {
    return this.cells.find((c) => c.id === id) || null;
  }

  addCode(name, type = "NOMINAL") {
    if (this.type !== "MATRIX") throw new Error("只有矩阵列能加子码");
    if (this.codes.includes(name)) throw new Error(`子码已存在：${name}`);
    this.codes.push(name);
    this.codeTypes.push(type);
    for (const c of this.cells) {
      if (c.value) {
        c.value.codes = this.codes.slice();
        c.value.codeTypes = this.codeTypes.slice();
        c.value.values.push("");
      }
    }
    return name;
  }

  removeCode(name) {
    const i = this.codes.indexOf(name);
    if (i < 0) return;
    this.codes.splice(i, 1);
    this.codeTypes.splice(i, 1);
    for (const c of this.cells) {
      if (c.value) {
        c.value.codes.splice(i, 1);
        c.value.values.splice(i, 1);
      }
    }
  }

  clone() {
    const c = new Column(this.name, this.type, this.codes, this.codeTypes);
    c.hidden = this.hidden;
    c.cells = this.cells.map((x) => x.clone());
    return c;
  }
}

/* ---------------------------------------------------------------- Database */

class Database {
  constructor(name = "untitled") {
    this.name = name;
    this.columns = []; // 有序：Datavyu 的列顺序就是显示顺序
    this.origpath = "";
    this.extraProject = {}; // 从 .opf 的 project YAML 里保留下来的未知键
    this.extraEntries = []; // .opf 里我们不认识的其他条目（原样带回）
  }

  getColumn(name) {
    return this.columns.find((c) => c.name === name) || null;
  }

  getColumnById(id) {
    return this.columns.find((c) => c.id === id) || null;
  }

  columnNames() {
    return this.columns.map((c) => c.name);
  }

  /** 列名唯一（原版是 Map<String,Variable>，重名会覆盖） */
  assertNameFree(name, exceptId = null) {
    if (!name) throw new Error("列名不能为空");
    // 比官方文档宽一点：额外允许连字符（真实 .opf 里就有 my-notes 这类列名）
    if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(name)) {
      throw new Error("列名只能包含字母/数字/下划线/连字符，且不能以数字或下划线开头");
    }
    for (const c of this.columns) {
      if (c.id !== exceptId && c.name === name) throw new Error(`列名已存在：${name}`);
    }
  }

  addColumn(name, type, codes, codeTypes) {
    this.assertNameFree(name);
    const col = new Column(name, type, codes, codeTypes);
    this.columns.push(col);
    return col;
  }

  removeColumn(id) {
    const i = this.columns.findIndex((c) => c.id === id);
    if (i >= 0) return this.columns.splice(i, 1)[0];
    return null;
  }

  renameColumn(id, newName) {
    this.assertNameFree(newName, id);
    const col = this.getColumnById(id);
    if (col) col.name = newName;
    return col;
  }

  moveColumn(id, dir) {
    const i = this.columns.findIndex((c) => c.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= this.columns.length) return false;
    [this.columns[i], this.columns[j]] = [this.columns[j], this.columns[i]];
    return true;
  }

  /** 时间范围：所有列所有 cell 的 min(onset) / max(offset) */
  get timeRange() {
    let lo = Infinity;
    let hi = -Infinity;
    for (const col of this.columns) {
      for (const c of col.cells) {
        if (c.onset < lo) lo = c.onset;
        if (c.offset > hi) hi = c.offset;
      }
    }
    if (!Number.isFinite(lo)) return { start: 0, end: 0 };
    return { start: lo, end: hi };
  }

  cellCount() {
    return this.columns.reduce((a, c) => a + c.cells.length, 0);
  }

  toJSON() {
    return {
      name: this.name,
      origpath: this.origpath,
      extraProject: this.extraProject,
      columns: this.columns.map((c) => ({
        id: c.id,
        name: c.name,
        type: c.type,
        hidden: c.hidden,
        codes: c.codes.slice(),
        codeTypes: (c.codeTypes || []).slice(),
        cells: c.cells.map((x) => x.toJSON()),
      })),
    };
  }

  static fromJSON(obj) {
    const db = new Database(obj.name || "untitled");
    db.origpath = obj.origpath || "";
    db.extraProject = obj.extraProject || {};
    for (const c of obj.columns || []) {
      const col = new Column(c.name, c.type, c.codes, c.codeTypes);
      col.hidden = !!c.hidden;
      if (c.id) col.id = c.id;
      col.cells = (c.cells || []).map((x) => {
        const cell = new Cell(x.onset, x.offset, null);
        if (x.id) cell.id = x.id;
        if (col.type === "MATRIX") {
          const mv = new MatrixValue(col.codes, [], col.codeTypes);
          if (x.value && Array.isArray(x.value.values)) mv.values = x.value.values.slice();
          cell.value = mv;
        } else {
          cell.value = new Value(x.value && typeof x.value === "object" ? x.value.str : x.value);
        }
        return cell;
      });
      db.columns.push(col);
    }
    return db;
  }
}

/* -------------------------------------------------------------- 撤销栈 */

/**
 * 所有改动都通过 store.apply(label, fn) 提交：
 *   apply 前对数据库做结构化快照，commit 后压栈。
 * 原版 Datavyu 靠一堆 *Edit 类；这里用整库快照，代码量小且不会漏改。
 */
class History {
  constructor(limit = 200) {
    this.limit = limit;
    this.past = [];
    this.future = [];
  }
  push(snapshot, label) {
    this.past.push({ snapshot, label });
    if (this.past.length > this.limit) this.past.shift();
    this.future.length = 0;
  }
  undo(currentSnapshot) {
    if (!this.past.length) return null;
    const entry = this.past.pop();
    this.future.push({ snapshot: currentSnapshot, label: entry.label });
    return entry;
  }
  redo(currentSnapshot) {
    if (!this.future.length) return null;
    const entry = this.future.pop();
    this.past.push({ snapshot: currentSnapshot, label: entry.label });
    return entry;
  }
  get canUndo() {
    return this.past.length > 0;
  }
  get canRedo() {
    return this.future.length > 0;
  }
  clear() {
    this.past.length = 0;
    this.future.length = 0;
  }
}

const api = {
  Value,
  MatrixValue,
  Cell,
  Column,
  Database,
  History,
  msToTimestamp,
  timestampToMs,
};

if (typeof module !== "undefined" && module.exports) module.exports = api;
if (typeof globalThis !== "undefined") {
  globalThis.DVY = globalThis.DVY || {};
  globalThis.DVY.model = api;
}
})();
