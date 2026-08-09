@echo off
setlocal EnableExtensions

REM Syncs this repository to a release that has already been published.
REM Run this on the source PC after a build publishes a GitHub Release, so the
REM version metadata, release notes, and consumed changelog fragments land in the
REM repository instead of being discarded with the build PC's local workspace.
REM
REM Usage:
REM   sync_published_release.bat [version] [extra arguments]
REM
REM Pass --dry-run to see what would change without writing anything.

set "SCRIPT_DIR=%~dp0"
for %%I in ("%SCRIPT_DIR%..") do set "APP_ROOT=%%~fI"

if not defined PYTHON_EXE (
    for /f "usebackq delims=" %%I in (`py -3.10 -c "import sys; print(sys.executable)" 2^>nul`) do set "PYTHON_EXE=%%I"
)
if not defined PYTHON_EXE set "PYTHON_EXE=python"

set "TARGET_VERSION=%~1"
if not defined TARGET_VERSION (
    echo Enter the published version to sync this repository to, for example 1.2.5.
    set /p "TARGET_VERSION=Published version: "
)

if not defined TARGET_VERSION (
    echo ERROR: No version was provided.
    exit /b 1
)

cd /d "%APP_ROOT%"
if errorlevel 1 (
    echo ERROR: Could not enter frontend directory: %APP_ROOT%
    exit /b 1
)

REM When the version came from the prompt there are no forwarded arguments to pass.
if "%~1"=="" (
    "%PYTHON_EXE%" build\sync_published_release.py %TARGET_VERSION%
) else (
    "%PYTHON_EXE%" build\sync_published_release.py %*
)
if errorlevel 1 (
    echo.
    echo ERROR: The repository was not synced.
    exit /b 1
)

echo.
echo Review the changes and commit them.
exit /b 0
