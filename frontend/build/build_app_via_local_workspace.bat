@echo off
setlocal EnableExtensions

REM Copies the network/source checkout to a local Documents build workspace,
REM then runs the ArcRho app build from that local workspace.
REM Optional:
REM   set ARCRHO_LOCAL_BUILD_ROOT=C:\Local\Path\build_arcrho_app
REM   set ARCRHO_LOCAL_BUILD_COPY_THREADS=64
REM   set ARCRHO_LOCAL_BUILD_SHOW_PROGRESS=0
REM   set ARCRHO_LOCAL_BUILD_SKIP_COPY=1
REM Optional arguments are forwarded to build_app.bat.

set "SCRIPT_DIR=%~dp0"
set "LOCAL_ROOT=%USERPROFILE%\Documents\build_arcrho_app"
if defined ARCRHO_LOCAL_BUILD_ROOT set "LOCAL_ROOT=%ARCRHO_LOCAL_BUILD_ROOT%"
set "LOCAL_FRONTEND=%LOCAL_ROOT%\frontend"
if not defined ARCRHO_LOCAL_BUILD_COPY_THREADS set "ARCRHO_LOCAL_BUILD_COPY_THREADS=32"
set "LOCAL_BUILD_PROGRESS_ARGS="
if /i "%ARCRHO_LOCAL_BUILD_SHOW_PROGRESS%"=="0" set "LOCAL_BUILD_PROGRESS_ARGS=-NoProgress"
set "ARCRHO_LOCAL_BUILD_START_SECONDS="
for /f "usebackq delims=" %%I in (`powershell -NoProfile -Command "[DateTimeOffset]::UtcNow.ToUnixTimeSeconds()" 2^>nul`) do set "ARCRHO_LOCAL_BUILD_START_SECONDS=%%I"

if /i "%~1"=="--check" (
    echo Network/source build script: %SCRIPT_DIR%
    echo Local workspace:           %LOCAL_ROOT%
    if not exist "%SCRIPT_DIR%prepare_local_build_workspace.ps1" (
        echo ERROR: Missing prepare_local_build_workspace.ps1 beside this batch file.
        exit /b 1
    )
    echo Local workspace wrapper check passed.
    exit /b 0
)

echo ========================================
echo Preparing local ArcRho build workspace
echo ========================================
echo Source build script: %SCRIPT_DIR%
echo Local workspace:     %LOCAL_ROOT%
echo.

set "RUN_COPY=1"
if /i "%ARCRHO_LOCAL_BUILD_SKIP_COPY%"=="1" (
    set "RUN_COPY=0"
) else (
    choice /C YN /N /M "Copy source files to the local workspace before building? [Y/N] "
    if errorlevel 2 set "RUN_COPY=0"
)

if "%RUN_COPY%"=="1" (
    powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%prepare_local_build_workspace.ps1" -Destination "%LOCAL_ROOT%" -CopyThreads %ARCRHO_LOCAL_BUILD_COPY_THREADS% %LOCAL_BUILD_PROGRESS_ARGS% -CleanDestination
    if errorlevel 1 (
        echo.
        echo ERROR: Failed to prepare local build workspace.
        pause
        exit /b 1
    )
) else (
    echo Skipping source copy. Building from existing local workspace.
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
call :print_total_time
pause
exit /b 0

:print_total_time
if not defined ARCRHO_LOCAL_BUILD_START_SECONDS exit /b 0
for /f "usebackq delims=" %%I in (`powershell -NoProfile -Command "$elapsed = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds() - [int64]$env:ARCRHO_LOCAL_BUILD_START_SECONDS; $span = [TimeSpan]::FromSeconds($elapsed); if ($span.TotalHours -ge 1) { '{0:00}:{1:00}:{2:00}' -f [int]$span.TotalHours, $span.Minutes, $span.Seconds } else { '{0:00}:{1:00}' -f [int]$span.TotalMinutes, $span.Seconds }" 2^>nul`) do set "ARCRHO_LOCAL_BUILD_ELAPSED=%%I"
if defined ARCRHO_LOCAL_BUILD_ELAPSED echo Total time spent: %ARCRHO_LOCAL_BUILD_ELAPSED%
exit /b 0
