/* ui/app.js —— 接线层：把 store / video / grid / timeline / 菜单 / 快捷键 串起来
 *
 * 这一层只做「翻译」：菜单动作 → store 调用，store 事件 → 界面刷新。
 * 业务规则一律不写在这里（在 lib/ 与 store.js 里）。
 */

(function () {
  const U = globalThis.DVY.util;
  const Store = globalThis.DVY.store.Store;
  const T = globalThis.DVY.timeutil;

  const $ = (id) => document.getElementById(id);

  const store = new Store();

  /* ------------------------------------------------------------ DOM 引用 */

  const els = {
    // 顶栏
    pillFile: $("pill-file"),
    pillFormat: $("pill-format"),
    pillDirty: $("pill-dirty"),
    // 播放器
    video: $("video"),
    videoWrap: $("video-wrap"),
    videoEmpty: $("video-empty"),
    hudTc: $("hud-tc"),
    hudFps: $("hud-fps"),
    btnPlay: $("btn-play"),
    btnBackFrame: $("btn-backframe"),
    btnFwdFrame: $("btn-fwdframe"),
    btnBack1s: $("btn-back1s"),
    btnFwd1s: $("btn-fwd1s"),
    btnStart: $("btn-start"),
    btnEnd: $("btn-end"),
    seek: $("seek"),
    fps: $("fps"),
    rate: $("rate"),
    tcInput: $("tc-input"),
    mediaUrl: $("media-url"),
    loadUrl: $("btn-load-url"),
    pickVideo: $("btn-pick-video"),
    pickVideo2: $("btn-pick-video2"),
    mediaName: $("media-name"),
    fileInput: $("file-input"),
    // 表格
    gridScroll: $("grid-scroll"),
    grid: $("grid"),
    sheetTitle: $("sheet-title"),
    sheetHint: $("sheet-hint"),
    // 侧栏
    sidebar: $("sidebar"),
    columnManager: $("column-manager"),
    chkAlign: $("chk-align"),
    chkLive: $("chk-live"),
    // 时间轴
    timeline: $("timeline"),
    timelineBody: $("timeline-body"),
    // 状态栏
    stCols: $("st-cols"),
    stCells: $("st-cells"),
    stTime: $("st-time"),
    stTime: $("st-time"),
    stSpan: $("st-span"),
    stMsg: $("st-msg"),
    // 对话框
    dlgColumn: $("dlg-column"),
    dlgColName: $("dlg-col-name"),
    dlgColType: $("dlg-col-type"),
    dlgCodesRow: $("dlg-codes-row"),
    dlgColCodes: $("dlg-col-codes"),
    dlgInfo: $("dlg-info"),
    infoTitle: $("info-title"),
    infoBody: $("info-body"),
  };

  /* ------------------------------------------------------------ 消息 */

  let msgTimer = 0;
  function msg(text, kind = "") {
    els.stMsg.textContent = text;
    els.stMsg.className = "msg " + kind;
    clearTimeout(msgTimer);
    msgTimer = setTimeout(() => {
      els.stMsg.textContent = "";
      els.stMsg.className = "msg";
    }, 6000);
  }
  store.on("msg", (p) => msg(p.text, p.kind));

  /* ------------------------------------------------------ 挂载子系统 */

  const video = globalThis.DVY.ui.video.mount(store, els);
  const grid = globalThis.DVY.ui.grid.mount(store, {
    ...els,
    onAddColumn: () => openColumnDialog(),
    onNewCell: (colId, at) => {
      try {
        store.addCell(colId, at, at);
      } catch (e) {
        msg(e.message, "err");
      }
    },
  });
  const timeline = globalThis.DVY.ui.timeline.mount(store, {
    ...els,
    onSeek: (ms) => video.seekTo(ms),
  });

  store.setFps(els.fps.value);

  /* -------------------------------------------------------- 列管理面板 */

  function renderColumns() {
    const box = els.columnManager;
    box.innerHTML = "";
    if (!store.db.columns.length) {
      const p = document.createElement("div");
      p.style.cssText = "padding:10px;color:var(--fg-mute);font-size:12px";
      p.textContent = "还没有列。点右上角 ＋ 新建。";
      box.appendChild(p);
      return;
    }
    store.db.columns.forEach((col, idx) => {
      const item = document.createElement("div");
      item.className = "side-item" + (col.id === store.selectedColumnId ? " sel" : "") + (col.hidden ? " hidden-col" : "");

      const dot = document.createElement("span");
      dot.className = "dot";
      dot.style.background = T.colorFor(col.name);

      const nm = document.createElement("span");
      nm.className = "nm";
      nm.textContent = col.name;
      nm.title = "双击重命名";
      nm.addEventListener("dblclick", () => {
        const next = prompt("新的列名（只能字母/数字/下划线）", col.name);
        if (next === null || next === col.name) return;
        try {
          store.renameColumn(col.id, next.trim());
          msg(`已重命名为 ${next.trim()}`, "ok");
        } catch (e) {
          msg(e.message, "err");
        }
      });

      const ty = document.createElement("span");
      ty.className = "ty";
      ty.textContent = `${col.type}·${col.cells.length}`;

      const ops = document.createElement("span");
      ops.className = "ops";
      const mk = (label, title, fn) => {
        const b = document.createElement("button");
        b.textContent = label;
        b.title = title;
        b.addEventListener("click", (e) => {
          e.stopPropagation();
          fn();
        });
        return b;
      };
      ops.append(
        mk(col.hidden ? "◌" : "●", col.hidden ? "显示此列" : "隐藏此列", () => store.toggleColumnHidden(col.id)),
        mk("↑", "左移", () => idx > 0 && store.moveColumn(col.id, -1)),
        mk("↓", "右移", () => idx < store.db.columns.length - 1 && store.moveColumn(col.id, 1)),
        mk("✕", "删除此列（含所有行）", () => {
          if (confirm(`删除列「${col.name}」及其 ${col.cells.length} 行？可用 ⌘Z 撤销。`)) store.removeColumn(col.id);
        }),
      );

      item.append(dot, nm, ty, ops);
      item.addEventListener("click", () => store.select(col.id, null));
      box.appendChild(item);
    });
  }

  /* ------------------------------------------------------- 状态栏 / 顶栏 */

  function renderStatus() {
    const s = store.stats();
    els.stCols.textContent = `列 ${s.columns}`;
    els.stCells.textContent = `行 ${s.cells}`;
    els.stSpan.textContent = `跨度 ${(s.span / 1000).toFixed(3)} s`;
    els.pillFile.textContent = store.db.name || "未命名";
    els.pillFormat.textContent = "自存浏览器 · 导出 .opf";
    els.pillDirty.hidden = !store.dirty;
    document.title = `${store.dirty ? "• " : ""}${store.db.name || "未命名"} — Datavyu 网页版`;
  }

  store.on("db", () => {
    renderColumns();
    renderStatus();
  });
  store.on("sel", renderColumns);
  store.on("time", renderStatus);

  /* --------------------------------------------------------- 文件操作 */

  function download(filename, data, mime) {
    const blob = data instanceof Uint8Array ? new Blob([data], { type: mime }) : new Blob([data], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  function baseName() {
    return (store.db.name || "untitled").replace(/[\\/:*?"<>|]/g, "_");
  }

  function isOpfBytes(u8) {
    return u8.length > 4 && u8[0] === 0x50 && u8[1] === 0x4b;
  }

  function openFile(file) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const u8 = new Uint8Array(reader.result);
        const res = store.openBytes(u8, file.name);
        msg(`已打开 ${file.name}（识别为 ${res.kind}，${store.db.columns.length} 列 ${store.db.cellCount()} 行）`, "ok");
      } catch (e) {
        msg("打开失败：" + e.message, "err");
      }
    };
    reader.onerror = () => msg("读文件失败", "err");
    reader.readAsArrayBuffer(file);
  }

  function openViaPicker(accept) {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.addEventListener("change", () => {
      if (input.files && input.files[0]) openFile(input.files[0]);
    });
    input.click();
  }

  els.fileInput.addEventListener("change", () => {
    const f = els.fileInput.files && els.fileInput.files[0];
    if (f) {
      if (/\.(opf|db|csv|json|txt|odb)$/i.test(f.name)) openFile(f);
      else video.loadFile(f);
    }
    els.fileInput.value = "";
  });

  /* ------------------------------------------------------- 新建列对话框 */

  function openColumnDialog() {
    els.dlgColName.value = "";
    els.dlgColType.value = "TEXT";
    els.dlgCodesRow.hidden = true;
    els.dlgColCodes.value = "code01, code02";
    els.dlgColumn.showModal();
    els.dlgColName.focus();
  }

  els.dlgColType.addEventListener("change", () => {
    els.dlgCodesRow.hidden = els.dlgColType.value !== "MATRIX";
  });

  els.dlgColumn.addEventListener("close", () => {
    if (els.dlgColumn.returnValue !== "ok") return;
    const name = els.dlgColName.value.trim();
    const type = els.dlgColType.value;
    const codes = els.dlgColCodes.value.split(",").map((s) => s.trim()).filter(Boolean);
    try {
      store.addColumn(name, type, type === "MATRIX" ? codes : null);
      msg(`已新建列 ${name}（${type}）`, "ok");
    } catch (e) {
      msg(e.message, "err");
      setTimeout(openColumnDialog, 30);
    }
  });

  /* ------------------------------------------------------------ 说明框 */

  function showInfo(title, html) {
    els.infoTitle.textContent = title;
    els.infoBody.innerHTML = html;
    els.dlgInfo.showModal();
  }
  $("info-close").addEventListener("click", () => els.dlgInfo.close());

  const HELP_KEYS = `
    <table>
      <tr><th>动作</th><th>快捷键</th></tr>
      <tr><td>播放 / 暂停</td><td><code>空格</code></td></tr>
      <tr><td>前进 / 后退一帧</td><td><code>→</code> / <code>←</code></td></tr>
      <tr><td>前进 / 后退 1 秒</td><td><code>L</code> / <code>J</code></td></tr>
      <tr><td>跳到开头 / 结尾</td><td><code>Home</code> / <code>End</code></td></tr>
      <tr><td>把选中行的起点设为播放头</td><td><code>I</code></td></tr>
      <tr><td>把选中行的终点设为播放头</td><td><code>O</code></td></tr>
      <tr><td>在播放头新建行</td><td><code>N</code></td></tr>
      <tr><td>在选中行之后 / 之前新建</td><td><code>⌘R</code> / <code>⌘L</code></td></tr>
      <tr><td>删除选中行</td><td><code>Delete</code></td></tr>
      <tr><td>撤销 / 重做</td><td><code>⌘Z</code> / <code>⇧⌘Z</code></td></tr>
      <tr><td>新建列</td><td><code>⌘K</code></td></tr>
      <tr><td>时间对齐开关</td><td><code>⌘T</code></td></tr>
      <tr><td>缩放</td><td><code>⌘+</code> <code>⌘-</code> <code>⌘0</code></td></tr>
      <tr><td>保存 .opf / 打开</td><td><code>⌘S</code> / <code>⌘O</code></td></tr>
      <tr><td>跳到当前行起点 / 终点</td><td><code>+</code> / <code>⇧+</code></td></tr>
    </table>`;

  const HELP_ABOUT = `
    <p>本程序是 <strong>Datavyu 的网页重实现</strong>，目标不是 100% 复刻界面，而是：
    ① 能读写 Datavyu 的 <code>.opf</code> 工程文件；② 导出格式与原版逐字符一致；③ 不需要安装、不需要 Java。</p>
    <h4>已经做到</h4>
    <ul>
      <li>列 / 行 / 起止时间 / 文本、分类、矩阵三种列类型的完整编辑</li>
      <li><code>.opf</code>（ZIP：project + db）读写，含隐藏列、矩阵子码类型、未知条目原样保留</li>
      <li><code>#4</code> 数据库文本、每行一个 cell 的 CSV、逐帧 CSV 三种格式读写</li>
      <li>视频联动：帧精确跳转、<code>I</code>/<code>O</code> 打点、时间轴拖动改起止、撤销重做</li>
    </ul>
    <h4>与原版的已知差异（有意为之）</h4>
    <ul>
      <li>原版「Export File…」忽略文件过滤器、永远只出 cell CSV；这里分成三个明确的导出项</li>
      <li>原版每行 cell CSV 行尾多一个逗号且表头被 trim；默认保持兼容，另外提供 strict 模式</li>
      <li>原版逐帧 CSV 循环上界多一帧；默认按实际长度输出，可开关复刻</li>
      <li>原版 <code>.odb</code> 保存分支是死代码（静默不写文件）；这里不再提供这个入口</li>
      <li>列重名/非法列名原版静默覆盖，这里直接报错</li>
    </ul>
    <h4>合规与隐私</h4>
    <ul>
      <li>纯本地：没有后端、没有账号、不发任何网络请求；视频文件只在浏览器内解码播放</li>
      <li>自动存档写在浏览器 <code>localStorage</code>，清除方式见「文件 → 清除浏览器本地存档」</li>
    </ul>`;

  /* ------------------------------------------------------------ 菜单 */

  document.querySelectorAll(".menu").forEach((menu) => {
    const btn = menu.querySelector(".menu-btn");
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const wasOpen = menu.classList.contains("open");
      document.querySelectorAll(".menu.open").forEach((m) => m.classList.remove("open"));
      if (!wasOpen) menu.classList.add("open");
    });
  });
  document.addEventListener("click", () => document.querySelectorAll(".menu.open").forEach((m) => m.classList.remove("open")));

  const actions = {
    new() {
      if (store.db.cellCount() && !confirm("新建会清空当前工程（浏览器存档也会被覆盖）。继续？")) return;
      store.newProject("untitled");
      msg("已新建空工程", "ok");
    },
    open() {
      openViaPicker(".opf,.db,.csv,.json,.txt,.odb");
    },
    "save-opf"() {
      const bytes = store.toOpfBytes();
      download(baseName() + ".opf", bytes, "application/zip");
      store.dirty = false;
      renderStatus();
      msg("已导出 .opf（Datavyu 可以直接打开；ZIP 内含 project + db）", "ok");
    },
    "export-cells"() {
      download(baseName() + ".cells.csv", store.toCellsCsv(), "text/csv;charset=utf-8");
      msg("已导出「每行一个 cell」CSV（与原版 Export File… 一致，含行尾逗号）", "ok");
    },
    "export-frames"() {
      download(baseName() + ".frames.csv", store.toFrameCsv(), "text/csv;charset=utf-8");
      msg(`已导出逐帧 CSV（${store.fps} fps，共 ${store.toFrameCsv().trim().split("\n").length - 1} 帧）`, "ok");
    },
    "export-json"() {
      download(baseName() + ".json", store.toJsonText(), "application/json");
      msg("已导出本程序 JSON（含全部列与行，可再导入）", "ok");
    },
    "clear-local"() {
      if (!confirm("清除浏览器里保存的自动存档？当前界面上的内容不受影响。")) return;
      store.clearAutosave();
      msg("已清除浏览器自动存档", "ok");
    },
    undo() {
      msg(store.undo() ? "已撤销" : "没有可撤销的操作");
    },
    redo() {
      msg(store.redo() ? "已重做" : "没有可重做的操作");
    },
    "add-column": openColumnDialog,
    "toggle-align"() {
      const next = !grid.aligned;
      els.chkAlign.checked = next;
      grid.setAligned(next);
      msg(next ? "时间对齐：开" : "时间对齐：关");
    },
    "show-all"() {
      store.apply("显示所有列", (db) => db.columns.forEach((c) => (c.hidden = false)));
      msg("已显示所有列", "ok");
    },
    "zoom-in"() {
      grid.setZoom(grid.zoom + 0.15);
    },
    "zoom-out"() {
      grid.setZoom(grid.zoom - 0.15);
    },
    "zoom-reset"() {
      grid.setZoom(1);
    },
    "side-toggle"() {
      els.sidebar.classList.toggle("collapsed");
    },
    "timeline-toggle"() {
      els.timeline.classList.toggle("hidden");
    },
    "help-keys"() {
      showInfo("快捷键", HELP_KEYS);
    },
    "help-about"() {
      showInfo("关于 Datavyu 网页版", HELP_ABOUT);
    },
  };

  document.querySelectorAll(".menu-pop button").forEach((b) => {
    b.addEventListener("click", () => {
      const fn = actions[b.dataset.act];
      document.querySelectorAll(".menu.open").forEach((m) => m.classList.remove("open"));
      if (fn) {
        try {
          fn();
        } catch (e) {
          msg(e.message, "err");
        }
      }
    });
  });

  /* ---------------------------------------------------------- 控件绑定 */

  els.chkAlign.addEventListener("change", () => grid.setAligned(els.chkAlign.checked));
  els.chkLive.addEventListener("change", () => {
    store.liveFollow = els.chkLive.checked;
  });
  $("btn-add-column").addEventListener("click", openColumnDialog);

  $("btn-set-onset").addEventListener("click", () => {
    const col = store.selectedColumn;
    const cell = store.selectedCell;
    if (!col || !cell) return msg("先在表格里选中一个行（点一下 cell）", "err");
    store.setCellTime(col.id, cell.id, "onset", store.time);
    msg(`起点已设为 ${U.msToTimestamp(store.time)}`, "ok");
  });

  $("btn-set-offset").addEventListener("click", () => {
    const col = store.selectedColumn;
    const cell = store.selectedCell;
    if (!col || !cell) return msg("先在表格里选中一个行", "err");
    store.setCellTime(col.id, cell.id, "offset", store.time);
    msg(`终点已设为 ${U.msToTimestamp(store.time)}`, "ok");
  });

  $("btn-new-cell").addEventListener("click", () => newCellHere());

  function newCellHere() {
    let col = store.selectedColumn;
    if (!col) col = store.db.columns.find((c) => !c.hidden) || store.db.columns[0];
    if (!col) return msg("先新建一列", "err");
    try {
      store.addCell(col.id, store.time, store.time);
      msg(`已在 ${col.name} 的 ${U.msToTimestamp(store.time)} 新建行`, "ok");
    } catch (e) {
      msg(e.message, "err");
    }
  }

  /* -------------------------------------------------------- 快捷键 */

  function isTyping(el) {
    if (!el) return false;
    const tag = el.tagName;
    return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
  }

  document.addEventListener("keydown", (e) => {
    if (isTyping(e.target)) return;
    const col = store.selectedColumn;
    const cell = store.selectedCell;
    const mod = e.metaKey || e.ctrlKey;

    if (mod) {
      const k = e.key.toLowerCase();
      if (k === "z") {
        e.preventDefault();
        e.shiftKey ? store.redo() : store.undo();
        return;
      }
      if (k === "s") {
        e.preventDefault();
        actions["save-opf"]();
        return;
      }
      if (k === "o") {
        e.preventDefault();
        actions.open();
        return;
      }
      if (k === "n") {
        e.preventDefault();
        actions.new();
        return;
      }
      if (k === "k") {
        e.preventDefault();
        openColumnDialog();
        return;
      }
      if (k === "t") {
        e.preventDefault();
        actions["toggle-align"]();
        return;
      }
      if (k === "r" && col) {
        e.preventDefault();
        const c = store.addCellRelative(col.id, cell ? cell.id : null, 1);
        if (c) msg("已在右侧新建行", "ok");
        return;
      }
      if (k === "l" && col) {
        e.preventDefault();
        const c = store.addCellRelative(col.id, cell ? cell.id : null, -1);
        if (c) msg("已在左侧新建行", "ok");
        return;
      }
      if (e.key === "=" || e.key === "+") {
        e.preventDefault();
        grid.setZoom(grid.zoom + 0.15);
        return;
      }
      if (e.key === "-" || e.key === "_") {
        e.preventDefault();
        grid.setZoom(grid.zoom - 0.15);
        return;
      }
      if (e.key === "0") {
        e.preventDefault();
        grid.setZoom(1);
        return;
      }
      return;
    }

    switch (e.key) {
      case " ":
        e.preventDefault();
        video.togglePlay();
        break;
      case "ArrowRight":
        e.preventDefault();
        e.shiftKey ? video.stepSeconds(1) : video.stepFrames(1);
        break;
      case "ArrowLeft":
        e.preventDefault();
        e.shiftKey ? video.stepSeconds(-1) : video.stepFrames(-1);
        break;
      case "Home":
        e.preventDefault();
        video.toStart();
        break;
      case "End":
        e.preventDefault();
        video.toEnd();
        break;
      case "l":
      case "L":
        video.stepSeconds(1);
        break;
      case "j":
      case "J":
        video.stepSeconds(-1);
        break;
      case "i":
      case "I":
        $("btn-set-onset").click();
        break;
      case "o":
      case "O":
        $("btn-set-offset").click();
        break;
      case "n":
      case "N":
        newCellHere();
        break;
      case "+":
        if (cell) video.seekTo(cell.onset);
        break;
      case "=":
        if (cell) video.seekTo(cell.onset);
        break;
      case "Backspace":
      case "Delete":
        if (col && cell) {
          e.preventDefault();
          store.removeCell(col.id, cell.id);
          msg("已删除选中行", "ok");
        }
        break;
      default:
        break;
    }
  });

  document.addEventListener("keydown", (e) => {
    if (isTyping(e.target)) return;
    if (e.shiftKey && e.key === "+" && store.selectedCell) {
      video.seekTo(store.selectedCell.offset);
    }
  });

  /* -------------------------------------------------------- 分隔条拖动 */

  function bindRowSplitter(el, target, { min, max, invert = false }) {
    let startY = 0;
    let startH = 0;
    el.addEventListener("mousedown", (e) => {
      e.preventDefault();
      startY = e.clientY;
      startH = target.getBoundingClientRect().height;
      const onMove = (ev) => {
        let h = startH + (invert ? -(ev.clientY - startY) : ev.clientY - startY);
        h = U.clamp(h, min, max());
        target.style.height = h + "px";
      };
      const onUp = () => {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        grid.render();
        timeline.render();
      };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    });
  }

  bindRowSplitter($("splitter-player"), document.querySelector(".player"), {
    min: 150,
    max: () => window.innerHeight - 220,
  });
  bindRowSplitter($("splitter-timeline"), els.timeline, {
    min: 70,
    max: () => window.innerHeight - 260,
    invert: true,
  });

  /* --------------------------------------------------- 初始状态与提示 */

  window.addEventListener("beforeunload", (e) => {
    if (!store.dirty) return;
    e.preventDefault();
    e.returnValue = "";
  });

  /* ---------------------------------------------------- 演示数据钩子
   * 用途：① 新用户一眼看懂这个工具长什么样；② 自动化截图/验收需要一个有内容的状态。
   * 只在 URL 带 ?demo=1 时生效，且不写入 localStorage（避免污染真实工作）。
   */
  function loadDemo() {
    store.newProject("示例工程");
    store.apply("载入示例数据", (db) => {
      const mk = (name, type, codes, rows) => {
        const col = db.addColumn(name, type, codes, codes ? codes.map(() => "NOMINAL") : null);
        for (const [on, off, val] of rows) {
          const v =
            type === "MATRIX"
              ? new DVY.model.MatrixValue(col.codes, val, col.codeTypes)
              : new DVY.model.Value(val);
          col.addCell(new DVY.model.Cell(on, off, v));
        }
        return col;
      };
      mk("gaze", "NOMINAL", null, [
        [0, 2400, "母亲"], [2400, 4100, "玩具"], [4100, 7000, "母亲"], [7000, 9000, "镜头外"],
      ]);
      mk("gesture", "MATRIX", ["code01", "code02"], [
        [1200, 1900, ["指点", "右手"]], [2600, 3000, ["伸手", "左手"]], [5200, 6400, ["拍手", "双手"]],
      ]);
      mk("vocal", "TEXT", null, [
        [500, 1500, "咿呀发声"], [3000, 3600, "笑"], [6600, 7200, "叫妈妈"],
      ]);
      mk("notes", "TEXT", null, [[0, 400, "起点：母亲进入画面"]]);
    });
    store.dirty = false;
    store.time = 0;
    store.clearAutosave();
    renderColumns();
    renderStatus();
    msg("已载入示例数据（?demo=1）。改完记得「保存工程 .opf」。", "ok");
  }

  renderColumns();
  renderStatus();

  if (new URLSearchParams(location.search).get("demo") === "1") {
    loadDemo();
  } else if (!store.db.columns.length) {
    msg("空的：点「工作表 → 新建列」开始，或「文件 → 打开」载入 .opf / CSV", "");
  } else {
    msg(`已从浏览器自动存档恢复：${store.db.columns.length} 列 ${store.db.cellCount()} 行`, "ok");
  }

  // 暴露给控制台/自动化测试
  globalThis.DVY.app = { store, video, grid, timeline, actions };
})();
