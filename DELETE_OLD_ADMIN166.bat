@echo off
cd /d "%~dp0"
if not exist "src\server.js" (
  echo Put this file in the Backend project root.
  pause
  exit /b 1
)
del /q "public\pages\admin.js" "public\pages\admin-auth.js" 2>nul
echo Old admin files removed.
pause
