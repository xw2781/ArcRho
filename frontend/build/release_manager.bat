@echo off
setlocal EnableExtensions

REM Starts the local Release Manager server and opens its UI in the default
REM browser. It builds installers for local testing first and keeps GitHub
REM publication as a separate explicit action. Keep this window open while it
REM runs; press Ctrl+C or use Quit in the UI to stop it.

set "SCRIPT_DIR=%~dp0"
if not defined PYTHON_EXE (
    for /f "usebackq delims=" %%I in (`py -3.10 -c "import sys; print(sys.executable)" 2^>nul`) do set "PYTHON_EXE=%%I"
)
if not defined PYTHON_EXE set "PYTHON_EXE=python"

"%PYTHON_EXE%" "%SCRIPT_DIR%release_manager.py" %*
exit /b %ERRORLEVEL%
