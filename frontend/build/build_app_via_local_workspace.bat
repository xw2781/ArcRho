@echo off
setlocal EnableExtensions

set "SCRIPT_DIR=%~dp0"
if not defined ARCRHO_BUILD_PRODUCT set "ARCRHO_BUILD_PRODUCT=arcrho"
if /i "%ARCRHO_BUILD_PRODUCT%"=="arcrho" goto product_arcrho
if /i "%ARCRHO_BUILD_PRODUCT%"=="arcode" goto product_arcode
echo ERROR: Unsupported ARCRHO_BUILD_PRODUCT: %ARCRHO_BUILD_PRODUCT%
echo Expected arcrho or arcode.
exit /b 1

:product_arcrho
set "PRODUCT_NAME=ArcRho"
set "INSTALLER_PREFIX=ArcRho"
set "DEFAULT_LOCAL_ROOT=%USERPROFILE%\Documents\build_arcrho_app"
set "RELEASE_FEED_DIR=E:\ArcRho Server\releases\installers"
set "PYTHON_SERVER_BUILD_SCRIPT=build\build_python_server.bat"
set "PYTHON_SERVER_DIR=arcrho_server"
set "PYTHON_SERVER_EXE=arcrho_server.exe"
set "ELECTRON_BUILDER_CONFIG_ARGS="
set "PUBLISH_PYTHON_API=1"
goto product_ready

:product_arcode
set "PRODUCT_NAME=Arcode"
set "INSTALLER_PREFIX=Arcode"
set "DEFAULT_LOCAL_ROOT=%USERPROFILE%\Documents\build_arcode_app"
set "RELEASE_FEED_DIR=E:\Arcode Server\releases\arcode-installers"
set "PYTHON_SERVER_BUILD_SCRIPT=build\build_arcode_python_server.bat"
set "PYTHON_SERVER_DIR=arcode_server"
set "PYTHON_SERVER_EXE=arcode_server.exe"
set "ELECTRON_BUILDER_CONFIG_ARGS=--config electron-builder.arcode.json"
set "PUBLISH_PYTHON_API=0"
set "ARCRHO_APP_MODE=arcode"

:product_ready
if defined ARCRHO_LOCAL_WORKSPACE_LOG_ACTIVE goto after_wrapper_log_setup
for /f "usebackq delims=" %%I in (`powershell -NoProfile -Command "Get-Date -Format yyyyMMdd-HHmmss"`) do set "ARCRHO_LOCAL_WORKSPACE_LOG_STAMP=%%I"
set "ARCRHO_LOCAL_WORKSPACE_LOG_DIR=E:\XWSpace\Build ArcRho App\logs\%COMPUTERNAME%"
set "ARCRHO_LOCAL_WORKSPACE_LOG_FILE=%ARCRHO_LOCAL_WORKSPACE_LOG_DIR%\build_%ARCRHO_BUILD_PRODUCT%_via_local_workspace_%ARCRHO_LOCAL_WORKSPACE_LOG_STAMP%.log"
echo Writing local-workspace build log to: %ARCRHO_LOCAL_WORKSPACE_LOG_FILE%
set "ARCRHO_LOCAL_WORKSPACE_LOG_ACTIVE=1"
powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%run_with_log.ps1" -LogPath "%ARCRHO_LOCAL_WORKSPACE_LOG_FILE%" -CommandPath "%~f0" %*
exit /b %ERRORLEVEL%

:after_wrapper_log_setup

REM Copies the network/source archive to a local Documents build workspace,
REM waits for its completion flag, then runs the selected app build from that
REM local workspace and opens the published installer.
REM Optional:
REM   set ARCRHO_LOCAL_BUILD_ROOT=C:\Local\Path\build_arcrho_app
REM   set ARCRHO_LOCAL_BUILD_SOURCE_ZIP=E:\XWSpace\Build ArcRho App\ArcRho.zip
REM Optional arguments are forwarded to the local application build stage.

set "SOURCE_ZIP=E:\XWSpace\Build ArcRho App\ArcRho.zip"
if defined ARCRHO_LOCAL_BUILD_SOURCE_ZIP set "SOURCE_ZIP=%ARCRHO_LOCAL_BUILD_SOURCE_ZIP%"
set "LOCAL_ROOT=%DEFAULT_LOCAL_ROOT%"
if defined ARCRHO_LOCAL_BUILD_ROOT set "LOCAL_ROOT=%ARCRHO_LOCAL_BUILD_ROOT%"
set "LOCAL_FRONTEND=%LOCAL_ROOT%\frontend"
set "SOURCE_ZIP_READY_FLAG=%SOURCE_ZIP%.ready"
set "SOURCE_ZIP_HASH=%SOURCE_ZIP%.sha256"
set "READY_SIGNAL_FILE=%LOCAL_ROOT%.source_zip_ready_signal"
set "ARCRHO_BUILD_LOG_DIR=E:\XWSpace\Build ArcRho App\logs\%COMPUTERNAME%"
set "ARCRHO_LOCAL_BUILD_START_SECONDS="
for /f "usebackq delims=" %%I in (`powershell -NoProfile -Command "[DateTimeOffset]::UtcNow.ToUnixTimeSeconds()" 2^>nul`) do set "ARCRHO_LOCAL_BUILD_START_SECONDS=%%I"

if /i "%~1"=="--check" (
    echo Network/source build script: %SCRIPT_DIR%
    echo Product:                     %PRODUCT_NAME%
    echo Source archive:              %SOURCE_ZIP%
    echo Source completion flag:      %SOURCE_ZIP_READY_FLAG%
    echo Local workspace:           %LOCAL_ROOT%
    echo Consumed-signal marker:     %READY_SIGNAL_FILE%
    echo Published installer feed:  %RELEASE_FEED_DIR%
    echo Shared build log directory: %ARCRHO_BUILD_LOG_DIR%
    if not exist "%SCRIPT_DIR%prepare_local_build_workspace_from_zip.ps1" (
        echo ERROR: Missing prepare_local_build_workspace_from_zip.ps1 beside this batch file.
        exit /b 1
    )
    echo Local workspace wrapper check passed.
    exit /b 0
)

echo ========================================
echo Preparing local %PRODUCT_NAME% build workspace
echo ========================================
echo Source build script: %SCRIPT_DIR%
echo Source archive:      %SOURCE_ZIP%
echo Completion flag:     %SOURCE_ZIP_READY_FLAG%
echo Local workspace:     %LOCAL_ROOT%
echo Signal marker:       %READY_SIGNAL_FILE%
echo Shared log directory: %ARCRHO_BUILD_LOG_DIR%
echo.

call :wait_for_new_source_zip_signal
if errorlevel 1 (
    echo.
    echo ERROR: Failed while waiting for a completed source ZIP.
    pause
    exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%prepare_local_build_workspace_from_zip.ps1" -SourceZip "%SOURCE_ZIP%" -Destination "%LOCAL_ROOT%"
if errorlevel 1 (
    echo.
    echo ERROR: Failed to prepare local build workspace.
    pause
    exit /b 1
)

if not exist "%LOCAL_FRONTEND%\build\build_app_via_local_workspace.bat" (
    echo.
    echo ERROR: Local build script was not copied to %LOCAL_FRONTEND%\build\build_app_via_local_workspace.bat
    pause
    exit /b 1
)

echo.
echo ========================================
echo Building %PRODUCT_NAME% from local workspace
echo ========================================
echo.

pushd "%LOCAL_FRONTEND%"
if errorlevel 1 (
    echo ERROR: Could not enter local frontend directory: %LOCAL_FRONTEND%
    pause
    exit /b 1
)

set "ARCRHO_INSTALL_PYTHON_DEPS=1"
set "ARCRHO_SKIP_SUCCESS_PAUSE=1"
call :build_local_application %*
set "BUILD_EXIT_CODE=%ERRORLEVEL%"

popd

if not "%BUILD_EXIT_CODE%"=="0" (
    echo.
    echo ERROR: Local %PRODUCT_NAME% build failed with exit code %BUILD_EXIT_CODE%.
    echo Build log directory: %ARCRHO_BUILD_LOG_DIR%
    call :print_total_time
    pause
    exit /b %BUILD_EXIT_CODE%
)

echo.
echo ========================================
echo Local %PRODUCT_NAME% build completed successfully
echo ========================================
echo Local output directory: %LOCAL_FRONTEND%\dist
echo.
call :record_source_zip_signal
if errorlevel 1 (
    echo WARNING: Could not record the completed ZIP signal.
    echo The next Step 2 run may build this ZIP again.
    echo.
)
call :print_total_time
call :open_released_installer
if errorlevel 1 (
    echo.
    echo WARNING: The build succeeded, but the published installer could not be opened.
    echo Published installer feed: %RELEASE_FEED_DIR%
    pause
)
exit /b 0

:wait_for_new_source_zip_signal
set "LAST_READY_SIGNAL="
if exist "%READY_SIGNAL_FILE%" set /p LAST_READY_SIGNAL=<"%READY_SIGNAL_FILE%"
echo Waiting for Step 1 to publish a new completed ZIP signal...
echo Press Ctrl+C to stop waiting.

:wait_for_new_source_zip_signal_loop
set "CURRENT_READY_SIGNAL="
if exist "%SOURCE_ZIP_READY_FLAG%" set /p CURRENT_READY_SIGNAL=<"%SOURCE_ZIP_READY_FLAG%"
if not defined CURRENT_READY_SIGNAL goto wait_for_new_source_zip_signal_delay
if defined LAST_READY_SIGNAL if "%CURRENT_READY_SIGNAL%"=="%LAST_READY_SIGNAL%" goto wait_for_new_source_zip_signal_delay
if not exist "%SOURCE_ZIP%" goto wait_for_new_source_zip_signal_delay
if not exist "%SOURCE_ZIP_HASH%" goto wait_for_new_source_zip_signal_delay
echo New completed source ZIP detected.
echo Signal: %CURRENT_READY_SIGNAL%
echo.
exit /b 0

:wait_for_new_source_zip_signal_delay
timeout /t 5 /nobreak >nul
goto wait_for_new_source_zip_signal_loop

:record_source_zip_signal
if not defined CURRENT_READY_SIGNAL exit /b 1
for %%I in ("%READY_SIGNAL_FILE%") do if not exist "%%~dpI" mkdir "%%~dpI" >nul 2>nul
> "%READY_SIGNAL_FILE%" echo %CURRENT_READY_SIGNAL%
if errorlevel 1 exit /b 1
exit /b 0

:open_released_installer
powershell -NoProfile -ExecutionPolicy Bypass -Command "$manifestPath = Join-Path $env:RELEASE_FEED_DIR 'latest.json'; if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) { throw ('Published installer manifest not found: ' + $manifestPath) }; $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json; $installerName = [string]$manifest.installer; $expectedPattern = '^' + [regex]::Escape($env:INSTALLER_PREFIX) + '-Setup-.+\.exe$'; if ([string]::IsNullOrWhiteSpace($installerName) -or [System.IO.Path]::GetFileName($installerName) -ne $installerName -or $installerName -notmatch $expectedPattern) { throw 'Published installer manifest contains an invalid installer name.' }; $installerPath = Join-Path $env:RELEASE_FEED_DIR $installerName; if (-not (Test-Path -LiteralPath $installerPath -PathType Leaf)) { throw ('Published installer not found: ' + $installerPath) }; Write-Host ('Opening published installer: ' + $installerPath); Start-Process -FilePath $installerPath"
exit /b %ERRORLEVEL%

:print_total_time
if not defined ARCRHO_LOCAL_BUILD_START_SECONDS exit /b 0
for /f "usebackq delims=" %%I in (`powershell -NoProfile -Command "$elapsed = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds() - [int64]$env:ARCRHO_LOCAL_BUILD_START_SECONDS; $span = [TimeSpan]::FromSeconds($elapsed); if ($span.TotalHours -ge 1) { '{0:00}:{1:00}:{2:00}' -f [int]$span.TotalHours, $span.Minutes, $span.Seconds } else { '{0:00}:{1:00}' -f [int]$span.TotalMinutes, $span.Seconds }" 2^>nul`) do set "ARCRHO_LOCAL_BUILD_ELAPSED=%%I"
if defined ARCRHO_LOCAL_BUILD_ELAPSED echo Total time spent: %ARCRHO_LOCAL_BUILD_ELAPSED%
exit /b 0

:build_local_application
set "APP_ROOT=%CD%"
if not defined ARCRHO_BUILD_LOG_FILE set "ARCRHO_BUILD_LOG_FILE=%ARCRHO_LOCAL_WORKSPACE_LOG_FILE%"

echo ========================================
echo Building %PRODUCT_NAME% Standalone Application
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
set "UPDATE_FEED_DIR=%RELEASE_FEED_DIR%"
if not defined PYTHON_API_PACKAGE_DIR set "PYTHON_API_PACKAGE_DIR=E:\ArcRho Server\packages"
set "PYTHON_API_WHEEL="

echo Validating bundled Node, npm, and Codex runtime...
call :validate_bundled_codex_runtime "%NODE_HOME%" "%APP_ROOT%"
if errorlevel 1 (
    echo ERROR: Bundled Node, npm, and Codex runtime validation failed.
    echo.
    pause
    exit /b 1
)
echo Bundled CLI runtime validated.
echo.

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
    "%PYTHON_EXE%" build\version_manager.py --release-feed-dir "%UPDATE_FEED_DIR%" --installer-prefix "%INSTALLER_PREFIX%" --version-file "%APP_VERSION_FILE%"
) else (
    "%PYTHON_EXE%" build\version_manager.py "%~1" --installer-prefix "%INSTALLER_PREFIX%" --version-file "%APP_VERSION_FILE%"
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

if "%PUBLISH_PYTHON_API%"=="1" (
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
) else (
    echo Step 2: Python API wheel publication is not part of the %PRODUCT_NAME% build.
    echo.
)

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
if not exist "python_dist\%PYTHON_SERVER_DIR%\%PYTHON_SERVER_EXE%" (
    echo ERROR: Missing app-server bundle: python_dist\%PYTHON_SERVER_DIR%\%PYTHON_SERVER_EXE%
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

set "PACKAGED_NODE_HOME=%APP_ROOT%\dist\win-unpacked\resources\node-portable"
echo Validating packaged ArcBot CLI runtime...
call :validate_bundled_codex_runtime "%PACKAGED_NODE_HOME%" "%APP_ROOT%"
if errorlevel 1 (
    echo ERROR: Packaged Node, npm, and Codex runtime validation failed.
    echo HINT: The installer was not published because its bundled CLI payload is incomplete or cannot run.
    echo.
    pause
    exit /b 1
)
echo Packaged ArcBot CLI runtime validated.
echo.

if not exist "dist\%INSTALLER_PREFIX%-Setup-*.exe" (
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
powershell -NoProfile -ExecutionPolicy Bypass -File "build\publish_update_feed.ps1" -InstallerPath "dist\%INSTALLER_PREFIX%-Setup-%APP_VERSION%.exe" -FeedDir "%UPDATE_FEED_DIR%" -ReleaseNotesPath "%RELEASE_NOTE_PATH%" -ProductName "%PRODUCT_NAME%"
if errorlevel 1 (
    echo ERROR: Failed to publish installer update feed.
    echo.
    pause
    exit /b 1
)
echo Installer update feed published: %UPDATE_FEED_DIR%
echo.

echo Step 6b: Publishing GitHub Release...
echo ----------------------------------------
powershell -NoProfile -ExecutionPolicy Bypass -File "build\publish_github_release.ps1" -InstallerPath "dist\%INSTALLER_PREFIX%-Setup-%APP_VERSION%.exe" -ReleaseNotesPath "%RELEASE_NOTE_PATH%" -ProductName "%PRODUCT_NAME%"
if errorlevel 1 (
    echo ERROR: Failed to publish GitHub Release.
    echo HINT: Ensure the gh CLI is installed and authenticated ^(run: gh auth login^).
    echo.
    pause
    exit /b 1
)
echo GitHub Release published.
echo.

if "%PUBLISH_PYTHON_API%"=="1" (
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
) else (
    echo Step 7: Shared Python API package publication is not part of the %PRODUCT_NAME% build.
    echo.
)

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
echo - %INSTALLER_PREFIX%-Setup-%APP_VERSION%.exe  (Installer)
echo - %UPDATE_FEED_DIR%\%INSTALLER_PREFIX%-Setup-%APP_VERSION%.exe  (Published Installer)
echo - %UPDATE_FEED_DIR%\latest.json  (Update Manifest)
echo - GitHub Release %INSTALLER_PREFIX%-v%APP_VERSION%  (Auto-Update Source)
if "%PUBLISH_PYTHON_API%"=="1" echo - %PYTHON_API_PACKAGE_DIR%\arcrho_api-latest.whl  (Python API Package)
echo - %RELEASE_NOTE_PATH%  (Release Notes)
echo.
if not defined ARCRHO_SKIP_SUCCESS_PAUSE pause
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
    echo ERROR: %PRODUCT_NAME% packaging requires Python 3.10.6 or newer within the Python 3.10 line.
    echo HINT: Install Python 3.10.6+ or set PYTHON_EXE to a compatible Python 3.10 executable before running the one-click build.
    exit /b 1
)
exit /b 0

:validate_bundled_codex_runtime
if not exist "%~1\node.exe" (
    echo ERROR: Missing portable Node executable: %~1\node.exe
    exit /b 1
)
if not exist "%APP_ROOT%\build\validate_bundled_codex_runtime.js" (
    echo ERROR: Missing bundled CLI runtime validator: %APP_ROOT%\build\validate_bundled_codex_runtime.js
    exit /b 1
)
call "%~1\node.exe" "%APP_ROOT%\build\validate_bundled_codex_runtime.js" --runtime-root "%~1" --cwd "%~2" --timeout-ms 8000
if errorlevel 1 exit /b 1
exit /b 0

:run_pyinstaller
call %PYTHON_SERVER_BUILD_SCRIPT%
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
call %PYTHON_SERVER_BUILD_SCRIPT% --clean
if not errorlevel 1 exit /b 0

echo ERROR: PyInstaller build failed after retry.
echo HINT: Re-run manually to capture full traceback:
echo       set PYTHON_EXE=%PYTHON_EXE%
echo       %PYTHON_SERVER_BUILD_SCRIPT% --clean
exit /b 1

:prepare_app_builder
if not exist "%APP_BUILDER_EXE%" exit /b 0
REM Best-effort unblock in case Windows marks this binary as downloaded.
powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-Item -Path '%APP_BUILDER_EXE%' -ErrorAction SilentlyContinue | Unblock-File -ErrorAction SilentlyContinue" >nul 2>nul
exit /b 0

:run_electron
if /i "%ARCRHO_BUILD_PRODUCT%"=="arcode" (
    call "%NODE_HOME%\node.exe" build\convert_icon.js icons\icon_wing_geo_v8.svg build\generated\arcode-icons
    if errorlevel 1 (
        echo ERROR: Failed to generate Arcode icons from icons\icon_wing_geo_v8.svg.
        exit /b 1
    )
)
call "%NODE_HOME%\node.exe" build\patch_nsis_installer_progress.js
if errorlevel 1 (
    echo ERROR: Failed to prepare NSIS installer progress patch.
    exit /b 1
)
call "%NODE_HOME%\node.exe" node_modules\electron-builder\cli.js %ELECTRON_BUILDER_CONFIG_ARGS% --win
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
call "%NODE_HOME%\node.exe" node_modules\electron-builder\cli.js %ELECTRON_BUILDER_CONFIG_ARGS% --win
if not errorlevel 1 exit /b 0

echo ERROR: Electron build failed after retry.
echo HINT: If error shows "spawn EPERM" for app-builder.exe, run:
echo       powershell -NoProfile -Command "Get-Item '%APP_BUILDER_EXE%' ^| Unblock-File"
echo       Then retry the one-click build workflow.
exit /b 1
