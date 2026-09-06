#!/bin/sh
# Skills 管理端 · 一键启动（macOS：后台服务 + Edge/Chrome App 窗口）
cd "$(dirname "$0")" || exit 1
chmod +x runtime/node-darwin-* 2>/dev/null
ARCH=$(uname -m); [ "$ARCH" = "x86_64" ] && ARCH=x64
if [ -x "runtime/node-darwin-$ARCH" ]; then
  NODE="runtime/node-darwin-$ARCH"
elif command -v node >/dev/null 2>&1; then
  NODE=node
else
  echo "未找到 Node 运行时（runtime/ 目录缺失且系统未装 Node）"; exit 1
fi
exec "$NODE" app.js
