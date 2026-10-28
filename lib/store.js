/* 注意：本文件用 IIFE 包住。
 * 原因：index.html 用的是 classic <script>，所有脚本共享同一个全局词法作用域，
 * 两个文件里都写 `const api = ...` 会直接抛出 SyntaxError「Identifier 'api' has already been declared」，
 * 而且整个脚本会被静默丢弃（页面看起来只是「没反应」）。这个坑已经踩过一次，记在这里。
 * Node 端的 CommonJS 分支（module.exports）行为不变。
 */
(function () {
"use strict";

/* store.js —— 应用状态中枢
 *
 * 职责（刻意收窄，UI 只做渲染和输入）：
 *   - 持有当前 Database + 播放器状态（时间、fps、倍速、选中）
 *   - 所有改动走 apply()，自动进撤销栈，并广播事件
 *   - 本地存储（localStorage）自动保存 + 工程导入导出
 *
 * 事件：db（数据变了）/ time（播放位置变了）/ sel（选中变了）/ ui（其它界面开关）
 */

const M = (() => {
  if (typeof require === "function" && typeof module !== "undefined") return require("./model.js");
  return globalThis.DVY.model;
})();
const D4 = (() => {
  if (typeof require === "function" && typeof module !== "undefined") return require("./db4.js");
  return globalThis.DVY.db4;
})();
const OPF = (() => {
  if (typeof require === "function" && typeof module !== "undefined") return require("./opf.js");
  return globalThis.DVY.opf;
})();
const U = (() => {
  if (typeof require === "function" && typeof module !== "undefined") return require("./util.js");
  return globalThis.DVY.util;
})();

const LS_KEY = "datavyu-web:autosave:v1";

class Store {
  constructor() {
    this.db = new M.Database("untitled");
    this.project = null; // 从 .opf 读进来的 project 元数据（保存时写回）
    this.extraEntries = []; // .opf 里的未知条目，原样带回
    this.history = new M.History(200);

    // 播放器状态（原版靠 Data Controller 管，这里放在 store 里，UI 只读）
    this.time = 0; // 当前播放头（毫秒）
    this.playing = false;
    this.rate = 1;
    this.fps = 30;
    this.duration = 0;
    this.mediaName = "";
    this.mediaObjectUrl = null; // 本地选择的视频不进 localStorage，只保留名字

    // 选中状态
    this.selectedColumnId = null;
    this.selectedCellId = null;

    /* 打点（mark）状态
     * 「按一下开始、再按一下结束」的即时记录模式。
     * 注意：这不是 Datavyu 原版的功能，所以**不写进 .opf**（保持文件格式纯净），
     * 只作为界面偏好存在浏览器本地。
     *   markColumns: 已注册到打点条的列 id（有序，决定数字键分配）
     *   marking:     正在录制中的列 { [colId]: onsetMs }
     */
    this.markColumns = [];
    this.marking = {};
    this.markHistory = []; // 最近完成的打点，用于状态栏回显

    this.dirty = false;
    this._listeners = new Map();
    this._restoreAutosave();
  }

  /* ------------------------------------------------------------ 事件总线 */

  on(evt, fn) {
    if (!this._listeners.has(evt)) this._listeners.set(evt, new Set());
    this._listeners.get(evt).add(fn);
    return () => this._listeners.get(evt).delete(fn);
  }

  emit(evt, payload) {
    const set = this._listeners.get(evt);
    if (set) for (const fn of set) fn(payload, this);
  }

  /* -------------------------------------------------------------- 改动入口 */

  /**
   * 所有数据改动都必须走这里：
   *   store.apply("加行", (db) => { ... })
   * 返回 fn 的返回值；抛错则回滚快照。
   */
  apply(label, fn) {
    const snapshot = JSON.stringify(this.db.toJSON());
    let result;
    try {
      result = fn(this.db, this);
    } catch (err) {
      this.db = M.Database.fromJSON(JSON.parse(snapshot)); // 出错就回滚，别让库停在半路
      this.emit("db", { label: "回滚", error: err });
      throw err;
    }
    this.history.push(snapshot, label);
    this.dirty = true;
    this.emit("db", { label });
    this._autosave();
    return result;
  }

  undo() {
    if (!this.history.canUndo) return false;
    const entry = this.history.undo(JSON.stringify(this.db.toJSON()));
    this.db = M.Database.fromJSON(JSON.parse(entry.snapshot));
    this._afterStructuralChange(entry.label);
    return true;
  }

  redo() {
    if (!this.history.canRedo) return false;
    const entry = this.history.redo(JSON.stringify(this.db.toJSON()));
    this.db = M.Database.fromJSON(JSON.parse(entry.snapshot));
    this._afterStructuralChange(entry.label);
    return true;
  }

  _afterStructuralChange(label) {
    // 撤销/重做后选中的对象可能已经不存在了
    if (this.selectedColumnId && !this.db.getColumnById(this.selectedColumnId)) {
      this.selectedColumnId = null;
      this.selectedCellId = null;
    }
    if (this.selectedColumnId && this.selectedCellId) {
      const col = this.db.getColumnById(this.selectedColumnId);
      if (!col || !col.getCell(this.selectedCellId)) this.selectedCellId = null;
    }
    this.dirty = true;
    this.emit("db", { label: label || "撤销" });
    this.emit("sel", {});
    this._autosave();
  }

  /* ------------------------------------------------------------ 常用操作 */

  get selectedColumn() {
    return this.selectedColumnId ? this.db.getColumnById(this.selectedColumnId) : null;
  }

  get selectedCell() {
    const col = this.selectedColumn;
    return col && this.selectedCellId ? col.getCell(this.selectedCellId) : null;
  }

  select(columnId, cellId = null) {
    this.selectedColumnId = columnId;
    this.selectedCellId = cellId;
    this.emit("sel", { columnId, cellId });
  }

  /** 新建列：返回新列；重名/非法名会抛错（原版会静默覆盖） */
  addColumn(name, type, codes, codeTypes) {
    return this.apply(`新建列 ${name}`, (db) => {
      const col = db.addColumn(name, type, codes, codeTypes);
      this.selectedColumnId = col.id;
      this.selectedCellId = null;
      return col;
    });
  }

  removeColumn(id) {
    const col = this.db.getColumnById(id);
    if (!col) return;
    this.apply(`删除列 ${col.name}`, (db) => {
      db.removeColumn(id);
      if (this.selectedColumnId === id) {
        this.selectedColumnId = db.columns.length ? db.columns[0].id : null;
        this.selectedCellId = null;
      }
    });
  }

  renameColumn(id, name) {
    return this.apply(`重命名列 → ${name}`, (db) => db.renameColumn(id, name));
  }

  moveColumn(id, dir) {
    this.apply("移动列", (db) => db.moveColumn(id, dir));
  }

  toggleColumnHidden(id) {
    this.apply("切换列可见性", (db) => {
      const col = db.getColumnById(id);
      if (col) col.hidden = !col.hidden;
    });
  }

  /**
   * 新建 cell。原版有三种：
   *   - 在播放头处新建零长度 cell（最常用，配合 NUM+ 打点）
   *   - 相对当前 cell 往左/右（Cmd L / Cmd R）
   *   - 围绕播放头（onset 取上一 cell 的 offset）
   */
  addCell(columnId, onset = this.time, offset = null) {
    const col = this.db.getColumnById(columnId);
    if (!col) throw new Error("列不存在");
    const on = Math.max(0, Math.round(onset));
    const off = offset === null ? on : Math.max(on, Math.round(offset));
    return this.apply(`新建行 @${U.msToTimestamp(on)}`, (db) => {
      const c = db.getColumnById(columnId);
      const cell = new M.Cell(on, off, c.makeValue());
      c.addCell(cell);
      this.selectedCellId = cell.id;
      return cell;
    });
  }

  /** 在选中 cell 之后/之前新建（Cmd R / Cmd L 的语义） */
  addCellRelative(columnId, cellId, dir) {
    const col = this.db.getColumnById(columnId);
    if (!col) return null;
    const cells = col.sorted();
    const idx = cells.findIndex((c) => c.id === cellId);
    const ref = idx >= 0 ? cells[idx] : cells[cells.length - 1];
    let onset;
    if (!ref) onset = this.time;
    else if (dir > 0) onset = ref.offset;
    else onset = Math.max(0, ref.onset - (ref.duration || 1000));
    return this.addCell(columnId, onset, onset);
  }

  removeCell(columnId, cellId) {
    this.apply("删除行", (db) => {
      const col = db.getColumnById(columnId);
      if (col) col.removeCell(cellId);
      if (this.selectedCellId === cellId) this.selectedCellId = null;
    });
  }

  setCellTime(columnId, cellId, which, ms) {
    const label = which === "onset" ? "改起点" : "改终点";
    this.apply(label, (db) => {
      const col = db.getColumnById(columnId);
      const cell = col && col.getCell(cellId);
      if (!cell) return;
      const v = Math.max(0, Math.round(ms));
      cell[which] = v;
      if (cell.offset < cell.onset) {
        // 起点越过终点时，把另一端顶开（原版是各自独立改，会留下负长度 cell）
        if (which === "onset") cell.offset = v;
        else cell.onset = v;
      }
    });
  }

  setCellValue(columnId, cellId, value, codeIndex = null) {
    this.apply(codeIndex === null ? "改值" : "改子码值", (db) => {
      const col = db.getColumnById(columnId);
      const cell = col && col.getCell(cellId);
      if (!cell) return;
      if (col.type === "MATRIX" && codeIndex !== null) cell.value.set(codeIndex, value);
      else if (col.type === "MATRIX") cell.value = new M.MatrixValue(col.codes, col.codes.map(() => value), col.codeTypes);
      else cell.value = new M.Value(value);
    });
  }

  addCode(columnId, name, type = "NOMINAL") {
    this.apply(`加子码 ${name}`, (db) => db.getColumnById(columnId).addCode(name, type));
  }

  removeCode(columnId, name) {
    this.apply(`删子码 ${name}`, (db) => db.getColumnById(columnId).removeCode(name));
  }

  /* ------------------------------------------------------------ 即时打点
   *
   * 手感（用户明确要的）：点一下分类 = 开始，再点一下 = 结束。
   * 这是行为编码里最快的记录方式 —— 编码员眼睛盯视频，手指只需要一个键。
   *
   * 设计约束：
   *   - 一定产生**合法 cell**（offset >= onset），所以结束时若不足一帧，就补齐一帧
   *   - 每次打点都是一次 apply()，所以 ⌘Z 能一次撤销一个打点（而不是撤销一整段）
   *   - 状态存这里而不是 UI 里，因为键盘和按钮两条入口必须共享同一份状态
   */

  /** 注册/取消注册到打点条（不改数据，只改界面偏好） */
  registerMark(columnId, on = true) {
    const has = this.markColumns.includes(columnId);
    if (on && !has) this.markColumns.push(columnId);
    if (!on && has) {
      this.markColumns = this.markColumns.filter((id) => id !== columnId);
      delete this.marking[columnId];
    }
    this.emit("marks", {});
    this._autosave();
  }

  setMarkColumns(ids) {
    const valid = ids.filter((id) => !!this.db.getColumnById(id));
    this.markColumns = valid;
    for (const id of Object.keys(this.marking)) {
      if (!valid.includes(id)) delete this.marking[id];
    }
    this.emit("marks", {});
    this._autosave();
  }

  /** 数字键 → 列（1..9 给前 9 个，0 给第 10 个） */
  markColumnForSlot(slot) {
    const idx = slot === 0 ? 9 : slot - 1;
    const id = this.markColumns[idx];
    return id ? this.db.getColumnById(id) : null;
  }

  isMarking(columnId) {
    return this.marking[columnId] !== undefined;
  }

  get markingCount() {
    return Object.keys(this.marking).length;
  }

  /**
   * 切换打点状态。
   * 返回 { action: 'start'|'end', column, cell?, onset, offset? }，方便调用方回显。
   */
  toggleMark(columnId, opts = {}) {
    const col = this.db.getColumnById(columnId);
    if (!col) throw new Error("要打点的列不存在");
    const at = Math.max(0, Math.round(opts.at !== undefined ? opts.at : this.time));

    if (this.isMarking(columnId)) {
      const onset = this.marking[columnId];
      delete this.marking[columnId];
      // 不足一帧就补一帧：宁可给一个最小的合法 cell，也不要零长度（原版会留下 onset==offset 的行，
      // 后续导出/统计里很别扭）
      const minLen = Math.max(1, Math.round(this.frameStep));
      const offset = at > onset ? at : onset + minLen;
      const cell = this.apply(`结束打点 ${col.name}`, (db) => {
        const c = db.getColumnById(columnId);
        const nc = new M.Cell(onset, offset, c.makeValue());
        c.addCell(nc);
        this.selectedColumnId = columnId;
        this.selectedCellId = nc.id;
        return nc;
      });
      this.markHistory.unshift({ columnId, name: col.name, onset, offset, at: Date.now() });
      this.markHistory = this.markHistory.slice(0, 20);
      this.emit("marks", { action: "end", columnId });
      return { action: "end", column: col, cell, onset, offset };
    }

    this.marking[columnId] = at;
    this.selectedColumnId = columnId;
    if (opts.select !== false) this.emit("sel", { columnId, cellId: null });
    this.emit("marks", { action: "start", columnId });
    return { action: "start", column: col, onset: at };
  }

  /** 放弃正在录制中的打点（按 Esc 的场景） */
  cancelMark(columnId = null) {
    const ids = columnId ? [columnId] : Object.keys(this.marking);
    let n = 0;
    for (const id of ids) {
      if (this.marking[id] !== undefined) {
        delete this.marking[id];
        n++;
      }
    }
    if (n) this.emit("marks", { action: "cancel" });
    return n;
  }

  /** 把播放头跳到某个打点的起点，方便核对 */
  jumpToLastMark() {
    const last = this.markHistory[0];
    if (!last) return null;
    return last;
  }

  /* -------------------------------------------------------- 播放头与选中 */

  setTime(ms, { emit = true } = {}) {
    const v = Math.max(0, Math.round(ms));
    if (v === this.time) return;
    this.time = v;
    if (emit) {
      this.emit("time", { time: v });
      this._syncSelectionToTime();
    }
  }

  /** 播放头移动时自动高亮当前覆盖的 cell（原版是选中 cell 不动，这里做成跟随更好用） */
  _syncSelectionToTime() {
    const col = this.selectedColumn;
    if (!col) return;
    const hit = col.sorted().find((c) => c.contains(this.time));
    if (hit && hit.id !== this.selectedCellId) {
      this.selectedCellId = hit.id;
      this.emit("sel", { columnId: col.id, cellId: hit.id, follow: true });
    }
  }

  setPlaying(v) {
    this.playing = !!v;
    this.emit("play", { playing: this.playing });
  }

  setRate(r) {
    this.rate = r;
    this.emit("play", { rate: r });
  }

  setFps(f) {
    const v = Number(f);
    if (!Number.isFinite(v) || v <= 0 || v > 1000) return;
    this.fps = v;
    this.emit("play", { fps: v });
    this._autosave();
  }

  get frameStep() {
    return 1000 / this.fps;
  }

  /* ------------------------------------------------------- 新建 / 打开 / 保存 */

  newProject(name = "untitled") {
    this.db = new M.Database(name);
    this.project = null;
    this.extraEntries = [];
    this.history.clear();
    this.selectedColumnId = null;
    this.selectedCellId = null;
    this.time = 0;
    this.dirty = false;
    this.markColumns = [];
    this.marking = {};
    this.markHistory = [];
    this.emit("db", { label: "新建" });
    this.emit("marks", {});
    this.emit("time", { time: 0 });
    this.emit("sel", {});
    this._autosave();
  }

  loadResult(result, filename) {
    this.db = result.db;
    this.project = result.project || null;
    this.extraEntries = result.extraEntries || [];
    this.marking = {};
    this.markColumns = this.markColumns.filter((id) => !!this.db.getColumnById(id));
    if (!this.markColumns.length && this.db.columns.length) {
      this.markColumns = this.db.columns.slice(0, 4).map((c) => c.id);
    }
    if (!this.db.name || this.db.name === "untitled") {
      this.db.name = (filename || "").replace(/\.[^.]+$/, "") || "untitled";
    }
    this.history.clear();
    this.selectedColumnId = this.db.columns.length ? this.db.columns[0].id : null;
    this.selectedCellId = null;
    this.dirty = false;
    this.emit("db", { label: "打开 " + (filename || "") });
    this.emit("sel", {});
    this._autosave();
  }

  openBytes(bytes, filename) {
    const result = OPF.readAny(bytes, filename);
    this.loadResult(result, filename);
    return result;
  }

  /** 导出 .opf（真正的 Datavyu 工程文件，ZIP） */
  toOpfBytes() {
    return OPF.writeOpf(this.db, {
      project: this.project,
      extraEntries: this.extraEntries,
      name: this.db.name,
    });
  }

  toCellsCsv(opts) {
    return D4.writeCellsCsv(this.db, opts);
  }

  toFrameCsv(opts) {
    // numeric 默认开：时间既给毫秒也给秒，导出后能直接算
    return D4.writeFrameCsv(this.db, { fps: this.fps, numeric: true, ...opts });
  }

  /** 分析用 CSV（长表，时间全数字）—— Excel / R / SPSS / Python 直接吃 */
  toAnalysisCsv(opts) {
    return D4.writeAnalysisCsv(this.db, opts);
  }

  toJsonText() {
    return JSON.stringify(
      {
        format: "datavyu-web",
        version: 1,
        project: this.project,
        // markColumns 是界面偏好（不写进 .opf），但自动存档要带上，
        // 否则刷新一次辛苦注册的打点分类就没了
        ui: { markColumns: this.markColumns, fps: this.fps },
        db: this.db.toJSON(),
      },
      null,
      2,
    );
  }

  /* ------------------------------------------------------------ 本地存储 */

  _autosave() {
    if (typeof localStorage === "undefined") return;
    try {
      localStorage.setItem(LS_KEY, this.toJsonText());
    } catch (err) {
      // 配额超了就算了，不打断使用（大工程建议直接存 .opf）
      console.warn("autosave failed", err);
    }
  }

  _restoreAutosave() {
    if (typeof localStorage === "undefined") return;
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (!raw) return;
      const obj = JSON.parse(raw);
      if (obj && obj.db) {
        this.db = M.Database.fromJSON(obj.db);
        this.project = obj.project || null;
        this.selectedColumnId = this.db.columns.length ? this.db.columns[0].id : null;
        // 只恢复仍然存在的列（工程可能被换过）
        const ui = obj.ui || {};
        if (Array.isArray(ui.markColumns)) {
          this.markColumns = ui.markColumns.filter((id) => !!this.db.getColumnById(id));
        }
        // 兼容旧存档：没记过打点条，就默认把前 4 列注册上（大多数编码方案够用）
        if (!this.markColumns.length && this.db.columns.length) {
          this.markColumns = this.db.columns.slice(0, 4).map((c) => c.id);
        }
        if (Number.isFinite(ui.fps) && ui.fps > 0) this.fps = ui.fps;
      }
    } catch (err) {
      console.warn("restore autosave failed", err);
    }
  }

  clearAutosave() {
    if (typeof localStorage === "undefined") return;
    localStorage.removeItem(LS_KEY);
  }

  /** 当前统计，用于状态栏 */
  stats() {
    const range = this.db.timeRange;
    return {
      columns: this.db.columns.length,
      cells: this.db.cellCount(),
      span: range.end - range.start,
      time: this.time,
    };
  }
}

const api = { Store, LS_KEY };
if (typeof module !== "undefined" && module.exports) module.exports = api;
if (typeof globalThis !== "undefined") {
  globalThis.DVY = globalThis.DVY || {};
  globalThis.DVY.store = api;
}
})();
