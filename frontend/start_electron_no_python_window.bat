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

if not defined ARCRHO_UPDATE_DIR set "ARCRHO_UPDATE_DIR=E:\ArcRho Server\releases\installers"

set "ARCRHO_RELEASE_VERSION="
for /f "usebackq delims=" %%i in (`powershell -NoProfile -Command "$versions = @(); $dir = $env:ARCRHO_UPDATE_DIR; $manifest = Join-Path $dir 'latest.json'; if (Test-Path -LiteralPath $manifest) { try { $version = [string]((Get-Content -LiteralPath $manifest -Raw | ConvertFrom-Json).version); if ($version -match '^\d+\.\d+\.\d+$') { $versions += $version } } catch {} }; if (Test-Path -LiteralPath $dir -PathType Container) { Get-ChildItem -LiteralPath $dir -Filter 'ArcRho-Setup-*.exe' -File -ErrorAction SilentlyContinue | ForEach-Object { if ($_.Name -match '^ArcRho-Setup-(\d+\.\d+\.\d+)\.exe$') { $versions += $Matches[1] } } }; $versions | Sort-Object { [version]$_ } -Descending | Select-Object -First 1" 2^>nul`) do set "ARCRHO_RELEASE_VERSION=%%i"
if not defined ARCRHO_RELEASE_VERSION (
  for /f "usebackq delims=" %%i in (`powershell -NoProfile -Command "try { $version = [string]((Get-Content -LiteralPath 'package.json' -Raw | ConvertFrom-Json).version); if ($version -match '^\d+\.\d+\.\d+$') { $version } } catch {}" 2^>nul`) do set "ARCRHO_RELEASE_VERSION=%%i"
)

for /f %%i in ('powershell -NoProfile -Command "Get-Date -Format yyyyMMddHHmmss"') do set "ARCRHO_UI_VERSION_STAMP=%%i"
if defined ARCRHO_RELEASE_VERSION (
  if not defined ARCRHO_DISPLAY_VERSION set "ARCRHO_DISPLAY_VERSION=%ARCRHO_RELEASE_VERSION%+"
  set "ARCRHO_UI_VERSION=%ARCRHO_RELEASE_VERSION%+%ARCRHO_UI_VERSION_STAMP%"
) else (
  set "ARCRHO_UI_VERSION=%ARCRHO_UI_VERSION_STAMP%"
)
set "ARCRHO_BACKEND_CONSOLE=hidden"

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

set "PYTHONW_EXE=%PYTHON_EXE%"
for /f "usebackq delims=" %%i in (`"%PYTHON_EXE%" -c "from pathlib import Path; import sys; p=Path(sys.executable); q=p.with_name('pythonw.exe'); print(q if q.exists() else p)" 2^>nul`) do set "PYTHONW_EXE=%%i"

set "PYTHON_EXE=%PYTHONW_EXE%"
start "" "%PYTHONW_EXE%" "%~dp0electron_shell.py"
endlocal
