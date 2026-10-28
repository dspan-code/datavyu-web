/* verify-web.mjs —— 浏览器端自检
 *
 * 用法：node verify-web.mjs            （自动起服务 + 拉起本机 Chrome 做真实 DOM 测试）
 *       node verify-web.mjs --no-browser   （只起服务，打印地址，自己用浏览器看）
 *
 * 这里刻意不引 Playwright/Puppeteer：项目硬约束是零依赖。
 * 用的是 Chrome 自带的 DevTools 协议（CDP）：
 *   1. node 起一个只绑 127.0.0.1 的静态服务
 *   2. 用 --remote-debugging-port 启动 headless Chrome
 *   3. 通过 /json/list 拿到页面目标，用原生 WebSocket 发 Runtime.evaluate
 *   4. 用完杀掉 Chrome
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;
const NO_BROWSER = process.argv.includes("--no-browser");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

let pass = 0;
let fail = 0;
const failures = [];
function ok(name, cond, detail = "") {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    failures.push(name + (detail ? ` — ${detail}` : ""));
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}
function eq(name, a, b) {
  ok(name, a === b, `期望 ${JSON.stringify(b)} 实际 ${JSON.stringify(a)}`);
}
function section(t) {
  console.log(`\n== ${t} ==`);
}

/* ------------------------------------------------------------ 静态服务 */

function startServer() {
  const served = new Map();
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent(req.url.split("?")[0]);
    if (p === "/") p = "/index.html";
    const file = path.join(ROOT, path.normalize(p).replace(/^(\.\.[/\\])+/, ""));
    if (!file.startsWith(ROOT)) {
      res.writeHead(403);
      res.end("forbidden");
      return;
    }
    fs.readFile(file, (err, data) => {
      if (err) {
        served.set(p, 404);
        res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        res.end("404 " + p);
        return;
      }
      served.set(p, 200);
      res.writeHead(200, {
        "content-type": MIME[path.extname(file)] || "application/octet-stream",
        // 必须禁缓存：否则改了 js 但浏览器还在跑旧版，测试会给出莫名其妙的假失败
        "cache-control": "no-store, no-cache, must-revalidate",
      });
      res.end(data);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ server, port, served, base: `http://127.0.0.1:${port}` });
    });
  });
}

/* ------------------------------------------------------- 最小 CDP 客户端 */

function findChrome() {
  const candidates = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ];
  return candidates.find((c) => {
    try {
      fs.accessSync(c, fs.constants.X_OK);
      return true;
    } catch (_) {
      return false;
    }
  });
}

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.logs = [];
    ws.addEventListener("message", (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch (_) {
        return;
      }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
        return;
      }
      if (msg.method === "Runtime.consoleAPICalled") {
        this.logs.push({
          level: msg.params.type,
          text: (msg.params.args || []).map((a) => a.value ?? a.description ?? a.type).join(" "),
        });
      }
      if (msg.method === "Runtime.exceptionThrown") {
        const d = msg.params.exceptionDetails;
        this.logs.push({ level: "exception", text: d.exception?.description || d.text });
      }
      if (msg.method === "Log.entryAdded") {
        this.logs.push({ level: msg.params.entry.level, text: msg.params.entry.text });
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP 超时: ${method}`));
        }
      }, 20000);
    });
  }
  async eval(expression) {
    const r = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    }
    return r.result.value;
  }
}

async function connect(port, target, timeoutMs = 20000) {
  const t0 = Date.now();
  let list;
  for (;;) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      list = await res.json();
      if (list.some((t) => t.type === "page")) break;
    } catch (_) {
      /* 还没起来 */
    }
    if (Date.now() - t0 > timeoutMs) throw new Error("等待 Chrome CDP 超时");
    await new Promise((r) => setTimeout(r, 250));
  }
  const page = list.find((t) => t.type === "page") || list[0];
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", () => reject(new Error("WebSocket 连接失败")), { once: true });
  });
  void target;
  return new CDP(ws);
}

/* ------------------------------------------------------------------ 主流程 */

/* 支持对「已经部署好的线上站点」跑同一套测试：
 *   node verify-web.mjs --url=https://dspan-code.github.io/datavyu-web/
 * 这时跳过本地服务，直接对着公网地址断言真实 DOM。
 * 这是最接近用户的验证方式（公开站点 + 真实网络）。 */
const urlArg = process.argv.find((a) => a.startsWith("--url="));
const remoteBase = urlArg ? urlArg.slice("--url=".length).replace(/\/$/, "") : null;

const local = remoteBase ? null : await startServer();
const server = local ? local.server : { close() {} };
const port = local ? local.port : 0;
const served = local ? local.served : new Map();
const base = remoteBase || local.base;
console.log(remoteBase ? `目标站点（线上）：${base}` : `静态服务：${base}`);

if (NO_BROWSER) {
  console.log("（--no-browser：只起服务，Ctrl+C 结束）");
} else {
  const chrome = findChrome();
  if (!chrome) {
    console.log("没找到 Chrome/Chromium，退化为「只起服务」模式");
  } else {
    const userDir = fs.mkdtempSync(path.join(os.tmpdir(), "dvy-chrome-"));
    const dbgPort = 9500 + Math.floor(Math.random() * 400);
    const child = spawn(
      chrome,
      [
        "--headless=new",
        `--remote-debugging-port=${dbgPort}`,
        `--user-data-dir=${userDir}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-extensions",
        "--disable-gpu",
        // 沙箱里 Chrome 会因为没有写 ~/Library 权限而直接 BPT 崩掉，必须关掉它自己的沙箱与崩溃上报
        "--no-sandbox",
        "--disable-crashpad",
        "--disable-breakpad",
        "--disable-dev-shm-usage",
        "--disable-sync",
        "--disable-background-networking",
        "--disable-application-cache",
        "--disk-cache-size=1",
        "--autoplay-policy=no-user-gesture-required",
        "--window-size=1600,1000",
        "about:blank",
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    let chromeErr = "";
    child.stderr.on("data", (d) => (chromeErr += d.toString()));

    let cdp;
    try {
      cdp = await connect(dbgPort, null);
      await cdp.send("Runtime.enable").catch((e) => { throw new Error("Runtime.enable 失败：" + e.message); });
      await cdp.send("Log.enable");
      await cdp.send("Page.enable");

      const loaded = new Promise((resolve) => {
        const handler = (ev) => {
          try {
            const m = JSON.parse(ev.data);
            if (m.method === "Page.loadEventFired") resolve();
          } catch (_) {
            /* ignore */
          }
        };
        cdp.ws.addEventListener("message", handler);
        setTimeout(resolve, 12000);
      });
      await cdp.send("Page.navigate", { url: base + "/index.html" });
      await loaded;
      await new Promise((r) => setTimeout(r, 700));

      await runTests(cdp);
    } catch (err) {
      ok("浏览器测试执行", false, err.message + (chromeErr ? ` / chrome: ${chromeErr.slice(-300)}` : ""));
    } finally {
      child.kill("SIGKILL");
      try {
        fs.rmSync(userDir, { recursive: true, force: true });
      } catch (_) {
        /* ignore */
      }
    }

    if (!remoteBase) {
      section("静态资源（本地服务）");
      const missing = [...served.entries()].filter(([p, code]) => code === 404 && p !== "/favicon.ico").map(([p]) => p);
      eq("无 404 资源", missing.join(","), "");
      ok("index.html 被请求", served.get("/index.html") === 200);
    } else {
      section("静态资源（线上站点）");
      for (const f of ["/index.html", "/css/app.css", "/lib/zip.js", "/lib/db4.js", "/lib/opf.js",
                       "/lib/store.js", "/ui/app.js", "/ui/video.js", "/ui/grid.js", "/ui/timeline.js", "/ui/timeutil.js"]) {
        const r = await fetch(base + f, { method: "GET" });
        ok(`GET ${f} -> ${r.status}`, r.status === 200);
      }
    }
  }
}

server.close();

/* ------------------------------------------------------------- 测试用例 */

async function runTests(cdp) {
  section("启动与依赖");
  const ready = await cdp.eval(`!!(window.DVY && DVY.app && DVY.app.store)`);
  ok("DVY.app 已就绪（所有脚本按顺序加载成功）", ready);

  const libs = await cdp.eval(`Object.keys(DVY).sort().join(",")`);
  ok(`命名空间：${libs}`, libs.includes("zip") && libs.includes("db4") && libs.includes("opf") && libs.includes("store") && libs.includes("model") && libs.includes("util"));

  // 从干净状态开始，避免上一轮 localStorage 干扰
  await cdp.eval(`DVY.app.store.clearAutosave(); DVY.app.store.newProject("测试工程"); true`);

  section("浏览器里跑一遍核心库（与 Node 自检同源）");
  const rt = await cdp.eval(`(() => {
    const U = DVY.util, Z = DVY.zip, D4 = DVY.db4, M = DVY.model, OPF = DVY.opf;
    const out = {};
    // deflate / zip 往返（浏览器实现）
    const raw = new TextEncoder().encode("行为编码 abababab".repeat(40));
    out.deflateRT = Z.inflateRaw(Z.deflateRaw(raw)).length === raw.length;
    const zf = Z.zip([{name:"project", data:"version: 4\\n"}, {name:"db", data:"#4\\nnotes (TEXT,true,)\\n00:00:00:000,00:00:01:000,hi\\n"}]);
    const en = Z.unzip(zf);
    out.zipRT = en.length === 2 && en[1].text().startsWith("#4");
    // 模型 + #4 往返
    const db = new M.Database("t");
    const c = db.addColumn("my-notes", "TEXT");
    c.addCell(new M.Cell(0, 2500, new M.Value('他说"你好", 走了')));
    const g = db.addColumn("gesture", "MATRIX", ["code01","code02"], ["NOMINAL","TEXT"]);
    g.addCell(new M.Cell(1000, 2000, new M.MatrixValue(["code01","code02"], ["look","at, me"], ["NOMINAL","TEXT"])));
    const text = D4.writeDb4(db);
    out.db4RT = D4.writeDb4(D4.parseDb4(text)) === text;
    out.db4HasCodeType = text.includes("code02|TEXT");
    // opf 往返
    const bytes = OPF.writeOpf(db, {name:"t"});
    const back = OPF.readAny(bytes, "t.opf");
    out.opfRT = back.kind === "opf" && back.db.columns.length === 2 && back.db.getColumn("gesture").codeTypes.join() === "NOMINAL,TEXT";
    // CSV
    const cc = D4.parseCsv(D4.writeCellsCsv(db));
    out.cellsCsvHdr = cc[0].length;
    out.cellsCsvFields = cc[1].length;
    const fr = D4.writeFrameCsv(db, {fps:30}).trim().split("\\n");
    out.frameRows = fr.length - 1;
    out.frameFirst = Number(fr[1].split(",")[1]);
    out.frameLast = Number(fr[fr.length-1].split(",")[1]);
    out.dbRange = db.timeRange;
    return out;
  })()`);
  ok("deflate 往返", rt.deflateRT);
  ok("ZIP 往返（含条目名）", rt.zipRT);
  ok("#4 文本往返逐字符一致", rt.db4RT);
  ok("矩阵子码类型保留 (code02|TEXT)", rt.db4HasCodeType);

  ok(".opf 往返（含子码类型）", rt.opfRT);
  eq("cell CSV 表头字段数（gesture 5 + notes 4）", rt.cellsCsvHdr, 9);
  // 数据行比表头多 1 个字段，是原版「表头 trim 掉一个逗号、数据行保留」留下的坑；
  // 同时 my-notes 的值里带逗号（在引号内），所以「按真 CSV 解析」后是 10 个字段。
  eq("cell CSV 数据行字段数（9 + 原版多出的行尾逗号）", rt.cellsCsvFields, 10);
  eq("逐帧 CSV 行数（0→2500ms @30fps：2500/33.33+1）", rt.frameRows, 76);
  ok(`逐帧 CSV 覆盖 [${rt.frameFirst},${rt.frameLast}] ms`, rt.frameFirst === 0 && rt.frameLast === 2500);

  section("界面：新建列 / 加行 / 改值 / 撤销");
  const ui = await cdp.eval(`(() => {
    const app = DVY.app, store = app.store;
    store.newProject("界面测试");   // 关键：每段测试都从干净状态开始，否则计数会被上一段污染
    const out = {};
    const col = store.addColumn("gaze", "TEXT");
    out.colCount = store.db.columns.length;
    out.sideItems = document.querySelectorAll("#column-manager .side-item").length;
    store.addCell(col.id, 500, 1500);
    const cell = store.selectedCell;
    store.setCellValue(col.id, cell.id, "看向母亲");
    out.gridCells = document.querySelectorAll("#grid .cellbox").length;
    out.gridText = document.querySelector("#grid .cellbox .cb-val").textContent;
    out.timelineBars = document.querySelectorAll("#timeline .tl-bar").length;
    // 播放头 → 选中跟随 / 时间码
    app.video.seekTo(900);
    out.hudTc = document.getElementById("hud-tc").textContent;
    out.stTime = document.getElementById("st-time").textContent;
    // 帧步进：30fps 步长 33.333ms，采用「就近取帧」语义（见 ui/video.js 注释）。
    // 900ms ↔ 第 27 帧；+1 帧 = 第 28 帧 = 933ms；-1 帧 = 第 27 帧 = 900ms（正好回到原处）。
    const before = Math.round(store.time);
    app.video.stepFrames(1);
    out.afterStepMs = Math.round(store.time);
    app.video.stepFrames(-1);
    out.backMs = Math.round(store.time);
    out.before = before;
    // 反向对称：从 933 退一帧，必须回到 900（回归测试：以前会退到 867）
    app.video.seekTo(933);
    app.video.stepFrames(-1);
    out.symBack = Math.round(store.time);
    // 撤销：删掉值
    store.setCellValue(col.id, cell.id, "看向父亲");
    out.beforeUndo = store.selectedCell.value.toString();
    store.undo();
    out.afterUndo = store.selectedCell.value.toString();
    return out;
  })()`);
  eq("侧栏列条目数", ui.sideItems, ui.colCount);
  eq("网格里渲染出 cell", ui.gridCells, 1);
  eq("cell 值渲染", ui.gridText, "看向母亲");
  eq("时间轴轨道色块", ui.timelineBars, 1);
  eq("HUD 时间码跟随播放头", ui.hudTc, "00:00:00:900");
  eq("状态栏时间跟随", ui.stTime, "播放头 00:00:00:900");
  eq("stepFrames(+1) → 第 28 帧边界 933ms", ui.afterStepMs, 933);
  eq("stepFrames(-1) → 第 27 帧边界 900ms", ui.backMs, 900);
  eq("步进是「帧边界对齐」而不是「±33ms」", ui.before, 900);
  eq("933ms 退一帧 = 900ms（浮点边界回归）", ui.symBack, 900);
  eq("撤销前值", ui.beforeUndo, "看向父亲");
  eq("撤销后值", ui.afterUndo, "看向母亲");

  section("界面：I/O 打点与新建行按钮");
  const marks = await cdp.eval(`(() => {
    const app = DVY.app, store = app.store;
    store.newProject("打点测试");
    const col = store.addColumn("mark", "TEXT");
    store.addCell(col.id, 0, 1000);
    store.select(col.id, store.selectedCell.id);
    const cell = store.selectedCell;
    store.setTime(2000);
    document.getElementById("btn-set-offset").click();
    const out = { offset: store.selectedCell.offset };
    document.getElementById("btn-new-cell").click();
    out.cells = col.cells.length;
    out.status = document.getElementById("st-msg").textContent;
    out.newCellOnset = store.selectedCell.onset;
    return out;
  })()`);
  eq("设终点按钮生效 (2000ms)", marks.offset, 2000);
  eq("新建行后 cell 数", marks.cells, 2);
  eq("新行落在播放头 (2000ms)", marks.newCellOnset, 2000);

  section("界面：列重名拦截（原版会静默覆盖）");
  const guard = await cdp.eval(`(() => {
    const store = DVY.app.store;
    let err = "";
    try { store.addColumn("mark", "TEXT"); } catch (e) { err = e.message; }
    return { err, cols: store.db.columns.length, status: document.getElementById("st-msg").textContent };
  })()`);
  ok("重名抛错并提示", guard.err.includes("已存在"), guard.err);
  eq("列数没有变化", guard.cols, 1);

  section("导出通道（不落盘，只验证字节）");
  const exp = await cdp.eval(`(() => {
    const store = DVY.app.store;
    store.newProject("导出测试");
    const col = store.addColumn("gaze", "TEXT");
    store.addCell(col.id, 0, 1200);
    const opf = store.toOpfBytes();
    const cells = store.toCellsCsv();
    const frames = store.toFrameCsv();
    const json = store.toJsonText();
    return {
      opfIsZip: opf[0]===0x50 && opf[1]===0x4b,
      opfLen: opf.length,
      cellsHasHeader: cells.split("\\n")[0].includes("gaze.ordinal"),
      framesFirst: frames.split("\\n")[1].split(",").slice(0,2).join(","),
      jsonOK: JSON.parse(json).db.columns.length === 1 && JSON.parse(json).db.columns[0].name === "gaze",
    };
  })()`);
  ok("导出的 .opf 是合法 ZIP 头", exp.opfIsZip);
  ok(`.opf 体积合理 (${exp.opfLen} B)`, exp.opfLen > 200 && exp.opfLen < 200000);
  ok("cell CSV 表头正确", exp.cellsHasHeader);
  eq("逐帧 CSV 第一行 framenum,time", exp.framesFirst, "1,0");
  ok("JSON 导出可解析", exp.jsonOK);

  section("导出：时间必须是可计算的数字");
  const ex2 = await cdp.eval(`(() => {
    const store = DVY.app.store;
    store.newProject("导出格式测试");
    const col = store.addColumn("gaze", "NOMINAL");
    store.addCell(col.id, 1500, 4250);

    const longTxt = store.toAnalysisCsv();
    const long = DVY.db4.parseCsv(longTxt);
    const secTxt = store.toAnalysisCsv({ units: "seconds" });
    const sec = DVY.db4.parseCsv(secTxt);
    const wide = DVY.db4.parseCsv(store.toAnalysisCsv({ mode: "wide" }));
    const frames = DVY.db4.parseCsv(store.toFrameCsv());

    const pick = (row, key) => row[long[0].indexOf(key)];
    return {
      longHeader: long[0].join(","),
      longOnsetMs: pick(long[1], "onset_ms"),
      longOnsetS: pick(long[1], "onset_s"),
      longDurationS: pick(long[1], "duration_s"),
      allNumeric: ["onset_ms","onset_s","offset_ms","offset_s","duration_ms","duration_s"]
        .every(k => Number.isFinite(Number(pick(long[1], k)))),
      secHeader: sec[0].join(","),
      secNoMs: !sec[0].includes("onset_ms"),
      wideHasMs: wide[0].some(h => h === "gaze.onset_ms"),
      frameHasTimeS: frames[0][2] === "time_s",
      // 菜单里三个分析导出都在
      menuActs: [...document.querySelectorAll(".menu-pop button[data-act]")]
        .map(b => b.dataset.act).filter(a => a.startsWith("export-")).join(","),
    };
  })()`);
  eq("长表表头（毫秒+秒都有）", ex2.longHeader.split(",").slice(0, 9).join(","), "column,type,ordinal,onset_ms,onset_s,offset_ms,offset_s,duration_ms,duration_s");
  eq("onset_ms = 1500", ex2.longOnsetMs, "1500");
  eq("onset_s = 1.500", ex2.longOnsetS, "1.500");
  eq("duration_s = 2.750", ex2.longDurationS, "2.750");
  ok("六列时间全部是数字（能直接求和）", ex2.allNumeric);
  eq("纯秒版表头", ex2.secHeader.split(",").slice(0, 6).join(","), "column,type,ordinal,onset_s,offset_s,duration_s");
  ok("纯秒版没有毫秒列", ex2.secNoMs);
  ok("宽表含 gaze.onset_ms", ex2.wideHasMs);
  ok("逐帧 CSV 含 time_s", ex2.frameHasTimeS);
  ok("菜单里有三个分析导出入口", /export-analysis/.test(ex2.menuActs) && /export-analysis-seconds/.test(ex2.menuActs) && /export-cells-wide/.test(ex2.menuActs), ex2.menuActs);

  section("从仓库打开样本 .opf");
  const sampleT = await cdp.eval(`(async () => {
    const tick = () => new Promise((r) => setTimeout(r, 0));
    const app = DVY.app, store = app.store;
    store.newProject("样本测试");
    app.actions["open-sample"]();
    // 等 fetch 清单 + 渲染
    for (let i = 0; i < 40 && !document.querySelector("#samples-list .sample-item"); i++) await tick();
    const items = [...document.querySelectorAll("#samples-list .sample-item")];
    const out = {
      dialogOpen: document.getElementById("dlg-samples").open,
      note: document.getElementById("samples-note").textContent,
      items: items.length,
      title: items[0] ? items[0].querySelector(".si-title").textContent : null,
    };
    if (items[0]) {
      items[0].click();
      for (let i = 0; i < 40 && store.db.cellCount() === 0; i++) await tick();
      out.loadedCols = store.db.columns.map((c) => c.name);
      out.loadedCells = store.db.cellCount();
      out.loadedName = store.db.name;
      out.dialogClosed = !document.getElementById("dlg-samples").open;
      // 载入后图表应当算得出来
      const d = app.chart.data();
      out.chartBars = d.bars.length;
      out.gazeSec = d.bars.find((b) => b.name === "gaze") ? Number(d.bars.find((b) => b.name === "gaze").value.toFixed(2)) : null;
      document.getElementById("chart-close").click();
    }
    return out;
  })()`);
  ok("样本对话框能打开", sampleT.dialogOpen);
  eq("清单里至少有 1 个样本", sampleT.items >= 1, true);
  ok(`样本标题可读：${sampleT.title}`, !!sampleT.title);
  eq("载入后是 4 列", (sampleT.loadedCols || []).length, 4);
  eq("载入后是 11 段", sampleT.loadedCells, 11);
  eq("载入的是 opf", sampleT.loadedName, "示例工程");
  ok("载入后对话框自动关闭", sampleT.dialogClosed);
  eq("载入后图表能算出柱子（4 类 + 未编码）", sampleT.chartBars, 5);
  eq("示例里 gaze 累计 9.00s", sampleT.gazeSec, 9);

  section("累计时长柱状图（每类一根柱子）");
  const chartT = await cdp.eval(`(async () => {
    const tick = () => new Promise((r) => setTimeout(r, 0));
    const app = DVY.app, store = app.store;
    store.newProject("图表测试");
    const a = store.addColumn("gaze", "NOMINAL");
    store.addCell(a.id, 0, 1500);      // 1.5s
    store.addCell(a.id, 2000, 3000);   // 1.0s
    const b = store.addColumn("vocal", "TEXT");
    store.addCell(b.id, 1000, 2500);   // 1.5s
    await tick();

    app.chart.open();
    const out = {};
    out.dialogOpen = document.getElementById("dlg-chart").open;
    out.bars = [...document.querySelectorAll("#chart-host .chart-bar")].map((r) => ({
      name: r.dataset.name, valueMs: Number(r.dataset.valueMs),
    }));
    out.meta = document.getElementById("chart-meta").textContent;
    out.values = [...document.querySelectorAll("#chart-host .chart-value")].map((t) => t.textContent);

    // 切换单位到毫秒
    document.getElementById("chart-units").value = "ms";
    document.getElementById("chart-units").dispatchEvent(new Event("change"));
    await tick();
    out.msValues = [...document.querySelectorAll("#chart-host .chart-value")].map((t) => t.textContent);

    // 关闭再打开
    document.getElementById("chart-close").click();
    out.closed = !document.getElementById("dlg-chart").open;
    app.chart.open();
    out.reopened = document.getElementById("dlg-chart").open;
    document.getElementById("chart-close").click();
    return out;
  })()`);
  ok("图表对话框能打开", chartT.dialogOpen);
  eq("柱状图柱子数 = 2 类 + 未编码", chartT.bars.length, 3);
  const byName = Object.fromEntries(chartT.bars.map((b) => [b.name, b.valueMs]));
  eq("gaze 累计 2500ms", byName.gaze, 2500);
  eq("vocal 累计 1500ms", byName.vocal, 1500);
  eq("未编码 0ms（三段刚好铺满 0→3000）", byName["未编码"], 0);
  ok(`每根柱子都有数值标签（${chartT.values.join(" / ")}）`, chartT.values.length === 3);
  ok("秒单位下 gaze 显示 2.50s", chartT.values.includes("2.50s"), chartT.values.join(","));
  ok("切到毫秒后显示 2,500 或 2500", chartT.msValues.some((v) => /2[,.]?500/.test(v)), chartT.msValues.join(","));
  ok("能关闭图表对话框", chartT.closed);
  ok("能再次打开", chartT.reopened);
  ok("元信息含段数与跨度", /2 段|3 段|跨度/.test(chartT.meta), chartT.meta);

  section("本地存档（localStorage）");
  const ls = await cdp.eval(`(() => {
    const store = DVY.app.store;
    const raw = localStorage.getItem(DVY.store.LS_KEY);
    const obj = JSON.parse(raw);
    // 断言「存档内容 == 内存数据」，而不是写死列数
    return {
      has: !!raw,
      cols: obj.db.columns.length,
      name: obj.db.name,
      storeCols: store.db.columns.length,
      storeName: store.db.name,
      cells: obj.db.columns.reduce((a, c) => a + c.cells.length, 0),
      storeCells: store.db.cellCount(),
    };
  })()`);
  ok("自动存档已写入 localStorage", ls.has);
  eq("存档列数与内存一致", ls.cols, ls.storeCols);
  eq("存档工程名与内存一致", ls.name, ls.storeName);
  eq("存档行数与内存一致", ls.cells, ls.storeCells);

  section("时间对齐切换 / 缩放 / 面板开关");
  const toggle = await cdp.eval(`(() => {
    const app = DVY.app, store = app.store;
    const before = app.grid.aligned;
    app.actions["toggle-align"]();
    const after = app.grid.aligned;
    app.actions["zoom-in"]();
    const z = app.grid.zoom;
    app.actions["zoom-reset"]();
    app.actions["side-toggle"]();
    const sideHidden = document.getElementById("sidebar").classList.contains("collapsed");
    app.actions["side-toggle"]();
    app.actions["timeline-toggle"]();
    const tlHidden = document.getElementById("timeline").classList.contains("hidden");
    app.actions["timeline-toggle"]();
    // 用「表格里渲染的 cell 数 == store 里的 cell 数」做断言，
    // 不写死具体数字 —— 否则前面测试段增加了数据，这里就会莫名其妙变红
    return {
      before, after, z, sideHidden, tlHidden,
      cells: document.querySelectorAll("#grid .cellbox").length,
      storeCells: store.db.cellCount(),
    };
  })()`);
  eq("时间对齐可切换", toggle.before !== toggle.after, true);
  ok(`缩放生效 (${toggle.z})`, Math.abs(toggle.z - 1.15) < 1e-6 || toggle.z > 1);
  ok("侧栏可折叠", toggle.sideHidden);
  ok("时间轴可隐藏", toggle.tlHidden);
  eq("堆叠模式下渲染的 cell 数与数据一致", toggle.cells, toggle.storeCells);

  section("打点条：单击切换式打点 + 数字键 + 自动进编辑");
  const mark = await cdp.eval(`(async () => {
    const tick = () => new Promise((r) => setTimeout(r, 0));
    const app = DVY.app, store = app.store;
    store.newProject("打点测试");
    const out = {};
    const gaze = store.addColumn("gaze", "NOMINAL");
    const gest = store.addColumn("gesture", "TEXT");

    // 默认注册前 4 列，但 newProject 清空了，这里手动注册两个
    store.setMarkColumns([gaze.id, gest.id]);
    out.chips = document.querySelectorAll("#mark-chips .mchip").length;
    out.keys = [...document.querySelectorAll("#mark-chips .mchip .mkey")].map(e => e.textContent).join(",");
    out.hint = document.getElementById("mark-hint").textContent;

    // —— 鼠标单击：开始
    store.setTime(1000);
    document.querySelectorAll("#mark-chips .mchip")[0].click();
    out.afterFirstClick = { marking: store.markingCount, cells: gaze.cells.length, rec: document.querySelectorAll("#mark-chips .mchip.rec").length };

    // —— 再单击：结束，应生成一行并自动进入编辑
    store.setTime(2500);
    document.querySelectorAll("#mark-chips .mchip")[0].click();
    out.afterSecondClick = { marking: store.markingCount, cells: gaze.cells.length };
    const c0 = gaze.cells[0];
    out.cell = { onset: c0.onset, offset: c0.offset };
    // 「打完自动进编辑」排在 microtask 里，等它落地再查
    await tick();
    let editing = document.querySelector("#grid .cb-val.editing");
    out.autoEdit = !!editing && !!document.activeElement.closest("#grid");
    // 回归：新行必须真的渲染出来，且 grid 不在「悬挂编辑态」里
    // （曾经因为编辑器没关，渲染被永久推迟，表格停在上一个项目的内容上）
    out.newRowRendered = document.querySelectorAll("#grid .cellbox").length === 1;
    out.gridEditing = app.grid.isEditing();
    // 接着打字应该写进这个 cell（而不是被当成快捷键）
    if (editing) {
      editing.textContent = "母亲";
      editing.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      await tick();
    }
    out.typedValue = store.db.getColumn("gaze").cells[0].value.toString();
    out.stillOneCell = store.db.getColumn("gaze").cells.length;

    // —— 键盘数字键 2 = 第二个分类
    store.setTime(3000);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "2", bubbles: true }));
    out.key2Start = store.isMarking(gest.id);
    store.setTime(3600);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "2", bubbles: true }));
    out.key2End = { marking: store.isMarking(gest.id), cells: gest.cells.length };
    out.msg = document.getElementById("st-msg").textContent;

    // —— Esc 放弃正在录制的
    store.setTime(4000);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "1", bubbles: true }));
    out.beforeEsc = store.markingCount;
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    out.afterEsc = { marking: store.markingCount, cells: store.db.getColumn("gaze").cells.length };

    // —— 不足一帧也要产生合法 cell
    store.setTime(5000);
    store.toggleMark(gest.id);
    store.toggleMark(gest.id);       // 同一时刻结束
    const last = store.db.getColumn("gesture").cells.slice(-1)[0];
    out.zeroLenGuard = { len: last.offset - last.onset, ok: last.offset > last.onset };

    // —— 撤销一次只撤销一个打点
    const before = store.db.getColumn("gesture").cells.length;
    store.undo();
    out.undoOneMark = { before, after: store.db.getColumn("gesture").cells.length };
    return out;
  })()`);
  eq("打点条渲染出分类块", mark.chips, 2);
  eq("数字键分配 1,2", mark.keys, "1,2");
  ok("提示文案给了数字键用法", /数字键/.test(mark.hint), mark.hint);
  eq("单击一次 = 开始录制", mark.afterFirstClick.marking, 1);
  eq("开始时还不产生行", mark.afterFirstClick.cells, 0);
  ok("录制中的块有视觉状态", mark.afterFirstClick.rec === 1);
  eq("再单击 = 结束录制", mark.afterSecondClick.marking, 0);
  eq("结束时产生一行", mark.afterSecondClick.cells, 1);
  eq("时间范围正确", `${mark.cell.onset}-${mark.cell.offset}`, "1000-2500");
  ok("打点后自动进入值编辑", mark.autoEdit);
  ok("打点后表格里确实渲染出新行", mark.newRowRendered);
  ok("编辑态是正常的（不是悬挂状态）", mark.gridEditing === true);
  eq("进入编辑后打字写进该行", mark.typedValue, "母亲");
  eq("回车不会多建行", mark.stillOneCell, 1);
  ok("数字键 2 开始录制第二列", mark.key2Start);
  eq("数字键 2 结束并生成行", mark.key2End.cells, 1);
  ok("状态栏回显了这一笔打点", /gesture/.test(mark.msg), mark.msg);
  eq("数字键 1 开始录制", mark.beforeEsc, 1);
  eq("Esc 放弃录制", mark.afterEsc.marking, 0);
  eq("Esc 不产生行", mark.afterEsc.cells, 1);
  ok("不足一帧也生成合法 cell", mark.zeroLenGuard.ok, `长度 ${mark.zeroLenGuard.len}`);
  eq("撤销一次 = 撤销一个打点", mark.undoOneMark.after, mark.undoOneMark.before - 1);

  section("表格编辑：方向键 / Tab / 复制上一行");
  const edit = await cdp.eval(`(() => {
    const app = DVY.app, store = app.store;
    store.newProject("编辑测试");
    const col = store.addColumn("notes", "TEXT");
    store.addCell(col.id, 0, 500);
    store.addCell(col.id, 1000, 1500);
    store.addCell(col.id, 2000, 2500);
    void document.body.offsetHeight;
    const out = {};
    const cells = () => [...document.querySelectorAll("#grid .cellbox")];
    out.rendered = cells().length;

    // 选中第一行，方向键下移
    store.select(col.id, col.cells[0].id);
    out.sel0 = store.selectedCell.onset;
    const box0 = document.querySelector('#grid .cellbox[data-cell-id="' + col.cells[0].id + '"]');
    if (!box0) return out;
    box0.focus();
    box0.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    out.sel1 = store.selectedCell.onset;
    document.querySelector('#grid .cellbox[data-cell-id="' + col.cells[1].id + '"]')
      .dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    out.sel2 = store.selectedCell.onset;

    out.boxIds = cells().map(b => b.dataset.cellId);
    out.wantIds = col.cells.map(c => c.id);

    // Tab 在编辑态里保存并跳到下一格
    const box1 = document.querySelector('#grid .cellbox[data-cell-id="' + col.cells[1].id + '"]');
    out.foundBox1 = !!box1;
    if (!box1) return out;
    const val = box1.querySelector(".cb-val");
    out.foundVal = !!val;
    if (!val) return out;
    val.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    out.editing = !!document.querySelector("#grid .cb-val.editing");
    const ed = document.querySelector("#grid .cb-val.editing");
    if (!ed) return out;
    ed.textContent = "第二个";
    ed.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
    out.valueSaved = col.cells[1].value.toString();
    out.movedToNext = store.selectedCell ? store.selectedCell.onset : null;

    // ⌘↑ 复制上一行的值
    store.select(col.id, col.cells[2].id);
    const box2 = document.querySelector('#grid .cellbox[data-cell-id="' + col.cells[2].id + '"]');
    const v2 = box2.querySelector(".cb-val");
    v2.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    const ed2 = document.querySelector("#grid .cb-val.editing");
    out.beforeCopy = ed2.textContent;
    ed2.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", metaKey: true, bubbles: true, cancelable: true }));
    out.afterCopy = document.querySelector("#grid .cb-val.editing").textContent;
    document.querySelector("#grid .cb-val.editing").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    return out;
  })()`);
  eq("三行都渲染出来", edit.rendered, 3);
  eq("选中的是第一行", edit.sel0, 0);
  eq("方向键↓ 移到第二行", edit.sel1, 1000);
  eq("再按↓ 移到第三行", edit.sel2, 2000);
  ok("单击值即进入编辑", edit.editing);
  eq("Tab 保存了值", edit.valueSaved, "第二个");
  eq("Tab 跳到了下一格", edit.movedToNext, 2000);
  eq("复制前是空的", edit.beforeCopy, "");
  eq("⌘↑ 复制到上一行的值", edit.afterCopy, "第二个");

  section("视频全屏（应用内，按 F）");
  const fs2 = await cdp.eval(`(() => {
    const app = DVY.app;
    const player = document.querySelector(".player");
    const out = {};
    out.before = app.video.isFullscreen;
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "f", bubbles: true, cancelable: true }));
    out.on = app.video.isFullscreen;
    out.hasClass = player.classList.contains("fs");
    out.position = getComputedStyle(player).position;
    out.rect = (() => { const r = player.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; })();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    out.off = app.video.isFullscreen;
    out.classGone = !player.classList.contains("fs");
    return out;
  })()`);
  eq("初始不是全屏", fs2.before, false);
  ok("按 F 进入全屏", fs2.on && fs2.hasClass);
  eq("全屏时用 fixed 铺满", fs2.position, "fixed");
  ok(`全屏尺寸约等于视口 (${fs2.rect.w}x${fs2.rect.h})`, fs2.rect.w > 1000 && fs2.rect.h > 600);
  ok("Esc 退出全屏", !fs2.off && fs2.classGone);

  section("控制台干净");
  const bad = cdp.logs.filter((l) => ["error", "exception"].includes(l.level));
  ok(`无 JS 报错/异常（共 ${cdp.logs.length} 条日志）`, bad.length === 0, bad.map((b) => b.text).join(" | ").slice(0, 400));
}

/* ------------------------------------------------------------------ 汇总 */

console.log(`\n${"=".repeat(52)}`);
console.log(fail === 0 ? `浏览器自检全部通过：${pass} 项` : `通过 ${pass} 项，失败 ${fail} 项`);
if (fail) {
  console.log("失败清单：");
  for (const f of failures) console.log("  - " + f);
  process.exit(1);
}
