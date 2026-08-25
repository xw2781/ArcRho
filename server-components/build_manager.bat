@echo off
setlocal

cd /d "%~dp0"

if defined PYTHONW_EXE (
    start "" "%PYTHONW_EXE%" "src\arcrho_build_manager.py"
    exit /b 0
)

if defined PYTHON_EXE (
    for %%I in ("%PYTHON_EXE%") do set "PYTHONW_CANDIDATE=%%~dpIpythonw.exe"
    if exist "%PYTHONW_CANDIDATE%" (
        start "" "%PYTHONW_CANDIDATE%" "src\arcrho_build_manager.py"
    ) else (
        start "" "%PYTHON_EXE%" "src\arcrho_build_manager.py"
    )
) else (
    start "" pyw -3 "src\arcrho_build_manager.py"
)
