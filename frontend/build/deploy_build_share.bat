@echo off
setlocal EnableExtensions

REM Publishes the build-share launcher scripts from the repository to the build share.
REM The repository copy in build\build_share is the source of truth; the share holds
REM deployed copies because that is the one path both PCs agree on.
REM
REM Usage:
REM   deploy_build_share.bat              Deploy the scripts that differ.
REM   deploy_build_share.bat --verify     Report drift without writing anything.
REM   deploy_build_share.bat --force      Overwrite share copies that are newer.

set "SCRIPT_DIR=%~dp0"
set "DEPLOY_SCRIPT=%SCRIPT_DIR%deploy_build_share.ps1"

if not exist "%DEPLOY_SCRIPT%" (
    echo ERROR: Missing deploy script: %DEPLOY_SCRIPT%
    exit /b 1
)

set "DEPLOY_ARGS="
if /i "%~1"=="--verify" set "DEPLOY_ARGS=-Verify"
if /i "%~1"=="--force" set "DEPLOY_ARGS=-Force"

powershell -NoProfile -ExecutionPolicy Bypass -File "%DEPLOY_SCRIPT%" %DEPLOY_ARGS%
if errorlevel 1 (
    echo.
    echo ERROR: The build share was not updated.
    exit /b 1
)
exit /b 0
