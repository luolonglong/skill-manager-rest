@echo off
cd /d "%~dp0"
set "NODE=runtime\node.exe"
if not exist "%NODE%" set "NODE=node"
start "Skills Manager" /min "%NODE%" app.js
exit
