@echo off
setlocal

cd /d "%~dp0"

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-desktop.ps1"
set "EXIT_CODE=%ERRORLEVEL%"

echo.
if not "%EXIT_CODE%"=="0" (
  echo MyWiki Froggy desktop launcher failed. Error code: %EXIT_CODE%
  echo Please check logs\desktop-launch.log in this project folder.
) else (
  echo MyWiki Froggy desktop launcher has exited.
)
echo.
pause
exit /b %EXIT_CODE%
