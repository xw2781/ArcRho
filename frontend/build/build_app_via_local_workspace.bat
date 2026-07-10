@echo off
setlocal EnableExtensions

REM Copies the network/source archive to a local Documents build workspace,
REM then runs the ArcRho app build from that local workspace.
REM Optional:
REM   set ARCRHO_LOCAL_BUILD_ROOT=C:\Local\Path\build_arcrho_app
REM   set ARCRHO_LOCAL_BUILD_SOURCE_ZIP=E:\XWSpace\Repos\ArcRho.zip
REM Optional arguments are forwarded to build_app.bat.

set "SCRIPT_DIR=%~dp0"
set "SOURCE_ZIP=E:\XWSpace\Repos\ArcRho.zip"
if defined ARCRHO_LOCAL_BUILD_SOURCE_ZIP set "SOURCE_ZIP=%ARCRHO_LOCAL_BUILD_SOURCE_ZIP%"
set "LOCAL_ROOT=%USERPROFILE%\Documents\build_arcrho_app"
if defined ARCRHO_LOCAL_BUILD_ROOT set "LOCAL_ROOT=%ARCRHO_LOCAL_BUILD_ROOT%"
set "LOCAL_FRONTEND=%LOCAL_ROOT%\frontend"
set "ZIP_TIMESTAMP_FILE=%LOCAL_ROOT%.source_zip_timestamp"
set "ARCRHO_LOCAL_BUILD_START_SECONDS="
for /f "usebackq delims=" %%I in (`powershell -NoProfile -Command "[DateTimeOffset]::UtcNow.ToUnixTimeSeconds()" 2^>nul`) do set "ARCRHO_LOCAL_BUILD_START_SECONDS=%%I"

if /i "%~1"=="--check" (
    echo Network/source build script: %SCRIPT_DIR%
    echo Source archive:              %SOURCE_ZIP%
    echo Local workspace:           %LOCAL_ROOT%
    echo ZIP timestamp marker:       %ZIP_TIMESTAMP_FILE%
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
echo Local workspace:     %LOCAL_ROOT%
echo ZIP timestamp file:  %ZIP_TIMESTAMP_FILE%
echo.

call :check_source_zip_timestamp
if errorlevel 1 (
    echo.
    echo Build stopped. Create a new source ZIP, then rerun this script.
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
call build\build_app.bat %*
set "BUILD_EXIT_CODE=%ERRORLEVEL%"

popd

if not "%BUILD_EXIT_CODE%"=="0" (
    echo.
    echo ERROR: Local ArcRho build failed with exit code %BUILD_EXIT_CODE%.
    echo Local log directory: %LOCAL_FRONTEND%\build\log
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
call :record_source_zip_timestamp
call :print_total_time
pause
exit /b 0

:check_source_zip_timestamp
if not exist "%SOURCE_ZIP%" (
    echo.
    echo ERROR: Source ZIP not found: %SOURCE_ZIP%
    exit /b 1
)

set "CURRENT_ZIP_TIMESTAMP="
for /f "usebackq delims=" %%I in (`powershell -NoProfile -Command "(Get-Item -LiteralPath $env:SOURCE_ZIP).LastWriteTimeUtc.Ticks" 2^>nul`) do set "CURRENT_ZIP_TIMESTAMP=%%I"
if not defined CURRENT_ZIP_TIMESTAMP (
    echo.
    echo ERROR: Could not read source ZIP timestamp: %SOURCE_ZIP%
    exit /b 1
)

set "LAST_ZIP_TIMESTAMP="
if exist "%ZIP_TIMESTAMP_FILE%" (
    for /f "usebackq delims=" %%I in ("%ZIP_TIMESTAMP_FILE%") do set "LAST_ZIP_TIMESTAMP=%%I"
)

if defined LAST_ZIP_TIMESTAMP if "%CURRENT_ZIP_TIMESTAMP%"=="%LAST_ZIP_TIMESTAMP%" (
    echo.
    echo WARNING: Source ZIP timestamp has not changed since the last ZIP-based local build.
    echo Source ZIP: %SOURCE_ZIP%
    echo.
    choice /C YN /N /M "Continue with the existing ZIP anyway? [Y/N] "
    if errorlevel 2 exit /b 1
)

exit /b 0

:record_source_zip_timestamp
if not exist "%SOURCE_ZIP%" exit /b 0
set "CURRENT_ZIP_TIMESTAMP="
for /f "usebackq delims=" %%I in (`powershell -NoProfile -Command "(Get-Item -LiteralPath $env:SOURCE_ZIP).LastWriteTimeUtc.Ticks" 2^>nul`) do set "CURRENT_ZIP_TIMESTAMP=%%I"
if not defined CURRENT_ZIP_TIMESTAMP exit /b 0
for %%I in ("%ZIP_TIMESTAMP_FILE%") do if not exist "%%~dpI" mkdir "%%~dpI" >nul 2>nul
> "%ZIP_TIMESTAMP_FILE%" echo %CURRENT_ZIP_TIMESTAMP%
exit /b 0

:print_total_time
if not defined ARCRHO_LOCAL_BUILD_START_SECONDS exit /b 0
for /f "usebackq delims=" %%I in (`powershell -NoProfile -Command "$elapsed = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds() - [int64]$env:ARCRHO_LOCAL_BUILD_START_SECONDS; $span = [TimeSpan]::FromSeconds($elapsed); if ($span.TotalHours -ge 1) { '{0:00}:{1:00}:{2:00}' -f [int]$span.TotalHours, $span.Minutes, $span.Seconds } else { '{0:00}:{1:00}' -f [int]$span.TotalMinutes, $span.Seconds }" 2^>nul`) do set "ARCRHO_LOCAL_BUILD_ELAPSED=%%I"
if defined ARCRHO_LOCAL_BUILD_ELAPSED echo Total time spent: %ARCRHO_LOCAL_BUILD_ELAPSED%
exit /b 0
