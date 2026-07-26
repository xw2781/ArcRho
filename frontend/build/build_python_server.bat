@echo off
setlocal EnableExtensions
set "SCRIPT_DIR=%~dp0"
for %%I in ("%SCRIPT_DIR%..") do set "APP_ROOT=%%~fI"
cd /d "%APP_ROOT%"

if not defined PYTHON_EXE (
    for /f "usebackq delims=" %%I in (`py -3.10 -c "import sys; print(sys.executable)" 2^>nul`) do set "PYTHON_EXE=%%I"
)
if not defined PYTHON_EXE set "PYTHON_EXE=python"

"%PYTHON_EXE%" --version
if errorlevel 1 (
    echo ERROR: Could not run selected Python interpreter: %PYTHON_EXE%
    echo HINT: Install Python 3.10 or set PYTHON_EXE to a Python 3.10 executable.
    exit /b 1
)
"%PYTHON_EXE%" -c "import sys; raise SystemExit(0 if (3, 10, 6) <= sys.version_info[:3] < (3, 11) else 1)" >nul 2>nul
if errorlevel 1 (
    echo ERROR: ArcRho server packaging requires Python 3.10.6 or newer within the Python 3.10 line.
    echo HINT: Install Python 3.10.6+ or set PYTHON_EXE to a compatible Python 3.10 executable.
    exit /b 1
)

if "%~1"=="--version" (
    "%PYTHON_EXE%" -m PyInstaller --version
    exit /b %ERRORLEVEL%
)

set "CHECK_PYTHON_BUILD_ENV_ARGS=build\check_python_build_env.py"
if /i "%ARCRHO_INSTALL_PYTHON_DEPS%"=="1" set "CHECK_PYTHON_BUILD_ENV_ARGS=%CHECK_PYTHON_BUILD_ENV_ARGS% --install-missing"

"%PYTHON_EXE%" %CHECK_PYTHON_BUILD_ENV_ARGS%
if errorlevel 1 exit /b 1

set "PYINSTALLER_ARGS=build\server.spec --distpath python_dist --workpath python_build --noconfirm"
if "%~1"=="--clean" set "PYINSTALLER_ARGS=%PYINSTALLER_ARGS% --clean"

"%PYTHON_EXE%" -m PyInstaller %PYINSTALLER_ARGS%
if errorlevel 1 exit /b %ERRORLEVEL%

if not exist "python_dist\arcrho_server\arcrho_server.exe" (
    echo ERROR: PyInstaller did not produce python_dist\arcrho_server\arcrho_server.exe.
    exit /b 1
)
if not exist "python_dist\arcrho_server\_internal\ui\index.html" (
    echo ERROR: PyInstaller bundle is missing served UI assets.
    echo HINT: Expected python_dist\arcrho_server\_internal\ui\index.html.
    exit /b 1
)
if not exist "python_dist\arcrho_server\_internal\icons\icon.png" (
    echo ERROR: PyInstaller bundle is missing served icon assets.
    echo HINT: Expected python_dist\arcrho_server\_internal\icons\icon.png.
    exit /b 1
)

"%PYTHON_EXE%" build\write_backend_artifact_manifest.py python_dist\arcrho_server
if errorlevel 1 (
    echo ERROR: Failed to write the ArcRho backend artifact manifest.
    exit /b 1
)

exit /b 0
