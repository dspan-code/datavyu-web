/* ui/grid.js —— 电子表格网格
 *
 * 两种显示模式（对应原版的 Temporal Alignment 开关）：
 *   对齐模式：cell 的宽度 ∝ 时长，横向绝对定位；重叠的 cell 自动分「泳道」上下错开。
 *   堆叠模式：每列一竖排，只显示顺序，不体现时间。
 *
 * 时间码编辑：点时间码 → 输入框；左右拖动 → 以 10ms/px 微调。
 * 值编辑：点值 → contenteditable，回车/失焦提交（一次性提交，不产生逐字符撤销记录）。
 */

(function () {
  const U = globalThis.DVY.util;
  const T = globalThis.DVY.timeutil;

  const GUTTER = 186; // 左侧时间槽宽度（与 CSS .thead .th-time 保持一致）
  const COL_W = 236;
  const LANE_H = 46;
  const LANE_H_MATRIX = 60; // 矩阵列要放「子码名: 值」，给高一点
  const DRAG_MS_PER_PX = 10;

  function mount(store, els) {
    let aligned = true;
    let zoom = 1;
    let viewStart = 0; // 对齐模式下的左边界（毫秒）
    let drag = null;
    const MAX_ALIGNED = 400;

    // 编辑辅助：按「列 → 时间排序后的行序」定位一个 cell，用于 Tab / 方向键跳格和外部请求编辑
    let editIndex = new Map(); // colId -> cell 数组（已排序）
    let pendingEdit = null; // { colId, cellId, codeIndex }
    let focusCell = null; // { colId, cellId } —— 键盘操作后要聚焦/滚动到的 cell
    let activeEditor = null; // 正在编辑的 DOM 节点，用于「编辑期间不重建 DOM」
    let renderQueued = false; // 有渲染请求被推迟了

    function isEditing() {
      return !!activeEditor;
    }

    /** 编辑期间推迟重建：否则正在输入的框会被换掉，键入丢失 */
    function queueRender() {
      renderQueued = true;
    }
    function flushQueuedRender() {
      if (!renderQueued) return;
      if (activeEditor) return; // 还在编辑，继续等
      renderQueued = false;
      render();
    }

    /**
     * 强制结束当前编辑（不提交）。
     * 必须在「整表换数据」的场景调用：newProject / 打开文件 / 撤销。
     * 否则会留下一个悬挂的 activeEditor，让后续渲染全部被推迟 ——
     * 现象是"表格停在上一个项目的内容上"，非常难查（这个坑踩过一次）。
     */
    function endEdit() {
      if (activeEditor && activeEditor.blur) activeEditor.blur();
      activeEditor = null;
      // 兜底：万一有人把编辑器节点直接从 DOM 里摘掉了（blur 不会触发），也要清掉
      const stale = els.grid.querySelector(".cb-val.editing");
      if (stale) {
        stale.contentEditable = "false";
        stale.classList.remove("editing");
      }
    }

    function span() {
      const r = store.db.timeRange;
      const end = Math.max(r.end, r.start + 1000);
      return { start: r.start, end };
    }

    /* -------------------------------------------------------- 编辑辅助 */

    function columnCells(col) {
      return editIndex.get(col.id) || col.sorted();
    }

    function startEdit(col, cell, codeIndex) {
      requestEdit(col.id, cell.id, codeIndex);
    }

    /** 供外部（打点条/菜单/快捷键）请求打开某个 cell 的编辑器 */
    function requestEdit(columnId, cellId, codeIndex = null) {
      pendingEdit = { colId: columnId, cellId, codeIndex };
      render();
    }

    function afterRenderFocus() {
      if (pendingEdit) {
        const col = store.db.getColumnById(pendingEdit.colId);
        const cell = col && col.getCell(pendingEdit.cellId);
        if (col && cell) {
          const box = els.grid.querySelector(`.cellbox[data-cell-id="${cell.id}"]`);
          if (box) {
            const target = box.querySelector(".cb-val");
            if (target) startValueEdit(target, col, cell, pendingEdit.codeIndex);
          }
        }
        pendingEdit = null;
        return;
      }
      if (focusCell) {
        const box = els.grid.querySelector(`.cellbox[data-cell-id="${focusCell.cellId}"]`);
        if (box) {
          box.scrollIntoView({ block: "nearest", inline: "nearest" });
          if (focusCell.fromTime) scrollToTime(store.time);
        }
        focusCell = null;
      }
    }

    /* ---------------------------------------------------- 泳道分配算法 */

    /**
     * 把一组 cell 分配到尽量少的泳道：
     * 按 onset 排序，逐个放进「第一条尾部不超过它起点的泳道」。
     * 这是区间图着色的贪心解，对行为编码这种基本不重叠的数据 = 1 条泳道。
     */
    function assignLanes(cells) {
      const laneEnds = [];
      const place = [];
      for (const c of cells) {
        let lane = -1;
        for (let i = 0; i < laneEnds.length; i++) {
          if (laneEnds[i] <= c.onset) {
            lane = i;
            break;
          }
        }
        if (lane < 0) {
          lane = laneEnds.length;
          laneEnds.push(0);
        }
        laneEnds[lane] = Math.max(c.onset + 1, c.offset);
        place.push({ cell: c, lane });
      }
      return { place, lanes: Math.max(1, laneEnds.length) };
    }

    /* ------------------------------------------------------------ 渲染 */

    function render() {
      // 编辑器节点如果已经不在文档里（被上一次重建摘掉），就不能再算"正在编辑"，
      // 否则渲染会被永久推迟
      if (activeEditor && !document.contains(activeEditor)) {
        activeEditor = null;
      }
      if (activeEditor) {
        // 编辑期间数据可能变了（比如打点落了库），但先把这次渲染记下来，
        // 等编辑结束再补 —— 绝不能把正在输入的 DOM 换掉
        queueRender();
        return;
      }
      const grid = els.grid;
      const db = store.db;
      if (!db.columns.length) {
        grid.innerHTML = "";
        const empty = document.createElement("div");
        empty.className = "grid-empty";
        empty.style.cssText = "padding:40px;color:var(--fg-mute);text-align:center";
        empty.innerHTML = "<p>还没有任何列。</p><p>列 = 你要编码的一种行为（比如「注视」「手势」「发声」）。</p>";
        const b = document.createElement("button");
        b.className = "btn primary";
        b.textContent = "新建第一列";
        b.addEventListener("click", () => els.onAddColumn && els.onAddColumn());
        empty.appendChild(b);
        grid.appendChild(empty);
        els.sheetTitle.textContent = db.name || "工作表";
        return;
      }

      // 能走到这里是「没有活跃编辑器」，所以 DOM 里残留的 editing 类一定是孤儿
      const orphan = grid.querySelector(".cb-val.editing");
      if (orphan) {
        orphan.contentEditable = "false";
        orphan.classList.remove("editing");
      }
      const vis = db.columns.filter((c) => !c.hidden);
      const columns = vis.length ? vis : db.columns;
      editIndex = new Map(columns.map((c) => [c.id, c.sorted()]));
      const { start, end } = span();
      const totalMs = end - start;
      const width = GUTTER + columns.length * COL_W;
      grid.style.width = width + "px";

      const frag = document.createDocumentFragment();

      /* ---------------- 表头 ---------------- */
      const thead = document.createElement("div");
      thead.className = "thead";
      const thTime = document.createElement("div");
      thTime.className = "th-time";
      thTime.textContent = "时间 →";
      thead.appendChild(thTime);
      for (const col of columns) {
        const th = document.createElement("div");
        th.className = "th" + (col.id === store.selectedColumnId ? " sel" : "");
        th.style.width = COL_W + "px";
        th.title = `${col.name} · ${col.type} · ${col.cells.length} 行`;
        const name = document.createElement("div");
        name.className = "th-name";
        const dot = document.createElement("span");
        dot.style.cssText = `width:8px;height:8px;border-radius:50%;background:${T.colorFor(col.name)}`;
        const nm = document.createElement("span");
        nm.textContent = col.name;
        const ty = document.createElement("span");
        ty.className = "ty";
        ty.textContent = col.type;
        name.append(dot, nm, ty);
        th.appendChild(name);
        if (col.type === "MATRIX" && col.codes.length) {
          const codes = document.createElement("div");
          codes.className = "th-codes";
          for (const c of col.codes) {
            const s = document.createElement("span");
            s.textContent = c;
            codes.appendChild(s);
          }
          th.appendChild(codes);
        }
        th.addEventListener("click", () => store.select(col.id, null));
        thead.appendChild(th);
      }
      frag.appendChild(thead);

      /* ---------------- 表体 ---------------- */
      const body = document.createElement("div");
      body.className = "gbody";

      if (aligned) {
        // 可见窗口：整个时间范围，但 cell 太多时以播放头为中心截断
        let all = [];
        for (const col of columns) for (const c of col.sorted()) all.push({ col, c });
        all.sort((a, b) => a.c.onset - b.c.onset);
        const truncated = all.length > MAX_ALIGNED;
        if (truncated) {
          const idx = all.findIndex((x) => x.c.onset >= store.time);
          const from = Math.max(0, (idx < 0 ? all.length : idx) - Math.floor(MAX_ALIGNED / 2));
          all = all.slice(from, from + MAX_ALIGNED);
        }

        const lanesOf = new Map();
        let totalLanes = 1;
        const visibleIds = new Set(all.map((x) => x.c.id)); // Set 查询，避免 O(n²)
        for (const col of columns) {
          const cells = col.sorted().filter((c) => visibleIds.has(c.id));
          const { place, lanes } = assignLanes(cells);
          lanesOf.set(col.id, new Map(place.map((p) => [p.cell.id, p.lane])));
          totalLanes = Math.max(totalLanes, lanes);
        }
        const rowH = totalLanes * LANE_H;
        body.style.height = Math.max(rowH + 12, 80) + "px";

        // 竖向泳道参考线
        for (let i = 1; i < totalLanes; i++) {
          const line = document.createElement("div");
          line.className = "grow-line";
          line.style.top = i * LANE_H + "px";
          body.appendChild(line);
        }

        for (let ci = 0; ci < columns.length; ci++) {
          const col = columns[ci];
          const laneMap = lanesOf.get(col.id) || new Map();
          const left0 = GUTTER + ci * COL_W;
          for (const c of col.cells) {
            if (!laneMap.has(c.id)) continue;
            const h = (col.type === "MATRIX" && col.codes.length > 1 ? LANE_H_MATRIX : LANE_H) - 8;
            body.appendChild(makeCellBox(col, c, {
              left: left0 + ((c.onset - start) / totalMs) * COL_W,
              width: Math.max(6, ((c.offset - c.onset) / totalMs) * COL_W),
              top: laneMap.get(c.id) * LANE_H + 4,
              height: h,
            }));
          }
          // 该列底部一个「加行」按钮
          const add = document.createElement("button");
          add.className = "addbtn";
          add.style.cssText = `position:absolute;left:${left0 + 4}px;width:${COL_W - 8}px;top:${rowH + 2}px`;
          add.textContent = "＋ 在播放头新建行";
          add.addEventListener("click", () => {
            store.select(col.id, null);
            els.onNewCell(col.id, store.time);
          });
          body.appendChild(add);
        }

        if (truncated) {
          const note = document.createElement("div");
          note.style.cssText = `position:absolute;right:8px;top:${rowH + 4}px;color:var(--fg-mute);font-size:11.5px`;
          note.textContent = `行数较多，当前只渲染播放头附近 ${MAX_ALIGNED} 行（导出不受影响）`;
          body.appendChild(note);
        }
      } else {
        // 堆叠模式：每列一竖排
        const wrap = document.createElement("div");
        wrap.className = "grow-stacked";
        const gutter = document.createElement("div");
        gutter.style.cssText = `flex:0 0 ${GUTTER}px;border-right:1px solid var(--line-soft);padding:6px 8px;color:var(--fg-mute);font-size:11px`;
        gutter.textContent = "列 →";
        wrap.appendChild(gutter);
        for (const col of columns) {
          const box = document.createElement("div");
          box.className = "stack-col";
          box.style.width = COL_W - 8 + "px";
          const sorted = col.sorted();
          sorted.forEach((c, i) => box.appendChild(makeCellBox(col, c, { stacked: true, index: i })));
          const add = document.createElement("button");
          add.className = "addbtn";
          add.textContent = "＋ 新建行";
          add.addEventListener("click", () => {
            store.select(col.id, null);
            els.onNewCell(col.id, store.time);
          });
          box.appendChild(add);
          wrap.appendChild(box);
        }
        body.appendChild(wrap);
      }

      frag.appendChild(body);
      grid.innerHTML = "";
      grid.appendChild(frag);
      els.sheetTitle.textContent = db.name || "工作表";
      afterRenderFocus();
    }

    /* ------------------------------------------------------- 单个 cell */

    function makeCellBox(col, cell, geo) {
      const box = document.createElement("div");
      box.className = "cellbox" + (cell.id === store.selectedCellId ? " sel" : "");
      box.dataset.cellId = cell.id;
      box.dataset.colId = col.id;
      box.tabIndex = 0; // 让方向键/回车能用（单击即可聚焦）
      box.title = "单击选中 · 再单击值进入编辑 · 方向键跳格 · ⌘↑ 复制上一行的值";
      box.style.borderLeftColor = T.colorFor(col.name);
      if (geo.stacked) {
        box.style.position = "relative";
        box.style.minHeight = "34px";
      } else {
        box.style.left = geo.left + "px";
        box.style.top = geo.top + "px";
        box.style.width = geo.width + "px";
        box.style.height = geo.height + "px";
      }

      const times = document.createElement("div");
      times.className = "cb-times";
      const on = document.createElement("span");
      on.className = "cb-time";
      on.textContent = U.msToTimestamp(cell.onset);
      on.title = "点一下输入，或左右拖动微调起点";
      const off = document.createElement("span");
      off.className = "cb-time";
      off.textContent = U.msToTimestamp(cell.offset);
      off.title = "点一下输入，或左右拖动微调终点";
      times.append(on, off);
      box.appendChild(times);

      const val = document.createElement("div");
      val.className = "cb-val";
      renderValue(val, col, cell);
      box.appendChild(val);

      // 右边缘拖动改终点
      const handle = document.createElement("div");
      handle.className = "cb-handle";
      handle.title = "拖动调整终点";
      box.appendChild(handle);

      box.addEventListener("mousedown", (e) => {
        if (e.target === handle || e.target === on || e.target === off) return;
        store.select(col.id, cell.id);
      });

      bindTimeDrag(on, col, cell, "onset");
      bindTimeDrag(off, col, cell, "offset");
      bindEdgeDrag(handle, col, cell);

      // 编辑入口从「双击」改成「单击值」——用户反馈双击不好使。
      // 注意两个事件的先后：mousedown 先开编辑（此刻不改 store，所以不会触发重渲染把节点换掉），
      // click 之后再走选中逻辑；select 触发的渲染会因为「正在编辑」被推迟。
      val.addEventListener("mousedown", (e) => {
        if (val.classList.contains("editing")) return;
        if (window.getSelection && String(window.getSelection()).length) return; // 正在选文字，别抢
        e.preventDefault();
        startValueEdit(val, col, cell);
      });
      val.addEventListener("click", (e) => {
        if (e.target !== val && val.contains(e.target) && val.isContentEditable) return;
        store.select(col.id, cell.id); // 渲染被推迟，不会打断上面的编辑
      });

      return box;
    }

    function renderValue(node, col, cell) {
      node.innerHTML = "";
      node.classList.remove("editing");
      if (col.type === "MATRIX") {
        col.codes.forEach((code, i) => {
          const v = cell.value ? cell.value.get(i) : "";
          const line = document.createElement("div");
          const label = document.createElement("span");
          label.className = "cb-code";
          label.textContent = code + ":";
          const text = document.createElement("span");
          if (v === "") {
            text.className = "cb-empty";
            text.textContent = "—";
          } else {
            text.textContent = v;
          }
          line.append(label, text);
          node.appendChild(line);
        });
      } else {
        const v = cell.value ? cell.value.toString() : "";
        if (v === "") {
          const s = document.createElement("span");
          s.className = "cb-empty";
          s.textContent = "（空）双击输入";
          node.appendChild(s);
        } else {
          node.textContent = v;
        }
      }
    }

    /* --------------------------------------------------------- 值编辑 */

    function startValueEdit(node, col, cell, codeIndex = null) {
      if (node.classList.contains("editing")) return;
      activeEditor = node;
      node.classList.add("editing");
      node.contentEditable = "true";
      node.spellcheck = false;
      node.title = "Enter 保存 · Shift+Enter 换行 · Esc 取消 · ⌘↑ 复制上一行";
      if (col.type === "MATRIX") {
        // 矩阵列：每行一个子码，用「码: 值」的文本编辑，⌘Enter 提交
        node.textContent = col.codes.map((c, i) => `${c}: ${cell.value ? cell.value.get(i) : ""}`).join("\n");
      } else {
        node.textContent = cell.value ? cell.value.toString() : "";
      }
      node.focus();
      const range = document.createRange();
      if (codeIndex !== null && codeIndex !== undefined && col.type === "MATRIX") {
        // 直接定位到被点的那一行子码，省一次手动移动光标
        const lines = node.childNodes;
        const line = lines[codeIndex];
        if (line) {
          const textLen = (line.textContent || "").length;
          const textNode = line.firstChild;
          if (textNode && textNode.nodeType === 3) range.setStart(textNode, textLen);
          else range.selectNodeContents(line);
          range.collapse(true);
        } else {
          range.selectNodeContents(node);
        }
      } else {
        range.selectNodeContents(node);
      }
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);

      const commit = () => {
        node.contentEditable = "false";
        node.classList.remove("editing");
        const raw = node.innerText.replace(/\u00a0/g, " ").replace(/\n$/, "");
        try {
          if (col.type === "MATRIX") {
            const vals = col.codes.map((c, i) => {
              const re = new RegExp("^\\s*" + c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*:\\s?(.*)$");
              for (const line of raw.split("\n")) {
                const m = re.exec(line);
                if (m) return m[1].trim();
              }
              const byOrder = raw.split("\n")[i];
              return byOrder === undefined ? "" : byOrder.trim();
            });
            col.codes.forEach((c, i) => {
              const cur = cell.value ? cell.value.get(i) : "";
              if (cur !== vals[i]) store.setCellValue(col.id, cell.id, vals[i], i);
            });
          } else {
            const cur = cell.value ? cell.value.toString() : "";
            if (cur !== raw) store.setCellValue(col.id, cell.id, raw);
          }
        } catch (err) {
          store.emit("msg", { text: "保存失败：" + err.message, kind: "err" });
        }
        renderValue(node, col, cell);
      };

      let cancelled = false;
      const leave = () => {
        activeEditor = null;
        queueMicrotask(flushQueuedRender); // 编辑结束后把推迟的渲染补上
      };
      node.addEventListener(
        "blur",
        () => {
          if (cancelled) {
            node.contentEditable = "false";
            node.classList.remove("editing");
            renderValue(node, col, cell);
            leave();
            return;
          }
          commit();
          leave();
        },
        { once: true },
      );
      node.addEventListener("keydown", (e) => {
        if (e.key === "Escape") {
          cancelled = true;
          node.blur();
          return;
        }
        // ⌘/Ctrl + ↑：把上一行的值复制过来（重复编码非常常见，省一次输入）
        if (e.key === "ArrowUp" && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          const cells = columnCells(col);
          const i = cells.findIndex((c) => c.id === cell.id);
          const prev = i > 0 ? cells[i - 1] : null;
          if (!prev) return;
          if (col.type === "MATRIX") {
            node.textContent = col.codes.map((c, k) => `${c}: ${prev.value ? prev.value.get(k) : ""}`).join("\n");
          } else {
            node.textContent = prev.value ? prev.value.toString() : "";
          }
          const r = document.createRange();
          r.selectNodeContents(node);
          const sl = window.getSelection();
          sl.removeAllRanges();
          sl.addRange(r);
          store.emit("msg", { text: "已复制上一行的值（Enter 保存）", kind: "" });
          return;
        }
        // Tab / ⇧Tab：保存并跳到下一格/上一格（像表格软件那样连续录）
        if (e.key === "Tab") {
          e.preventDefault();
          const dir = e.shiftKey ? -1 : 1;
          commit();
          moveSelection(dir);
          return;
        }
        if (col.type !== "MATRIX" && e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          commit();
          node.contentEditable = "false";
          node.classList.remove("editing");
          moveSelection(1);
          return;
        }
        if (col.type === "MATRIX" && e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          node.blur();
        }
      });
    }

    /* -------------------------------------------------------- 时间拖动 */

    function bindTimeDrag(el, col, cell, which) {
      el.addEventListener("mousedown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const startX = e.clientX;
        const startMs = cell[which];
        let moved = false;
        const onMove = (ev) => {
          const dx = ev.clientX - startX;
          if (Math.abs(dx) < 3) return;
          moved = true;
          const next = Math.max(0, Math.round(startMs + dx * DRAG_MS_PER_PX));
          el.textContent = U.msToTimestamp(next);
          el.style.color = "var(--accent)";
        };
        const onUp = (ev) => {
          document.removeEventListener("mousemove", onMove);
          document.removeEventListener("mouseup", onUp);
          el.style.color = "";
          if (moved) {
            const dx = ev.clientX - startX;
            const next = Math.max(0, Math.round(startMs + dx * DRAG_MS_PER_PX));
            store.setCellTime(col.id, cell.id, which, next);
          } else {
            startTimeInput(el, col, cell, which);
          }
        };
        document.addEventListener("mousemove", onMove);
        document.addEventListener("mouseup", onUp);
      });
    }

    function startTimeInput(el, col, cell, which) {
      const cur = U.msToTimestamp(cell[which]);
      const input = document.createElement("input");
      input.value = cur;
      input.style.cssText = "width:104px;font:11px/1.2 ui-monospace,Menlo,monospace;background:#0d1014;color:var(--fg);border:1px solid var(--accent);border-radius:3px;padding:1px 3px";
      el.textContent = "";
      el.appendChild(input);
      input.focus();
      input.select();
      const done = (apply) => {
        if (apply) {
          const ms = T.parseTimeInput(input.value, cell[which]);
          store.setCellTime(col.id, cell.id, which, ms);
        }
        render();
      };
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") done(true);
        else if (e.key === "Escape") done(false);
        e.stopPropagation();
      });
      input.addEventListener("blur", () => done(true));
    }

    function bindEdgeDrag(handle, col, cell) {
      handle.addEventListener("mousedown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        store.select(col.id, cell.id);
        const box = handle.parentElement;
        const startX = e.clientX;
        const startOffset = cell.offset;
        const onMove = (ev) => {
          const dx = ev.clientX - startX;
          const next = Math.max(cell.onset, Math.round(startOffset + dx * DRAG_MS_PER_PX));
          const t = box.querySelectorAll(".cb-time")[1];
          if (t) t.textContent = U.msToTimestamp(next);
        };
        const onUp = (ev) => {
          document.removeEventListener("mousemove", onMove);
          document.removeEventListener("mouseup", onUp);
          const dx = ev.clientX - startX;
          if (Math.abs(dx) >= 2) {
            const next = Math.max(cell.onset, Math.round(startOffset + dx * DRAG_MS_PER_PX));
            store.setCellTime(col.id, cell.id, "offset", next);
          }
        };
        document.addEventListener("mousemove", onMove);
        document.addEventListener("mouseup", onUp);
      });
    }

    /* -------------------------------------------------- 选择与键盘导航 */

    /** 在当前列的相邻 cell 之间移动选中（dir=+1 下一个，-1 上一个） */
    function moveSelection(dir) {
      const col = store.selectedColumn;
      if (!col) return;
      const cells = columnCells(col);
      if (!cells.length) return;
      const i = cells.findIndex((c) => c.id === store.selectedCellId);
      const next = cells[Math.max(0, Math.min(cells.length - 1, (i < 0 ? 0 : i) + dir))];
      if (!next) return;
      store.select(col.id, next.id);
      focusCell = { colId: col.id, cellId: next.id };
    }

    // 容器级键盘：↑↓ 上下行，←→ 只在没有 cell 被选中时让位给视频逐帧
    els.grid.addEventListener("keydown", (e) => {
      if (e.target.classList && e.target.classList.contains("editing")) return;
      if (e.target.isContentEditable) return;
      const col = store.selectedColumn;
      if (!col) return;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        e.stopPropagation();
        moveSelection(e.key === "ArrowDown" ? 1 : -1);
        return;
      }
      if (e.key === "Enter" && store.selectedCell) {
        e.preventDefault();
        e.stopPropagation();
        startEdit(col, store.selectedCell, null);
      }
    });

    /* ------------------------------------------------------ 对外接口 */

    function setAligned(v) {
      aligned = !!v;
      render();
    }
    function setZoom(z) {
      zoom = U.clamp(z, 0.7, 2.4);
      document.documentElement.style.setProperty("--zoom", String(zoom));
      render();
    }
    function scrollToTime(ms) {
      const { start, end } = span();
      const total = end - start || 1;
      const x = GUTTER + ((ms - start) / total) * (store.db.columns.length * COL_W);
      els.gridScroll.scrollLeft = Math.max(0, x - els.gridScroll.clientWidth / 2);
    }

    store.on("db", render);
    store.on("sel", render);
    render();

    return {
      render,
      setAligned,
      setZoom,
      scrollToTime,
      requestEdit,
      moveSelection,
      isEditing,
      endEdit,
      get aligned() {
        return aligned;
      },
      get zoom() {
        return zoom;
      },
    };
  }

  globalThis.DVY = globalThis.DVY || {};
  globalThis.DVY.ui = globalThis.DVY.ui || {};
  globalThis.DVY.ui.grid = { mount, GUTTER, COL_W };
})();
