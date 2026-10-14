#!/bin/bash
# 双击运行：起一个只绑 127.0.0.1 的静态服务并打开浏览器。
# 为什么不用 file:// 直接开 index.html：file:// 下浏览器对本地文件的限制更多，
# 用回环 HTTP 行为最接近真实部署，也和项目里其他程序一致。
cd "$(dirname "$0")" || exit 1
PORT=8793
while lsof -nP -iTCP:$PORT -sTCP:LISTEN >/dev/null 2>&1; do PORT=$((PORT+1)); done
echo "Datavyu 网页版 -> http://127.0.0.1:$PORT/index.html"
echo "（带着 ?demo=1 可以直接看示例数据）"
echo "按 Ctrl+C 结束。"
( sleep 1; open "http://127.0.0.1:$PORT/index.html" 2>/dev/null || true ) &
exec python3 -m http.server "$PORT" --bind 127.0.0.1
