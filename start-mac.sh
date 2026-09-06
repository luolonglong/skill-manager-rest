#!/bin/sh
# Skills 管理端 REST+TUI（macOS/Linux）：TUI 会自动拉起 server.js，退出 q 时一并结束
cd "$(dirname "$0")"
node tui.js
