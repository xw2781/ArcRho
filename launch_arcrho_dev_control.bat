@echo off
setlocal
cd /d "%~dp0"

set "PYTHON_EXE="
for /f "usebackq delims=" %%i in (`py -3.10 -c "import sys; print(sys.executable)" 2^>nul`) do set "PYTHON_EXE=%%i"
if not defined PYTHON_EXE (
  echo Python 3.10 is required to run the ArcRho Dev Control Center.
  pause
  exit /b 1
)

"%PYTHON_EXE%" -m tools.arcrho_dev_control.server
endlocal
