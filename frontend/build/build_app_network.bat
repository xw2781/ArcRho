@echo off
setlocal EnableExtensions

REM Network-safe wrapper for running build_app.bat from a UNC path.
REM Usage from another PC:
REM   "\\Ne7saswpn02\e\XWSpace\Repos\ArcRho\frontend\build\build_app_network.bat"
REM Optional:
REM   set PYTHON_EXE=C:\Path\To\Python310\python.exe

set "SCRIPT_DIR=%~dp0"
set "ORIGINAL_DIR=%CD%"

pushd "%SCRIPT_DIR%"
if errorlevel 1 (
    echo ERROR: Could not map build directory: %SCRIPT_DIR%
    echo HINT: Confirm the network path is reachable from this PC.
    pause
    exit /b 1
)

if not defined PYTHON_EXE (
    for /f "usebackq delims=" %%I in (`py -3.10 -c "import sys; print(sys.executable)" 2^>nul`) do set "PYTHON_EXE=%%I"
)
if not defined PYTHON_EXE if exist "%LOCALAPPDATA%\Programs\Python\Python310\python.exe" set "PYTHON_EXE=%LOCALAPPDATA%\Programs\Python\Python310\python.exe"
if not defined PYTHON_EXE if exist "C:\Program Files\Python310\python.exe" set "PYTHON_EXE=C:\Program Files\Python310\python.exe"

if not defined PYTHON_EXE (
    echo ERROR: Python 3.10 was not found.
    echo HINT: Install Python 3.10.6+ or set PYTHON_EXE before running this wrapper.
    popd
    pause
    exit /b 1
)

echo Using PYTHON_EXE=%PYTHON_EXE%
if /i "%~1"=="--check" (
    "%PYTHON_EXE%" --version
    "%PYTHON_EXE%" -c "import sys; raise SystemExit(0 if (3, 10, 6) <= sys.version_info[:3] < (3, 11) else 1)"
    if errorlevel 1 (
        echo ERROR: This wrapper requires Python 3.10.6+ within the Python 3.10 line.
        popd
        pause
        exit /b 1
    )
    echo Network build wrapper check passed.
    popd
    cd /d "%ORIGINAL_DIR%" >nul 2>nul
    exit /b 0
)

call build_app.bat %*
set "BUILD_EXIT_CODE=%ERRORLEVEL%"

popd
cd /d "%ORIGINAL_DIR%" >nul 2>nul

exit /b %BUILD_EXIT_CODE%
