@echo off
setlocal EnableExtensions

set "SCRIPT_DIR=%~dp0"
if defined ARCRHO_LOCAL_WORKSPACE_LOG_ACTIVE goto after_wrapper_log_setup
for /f "usebackq delims=" %%I in (`powershell -NoProfile -Command "Get-Date -Format yyyyMMdd-HHmmss"`) do set "ARCRHO_LOCAL_WORKSPACE_LOG_STAMP=%%I"
set "ARCRHO_LOCAL_WORKSPACE_LOG_DIR=E:\XWSpace\Build ArcRho App\logs\%COMPUTERNAME%"
set "ARCRHO_LOCAL_WORKSPACE_LOG_FILE=%ARCRHO_LOCAL_WORKSPACE_LOG_DIR%\build_app_via_local_workspace_%ARCRHO_LOCAL_WORKSPACE_LOG_STAMP%.log"
echo Writing local-workspace build log to: %ARCRHO_LOCAL_WORKSPACE_LOG_FILE%
set "ARCRHO_LOCAL_WORKSPACE_LOG_ACTIVE=1"
powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%run_with_log.ps1" -LogPath "%ARCRHO_LOCAL_WORKSPACE_LOG_FILE%" -CommandPath "%~f0" %*
exit /b %ERRORLEVEL%

:after_wrapper_log_setup

REM Copies the network/source archive to a local Documents build workspace,
REM waits for its completion flag, then runs the ArcRho app build from that
REM local workspace and opens the published installer.
REM Create or refresh the default source archive on the source PC with:
REM   frontend\build\create_build_source_zip.bat
REM Optional:
REM   set ARCRHO_LOCAL_BUILD_ROOT=C:\Local\Path\build_arcrho_app
REM   set ARCRHO_LOCAL_BUILD_SOURCE_ZIP=E:\XWSpace\Build ArcRho App\ArcRho.zip
REM Optional arguments are forwarded to build_app.bat.

set "SOURCE_ZIP=E:\XWSpace\Build ArcRho App\ArcRho.zip"
if defined ARCRHO_LOCAL_BUILD_SOURCE_ZIP set "SOURCE_ZIP=%ARCRHO_LOCAL_BUILD_SOURCE_ZIP%"
set "LOCAL_ROOT=%USERPROFILE%\Documents\build_arcrho_app"
if defined ARCRHO_LOCAL_BUILD_ROOT set "LOCAL_ROOT=%ARCRHO_LOCAL_BUILD_ROOT%"
set "LOCAL_FRONTEND=%LOCAL_ROOT%\frontend"
set "SOURCE_ZIP_READY_FLAG=%SOURCE_ZIP%.ready"
set "SOURCE_ZIP_HASH=%SOURCE_ZIP%.sha256"
set "READY_SIGNAL_FILE=%LOCAL_ROOT%.source_zip_ready_signal"
set "RELEASE_FEED_DIR=E:\ArcRho Server\releases\installers"
set "ARCRHO_BUILD_LOG_DIR=E:\XWSpace\Build ArcRho App\logs\%COMPUTERNAME%"
set "ARCRHO_LOCAL_BUILD_START_SECONDS="
for /f "usebackq delims=" %%I in (`powershell -NoProfile -Command "[DateTimeOffset]::UtcNow.ToUnixTimeSeconds()" 2^>nul`) do set "ARCRHO_LOCAL_BUILD_START_SECONDS=%%I"

if /i "%~1"=="--check" (
    echo Network/source build script: %SCRIPT_DIR%
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
echo Preparing local ArcRho build workspace
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

if not exist "%LOCAL_FRONTEND%\build\build_app.bat" (
    echo.
    echo ERROR: Local build script was not copied to %LOCAL_FRONTEND%\build\build_app.bat
    pause
    exit /b 1
)

echo.
echo ========================================
echo Building ArcRho from local workspace
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
call build\build_app.bat %*
set "BUILD_EXIT_CODE=%ERRORLEVEL%"

popd

if not "%BUILD_EXIT_CODE%"=="0" (
    echo.
    echo ERROR: Local ArcRho build failed with exit code %BUILD_EXIT_CODE%.
    echo Build log directory: %ARCRHO_BUILD_LOG_DIR%
    call :print_total_time
    pause
    exit /b %BUILD_EXIT_CODE%
)

echo.
echo ========================================
echo Local ArcRho build completed successfully
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
powershell -NoProfile -ExecutionPolicy Bypass -Command "$manifestPath = Join-Path $env:RELEASE_FEED_DIR 'latest.json'; if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) { throw ('Published installer manifest not found: ' + $manifestPath) }; $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json; $installerName = [string]$manifest.installer; if ([string]::IsNullOrWhiteSpace($installerName) -or [System.IO.Path]::GetFileName($installerName) -ne $installerName -or $installerName -notmatch '^ArcRho-Setup-.+\.exe$') { throw 'Published installer manifest contains an invalid installer name.' }; $installerPath = Join-Path $env:RELEASE_FEED_DIR $installerName; if (-not (Test-Path -LiteralPath $installerPath -PathType Leaf)) { throw ('Published installer not found: ' + $installerPath) }; Write-Host ('Opening published installer: ' + $installerPath); Start-Process -FilePath $installerPath"
exit /b %ERRORLEVEL%

:print_total_time
if not defined ARCRHO_LOCAL_BUILD_START_SECONDS exit /b 0
for /f "usebackq delims=" %%I in (`powershell -NoProfile -Command "$elapsed = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds() - [int64]$env:ARCRHO_LOCAL_BUILD_START_SECONDS; $span = [TimeSpan]::FromSeconds($elapsed); if ($span.TotalHours -ge 1) { '{0:00}:{1:00}:{2:00}' -f [int]$span.TotalHours, $span.Minutes, $span.Seconds } else { '{0:00}:{1:00}' -f [int]$span.TotalMinutes, $span.Seconds }" 2^>nul`) do set "ARCRHO_LOCAL_BUILD_ELAPSED=%%I"
if defined ARCRHO_LOCAL_BUILD_ELAPSED echo Total time spent: %ARCRHO_LOCAL_BUILD_ELAPSED%
exit /b 0
