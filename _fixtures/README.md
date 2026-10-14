# 测试夹具（金标准）

这些不是程序运行时需要的文件，而是**自检的对照物**。

- `gold.db4` / `gold.cells.csv` / `gold.opf`：由已验证的 Python 工具生成
  （`../datavyu_notes.py`，即逆向报告 §7 的配套产物）。
  `node verify.mjs` 要求 JS 实现读出来的结构、以及写回去的文本，
  与这些文件**逐字符一致**。改了 `lib/db4.js` 之后如果这里对不上，说明格式被改坏了。
- `py_deflate.opf`：故意用 Python `zipfile` 以 DEFLATE + dynamic Huffman 压缩，
  用来验证自写的 inflate 能解别人的压缩产物（不是只能解自己写的）。

重新生成（在 `自由发挥/` 目录下执行）：

```bash
cd datavyu-web
python3 - <<'PY'
import sys, os, zipfile
sys.path.insert(0, os.path.abspath('..'))
import datavyu_notes as D
cols = [ ... ]   # 见 verify.mjs 里用到的结构；列要按名字排序，和原版 VariableSort 一致
open('_fixtures/gold.db4','w',encoding='utf-8').write(D.write_db4(cols))
open('_fixtures/gold.cells.csv','w',encoding='utf-8').write(D.write_cells_csv(cols))
PY
```

> 注意：`write_cells_csv` 按**传入顺序**输出列，而原版 Datavyu 的 `exportAsCells` 会先
> 按列名排序（`VariableSort`）。所以夹具的列顺序必须自己先排好，否则对拍会一直差一列。
