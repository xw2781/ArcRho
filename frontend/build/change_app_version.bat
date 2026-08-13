@echo off
setlocal EnableExtensions

set "SCRIPT_DIR=%~dp0"
for %%I in ("%SCRIPT_DIR%..") do set "APP_ROOT=%%~fI"

if not defined PYTHON_EXE (
    for /f "usebackq delims=" %%I in (`py -3.10 -c "import sys; print(sys.executable)" 2^>nul`) do set "PYTHON_EXE=%%I"
)
if not defined PYTHON_EXE set "PYTHON_EXE=python"

set "TARGET_VERSION=%~1"
if not defined TARGET_VERSION (
    echo Enter the new ArcRho app version.
    echo It must be a semantic version higher than the current version, for example 1.1.1 or 1.2.0.
    set /p "TARGET_VERSION=New version: "
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

"%PYTHON_EXE%" build\release\version_manager.py "%TARGET_VERSION%" --require-increase
if errorlevel 1 (
    echo.
    echo ERROR: Version was not changed.
    exit /b 1
)

echo.
echo ArcRho app version updated to %TARGET_VERSION%.
echo Updated package.json, package-lock.json, ui\index.html, and ui\splash.html.
exit /b 0
