@echo off
setlocal EnableExtensions
set "SCRIPT_DIR=%~dp0"
for %%I in ("%SCRIPT_DIR%..") do set "PYTHON_API_ROOT=%%~fI"

if not defined PYTHON_EXE (
    for /f "usebackq delims=" %%I in (`py -3.10 -c "import sys; print(sys.executable)" 2^>nul`) do set "PYTHON_EXE=%%I"
)
if not defined PYTHON_EXE set "PYTHON_EXE=python"

"%PYTHON_EXE%" --version
if errorlevel 1 (
    echo ERROR: Could not run selected Python interpreter: %PYTHON_EXE%
    exit /b 1
)
"%PYTHON_EXE%" -c "import sys; raise SystemExit(0 if sys.version_info[:2] >= (3, 10) else 1)" >nul 2>nul
if errorlevel 1 (
    echo ERROR: arcrho-api package publishing requires Python 3.10 or newer.
    exit /b 1
)

"%PYTHON_EXE%" "%PYTHON_API_ROOT%\tools\publish_package.py" %*
exit /b %ERRORLEVEL%
