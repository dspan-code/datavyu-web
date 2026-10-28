/* review.mjs —— 自动复习（守门人）
 *
 *   node review.mjs
 *
 * 这个脚本回答一个问题：**"上次踩过的坑，现在还有人守着吗？"**
 *
 * 和 verify.mjs / verify-web.mjs 的分工：
 *   verify.mjs       尺子 —— 数据对不对（拿金标准逐字符比）
 *   verify-web.mjs   尺子 —— 浏览器里跑不跑得起来
 *   review.mjs       守门人 —— **守卫还在不在**，以及仓库有没有退化
 *
 * 为什么要单独有它：测试是"用代码验证代码"，但有些退化是**元层面**的——
 * 测试全绿，可是守卫被删了、fixture 丢了、文件被写死了绝对路径，
 * 或者有人"优化"掉了那行看起来冗余的 \r 清理。
 * 这些 verify 抓不到（删了守卫，测试就跟着失效了，还是绿的）。
 *
 * 定位：它不做逻辑断言，只做**清单核对 + 铲屎**。所以不依赖任何外部库。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const rel = (p) => path.relative(ROOT, p);

let pass = 0;
let warn = 0;
let fail = 0;
const failures = [];
const warnings = [];

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
function soft(name, cond, detail = "") {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    warn++;
    warnings.push(name + (detail ? ` — ${detail}` : ""));
    console.log(`  ! ${name}${detail ? ` — ${detail}` : ""}`);
  }
}
function section(t) {
  console.log(`\n== ${t} ==`);
}
function read(f) {
  return fs.readFileSync(path.join(ROOT, f), "utf8");
}
function exists(f) {
  return fs.existsSync(path.join(ROOT, f));
}

/* ══════════════════════════════════════════════════════════════════
 * 1. 守卫清单：每条记录「哪个坑、守卫在哪、怎么判断守卫还在」
 *
 * 这一节就是 review.mjs 存在的主要理由。加新守卫请往下追加一条，
 * 并在 `制作笔记.md` 里写清当时是怎么踩到的。
 * ══════════════════════════════════════════════════════════════════ */

const GUARDS = [
  {
    id: "CRLF-行尾",
    why: "行尾 \\r 会被当成列名的一部分，导致整个 #4 文件解析成全空列（实测：列名解析结果 []）",
    file: "lib/db4.js",
    // 用字节级比较，避免被 JS/shell 的转义层级骗到（写这个脚本时就被骗过一次）
    must: 'if (line.endsWith("\\r")) line = line.slice(0, -1);',
    test: "CRLF：列数",
  },
  {
    id: "IIFE-脚本作用域",
    why:
      "index.html 用 classic <script>，所有文件共享全局词法作用域；" +
      "两个文件都写 `const api` 会 SyntaxError 且整个脚本被静默丢弃（页面只是「没反应」）",
    file: "lib/*.js",
    isGlob: true,
    must: "(function () {",
  },
  {
    id: "strict-行尾逗号",
    why: "曾经写成三元表达式两边都加逗号（`a ? x : y + \",\"`），看起来生效其实没有",
    file: "lib/db4.js",
    must: "opts.strict ? rowParts.join(\",\") : rowParts.join(\",\") + \",\"",
    test: "strict 模式总字段数",
  },
  {
    id: "codeTypes-转发",
    why:
      "Database.addColumn 曾经只转发 3 个参数，把 codeTypes 悄悄丢了，" +
      "矩阵子码类型被静默改成 NOMINAL（等于偷改用户文件）",
    file: "lib/model.js",
    must: "addColumn(name, type, codes, codeTypes)",
    test: "经 Database.addColumn 新建也保留子码类型",
  },
  {
    id: "帧边界-就近取帧",
    why:
      "900/(1000/30) 在 IEEE754 下 = 26.999999999999996，" +
      "用 floor 会让「后退一帧」退到 867ms（退过头）",
    file: "ui/video.js",
    must: "Math.floor(ms / store.frameStep + 0.5)",
    test: "933ms 退一帧",
  },
  {
    id: "无媒体时不读-video",
    why: "没加载视频时浏览器对 video.currentTime 的读写不一致，会把刚设好的播放头顶掉",
    file: "ui/video.js",
    must: 'if (seeking || !video.src) return;'.replace("seeking || ", ""), // 见下一行的两个守卫
    alsoMust: ["!video.src"],
  },
  {
    id: "悬挂编辑态",
    why:
      "编辑器没关就换数据（新建/打开）时，grid 的 activeEditor 会一直挂着，" +
      "导致所有后续渲染被推迟 —— 现象是「表格停在上一个项目的内容上」，极难查",
    file: "ui/grid.js",
    must: "function endEdit()",
    alsoMust: ["!document.contains(activeEditor)"],
    test: "编辑态是正常的",
  },
  {
    id: "单元素清单保留",
    why: "单条清单查询只剥掉一个最外层方括号，否则 `[[a],[b]]` 或 `[a]` 会错位",
    file: null, // 占位示例：本项目暂无此守卫，保留格式演示
    must: null,
  },
];

section("守卫清单（上次踩过的坑，现在还有人守着吗）");
for (const g of GUARDS) {
  if (!g.must) continue; // 跳过占位
  const files = g.isGlob
    ? fs.readdirSync(path.join(ROOT, "lib")).filter((f) => f.endsWith(".js")).map((f) => `lib/${f}`)
    : [g.file];
  for (const f of files) {
    if (!exists(f)) {
      ok(`[${g.id}] ${f} 存在`, false, "文件不见了");
      continue;
    }
    const src = read(f);
    ok(`[${g.id}] ${f} 守卫在位`, src.includes(g.must), `找不到: ${JSON.stringify(g.must)}`);
    if (g.alsoMust) {
      for (const m of g.alsoMust) ok(`[${g.id}] ${f} 附加守卫 ${JSON.stringify(m)}`, src.includes(m));
    }
  }
}

/* 每条守卫都应该在 verify.mjs 里有对应的回归测试，否则守卫被删了测试会跟着一起沉默 */
section("守卫 ↔ 回归测试 的配对");
// 断言可能落在任一测试文件里，两边都要查（帧边界那条就在 verify-web.mjs）
const testSources = ["verify.mjs", "verify-web.mjs"].filter(exists).map(read);
for (const g of GUARDS) {
  if (!g.test) continue;
  const hit = testSources.some((s) => s.includes(g.test));
  ok(`[${g.id}] 测试里有「${g.test}」`, hit, "verify.mjs / verify-web.mjs 都没找到这条断言");
}
soft(
  "每条守卫都登记了「为什么会踩到」",
  GUARDS.filter((g) => g.must).every((g) => g.why && g.why.length > 10),
);

/* ══════════════════════════════════════════════════════════════════
 * 2. 尺子还在不在（fixture 清单）
 * ══════════════════════════════════════════════════════════════════ */

section("尺子（金标准 fixture）");
const FIXTURES = [
  ["_fixtures/gold.db4", "Python 工具生成的 #4 金标准，verify.mjs 逐字符对拍"],
  ["_fixtures/gold.cells.csv", "逐 cell CSV 金标准（含原版的表头 trim / 行尾逗号缺陷）"],
  ["_fixtures/gold.opf", "工程文件金标准（含隐藏列、矩阵子码类型、未知条目）"],
  ["_fixtures/py_deflate.opf", "Python zipfile 的 DEFLATE 产物，用来证明 inflate 能解别人的压缩"],
  ["_fixtures/README.md", "夹具说明（含「为什么夹具列顺序必须自己先排好」这个陷阱）"],
];
for (const [f, desc] of FIXTURES) {
  ok(`${f} 存在`, exists(f), desc);
}

// 尺子会过期：夹具必须能被它自己的说明重新生成
const fixReadme = exists("_fixtures/README.md") ? read("_fixtures/README.md") : "";
soft("夹具 README 说明了怎么重新生成", /重新生成|PY|python3/.test(fixReadme));
soft(
  "夹具 README 记下了「Python 工具按传入顺序输出列，原版按列名排序」这个陷阱",
  /排序|VariableSort/.test(fixReadme),
);

/* ══════════════════════════════════════════════════════════════════
 * 3. 仓库卫生（防止悄悄退化）
 * ══════════════════════════════════════════════════════════════════ */

section("GitHub Pages 可达性（部署层，代码测试抓不到）");
{
  /* 真实踩过的坑：samples/ 目录原本叫 _samples/，
   * GitHub Pages 用 Jekyll 构建，**默认忽略下划线开头的目录**，
   * 于是线上 404，而本地自检全绿（本地是 http.server，没有 Jekyll）。
   * 这个坑只能靠"检查发布布局"发现，所以放进守门人。 */
  ok(".nojekyll 存在（禁用 Jekyll，防止下划线目录被吞）", exists(".nojekyll"));

  const topDirs = fs.readdirSync(ROOT, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  const underscoreDirs = topDirs.filter((d) => d.startsWith("_") && d !== "_fixtures" && d !== ".git");
  ok(
    `没有会被 Pages 吞掉的下划线目录（${underscoreDirs.join(",") || "无"}）`,
    underscoreDirs.length === 0,
    "下划线开头的目录在 GitHub Pages 上默认 404；改名，或确认 .nojekyll 已生效",
  );

  // 样本清单必须真实存在且能被应用读到
  ok("samples/samples.json 存在", exists("samples/samples.json"));
  ok("samples/README.md 存在", exists("samples/README.md"));
  if (exists("samples/samples.json")) {
    let manifest = null;
    try {
      manifest = JSON.parse(read("samples/samples.json"));
    } catch (e) {
      ok("samples.json 是合法 JSON", false, e.message);
    }
    if (manifest) {
      ok("samples.json 能解析", true);
      const items = Array.isArray(manifest.samples) ? manifest.samples : [];
      ok(`清单里有 ${items.length} 个样本`, items.length > 0);
      for (const it of items) {
        ok(`样本文件存在：${it.file}`, exists(path.join("samples", it.file)), "清单登记了但文件不在");
      }
      // 样本必须是合法 .opf（ZIP 头），否则点开会报错
      for (const it of items) {
        const p = path.join("samples", it.file);
        if (!exists(p)) continue;
        const head = fs.readFileSync(path.join(ROOT, p)).subarray(0, 4);
        ok(`样本是 ZIP 容器：${it.file}`, head[0] === 0x50 && head[1] === 0x4b);
      }
    }
  }

  // 应用里引用的路径必须与目录名一致（改过名但漏改代码，这里会红）
  const appSrc = exists("ui/app.js") ? read("ui/app.js") : "";
  ok('ui/app.js 引用的是 samples/ 而不是旧的 _samples/',
    appSrc.includes("./samples/") && !appSrc.includes("_samples/"));

  // 线上/本地都要能被 fetch 到的关键资源
  for (const f of ["index.html", "lib/analytics.js", "ui/chart.js", "ui/markstrip.js"]) {
    ok(`发布文件存在：${f}`, exists(f));
  }
}

section("仓库卫生");
const JS_FILES = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === ".git" || e.name === "node_modules" || e.name === "_fixtures") continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith(".js") || e.name.endsWith(".mjs")) JS_FILES.push(path.relative(ROOT, p));
  }
})(ROOT);

ok(`扫到 ${JS_FILES.length} 个 JS 文件`, JS_FILES.length > 8);

// 绝对路径写死 = 别人 clone 下来就炸。
// 只抓「真的把它当路径用」的写法（fs 调用 / import / 赋值给路径变量），
// 不误抓纯测试数据，例如夹具里 origpath 用的 "/tmp/x.mov"。
const ABS_PATTERNS = [
  /(?:fs\.\w+Sync|readFile|writeFile|createReadStream|createWriteStream|readdirSync|existsSync)\s*\(\s*["'`]\/(?:Users|home|tmp|var)\//,
  /from\s*["'`]\/(?:Users|home)\//,
  /(?:path|dir|root|filePath|ROOT)\w*\s*=\s*["'`]\/(?:Users|home)\/[^"'`]*["'`]/,
];
const absHits = [];
for (const f of JS_FILES) {
  const src = read(f);
  for (const re of ABS_PATTERNS) {
    const m = re.exec(src);
    if (m) absHits.push(`${f}: ${m[0].slice(0, 60)}`);
  }
}
ok("没有写死的绝对路径（fs/import/路径变量）", absHits.length === 0, absHits.join(" | "));

// 依赖卫生：零依赖是硬约束，出现裸 import 就是退化
const BARE_IMPORT = /^\s*import\s+[^"'\n]*from\s+["'](?!\.|\/|node:)[^"']+["']/m;
const bareHits = JS_FILES.filter((f) => BARE_IMPORT.test(read(f)));
ok("没有引入第三方依赖（零依赖约束）", bareHits.length === 0, bareHits.join(", "));

// index.html 的 script 顺序：lib 必须先于 ui（ui 依赖 lib 的命名空间）
const html = read("index.html");
const order = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map((m) => m[1]);
ok(`index.html 引用了 ${order.length} 个脚本`, order.length >= 10);
const lastLib = order.map((s, i) => (s.startsWith("lib/") ? i : -1)).filter((i) => i >= 0).pop();
const firstUi = order.findIndex((s) => s.startsWith("ui/"));
ok("lib/ 全部排在 ui/ 之前", lastLib !== -1 && firstUi !== -1 && lastLib < firstUi, order.join(" → "));
for (const need of ["lib/util.js", "lib/zip.js", "lib/model.js", "lib/db4.js", "lib/opf.js", "lib/store.js"]) {
  ok(`index.html 引入了 ${need}`, order.includes(need));
}
// util 必须在 model 之前（model 从 DVY.util 取函数）
ok("lib/util.js 排在 lib/model.js 之前", order.indexOf("lib/util.js") < order.indexOf("lib/model.js"));

// 文档与门口的东西
for (const f of ["README.md", "LICENSE", ".gitignore", "制作笔记.md", "Datavyu功能与实现报告.md"]) {
  ok(`${f} 存在`, exists(f));
}

// 密钥不该进仓库
const SECRET = /ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----/;
const secretHits = JS_FILES.filter((f) => SECRET.test(read(f)));
const docFiles = fs.readdirSync(ROOT).filter((f) => f.endsWith(".md"));
const secretDocs = docFiles.filter((f) => SECRET.test(read(f)));
ok("代码里没有硬编码令牌", secretHits.length === 0, secretHits.join(", "));
ok("文档里没有硬编码令牌", secretDocs.length === 0, secretDocs.join(", "));

/* ══════════════════════════════════════════════════════════════════
 * 4. 复习提示（不判定失败，只提醒）
 * ══════════════════════════════════════════════════════════════════ */

section("复习提示");
const notes = exists("制作笔记.md") ? read("制作笔记.md") : "";
soft("制作笔记.md 里记了 IIFE 那个坑", /IIFE|already been declared/.test(notes));
soft("制作笔记.md 里记了缓存导致的假失败", /缓存|cache/.test(notes));
soft("制作笔记.md 里记了浮点帧边界", /26\.99999|IEEE754|浮点/.test(notes));
soft("制作笔记.md 说明了「测试可能是我自己写错」", /期望.*错|是我的期望|断言写错/.test(notes));
soft(
  "制作笔记.md 记了浏览器缓存导致的假失败",
  /no-store|磁盘缓存|旧版/.test(notes),
);
soft(
  "制作笔记.md 记了「先证明是实现错还是期望错」这条纪律",
  /先证明|先确认|证明.*期望/.test(notes),
);
// 提醒：守卫多了但笔记没跟着长，说明有坑没记下来
const verifySrc = exists("verify.mjs") ? read("verify.mjs") : "";
const guardCount = GUARDS.filter((g) => g.must).length;
const readme = exists("README.md") ? read("README.md") : "";
// 文档里的测试数字必须和实际一致 —— 数字对不上，说明有人改了测试没改文档
const countIn = (src, re) => {
  const m = re.exec(src);
  return m ? Number(m[1]) : null;
};
// 断言数是动态生成的（循环里 ok() 很多次），数 ok( 没有意义。
// 真正有价值的是：README 和制作笔记这两个文档里的数字必须一致，
// 不一致说明有人只改了一处（这种情况确实会发生）。
const docNode = countIn(readme, /node verify\.mjs[^\n]*?(\d+)\s*项/);
const docWeb = countIn(readme, /node verify-web\.mjs[^\n]*?(\d+)\s*项/);
const noteNode = countIn(notes, /node verify\.mjs`?[^\n]*?(\d+)\s*项/);
const noteWeb = countIn(notes, /node verify-web\.mjs`?[^\n]*?(\d+)\s*项/);
soft(
  `README 与制作笔记的核心测试数一致（${docNode} / ${noteNode}）`,
  docNode !== null && docNode === noteNode,
  "两个文档的 verify.mjs 数字不一致，请同步",
);
soft(
  `README 与制作笔记的浏览器测试数一致（${docWeb} / ${noteWeb}）`,
  docWeb !== null && docWeb === noteWeb,
  "两个文档的 verify-web.mjs 数字不一致，请同步",
);

soft(
  `守卫数(${guardCount})与笔记体量匹配（笔记 ${notes.length} 字符）`,
  notes.length > guardCount * 400,
  "坑记进守卫了，但没写进制作笔记.md（下次靠人脑记 = 会忘）",
);

/* ══════════════════════════════════════════════════════════════════ */

console.log(`\n${"=".repeat(52)}`);
if (fail === 0 && warn === 0) {
  console.log(`守门人通过：${pass} 项，没有退化`);
} else if (fail === 0) {
  console.log(`守门人通过：${pass} 项，${warn} 条提醒（不阻塞）`);
  for (const w of warnings) console.log("  ! " + w);
} else {
  console.log(`通过 ${pass} 项，失败 ${fail} 项，提醒 ${warn} 条`);
  console.log("必须修的：");
  for (const f of failures) console.log("  - " + f);
  process.exit(1);
}
