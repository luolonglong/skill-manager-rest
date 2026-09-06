#!/bin/sh
# Skills 管理端 · 关闭后台服务（macOS）
cd "$(dirname "$0")" || exit 1
if [ -f .server-pid ]; then
  kill "$(cat .server-pid)" 2>/dev/null
  rm -f .server-pid
  echo "[skills-manager] 服务已关闭"
else
  echo "[skills-manager] 没有找到运行中的服务记录"
fi
