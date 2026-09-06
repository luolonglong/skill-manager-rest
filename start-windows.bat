@echo off
rem Skills 管理端 REST+TUI（Windows）：TUI 会自动拉起 server.js，退出 q 时一并结束
cd /d %~dp0
node tui.js
