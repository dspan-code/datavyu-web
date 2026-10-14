/* ui/timeline.js —— 时间轴轨道视图
 *
 * 每列一条轨道，cell 按时间画成色块；点击色块跳转，拖两端改起止。
 * 这一块是策略上「比原版好」的地方：原版只有表格 + Controller，没有全局时间轴，
 * 看多列之间的时间关系要靠脑补。
 */

(function () {
  const U = globalThis.DVY.util;
  const T = globalThis.DVY.timeutil;

  function mount(store, els) {
    let ratio = 40; // px / 秒
    let drag = null;
    let lastSpan = { start: 0, end: 1000 };

    function span() {
      const r = store.db.timeRange;
      const s = { start: Math.min(0, r.start), end: Math.max(r.end, 1000) };
      lastSpan = s;
      return s;
    }

    function render() {
      const body = els.timelineBody;
      const db = store.db;
      const cols = db.columns.filter((c) => !c.hidden);
      const { start, end } = span();
      const totalMs = Math.max(1, end - start);
      const width = Math.max(300, (totalMs / 1000) * ratio);

      body.innerHTML = "";

      if (!cols.length) {
        const p = document.createElement("div");
        p.style.cssText = "padding:14px;color:var(--fg-mute);font-size:12px";
        p.textContent = "还没有列，时间轴是空的。";
        body.appendChild(p);
        return;
      }

      /* ---------------- 时间刻度条 ---------------- */
      const bar = document.createElement("div");
      bar.className = "tl-timebar";
      const barName = document.createElement("div");
      barName.className = "tl-name";
      barName.textContent = "时间";
      const ticksBox = document.createElement("div");
      ticksBox.className = "tl-ticks";
      ticksBox.style.width = width + "px";
      for (const tk of T.ticks(start, end, width, 60)) {
        const d = document.createElement("div");
        d.className = "tl-tick";
        d.style.left = tk.pct + "%";
        const s = document.createElement("span");
        s.textContent = tk.label;
        d.appendChild(s);
        ticksBox.appendChild(d);
      }
      // 点击刻度条任意位置跳转
      ticksBox.addEventListener("mousedown", (e) => {
        const rect = ticksBox.getBoundingClientRect();
        const pct = (e.clientX - rect.left) / rect.width;
        els.onSeek(start + pct * totalMs);
      });
      bar.append(barName, ticksBox);
      body.appendChild(bar);

      /* ---------------- 每列一条轨道 ---------------- */
      for (const col of cols) {
        const row = document.createElement("div");
        row.className = "tl-row";
        const name = document.createElement("div");
        name.className = "tl-name";
        name.textContent = col.name;
        name.title = `${col.name} · ${col.cells.length} 行`;
        name.style.borderLeft = `3px solid ${T.colorFor(col.name)}`;
        const track = document.createElement("div");
        track.className = "tl-track";
        track.style.width = width + "px";

        for (const c of col.sorted()) {
          const leftPct = ((c.onset - start) / totalMs) * 100;
          const wPct = Math.max(0.15, ((c.offset - c.onset) / totalMs) * 100);
          const el = document.createElement("div");
          el.className = "tl-bar" + (c.id === store.selectedCellId ? " sel" : "");
          el.style.left = leftPct + "%";
          el.style.width = wPct + "%";
          el.title = `${U.msToTimestamp(c.onset)} → ${U.msToTimestamp(c.offset)} (${c.duration}ms)\n点击跳转，拖两端改起止`;
          const label = document.createElement("span");
          label.textContent = preview(c, col);
          el.appendChild(label);

          const hl = document.createElement("div");
          hl.className = "tl-h l";
          const hr = document.createElement("div");
          hr.className = "tl-h r";
          el.append(hl, hr);

          el.addEventListener("mousedown", (e) => {
            if (e.target === hl || e.target === hr) return;
            store.select(col.id, c.id);
            els.onSeek(c.onset);
          });
          bindHandle(hl, track, col, c, "onset", totalMs);
          bindHandle(hr, track, col, c, "offset", totalMs);
          track.appendChild(el);
        }

        row.append(name, track);
        body.appendChild(row);
      }

      /* ---------------- 播放头（绝对定位，跨越所有轨道） ---------------- */
      const ph = document.createElement("div");
      ph.className = "tl-playhead";
      ph.style.left = `calc(118px + ${((store.time - start) / totalMs) * 100}%)`;
      ph.style.right = "auto";
      body.appendChild(ph);
    }

    function preview(cell, col) {
      const v = cell.value ? cell.value.toString() : "";
      const s = v.length > 14 ? v.slice(0, 14) + "…" : v;
      return s || col.name;
    }

    function bindHandle(handle, track, col, cell, which, totalMs) {
      handle.addEventListener("mousedown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        store.select(col.id, cell.id);
        const rect = track.getBoundingClientRect();
        const msPerPx = totalMs / Math.max(1, rect.width);
        const startMs = cell[which];
        const startX = e.clientX;
        const bar = handle.parentElement;
        const onMove = (ev) => {
          const next = Math.max(0, Math.round(startMs + (ev.clientX - startX) * msPerPx));
          // 用 lastSpan 换算（拖动过程中时间范围不变），比拿 bar 当前几何反推可靠
          const pct = (v) => ((v - lastSpan.start) / totalMs) * 100;
          if (which === "onset") {
            const on = Math.min(next, cell.offset);
            bar.style.left = pct(on) + "%";
            bar.style.width = Math.max(0.15, pct(cell.offset) - pct(on)) + "%";
          } else {
            const off = Math.max(next, cell.onset);
            bar.style.width = Math.max(0.15, pct(off) - pct(cell.onset)) + "%";
          }
          drag = { next, which };
        };
        const onUp = (ev) => {
          document.removeEventListener("mousemove", onMove);
          document.removeEventListener("mouseup", onUp);
          const dx = ev.clientX - startX;
          if (Math.abs(dx) >= 2 && drag) {
            store.setCellTime(col.id, cell.id, which, drag.next);
          }
          drag = null;
        };
        document.addEventListener("mousemove", onMove);
        document.addEventListener("mouseup", onUp);
      });
    }

    function zoom(delta) {
      ratio = U.clamp(ratio * (delta > 0 ? 1.25 : 0.8), 3, 600);
      render();
    }

    store.on("db", render);
    store.on("sel", render);
    store.on("time", render);
    store.on("frame", () => {
      // 只挪播放头，避免每帧重建整个时间轴
      const ph = els.timelineBody.querySelector(".tl-playhead");
      if (!ph) return render();
      const { start, end } = span();
      ph.style.left = `calc(118px + ${((store.time - start) / Math.max(1, end - start)) * 100}%)`;
    });
    render();

    return { render, zoom, get ratio() { return ratio; } };
  }

  globalThis.DVY = globalThis.DVY || {};
  globalThis.DVY.ui = globalThis.DVY.ui || {};
  globalThis.DVY.ui.timeline = { mount };
})();
