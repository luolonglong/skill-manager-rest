@echo off
cd /d "%~dp0"
if exist .server-pid (
  for /f %%i in (.server-pid) do taskkill /F /PID %%i >nul 2>&1
  del .server-pid >nul 2>&1
  echo [skills-manager] server stopped.
) else (
  echo [skills-manager] no running server record.
)
pause
