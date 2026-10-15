# Datavyu 网页版（datavyu-web）

**浏览器里的视频行为编码工具。零依赖、无构建、纯本地、离线可用。**

Datavyu 是心理学 / 发展科学 / 语言学常用的视频行为编码工具：列 = 要编码的行为（"注视""手势""发声"），
行 = 一次事件，记 `onset` / `offset` 两个时间戳和若干"码"。

原版是 JavaFX 桌面程序，靠内嵌 JRE 分发，今天已经很难装起来。这个项目把它重做成网页版，
并且**保持文件级互通**：能直接读写 Datavyu 的 `.opf` 工程文件。

---

## 快速开始

```bash
# 方式一：双击
启动.command

# 方式二：任意静态服务器
python3 -m http.server 8793 --bind 127.0.0.1
# 然后打开 http://127.0.0.1:8793/index.html

# 想看示例数据：
# http://127.0.0.1:8793/index.html?demo=1
```

不需要 `npm install`，不需要构建，没有后端。

---

## 功能

**编码**
- 三种列类型：`TEXT`（自由文本，就是"笔记"）/ `NOMINAL`（单值分类）/ `MATRIX`（多子码）
- 行（cell）的 onset / offset 时间码（`hh:mm:ss:mmm`），也接受 `1.5s`、`2000` 简写
- 帧精确跳转与逐帧步进；`I` / `O` 把选中行的起点 / 终点设为播放头
- 拖动 cell 两端或时间轴色块直接改起止；改起点越过终点会自动顶开另一端
- 撤销 / 重做（整库快照，不会漏改）

**看**
- 泳道式时间对齐：重叠事件自动上下错开，不叠在一起
- 全局时间轴轨道视图：多列事件同屏对比（原版没有这个）
- 播放时自动高亮当前 cell

**文件**
- `.opf` 工程读写（ZIP = `project` YAML + `db` "#4" 文本 + 播放器设置）
- `#4` 数据库文本读写
- 导出「每行一个 cell」CSV / 「逐帧」CSV / 本程序 JSON
- 浏览器 `localStorage` 自动存档

**隐私**
- 没有后端、没有账号、不发任何网络请求；视频文件只在你的浏览器里解码播放

---

## 快捷键

| 动作 | 键 |
|---|---|
| 播放 / 暂停 | `空格` |
| 前进 / 后退一帧 | `→` / `←` |
| 前进 / 后退 1 秒 | `L` / `J` |
| 跳到开头 / 结尾 | `Home` / `End` |
| 设起点 / 设终点 | `I` / `O` |
| 在播放头新建行 | `N` |
| 在选中行之后 / 之前新建 | `⌘R` / `⌘L` |
| 删除选中行 | `Delete` |
| 撤销 / 重做 | `⌘Z` / `⇧⌘Z` |
| 新建列 | `⌘K` |
| 时间对齐开关 | `⌘T` |
| 缩放 | `⌘+` `⌘-` `⌘0` |
| 保存 `.opf` / 打开 | `⌘S` / `⌘O` |

---

## 自检

```bash
node verify.mjs        # 尺子：核心逻辑 78 项
node verify-web.mjs    # 尺子：浏览器端 43 项（自己拉起本机 Chrome，用 DevTools 协议断言真实 DOM）
node review.mjs        # 守门人：50 项，检查「以前踩过的坑现在还有没有人守着」

# 对已经部署好的线上站点跑同一套浏览器测试：
node verify-web.mjs --url=https://dspan-code.github.io/datavyu-web/
```

`verify.mjs` 会把本实现的输出和一份**金标准夹具**逐字符对拍
（夹具由独立的 Python 实现生成）；`verify-web.mjs` 不需要装 Playwright/Puppeteer，
用的是 Chrome 自带的 CDP，通过 Node 原生 `WebSocket` 通信。

`review.mjs` 是**守门人**，和上面两个的分工不同：它不做逻辑断言，而是核对
「上次踩过的坑，守卫还在不在、有没有对应的回归测试、尺子有没有过期、仓库有没有退化」。
为什么需要它：**守卫被删掉时，跟着它一起失效的测试也会一起变绿**——
这种"元层面"的退化，普通的测试抓不到。

每条守卫都登记了「为什么会踩到」，见 `review.mjs` 的 `GUARDS` 和 `制作笔记.md` §8.5。

---

## 为什么自己写 ZIP 和 Deflate

项目硬约束是**零依赖、无构建**：这类科研工具最大的敌人就是"装不上"。
所以 `lib/zip.js` 是一个最小可用的 ZIP 编解码器：

- 读：`stored` + `deflate`（stored / fixed-Huffman / dynamic-Huffman 三种块都能解）
- 写：`stored` + `deflate`（只发 fixed-Huffman 块，短数据体积略大但完全合规）
- 附带 CRC32、中央目录、UTF-8 / latin1 双解码

它已经被验证能解 Python `zipfile` 生成的 DEFLATE 产物，不只是"能读自己写的文件"。

---

## 结构

```
index.html          外壳：顶栏菜单 / 播放器 / 侧栏 / 表格 / 时间轴 / 状态栏
css/app.css         深色紧凑主题（不引任何外部资源）
lib/                纯逻辑，不碰 DOM，可在 Node 里直接测
  util.js           时间码、三种转义、UID
  zip.js            ZIP + inflate/deflate + CRC32
  model.js          Database / Column / Cell / Value / MatrixValue / History
  db4.js            "#4" 编解码 + 逐 cell CSV + 逐帧 CSV + CSV 词法
  opf.js            .opf 读写 + project YAML + 格式自动识别
  store.js          状态中枢：改动入口 apply()、撤销栈、本地存档、导出
ui/                 只做渲染与输入
  timeutil.js       刻度 / 配色 / 时间输入解析
  video.js          播放器 + 走带控制器
  grid.js           电子表格（泳道对齐 / 堆叠两种模式）
  timeline.js       时间轴轨道
  app.js            接线：菜单 / 快捷键 / 对话框 / 分隔条
```

设计要点：

1. **时间基准只有一个** —— `store.time`（整毫秒）。`<video>.currentTime` 只是执行器。
   浮点秒 + seek 取整会让帧步进出现 off-by-one。
2. **所有数据改动必须过 `store.apply(label, fn)`** —— 快照 → 执行 → 失败回滚 → 入撤销栈 → 广播 → 自动存档。
   UI 层无法绕过去改数据，所以撤销 / 持久化 / 重渲染三条链路天然一致。
3. **格式兼容优先，缺陷"默认兼容 + 可选修正"** —— 原版导出有两个已知缺陷
   （逐 cell CSV 表头被 trim 但数据行多一个逗号；逐帧 CSV 多出一帧），
   默认复刻以保证对拍一致，同时提供开关修正。

---

## 与原版 Datavyu 的差异

都是有意为之，理由见 `Datavyu功能与实现报告.md`：

- 导出拆成三个明确入口（原版「Export File…」忽略文件过滤器，永远只出 cell CSV）
- 不提供 `.odb` 保存（原版该分支是死代码，选了会静默不写文件）
- 列重名 / 非法列名直接报错（原版静默覆盖，会丢数据）
- 列名额外允许连字符（真实 `.opf` 里就有 `my-notes` 这种列名）
- 多了时间轴轨道 + 播放头跟随

## 已知未做

多工作表标签、浏览器内脚本 API、多视频同步、数据校验器（重叠检测 / 未编码区间统计）。
路线图见 `Datavyu功能与实现报告.md` §六。

---

## 文档

- `Datavyu功能与实现报告.md` —— 功能分析、原版问题清单、技术选型、框架设计
- `制作笔记.md` —— 逐步制作笔记，每个踩过的坑与修法（浮点、缓存、脚本作用域等）

## 致谢与声明

本项目是**独立重实现**，不是 Datavyu 官方项目，与 Databrary 项目无隶属关系。

格式规范来自对 Datavyu 1.3.8 公开分发包的行为观察与字节码分析（见 `制作笔记.md` 与
`Datavyu功能与实现报告.md`），代码为全新编写，未复制原项目源码。
Datavyu 由 Databrary Project（纽约大学）开发，采用其自身的开源许可；
若你依赖原版行为，请以官方发布为准。

## 许可

MIT
