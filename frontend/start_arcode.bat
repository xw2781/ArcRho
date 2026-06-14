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

for /f %%i in ('powershell -NoProfile -Command "Get-Date -Format yyyyMMddHHmmss"') do set "ARCRHO_UI_VERSION=%%i"
set "ARCRHO_APP_MODE=arcode"
set "ARCRHO_BACKEND_CONSOLE=same"

if not defined PYTHON_EXE (
  for /f "usebackq delims=" %%i in (`py -3.10 -c "import sys; print(sys.executable)" 2^>nul`) do set "PYTHON_EXE=%%i"
)

if not defined PYTHON_EXE set "PYTHON_EXE=python"

"%PYTHON_EXE%" -c "import uvicorn, fastapi, pandas, openpyxl" >nul 2>nul
if errorlevel 1 (
  echo ArcRho Python service dependencies were not found for: %PYTHON_EXE%
  echo Install the backend dependencies for that Python, or set PYTHON_EXE to a Python environment that has uvicorn, fastapi, pandas, and openpyxl.
  echo Example: set PYTHON_EXE=C:\Program Files\Python310\python.exe
  pause
  exit /b 1
)

"%PYTHON_EXE%" electron_shell.py --mode arcode
endlocal
