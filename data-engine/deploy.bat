@echo off
setlocal EnableExtensions

REM Requests a component build and deploy from the ArcRho Build Listener on the
REM server, streams its log, and returns the listener's exit code. Run
REM "deploy.bat --stale" to see which components a change made stale.

cd /d "%~dp0"

if not defined PYTHON_EXE (
    for /f "usebackq delims=" %%I in (`py -3.10 -c "import sys; print(sys.executable)" 2^>nul`) do set "PYTHON_EXE=%%I"
)
if not defined PYTHON_EXE set "PYTHON_EXE=python"

"%PYTHON_EXE%" "%~dp0deploy.py" %*
exit /b %ERRORLEVEL%
