@echo off
setlocal
if exist "src\services\vault-inventory-service.js" del /f /q "src\services\vault-inventory-service.js"
if exist "src\services\vault-inventory-normalizer.js" del /f /q "src\services\vault-inventory-normalizer.js"
if exist "src\services\vault-inventory-service.test.js" del /f /q "src\services\vault-inventory-service.test.js"
endlocal
exit /b 0
