@echo off
setlocal
cd /d "%~dp0"

set "NODE_HOME=%~dp0node-portable"
set "NPM_CMD=npm.cmd"

if exist "%NODE_HOME%\node.exe" (
  set "PATH=%NODE_HOME%;%PATH%"
  set "NPM_CMD=%NODE_HOME%\npm.cmd"
)

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js not found. Extract the portable zip to: %NODE_HOME%
  echo Expected: %NODE_HOME%\node.exe
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo node_modules not found. Running npm install...
  call "%NPM_CMD%" install
  if errorlevel 1 (
    echo npm install failed.
    pause
    exit /b 1
  )
)

for /f %%i in ('powershell -NoProfile -Command "Get-Date -Format yyyyMMddHHmmss"') do set "ADAS_UI_VERSION=%%i"

python electron_shell.py
endlocal
