@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo ==========================================
echo       Wedding Video Tool
echo ==========================================
echo.

if not exist "node_modules" (
  echo [错误] 未找到 node_modules，请先执行 npm install
  pause
  exit /b 1
)

start "Wedding Video Tool Server" /min cmd /c "npm start"
timeout /t 2 /nobreak >nul
start "" "http://127.0.0.1:3000"
