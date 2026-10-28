/* lib/analytics.js —— 统计与图表数据（纯逻辑，可单独测）
 *
 * 用户要的核心图表：**每一类行为的累计时长 Σ(offset − onset)**，一根柱子一个分类。
 *
 * 为什么累计时长是对的指标：行为编码里通常关心「这类行为一共持续了多久」，
 * 而不是「记了多少段」。两个指标在界面上都要能看到，但柱子画的是时长。
 *
 * 另外额外算一个「未编码时长」（gap）：
 *   gap = 所有列覆盖的并集之外，落在 [最早起点, 最晚终点] 之间的时间。
 * 这个数对科研很重要 —— 它告诉你还有多少片段没编码。
 */

(function () {
  const U = globalThis.DVY.util;

  /**
   * 每个分类的累计时长。
   * 同一列内的 cell 如果重叠，按「并集」算，避免重复计时（编码时重叠是常见的小失误）。
   */
  function columnDurations(db, opts = {}) {
    const mode = opts.mode === "sum" ? "sum" : "union";
    const out = [];
    for (const col of db.columns) {
      const cells = col.sorted();
      let total = 0;
      if (mode === "sum") {
        for (const c of cells) total += Math.max(0, c.offset - c.onset);
      } else {
        // 并集：把区间排序后合并
        let curStart = null;
        let curEnd = null;
        for (const c of cells) {
          const s = c.onset;
          const e = Math.max(c.offset, c.onset);
          if (curStart === null) {
            curStart = s;
            curEnd = e;
          } else if (s <= curEnd) {
            curEnd = Math.max(curEnd, e);
          } else {
            total += curEnd - curStart;
            curStart = s;
            curEnd = e;
          }
        }
        if (curStart !== null) total += curEnd - curStart;
      }
      const durations = cells.map((c) => Math.max(0, c.offset - c.onset));
      out.push({
        columnId: col.id,
        name: col.name,
        type: col.type,
        hidden: !!col.hidden,
        count: cells.length,
        totalMs: total,
        meanMs: cells.length ? total / cells.length : 0,
        maxMs: durations.length ? Math.max(...durations) : 0,
        minMs: durations.length ? Math.min(...durations) : 0,
        cells: cells.length,
      });
    }
    return out;
  }

  /** 所有列覆盖的并集时长（用来算未编码时长） */
  function coveredMs(db) {
    const spans = [];
    for (const col of db.columns) for (const c of col.sorted()) spans.push([c.onset, Math.max(c.offset, c.onset)]);
    if (!spans.length) return 0;
    spans.sort((a, b) => a[0] - b[0]);
    let total = 0;
    let cs = spans[0][0];
    let ce = spans[0][1];
    for (let i = 1; i < spans.length; i++) {
      const [s, e] = spans[i];
      if (s <= ce) ce = Math.max(ce, e);
      else {
        total += ce - cs;
        cs = s;
        ce = e;
      }
    }
    total += ce - cs;
    return total;
  }

  /**
   * 图表数据：给每一类一根柱子 + 一根「未编码」。
   * 默认只画未隐藏的列（界面上看不见的列不该悄悄进图表），可用 includeHidden 打开。
   */
  function barData(db, opts = {}) {
    const units = opts.units === "ms" ? "ms" : "s";
    const k = units === "ms" ? 1 : 1 / 1000;
    const mode = opts.mode === "sum" ? "sum" : "union";
    const all = columnDurations(db, { mode });
    const rows = all.filter((r) => opts.includeHidden || !r.hidden);

    const range = db.timeRange;
    const spanMs = Math.max(0, range.end - range.start);
    const covered = coveredMs(db);
    const gapMs = Math.max(0, spanMs - covered);

    const bars = rows.map((r) => ({
      key: r.columnId,
      name: r.name,
      type: r.type,
      count: r.count,
      value: r.totalMs * k,
      valueMs: r.totalMs,
      mean: r.meanMs * k,
      max: r.maxMs * k,
      kind: "column",
    }));

    const total = bars.reduce((a, b) => a + b.valueMs, 0);
    const maxBar = Math.max(...bars.map((b) => b.value), gapMs * k, 0);

    // 只有在确实有时间跨度时才画「未编码」这根柱子；空工程画一根 0 长度的柱子没有意义，
    // 还会让人误以为"有数据"
    if (rows.length || spanMs > 0) {
      bars.push({
        key: "__gap__",
        name: "未编码",
        type: "",
        count: 0,
        value: gapMs * k,
        valueMs: gapMs,
        mean: 0,
        max: 0,
        kind: "gap",
      });
    }

    return {
      units,
      mode,
      bars: opts.sort === false ? bars : bars.slice(0, -1).sort((a, b) => b.value - a.value).concat(bars.slice(-1)),
      maxBar: Math.max(maxBar, 1),
      span: spanMs * k,
      covered: covered * k,
      gap: gapMs * k,
      totalColumns: bars.reduce((a, b) => a + b.valueMs, 0),
      columns: rows.length,
      cells: db.cellCount(),
      range: { startMs: range.start, endMs: range.end },
    };
  }

  /** 数字格式：秒保留 2 位，毫秒取整；大数加千分位 */
  function fmt(v, units) {
    if (units === "ms") return Math.round(v).toLocaleString("en-US");
    return v < 100 ? v.toFixed(2) : v.toFixed(1);
  }

  const api = { columnDurations, coveredMs, barData, fmt };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  globalThis.DVY = globalThis.DVY || {};
  globalThis.DVY.analytics = api;
})();
