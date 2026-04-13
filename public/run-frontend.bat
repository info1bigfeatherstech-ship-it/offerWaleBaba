@echo off
REM Starts the Vite React app (offer_wale_baba).
REM From repo root (PowerShell):  .\backend\public\run-frontend.bat
REM Or use repo root:             .\run-frontend.bat
set "FRONTEND=%~dp0..\..\frontend\offer_wale_baba"
if not exist "%FRONTEND%\package.json" (
  echo ERROR: Could not find frontend at:
  echo   %FRONTEND%
  pause
  exit /b 1
)
cd /d "%FRONTEND%"
echo Starting Vite dev server in:
echo   %CD%
echo.
call npm run dev
pause
