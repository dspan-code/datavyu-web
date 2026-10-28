/* ui/chart.js —— 累计时长柱状图（每类一根柱子）
 *
 * 为什么画横向柱：分类名通常很长（"注视母亲""发声"…），横向柱的标签读起来最省力，
 * 而且按数值排序后，一眼就能看出哪类行为占比最大。
 *
 * 技术选择：SVG 而不是 canvas。
 *   - 文字是真实文本，缩放不糊、可被无障碍工具读到
 *   - 导出 PNG 时用 canvas 重绘一次即可（见 exportPng），不需要额外依赖
 */

(function () {
  const U = globalThis.DVY.util;

  function mount(store, els) {
    let units = "s";
    let includeHidden = false;
    let mode = "union";

    const PAD = { top: 14, right: 96, bottom: 26, left: 150 };
    const ROW_H = 30;
    const BAR_H = 18;

    function data() {
      return globalThis.DVY.analytics.barData(store.db, { units, includeHidden, mode });
    }

    /* ------------------------------------------------------------ 画图 */

    function buildSvg(d) {
      const rows = d.bars.length;
      const width = 760;
      const height = PAD.top + rows * ROW_H + PAD.bottom;
      const plotW = width - PAD.left - PAD.right;
      const max = d.maxBar || 1;

      const ns = "http://www.w3.org/2000/svg";
      const svg = document.createElementNS(ns, "svg");
      svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
      svg.setAttribute("width", width);
      svg.setAttribute("height", height);
      svg.setAttribute("class", "chart-svg");
      svg.setAttribute("role", "img");
      svg.setAttribute("aria-label", "每类行为的累计时长柱状图");

      const mk = (tag, attrs, text) => {
        const el = document.createElementNS(ns, tag);
        for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
        if (text !== undefined) el.textContent = text;
        return el;
      };

      // 背景
      svg.appendChild(mk("rect", { x: 0, y: 0, width, height, fill: "#1b1f26" }));

      // 竖向网格线（4 条）
      for (let i = 1; i <= 4; i++) {
        const x = PAD.left + (plotW * i) / 4;
        svg.appendChild(mk("line", { x1: x, y1: PAD.top, x2: x, y2: height - PAD.bottom, stroke: "#2a313a", "stroke-width": 1 }));
        const val = (max * i) / 4;
        svg.appendChild(
          mk("text", { x, y: height - PAD.bottom + 15, fill: "#6b7686", "font-size": 10, "text-anchor": "middle" },
            globalThis.DVY.analytics.fmt(val, units) + (units === "s" ? "s" : "ms")),
        );
      }

      const colors = globalThis.DVY.timeutil;
      d.bars.forEach((b, i) => {
        const y = PAD.top + i * ROW_H;
        const w = Math.max(1, (b.value / max) * plotW);
        const isGap = b.kind === "gap";
        const color = isGap ? "#4a5462" : colors.colorFor(b.name);

        // 分类名
        svg.appendChild(
          mk("text", { x: PAD.left - 10, y: y + BAR_H - 3, fill: "#c9d3e0", "font-size": 12, "text-anchor": "end" }, b.name),
        );
        // 柱子
        const rect = mk("rect", {
          x: PAD.left, y, width: w, height: BAR_H, rx: 3,
          fill: color, opacity: isGap ? 0.55 : 0.9,
          class: "chart-bar",
        });
        rect.dataset.name = b.name;
        rect.dataset.valueMs = String(b.valueMs);
        svg.appendChild(rect);
        // 数值
        svg.appendChild(
          mk("text", {
            x: PAD.left + w + 8, y: y + BAR_H - 3, fill: "#e6ebf2", "font-size": 11.5,
            class: "chart-value",
          }, `${globalThis.DVY.analytics.fmt(b.value, units)}${units === "s" ? "s" : "ms"}`),
        );
        // 段数 / 均长
        if (!isGap && b.count) {
          svg.appendChild(
            mk("text", {
              x: width - 8, y: y + BAR_H - 3, fill: "#6b7686", "font-size": 10, "text-anchor": "end",
            }, `${b.count} 段 · 均 ${globalThis.DVY.analytics.fmt(b.mean, units)}${units === "s" ? "s" : "ms"}`),
          );
        }
      });

      return { svg, width, height };
    }

    /* ------------------------------------------------------------ 渲染 */

    function render() {
      const d = data();
      els.chartMeta.textContent =
        d.cells === 0
          ? "还没有任何编码记录"
          : `${d.columns} 类 · ${d.cells} 段 · 时间跨度 ${globalThis.DVY.analytics.fmt(d.span, units)}${units === "s" ? "s" : "ms"}` +
            ` · 已覆盖 ${globalThis.DVY.analytics.fmt(d.covered, units)}${units === "s" ? "s" : "ms"}` +
            ` · 未编码 ${globalThis.DVY.analytics.fmt(d.gap, units)}${units === "s" ? "s" : "ms"}`;

      const host = els.chartHost;
      host.innerHTML = "";
      if (!d.bars.length) {
        const p = document.createElement("div");
        p.className = "chart-empty";
        p.textContent = "还没有列。先「工作表 → 新建列」，或者用打点条记几段。";
        host.appendChild(p);
        return;
      }
      const { svg } = buildSvg(d);
      host.appendChild(svg);
    }

    /* ---------------------------------------------------------- 导出 PNG */

    function exportPng(filename) {
      const d = data();
      const { svg, width, height } = buildSvg(d);
      const clone = svg.cloneNode(true);
      const xml = new XMLSerializer().serializeToString(clone);
      const url = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(xml);
      const img = new Image();
      img.onload = () => {
        const scale = 2; // 2x，贴进论文/PPT 不糊
        const canvas = document.createElement("canvas");
        canvas.width = width * scale;
        canvas.height = height * scale;
        const ctx = canvas.getContext("2d");
        ctx.scale(scale, scale);
        ctx.fillStyle = "#1b1f26";
        ctx.fillRect(0, 0, width, height);
        ctx.drawImage(img, 0, 0, width, height);
        canvas.toBlob((blob) => {
          const a = document.createElement("a");
          a.href = URL.createObjectURL(blob);
          a.download = filename;
          document.body.appendChild(a);
          a.click();
          a.remove();
          setTimeout(() => URL.revokeObjectURL(a.href), 3000);
        }, "image/png");
      };
      img.src = url;
    }

    /* ------------------------------------------------------------ 交互 */

    function setUnits(u) {
      units = u === "ms" ? "ms" : "s";
      render();
    }
    function setMode(m) {
      mode = m === "sum" ? "sum" : "union";
      render();
    }
    function setIncludeHidden(v) {
      includeHidden = !!v;
      render();
    }
    function open() {
      render();
      if (!els.dlgChart.open) els.dlgChart.showModal();
    }
    function close() {
      if (els.dlgChart.open) els.dlgChart.close();
    }

    return { render, open, close, setUnits, setMode, setIncludeHidden, exportPng, data, get units() { return units; }, get mode() { return mode; } };
  }

  globalThis.DVY = globalThis.DVY || {};
  globalThis.DVY.ui = globalThis.DVY.ui || {};
  globalThis.DVY.ui.chart = { mount };
})();
