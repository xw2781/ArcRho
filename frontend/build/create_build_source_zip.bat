@echo off
setlocal EnableExtensions

set "SCRIPT_DIR=%~dp0"

if /i "%~1"=="--check" (
    powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%transport\create_build_source_zip.ps1" -Check
) else (
    powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%transport\create_build_source_zip.ps1" %*
)

set "EXIT_CODE=%ERRORLEVEL%"
if not "%EXIT_CODE%"=="0" (
    echo.
    echo ERROR: ArcRho build ZIP creation failed with exit code %EXIT_CODE%.
)

exit /b %EXIT_CODE%
