@echo off
setlocal
cd /d "%~dp0" || exit /b 1
if not exist "package.json" goto wrong_folder
if not exist "src\server.js" goto wrong_folder
set "cleanup_failed="
for %%F in (
  "SERVER_STORES_PATCH_DOCS\INSTALL.md"
  "_electron_orchestration_v1_patches\ELECTRON_PATCH.md"
  "_electron_orchestration_v1_patches\RENDERER_PATCH.md"
  "_electron_orchestration_v1_patches\creator-analytics-backend-api.js"
  "_electron_orchestration_v1_patches\jobs-runner.js"
  "_electron_presence_orchestration_patches\ONLINE_PRESENCE_ARCHITECTURE.md"
  "_electron_presence_orchestration_patches\jobs-runner-presence-patch.md"
  "_electron_presence_orchestration_patches\online-users-backend-api.js"
  "_electron_team_v2_renderer_patches\RENDERER_PATCH.md"
  "_electron_team_v2_renderer_patches\team-analytics-api.js"
  "phase7-release.json"
  "routes\server-store-diagnostics.js"
) do (
  if exist "%%~F" del /f /q "%%~F"
  if exist "%%~F" set "cleanup_failed=1"
)
if exist "SERVER_STORES_PATCH_DOCS\" rd "SERVER_STORES_PATCH_DOCS" 2>nul
if exist "_electron_orchestration_v1_patches\" rd "_electron_orchestration_v1_patches" 2>nul
if exist "_electron_presence_orchestration_patches\" rd "_electron_presence_orchestration_patches" 2>nul
if exist "_electron_team_v2_renderer_patches\" rd "_electron_team_v2_renderer_patches" 2>nul
if defined cleanup_failed (
  echo ERROR: Some old files could not be deleted. See errors above.
  pause
  exit /b 1
)
echo Done. Old Backend files removed.
pause
exit /b 0
:wrong_folder
echo Put this BAT in the Backend root folder next to package.json.
pause
exit /b 1
