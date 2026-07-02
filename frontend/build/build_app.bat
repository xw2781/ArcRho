@echo off
setlocal EnableExtensions
set "SCRIPT_DIR=%~dp0"
for %%I in ("%SCRIPT_DIR%..") do set "APP_ROOT=%%~fI"

if defined ARCRHO_BUILD_LOG_ACTIVE goto after_log_setup
for /f "usebackq delims=" %%I in (`powershell -NoProfile -Command "Get-Date -Format yyyyMMdd-HHmmss"`) do set "ARCRHO_BUILD_LOG_STAMP=%%I"
set "ARCRHO_BUILD_LOG_FILE=%SCRIPT_DIR%log\build_app_%ARCRHO_BUILD_LOG_STAMP%.log"
echo Writing build log to: %ARCRHO_BUILD_LOG_FILE%
powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%run_with_log.ps1" -LogPath "%ARCRHO_BUILD_LOG_FILE%" -CommandPath "%~f0" %*
exit /b %ERRORLEVEL%

:after_log_setup
cd /d "%APP_ROOT%"

echo ========================================
echo Building ArcRho Standalone Application
echo ========================================
echo.
if defined ARCRHO_BUILD_LOG_FILE (
    echo Build log: %ARCRHO_BUILD_LOG_FILE%
    echo.
)

REM Setup portable node in PATH
set "NODE_HOME=%APP_ROOT%\node-portable"
set "PATH=%NODE_HOME%;%PATH%"
set "APP_BUILDER_EXE=node_modules\app-builder-bin\win\x64\app-builder.exe"
set "APP_VERSION="
set "UPDATE_FEED_DIR=E:\ArcRho Server\releases\installers"
if not defined PYTHON_API_PACKAGE_DIR set "PYTHON_API_PACKAGE_DIR=E:\ArcRho Server\packages"
set "PYTHON_API_WHEEL="

if not defined PYTHON_EXE (
    for /f "usebackq delims=" %%I in (`py -3.10 -c "import sys; print(sys.executable)" 2^>nul`) do set "PYTHON_EXE=%%I"
)
if not defined PYTHON_EXE set "PYTHON_EXE=python"

echo Using Python: %PYTHON_EXE%
call :validate_python_310
if errorlevel 1 (
    echo.
    pause
    exit /b 1
)
echo.

echo Step 0: Validating release note fragments...
echo ----------------------------------------
"%PYTHON_EXE%" build\release_notes.py check
if errorlevel 1 (
    echo ERROR: Release note fragment validation failed.
    echo.
    pause
    exit /b 1
)
echo Release note fragments validated.
echo.

echo Step 1: Updating application version...
echo ----------------------------------------
set "APP_VERSION_FILE=build\app_version.txt"
if exist "%APP_VERSION_FILE%" del /q "%APP_VERSION_FILE%" >nul 2>nul
if "%~1"=="" (
    "%PYTHON_EXE%" build\version_manager.py --release-feed-dir "%UPDATE_FEED_DIR%" --version-file "%APP_VERSION_FILE%"
) else (
    "%PYTHON_EXE%" build\version_manager.py "%~1" --version-file "%APP_VERSION_FILE%"
)
if errorlevel 1 (
    echo ERROR: Failed to update application version metadata.
    echo.
    pause
    exit /b 1
)
if exist "%APP_VERSION_FILE%" (
    set /p APP_VERSION=<"%APP_VERSION_FILE%"
    del /q "%APP_VERSION_FILE%" >nul 2>nul
)
if not defined APP_VERSION (
    echo ERROR: Version updater did not return a version.
    echo.
    pause
    exit /b 1
)
echo Building version %APP_VERSION%
echo.

echo Step 2: Building Python API wheel...
echo ----------------------------------------
call :build_python_api_wheel
if errorlevel 1 (
    echo.
    pause
    exit /b 1
)
echo Python API wheel built: %PYTHON_API_WHEEL%
echo.

echo Step 3: Building Python app server with PyInstaller...
echo ----------------------------------------
call :run_pyinstaller
if errorlevel 1 (
    echo.
    pause
    exit /b 1
)
echo Python app server built successfully!
echo.

echo Step 4: Building Electron app with electron-builder...
echo ----------------------------------------
if not exist "python_dist\arcrho_server\arcrho_server.exe" (
    echo ERROR: Missing app-server bundle: python_dist\arcrho_server\arcrho_server.exe
    echo HINT: PyInstaller step did not produce the server executable.
    echo       Do not continue, otherwise installer may build fast but fail at launch.
    echo.
    pause
    exit /b 1
)
call :prepare_app_builder
call :run_electron
if errorlevel 1 (
    echo.
    pause
    exit /b 1
)

if not exist "dist\ArcRho-Setup-*.exe" (
    echo ERROR: Installer was not generated in dist\.
    echo.
    pause
    exit /b 1
)

echo.
echo Step 5: Generating release notes...
echo ----------------------------------------
set "RELEASE_NOTE_PATH_FILE=build\release_note_path_%APP_VERSION%.txt"
if exist "%RELEASE_NOTE_PATH_FILE%" del /q "%RELEASE_NOTE_PATH_FILE%" >nul 2>nul
"%PYTHON_EXE%" build\release_notes.py release "%APP_VERSION%" --path-file "%RELEASE_NOTE_PATH_FILE%"
if errorlevel 1 (
    echo ERROR: Failed to generate release notes for version %APP_VERSION%.
    echo.
    pause
    exit /b 1
)
if exist "%RELEASE_NOTE_PATH_FILE%" (
    set /p RELEASE_NOTE_PATH=<"%RELEASE_NOTE_PATH_FILE%"
    del /q "%RELEASE_NOTE_PATH_FILE%" >nul 2>nul
)
if not defined RELEASE_NOTE_PATH (
    echo ERROR: Release note generator did not return a release note path.
    echo.
    pause
    exit /b 1
)
echo Release notes generated: %RELEASE_NOTE_PATH%
echo.

echo Step 6: Publishing installer update feed...
echo ----------------------------------------
powershell -NoProfile -ExecutionPolicy Bypass -File "build\publish_update_feed.ps1" -InstallerPath "dist\ArcRho-Setup-%APP_VERSION%.exe" -FeedDir "%UPDATE_FEED_DIR%" -ReleaseNotesPath "%RELEASE_NOTE_PATH%"
if errorlevel 1 (
    echo ERROR: Failed to publish installer update feed.
    echo.
    pause
    exit /b 1
)
echo Installer update feed published: %UPDATE_FEED_DIR%
echo.

echo Step 7: Publishing Python API package...
echo ----------------------------------------
call :publish_python_api_package
if errorlevel 1 (
    echo.
    pause
    exit /b 1
)
echo Python API package published: %PYTHON_API_PACKAGE_DIR%
echo.

echo Step 8: Cleaning Python build artifacts...
echo ----------------------------------------
if exist "python_dist" (
    rmdir /s /q "python_dist"
)
if exist "python_build" (
    rmdir /s /q "python_build"
)

if exist "dist\win-unpacked" (
    rmdir /s /q "dist\win-unpacked"
)
del /q "dist\*Portable*.exe" 2>nul
del /q "dist\*-portable*.exe" 2>nul
del /q "dist\*.zip" 2>nul

echo.
echo ========================================
echo Build completed successfully!
echo ========================================
echo.
echo Output location: dist\
echo Update feed: %UPDATE_FEED_DIR%
echo.
echo - ArcRho-Setup-%APP_VERSION%.exe  (Installer)
echo - %UPDATE_FEED_DIR%\ArcRho-Setup-%APP_VERSION%.exe  (Published Installer)
echo - %UPDATE_FEED_DIR%\latest.json  (Update Manifest)
echo - %PYTHON_API_PACKAGE_DIR%\arcrho_api-latest.whl  (Python API Package)
echo - %RELEASE_NOTE_PATH%  (Release Notes)
echo.
pause
endlocal
exit /b 0

:build_python_api_wheel
if not exist "%NODE_HOME%\node.exe" (
    echo ERROR: Missing portable node: %NODE_HOME%\node.exe
    exit /b 1
)
call "%NODE_HOME%\node.exe" build\build_python_api_wheel.js
if errorlevel 1 (
    echo ERROR: Failed to build Python API wheel.
    exit /b 1
)
for %%I in ("build\python_packages\arcrho_api-*.whl") do set "PYTHON_API_WHEEL=%%~fI"
if not defined PYTHON_API_WHEEL (
    echo ERROR: Python API wheel was not generated in build\python_packages.
    exit /b 1
)
if not exist "%PYTHON_API_WHEEL%" (
    echo ERROR: Python API wheel path does not exist: %PYTHON_API_WHEEL%
    exit /b 1
)
exit /b 0

:publish_python_api_package
if not defined PYTHON_API_WHEEL (
    echo ERROR: Python API wheel path is empty.
    exit /b 1
)
if not exist "%PYTHON_API_WHEEL%" (
    echo ERROR: Python API wheel does not exist: %PYTHON_API_WHEEL%
    exit /b 1
)
if not exist "%PYTHON_API_PACKAGE_DIR%" (
    mkdir "%PYTHON_API_PACKAGE_DIR%"
    if errorlevel 1 (
        echo ERROR: Failed to create Python API package directory: %PYTHON_API_PACKAGE_DIR%
        exit /b 1
    )
)
copy /Y "%PYTHON_API_WHEEL%" "%PYTHON_API_PACKAGE_DIR%\" >nul
if errorlevel 1 (
    echo ERROR: Failed to publish versioned Python API wheel to %PYTHON_API_PACKAGE_DIR%.
    exit /b 1
)
copy /Y "%PYTHON_API_WHEEL%" "%PYTHON_API_PACKAGE_DIR%\arcrho_api-latest.whl" >nul
if errorlevel 1 (
    echo ERROR: Failed to publish arcrho_api-latest.whl to %PYTHON_API_PACKAGE_DIR%.
    exit /b 1
)
exit /b 0

:validate_python_310
"%PYTHON_EXE%" --version
if errorlevel 1 (
    echo ERROR: Could not run selected Python interpreter: %PYTHON_EXE%
    echo HINT: Install Python 3.10 or set PYTHON_EXE to a Python 3.10 executable.
    exit /b 1
)
"%PYTHON_EXE%" -c "import sys; raise SystemExit(0 if (3, 10, 6) <= sys.version_info[:3] < (3, 11) else 1)" >nul 2>nul
if errorlevel 1 (
    echo ERROR: ArcRho packaging requires Python 3.10.6 or newer within the Python 3.10 line.
    echo HINT: Install Python 3.10.6+ or set PYTHON_EXE to a compatible Python 3.10 executable before running build_app.bat.
    exit /b 1
)
exit /b 0

:run_pyinstaller
call build\build_python_server.bat
if not errorlevel 1 exit /b 0

echo.
echo WARNING: PyInstaller failed on first attempt.
echo Retrying once with a clean Python build workspace...
if exist "python_dist" (
    rmdir /s /q "python_dist"
)
if exist "python_build" (
    rmdir /s /q "python_build"
)
call build\build_python_server.bat --clean
if not errorlevel 1 exit /b 0

echo ERROR: PyInstaller build failed after retry.
echo HINT: Re-run manually to capture full traceback:
echo       set PYTHON_EXE=%PYTHON_EXE%
echo       build\build_python_server.bat --clean
exit /b 1

:prepare_app_builder
if not exist "%APP_BUILDER_EXE%" exit /b 0
REM Best-effort unblock in case Windows marks this binary as downloaded.
powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-Item -Path '%APP_BUILDER_EXE%' -ErrorAction SilentlyContinue | Unblock-File -ErrorAction SilentlyContinue" >nul 2>nul
exit /b 0

:run_electron
call "%NODE_HOME%\node.exe" build\patch_nsis_installer_progress.js
if errorlevel 1 (
    echo ERROR: Failed to prepare NSIS installer progress patch.
    exit /b 1
)
call "%NODE_HOME%\node.exe" node_modules\electron-builder\cli.js --win
if not errorlevel 1 exit /b 0

echo.
echo WARNING: Electron build failed on first attempt.
echo Retrying once after re-preparing app-builder...
call :prepare_app_builder
call "%NODE_HOME%\node.exe" build\patch_nsis_installer_progress.js
if errorlevel 1 (
    echo ERROR: Failed to prepare NSIS installer progress patch.
    exit /b 1
)
timeout /t 2 /nobreak >nul
call "%NODE_HOME%\node.exe" node_modules\electron-builder\cli.js --win
if not errorlevel 1 exit /b 0

echo ERROR: Electron build failed after retry.
echo HINT: If error shows "spawn EPERM" for app-builder.exe, run:
echo       powershell -NoProfile -Command "Get-Item '%APP_BUILDER_EXE%' ^| Unblock-File"
echo       Then retry build\build_app.bat.
exit /b 1
