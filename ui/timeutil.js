/* ui/timeutil.js —— 时间轴/网格复用的刻度、配色、格式化 */

(function () {
  const U = globalThis.DVY.util;

  const COLORS = [
    "#4ea1ff", "#43d17a", "#ffb648", "#ff6b6b", "#b78cff",
    "#4fd6d6", "#ff8fd0", "#9fd356", "#ffd166", "#7a9cff",
  ];

  function colorFor(name) {
    let h = 0;
    const s = String(name || "");
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return COLORS[h % COLORS.length];
  }

  /** 挑一个「整」刻度间隔：目标是屏幕上每个 tick 大约 90px */
  function niceStep(spanMs, pxWidth) {
    if (!(spanMs > 0) || !(pxWidth > 0)) return 1000;
    const target = (spanMs / pxWidth) * 90;
    const candidates = [
      100, 200, 500,
      1000, 2000, 5000,
      10000, 15000, 30000,
      60000, 120000, 300000,
      600000, 1800000, 3600000,
    ];
    for (const c of candidates) if (c >= target) return c;
    return 3600000 * Math.ceil(target / 3600000);
  }

  /** 时间轴的刻度线（返回 [{ms,label,left%}]） */
  function ticks(start, end, pxWidth, maxTicks = 40) {
    const span = end - start;
    if (!(span > 0)) return [];
    const step = niceStep(span, pxWidth);
    const out = [];
    const first = Math.ceil(start / step) * step;
    for (let t = first; t <= end && out.length < maxTicks; t += step) {
      out.push({ ms: t, label: shortLabel(t), pct: ((t - start) / span) * 100 });
    }
    return out;
  }

  function shortLabel(ms) {
    const total = Math.round(ms);
    const h = Math.floor(total / 3600000);
    const m = Math.floor((total % 3600000) / 60000);
    const s = Math.floor((total % 60000) / 1000);
    const f = total % 1000;
    if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
    return `${m}:${String(s).padStart(2, "0")}.${String(f).padStart(3, "0")}`;
  }

  /** 解析用户输入的时间：hh:mm:ss:mmm / mm:ss:mmm / 纯毫秒 / 1.5s / 2m */
  function parseTimeInput(raw, fallbackMs = 0) {
    const s = String(raw ?? "").trim();
    if (s === "") return fallbackMs;
    let m = /^([\d.]+)\s*(ms|s|m|h)$/i.exec(s);
    if (m) {
      const v = parseFloat(m[1]);
      const unit = m[2].toLowerCase();
      const k = unit === "ms" ? 1 : unit === "s" ? 1000 : unit === "m" ? 60000 : 3600000;
      return Number.isFinite(v) ? Math.round(v * k) : fallbackMs;
    }
    if (s.includes(":")) {
      const v = U.timestampToMs(s);
      return Number.isFinite(v) && v !== 0 ? v : s === "00:00:00:000" ? 0 : v;
    }
    const n = Number(s);
    return Number.isFinite(n) ? Math.round(n) : fallbackMs;
  }

  function msToSec(ms) {
    return Math.max(0, ms / 1000);
  }

  globalThis.DVY = globalThis.DVY || {};
  globalThis.DVY.timeutil = { colorFor, niceStep, ticks, shortLabel, parseTimeInput, msToSec };
})();
