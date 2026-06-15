@echo off
setlocal
cd /d "%~dp0.."

if /I "%~1"=="--clean" (
    if exist python_dist\arcode_server rmdir /S /Q python_dist\arcode_server
    if exist python_build rmdir /S /Q python_build
)

set "PYTHON_EXE=python"
py -3.10 --version >nul 2>nul
if not errorlevel 1 set "PYTHON_EXE=py -3.10"

%PYTHON_EXE% build\check_python_build_env.py
if errorlevel 1 exit /b 1

set "PYINSTALLER_ARGS=build\arcode_server.spec --distpath python_dist --workpath python_build --noconfirm"
%PYTHON_EXE% -m PyInstaller %PYINSTALLER_ARGS%
if errorlevel 1 exit /b 1

if not exist "python_dist\arcode_server\arcode_server.exe" (
    echo ERROR: PyInstaller did not produce python_dist\arcode_server\arcode_server.exe.
    exit /b 1
)
if not exist "python_dist\arcode_server\_internal\ui\arcode\main.html" (
    echo ERROR: Arcode UI was not bundled into python_dist\arcode_server.
    echo HINT: Expected python_dist\arcode_server\_internal\ui\arcode\main.html.
    exit /b 1
)
if not exist "python_dist\arcode_server\_internal\ui\ai-assistant\index.js" (
    echo ERROR: Shared AI assistant assets were not bundled into python_dist\arcode_server.
    exit /b 1
)
if not exist "python_dist\arcode_server\_internal\ui\libs\monaco-editor\min\vs\loader.js" (
    echo ERROR: Monaco editor assets were not bundled into python_dist\arcode_server.
    exit /b 1
)

echo Arcode Python server bundle is ready.
exit /b 0
