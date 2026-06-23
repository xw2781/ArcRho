@echo off
setlocal EnableExtensions

REM Network-safe wrapper for running build_app.bat from a UNC path.
REM Usage from another PC:
REM   "\\Ne7saswpn02\e\XWSpace\Repos\ArcRho\frontend\build\build_app_from_network.bat"
REM Optional:
REM   set PYTHON_EXE=C:\Path\To\Python310\python.exe
REM   set ARCRHO_INSTALL_PYTHON_DEPS=1
REM Installer update feed publishing is handled by the delegated build_app.bat.

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

if /i "%ARCRHO_INSTALL_PYTHON_DEPS%"=="1" (
    "%PYTHON_EXE%" check_python_build_env.py --install-missing
    if errorlevel 1 (
        echo ERROR: Failed to install required Python build dependencies.
        popd
        cd /d "%ORIGINAL_DIR%" >nul 2>nul
        pause
        exit /b 1
    )
)

call :enable_sign_and_edit_executable
if errorlevel 1 (
    popd
    cd /d "%ORIGINAL_DIR%" >nul 2>nul
    pause
    exit /b 1
)

call build_app.bat %*
set "BUILD_EXIT_CODE=%ERRORLEVEL%"

popd
cd /d "%ORIGINAL_DIR%" >nul 2>nul

exit /b %BUILD_EXIT_CODE%

:enable_sign_and_edit_executable
set "ARCRHO_NETWORK_PACKAGE_JSON=%SCRIPT_DIR%..\package.json"
if not exist "%ARCRHO_NETWORK_PACKAGE_JSON%" (
    echo ERROR: Could not find package.json at %ARCRHO_NETWORK_PACKAGE_JSON%
    exit /b 1
)
powershell -NoProfile -ExecutionPolicy Bypass -Command "$p=$env:ARCRHO_NETWORK_PACKAGE_JSON; $text=Get-Content -LiteralPath $p -Raw; $q=[char]34; $falsePattern=$q+'signAndEditExecutable'+$q+'\s*:\s*false'; $truePattern=$q+'signAndEditExecutable'+$q+'\s*:\s*true'; if ($text -match $falsePattern) { $replacement=$q+'signAndEditExecutable'+$q+': true'; $text=[regex]::Replace($text,$falsePattern,$replacement,1); Set-Content -LiteralPath $p -Value $text -NoNewline; exit 0 }; if ($text -match $truePattern) { exit 0 }; Write-Error 'Could not find signAndEditExecutable in package.json.'; exit 1"
if errorlevel 1 (
    echo ERROR: Failed to enable signAndEditExecutable in package.json.
    exit /b 1
)
echo Enabled package.json build.win.signAndEditExecutable for network build.
exit /b 0
