/* ui/markstrip.js —— 即时打点条（事件记录器）
 *
 * 用户要的手感：**点一下分类 = 开始，再点一下 = 结束**。
 * 这是行为编码里最快的记录方式 —— 编码员眼睛盯视频，手指只按一个键，
 * 不用先「新建行」再「设起点/终点」。
 *
 * 键盘分配：1..9 对应前 9 个分类，0 对应第 10 个。
 * 这个映射由 store.markColumns 的顺序决定，而顺序来自注册顺序，
 * 所以「先注册的先占数字键」—— 最常用的分类自然拿到最好按的键。
 *
 * Esc 放弃正在录制的打点（比如发现按错了）。
 */

(function () {
  const U = globalThis.DVY.util;
  const T = globalThis.DVY.timeutil;

  function mount(store, els) {
    const chips = new Map(); // colId -> { el, timeEl }
    let addMenuOpen = false;

    /* ------------------------------------------------------------ 渲染 */

    function render() {
      const box = els.markStrip;
      const cols = store.markColumns.map((id) => store.db.getColumnById(id)).filter(Boolean);
      chips.clear();
      box.innerHTML = "";

      // 正在录制中的分类排前面，方便一眼看到
      const ordered = cols.slice().sort((a, b) => {
        const am = store.isMarking(a.id) ? 0 : 1;
        const bm = store.isMarking(b.id) ? 0 : 1;
        return am - bm;
      });

      ordered.forEach((col) => {
        const slot = store.markColumns.indexOf(col.id); // 0-based，决定数字键
        const chip = document.createElement("button");
        chip.className = "mchip" + (store.isMarking(col.id) ? " rec" : "");
        chip.type = "button";
        chip.style.setProperty("--chip-color", T.colorFor(col.name));
        chip.title = buildTitle(col, slot);

        const key = document.createElement("span");
        key.className = "mkey";
        key.textContent = slot < 9 ? String(slot + 1) : slot === 9 ? "0" : "·";

        const dot = document.createElement("span");
        dot.className = "mdot";

        const name = document.createElement("span");
        name.className = "mname";
        name.textContent = col.name;

        const state = document.createElement("span");
        state.className = "mstate";
        if (store.isMarking(col.id)) {
          state.textContent = "● 录制中 " + short(store.time - store.marking[col.id]);
        } else {
          state.textContent = col.cells.length ? `${col.cells.length} 段` : "未记录";
        }

        const off = document.createElement("span");
        off.className = "moff";
        off.textContent = "✕";
        off.title = "从打点条移除（列本身和数据都保留）";
        off.addEventListener("click", (e) => {
          e.stopPropagation();
          store.registerMark(col.id, false);
        });

        chip.append(key, dot, name, state, off);
        chip.addEventListener("click", () => doMark(col));
        box.appendChild(chip);
        chips.set(col.id, { el: chip, timeEl: state, col });
      });

      // 添加按钮
      const avail = store.db.columns.filter((c) => !store.markColumns.includes(c.id));
      const addBtn = document.createElement("button");
      addBtn.className = "madd";
      addBtn.type = "button";
      addBtn.disabled = !avail.length;
      addBtn.textContent = avail.length ? "＋ 置类型" : "＋ 置类型（没有可用列）";
      addBtn.title = avail.length
        ? "把某一列注册到打点条，用数字键直接打点"
        : "所有列都已经在打点条上了；需要先「工作表 → 新建列」";
      addBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        toggleAddMenu(addBtn, avail);
      });
      box.appendChild(addBtn);

      els.markHint.textContent = cols.length
        ? `数字键 1-9 / 0 打点 · Esc 放弃正在录制的 · 单击分类也可以`
        : `还没有注册分类。点「＋ 置类型」把要编码的行为放上来。`;

      renderNow();
    }

    function buildTitle(col, slot) {
      const keyTxt = slot < 10 ? `数字键 ${slot === 9 ? "0" : slot + 1}` : "（超出 10 个，只能用鼠标）";
      return [
        `${col.name} · ${col.type}`,
        `快捷键：${keyTxt}`,
        store.isMarking(col.id) ? "正在录制：再按一次结束" : "按一次开始，再按一次结束",
        "✕ 只会把它从打点条移除，列和数据都还在",
      ].join("\n");
    }

    function toggleAddMenu(anchor, avail) {
      const old = document.querySelector(".madd-pop");
      if (old) {
        old.remove();
        addMenuOpen = false;
        return;
      }
      const pop = document.createElement("div");
      pop.className = "madd-pop";
      for (const col of avail) {
        const b = document.createElement("button");
        b.type = "button";
        b.innerHTML = `<span class="mdot" style="background:${T.colorFor(col.name)}"></span>${escapeHtml(col.name)}<span class="ty">${col.type}</span>`;
        b.addEventListener("click", () => {
          store.registerMark(col.id, true);
          pop.remove();
          addMenuOpen = false;
        });
        pop.appendChild(b);
      }
      anchor.parentElement.appendChild(pop);
      addMenuOpen = true;
      const close = (ev) => {
        if (pop.contains(ev.target)) return;
        pop.remove();
        addMenuOpen = false;
        document.removeEventListener("click", close);
      };
      setTimeout(() => document.addEventListener("click", close), 0);
    }

    function escapeHtml(s) {
      return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
    }

    function short(ms) {
      const v = Math.max(0, Math.round(ms)) / 1000;
      if (v < 60) return v.toFixed(2) + "s";
      return Math.floor(v / 60) + ":" + String(Math.floor(v % 60)).padStart(2, "0");
    }

    /** 播放头移动时只更新「录制中」的计时文本，不重建整条 */
    function renderNow() {
      els.markNow.textContent = U.msToTimestamp(Math.round(store.time));
    }

    function tickRecording() {
      for (const [colId, ref] of chips) {
        if (!store.isMarking(colId)) continue;
        ref.timeEl.textContent = "● 录制中 " + short(store.time - store.marking[colId]);
      }
      renderNow();
    }

    /* ------------------------------------------------------------ 打点 */

    function doMark(col) {
      /* 关键顺序：结束打点会在 store 里走 apply() → emit("db") → 表格重建。
       * 所以「打完自动把光标放进新行值里」要多渲染一轮就会把编辑器换掉，
       * 这里改用「推迟到本轮 DOM 稳定之后」的方式（见 renderQueue），不抢渲染。 */
      let r;
      try {
        r = store.toggleMark(col.id);
      } catch (err) {
        store.emit("msg", { text: err.message, kind: "err" });
        return;
      }
      if (r.action === "start") {
        store.emit("msg", { text: `▶ ${col.name} 开始 @ ${U.msToTimestamp(r.onset)}（再按一次结束）`, kind: "" });
      } else {
        // 结束之后把光标送进新行的值里：等这一轮渲染结束（microtask）再请求，
        // 这样只会多一次「开编辑器」，不会把用户手上的 DOM 换掉
        if (r.cell && els.onMarked) {
          const cellId = r.cell.id;
          queueMicrotask(() => {
            try {
              els.onMarked(col.id, cellId);
            } catch (err) {
              console.warn("auto edit after mark failed", err);
            }
          });
        }
        const sec = ((r.offset - r.onset) / 1000).toFixed(2);
        store.emit("msg", {
          text: `■ ${col.name} ${U.msToTimestamp(r.onset)} → ${U.msToTimestamp(r.offset)}（${sec}s）`,
          kind: "ok",
        });
      }
    }

    /** 返回 true 表示这个按键已被打点条消费（app.js 不再处理） */
    function handleKey(e) {
      if (e.metaKey || e.ctrlKey || e.altKey) return false;

      if (e.key === "Escape" && store.markingCount) {
        const n = store.cancelMark();
        store.emit("msg", { text: `已放弃 ${n} 个正在录制的打点`, kind: "" });
        return true;
      }

      if (!/^[0-9]$/.test(e.key)) return false;
      const slot = e.key === "0" ? 10 : Number(e.key);
      const col = store.markColumnForSlot(e.key === "0" ? 0 : slot);
      if (!col) return false;
      e.preventDefault();
      doMark(col);
      return true;
    }

    /* -------------------------------------------------------- 事件订阅 */

    store.on("marks", render);
    store.on("db", render);
    store.on("sel", render);
    // 播放头每帧都在动，只更新计时文本
    store.on("frame", tickRecording);
    store.on("time", tickRecording);

    render();

    return { render, handleKey, doMark, get addMenuOpen() { return addMenuOpen; } };
  }

  globalThis.DVY = globalThis.DVY || {};
  globalThis.DVY.ui = globalThis.DVY.ui || {};
  globalThis.DVY.ui.markstrip = { mount };
})();
