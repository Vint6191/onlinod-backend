@echo off
setlocal
cd /d "%~dp0"

if exist "src\services\vault-inventory-service.js" del /f /q "src\services\vault-inventory-service.js"
if exist "src\services\vault-inventory-normalizer.js" del /f /q "src\services\vault-inventory-normalizer.js"
if exist "src\services\vault-inventory-service.test.js" del /f /q "src\services\vault-inventory-service.test.js"
if exist "src\routes\vault-intelligence.js" del /f /q "src\routes\vault-intelligence.js"
if exist "src\routes\vault-unsorted.js" del /f /q "src\routes\vault-unsorted.js"
if exist "src\services\vault-intelligence-service.js" del /f /q "src\services\vault-intelligence-service.js"

endlocal
exit /b 0
