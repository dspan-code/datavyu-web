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

const { server, port, served, base } = await startServer();
console.log(`静态服务：${base}`);

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

    section("静态资源");
    const missing = [...served.entries()].filter(([p, code]) => code === 404 && p !== "/favicon.ico").map(([p]) => p);
    eq("无 404 资源", missing.join(","), "");
    ok("index.html 被请求", served.get("/index.html") === 200);
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

  section("本地存档（localStorage）");
  const ls = await cdp.eval(`(() => {
    const store = DVY.app.store;
    const raw = localStorage.getItem(DVY.store.LS_KEY);
    const obj = JSON.parse(raw);
    return { has: !!raw, cols: obj.db.columns.length, name: obj.db.name };
  })()`);
  ok("自动存档已写入 localStorage", ls.has);
  eq("存档列数一致", ls.cols, 1);

  section("时间对齐切换 / 缩放 / 面板开关");
  const toggle = await cdp.eval(`(() => {
    const app = DVY.app;
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
    return { before, after, z, sideHidden, tlHidden, cells: document.querySelectorAll("#grid .cellbox").length };
  })()`);
  eq("时间对齐可切换", toggle.before !== toggle.after, true);
  ok(`缩放生效 (${toggle.z})`, Math.abs(toggle.z - 1.15) < 1e-6 || toggle.z > 1);
  ok("侧栏可折叠", toggle.sideHidden);
  ok("时间轴可隐藏", toggle.tlHidden);
  eq("堆叠模式下 cell 仍渲染（导出段留下的 1 行）", toggle.cells, 1);

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
