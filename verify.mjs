/* verify.mjs —— 自检（Node 直接跑，不需要浏览器、不需要安装依赖）
 *
 *   node verify.mjs
 *
 * 覆盖：
 *   1. util：时间码往返、三种转义互逆
 *   2. zip：deflate/stored 往返 + 解 Python zipfile 产物
 *   3. db4：解析 Python 工具生成的「金标准」夹具，并逐字符写回比对
 *   4. opf：读金标准 .opf（含额外条目/隐藏列/矩阵列），再写回再读回
 *   5. 导出：逐 cell CSV 与 Python 产物对拍；逐帧 CSV 行数/内容
 */

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(__dirname, "_fixtures");

const U = require("./lib/util.js");
const Z = require("./lib/zip.js");
const M = require("./lib/model.js");
const D4 = require("./lib/db4.js");
const OPF = require("./lib/opf.js");

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

/* ------------------------------------------------------------- 1. util */

section("util：时间码与转义");
eq("msToTimestamp 0", U.msToTimestamp(0), "00:00:00:000");
eq("msToTimestamp 2500", U.msToTimestamp(2500), "00:00:02:500");
eq("msToTimestamp 3661500", U.msToTimestamp(3661500), "01:01:01:500");
eq("msToTimestamp 大值", U.msToTimestamp(3600000 * 25 + 61000), "25:01:01:000");
eq("timestampToMs 往返", U.timestampToMs(U.msToTimestamp(987654)), 987654);
eq("timestampToMs 单段按毫秒", U.timestampToMs("1500"), 1500);
eq("timestampToMs 容错 mm:ss:mmm", U.timestampToMs("01:02:003"), 62003);

for (const [s, esc, unesc] of [
  ["a-b,c\\d\ne", U.escapeCSV, U.unescapeCSV],
  ["x(y)z,a|b-c\\d", U.escapeCSVArgument, U.unescapeCSVArgument],
]) {
  eq(`转义互逆 ${JSON.stringify(s)}`, unesc(esc(s)), s);
}
eq("escapeCSV 保留双引号", U.escapeCSV('a"b'), 'a"b');
eq("escapeCSVArgument 转义括号与竖线", U.escapeCSVArgument("x|y(z)"), "x\\|y\\(z\\)");
eq("escapeCSVQuotes", U.escapeCSVQuotes('他说"你好"'), '"他说""你好"""');
eq("删除 \\u0000/\\u0001", U.escapeCSV("a\u0000b\u0001c"), "abc");

/* -------------------------------------------------------------- 2. zip */

section("zip：压缩往返 + 解 Python 产物");
{
  const samples = [
    new Uint8Array(0),
    Z.utf8Encode("hello"),
    Z.utf8Encode("重复内容".repeat(500)),
    (() => {
      const a = new Uint8Array(70000);
      for (let i = 0; i < a.length; i++) a[i] = (i * 37 + 11) & 0xff;
      return a;
    })(),
  ];
  let allDeflate = true;
  let allStored = true;
  for (const s of samples) {
    const d = Z.inflateRaw(Z.deflateRaw(s));
    const t = Z.inflateRaw(Z.deflateStored(s));
    if (d.length !== s.length || !d.every((v, i) => v === s[i])) allDeflate = false;
    if (t.length !== s.length || !t.every((v, i) => v === s[i])) allStored = false;
  }
  ok(`deflate 往返 ${samples.length} 例`, allDeflate);
  ok(`stored 往返 ${samples.length} 例`, allStored);

  const file = Z.zip([{ name: "a/project", data: "#y\n" }, { name: "b", data: Z.utf8Encode("值带中文") }]);
  const back = Z.unzip(file);
  eq("zip 条目数", back.length, 2);
  eq("zip 条目名", back.map((e) => e.name).join(","), "a/project,b");
  eq("zip 内容 UTF-8", back[1].text(), "值带中文");

  const pyPath = path.join(FIX, "py_deflate.opf");
  if (fs.existsSync(pyPath)) {
    const e = Z.unzip(new Uint8Array(fs.readFileSync(pyPath)));
    const db = e.find((x) => x.name === "db");
    const txt = db.text();
    ok("解 Python zipfile(deflate) 的 db 条目", txt.startsWith("#4\nnotes (TEXT,true,)") && txt.trim().split("\n").length === 62);
  } else {
    ok("解 Python zipfile(deflate) 的 db 条目", false, "缺少夹具 py_deflate.opf");
  }
}

/* -------------------------------------------------------------- 3. db4 */

section("db4：与 Python 金标准逐字符比对");
const goldDb4 = fs.existsSync(path.join(FIX, "gold.db4"))
  ? fs.readFileSync(path.join(FIX, "gold.db4"), "utf8")
  : null;
{
  ok("存在金标准夹具 gold.db4", !!goldDb4);
  if (goldDb4) {
    const db = D4.parseDb4(goldDb4);
    eq("列数", db.columns.length, 4);
    eq("列名（含 - 转义）", db.columnNames().join("|"), "gesture|hidden_col|my-notes|paren (name)");
    eq("矩阵列子码", db.getColumn("gesture").codes.join(","), "code01,code02");
    eq("子码类型保留", db.getColumn("gesture").codeTypes.join(","), "NOMINAL,TEXT");
    // 这条是回归测试：曾经 Database.addColumn 只转发 3 个参数，把 codeTypes 悄悄丢了
    const direct = new M.Database("r");
    const dc = direct.addColumn("m", "MATRIX", ["c1", "c2"], ["TEXT", "NOMINAL"]);
    eq("经 Database.addColumn 新建也保留子码类型", dc.codeTypes.join(","), "TEXT,NOMINAL");
    eq("隐藏列 visible=false 解析", db.getColumn("hidden_col").hidden, true);
    eq("隐藏列值反转义", db.getColumn("hidden_col").cells[0].value.toString(), "x|y(z)");
    eq("空值 cell", db.getColumn("my-notes").cells[1].value.toString(), "");
    eq("时间码解析", db.getColumn("my-notes").cells[0].onsetString, "00:00:00:000");
    eq("矩阵值切分", JSON.stringify(db.getColumn("gesture").cells[0].value.values), JSON.stringify(["look", "at, me"]));
    eq("中文值", db.getColumn("my-notes").cells[0].value.toString(), '他说"你好", 然后走了');
    eq("无 cell 的列保留", db.getColumn("paren (name)").cells.length, 0);

    const back = D4.writeDb4(db);
    eq("写回与 Python 完全一致", back, goldDb4);
  }
}

/* -------------------------------------------------------------- 4. opf */

section("opf：读金标准工程 + 再写再读");
{
  const p = path.join(FIX, "gold.opf");
  ok("存在金标准夹具 gold.opf", fs.existsSync(p));
  if (fs.existsSync(p)) {
    const bytes = new Uint8Array(fs.readFileSync(p));
    const r = OPF.readOpf(bytes, "gold.opf");
    eq("opf 列数", r.db.columns.length, 4);
    eq("opf 项目名", r.project.name, "golden");
    eq("opf origpath", r.project.origpath, "/tmp/x.mov");
    eq("opf 额外条目保留", r.extraEntries.map((e) => e.name).join(","), "abc123");
    eq("opf 额外条目字节数", r.extraEntries[0].data.length, 15);

    const out = OPF.writeOpf(r.db, { project: r.project, extraEntries: r.extraEntries, name: r.project.name });
    const r2 = OPF.readOpf(out, "roundtrip.opf");
    eq("再读回列数", r2.db.columns.length, 4);
    eq("再读回项目名", r2.project.name, "golden");
    eq("再读回 db 文本一致", D4.writeDb4(r2.db), D4.writeDb4(r.db));
    eq("再读回额外条目", r2.extraEntries.map((e) => e.name).join(","), "abc123");
    ok(`zip 体积合理 ${out.length}/${bytes.length}`, out.length < bytes.length * 2);

    // readAny 自动识别
    const ra = OPF.readAny(bytes, "gold.opf");
    eq("readAny 识别为 opf", ra.kind, "opf");
    const rb = OPF.readAny(Z.utf8Encode(goldDb4), "x.db4");
    eq("readAny 识别为 #4", rb.kind, "db4");
    const rc = OPF.readAny(Z.utf8Encode(fs.readFileSync(path.join(FIX, "gold.cells.csv"), "utf8")), "x.csv");
    eq("readAny 识别为 cell CSV", rc.kind, "cells-csv");
    eq("readAny 列数一致", rc.db.columns.length, 4);
    eq("readAny 保留矩阵子码", rc.db.getColumn("gesture").codes.join(","), "code01,code02");
    // 注意：cell CSV 不编码列类型/可见性（原版也如此），所以只比对内容不比对类型
    const strip = (db) =>
      db.columns
        .map((c) => `${c.name}:${c.cells.map((x) => `${x.onset}-${x.offset}=${x.value.toString()}`).join(";")}`)
        .sort()
        .join("|");
    eq("readAny(cell CSV) 内容与金标准一致", strip(rc.db), strip(D4.parseDb4(goldDb4)));
    ok("cell CSV 已知信息损失：列类型退化为 TEXT/MATRIX", rc.db.getColumn("hidden_col").type === "TEXT");
  }
}

/* ------------------------------------------------------------ 5. 导出 */

section("导出：逐 cell CSV / 逐帧 CSV");
{
  const db = D4.parseDb4(goldDb4);
  const mine = D4.writeCellsCsv(db);
  const py = fs.readFileSync(path.join(FIX, "gold.cells.csv"), "utf8");
  eq("逐 cell CSV 与 Python 一致", mine, py);

  // 注意：不能用 split(",") 数字段 —— 值里的逗号在引号内（这正是原版的坑之一）
  const hdrFields = D4.parseCsv(mine)[0].length;
  const rowFields = D4.parseCsv(mine)[1].length;
  eq("表头字段数", hdrFields, 17);
  eq("数据行比表头多一个字段（原版 trim 表头留下的坑）", rowFields - hdrFields, 1);

  const strictTxt = D4.writeCellsCsv(db, { strict: true });
  const strictRows = D4.parseCsv(strictTxt);
  eq("strict 模式表头字段数不变", strictRows[0].length, 17);
  eq("strict 模式数据行字段数对齐", strictRows[1].length, 17);
  eq("strict 模式最后一个字段是 paren 的空值（不是补位逗号）", strictRows[1][16], "");
  eq("strict 模式总字段数", strictRows[1].length, 17);

  const frame = D4.writeFrameCsv(db, { fps: 30 });
  const rows = frame.trim().split("\n");
  eq("逐帧表头", rows[0].startsWith("framenum,time,"), true);
  ok("逐帧首行 framenum=1", rows[1].startsWith("1,"));
  const range = db.timeRange;
  const expected = Math.floor((range.end - range.start) / (1000 / 30)) + 1;
  eq("逐帧行数（不含原版多出的一帧）", rows.length - 1, expected);

  const withExtra = D4.writeFrameCsv(db, { fps: 30, inclusiveEnd: true });
  eq("inclusiveEnd 复刻原版多一帧", withExtra.trim().split("\n").length - 1, expected + 1);

  const at1000 = rows.find((r) => r.startsWith("31,"));
  ok("逐帧在 1s 处命中 gesture", !!at1000 && at1000.includes('"look"'));
}

section("模型：撤销 / 校验 / JSON");
{
  const db = new M.Database("t");
  const c = db.addColumn("notes", "TEXT");
  c.addCell(new M.Cell(0, 1000, new M.Value("a")));
  const hist = new M.History();
  hist.push(JSON.stringify(db.toJSON()), "add");
  c.addCell(new M.Cell(1000, 2000, new M.Value("b")));
  const entry = hist.undo(JSON.stringify(db.toJSON()));
  ok("撤销可用", !!entry);
  const restored = M.Database.fromJSON(JSON.parse(entry.snapshot));
  eq("撤销后 cell 数", restored.getColumn("notes").cells.length, 1);
  ok("重做可用", hist.canRedo);
  let threw = false;
  try {
    db.addColumn("notes", "TEXT");
  } catch (_) {
    threw = true;
  }
  ok("重名拦截", threw);
  threw = false;
  try {
    db.addColumn("9bad", "TEXT");
  } catch (_) {
    threw = true;
  }
  ok("非法列名拦截", threw);
}

/* ------------------------------------------------------------- 汇总 */

console.log(`\n${"=".repeat(52)}`);
console.log(fail === 0 ? `全部通过：${pass} 项` : `通过 ${pass} 项，失败 ${fail} 项`);
if (fail) {
  console.log("失败清单：");
  for (const f of failures) console.log("  - " + f);
  process.exit(1);
}
