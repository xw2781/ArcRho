@echo off
setlocal EnableExtensions

set "SCRIPT_DIR=%~dp0"
set "LISTENER_SCRIPT=%SCRIPT_DIR%build_app_listener.ps1"

if not exist "%LISTENER_SCRIPT%" (
    echo ERROR: Missing listener script: %LISTENER_SCRIPT%
    exit /b 1
)

if /i "%~1"=="--check" (
    powershell -NoProfile -ExecutionPolicy Bypass -File "%LISTENER_SCRIPT%" -Check
    exit /b %ERRORLEVEL%
)

echo Starting the ArcRho build-app listener in this window.
echo Leave this window open while the source PC should accept build requests.
echo Press Ctrl+C to stop the listener.
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%LISTENER_SCRIPT%"
exit /b %ERRORLEVEL%
