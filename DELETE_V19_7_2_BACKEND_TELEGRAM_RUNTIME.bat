@echo off
setlocal
cd /d "%~dp0"
echo Removing obsolete backend Telegram MTProto runtime...
if exist "src\services\telegram-mtproto-runtime.js" del /f /q "src\services\telegram-mtproto-runtime.js"
if exist "src\services\telegram-mtproto-runtime.test.js" del /f /q "src\services\telegram-mtproto-runtime.test.js"
echo.
echo V19.7.2 backend cleanup complete.
pause
