@echo off
cd /d "%~dp0"
set "NODE=runtime
ode.exe"
if not exist "%NODE%" set "NODE=node"
echo [skills-manager] foreground server for debugging (Ctrl+C to stop)
"%NODE%" server.js
pause
