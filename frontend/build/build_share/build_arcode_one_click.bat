@echo off
setlocal EnableExtensions

REM Requests a fresh shared ArcRho source ZIP from the source-PC listener, then
REM selects the Arcode product in the common local-workspace build wrapper.
set "BUILD_SHARE_ROOT=%~dp0"
set "BUILD_SHARE_ROOT=%BUILD_SHARE_ROOT:~0,-1%"
set "REQUESTS_DIRECTORY=%BUILD_SHARE_ROOT%\build_requests"
set "RESPONSES_DIRECTORY=%BUILD_SHARE_ROOT%\build_responses"
set "LOCAL_BUILD_WRAPPER=E:\XWSpace\Repos\ArcRho\frontend\build\build_app_via_local_workspace.bat"

if defined ARCRHO_LOCAL_BUILD_WRAPPER set "LOCAL_BUILD_WRAPPER=%ARCRHO_LOCAL_BUILD_WRAPPER%"
if not exist "%LOCAL_BUILD_WRAPPER%" (
    echo ERROR: The local-workspace build script was not found:
    echo %LOCAL_BUILD_WRAPPER%
    exit /b 1
)

if /i "%~1"=="--check" (
    echo Product:         Arcode
    echo Build share:     %BUILD_SHARE_ROOT%
    echo Request folder:  %REQUESTS_DIRECTORY%
    echo Response folder: %RESPONSES_DIRECTORY%
    echo Build wrapper:   %LOCAL_BUILD_WRAPPER%
    echo Local workspace: %USERPROFILE%\Documents\build_arcode_app
    echo Published feed:  E:\Arcode Server\releases\arcode-installers
    exit /b 0
)

for /f "usebackq delims=" %%I in (`powershell -NoProfile -Command "[Guid]::NewGuid().ToString('N')"`) do set "REQUEST_ID=%%I"
if not defined REQUEST_ID (
    echo ERROR: Could not create a build request ID.
    exit /b 1
)

set "REQUEST_PATH=%REQUESTS_DIRECTORY%\%REQUEST_ID%.request"
set "REQUEST_TEMP_PATH=%REQUEST_PATH%.tmp"
set "RESPONSE_PATH=%RESPONSES_DIRECTORY%\%REQUEST_ID%.json"
set "ARCRHO_REQUEST_ID=%REQUEST_ID%"
set "ARCRHO_REQUEST_PATH=%REQUEST_PATH%"
set "ARCRHO_REQUEST_TEMP_PATH=%REQUEST_TEMP_PATH%"

if not exist "%REQUESTS_DIRECTORY%" mkdir "%REQUESTS_DIRECTORY%" >nul 2>nul
if not exist "%RESPONSES_DIRECTORY%" mkdir "%RESPONSES_DIRECTORY%" >nul 2>nul
if not exist "%REQUESTS_DIRECTORY%" (
    echo ERROR: Cannot access request folder: %REQUESTS_DIRECTORY%
    exit /b 1
)
if not exist "%RESPONSES_DIRECTORY%" (
    echo ERROR: Cannot access response folder: %RESPONSES_DIRECTORY%
    exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -Command "$payload = [ordered]@{ schemaVersion = 1; requestId = $env:ARCRHO_REQUEST_ID; product = 'arcode'; requestedAtUtc = [DateTime]::UtcNow.ToString('o'); requestedBy = $env:COMPUTERNAME }; $json = ($payload | ConvertTo-Json -Compress) + [Environment]::NewLine; [System.IO.File]::WriteAllText($env:ARCRHO_REQUEST_TEMP_PATH, $json, (New-Object System.Text.UTF8Encoding($false))); Move-Item -LiteralPath $env:ARCRHO_REQUEST_TEMP_PATH -Destination $env:ARCRHO_REQUEST_PATH -ErrorAction Stop"
if errorlevel 1 (
    echo ERROR: Could not send the ZIP request to the source-PC listener.
    exit /b 1
)

echo Requested a fresh source ZIP for Arcode.
echo Request ID: %REQUEST_ID%
echo Waiting for the shared source-PC listener. Press Ctrl+C to stop waiting.

:wait_for_response
if not exist "%RESPONSE_PATH%" goto wait_for_response_delay
set "ARCRHO_RESPONSE_PATH=%RESPONSE_PATH%"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$response = Get-Content -LiteralPath $env:ARCRHO_RESPONSE_PATH -Raw | ConvertFrom-Json; if ($response.schemaVersion -ne 1 -or $response.requestId -ne $env:ARCRHO_REQUEST_ID) { throw 'The listener response does not match this build request.' }; if ($response.status -eq 'succeeded') { if ([string]::IsNullOrWhiteSpace([string]$response.readySignal)) { throw 'The listener response did not include a ZIP completion signal.' }; Write-Host ('Source ZIP ready. Signal: ' + $response.readySignal); exit 0 }; if ($response.status -eq 'failed') { throw ('Source ZIP request failed: ' + $response.message) }; throw ('Listener returned an unknown status: ' + $response.status)"
if errorlevel 1 (
    echo ERROR: The source-PC listener did not create the requested ZIP.
    echo Response retained for troubleshooting: %RESPONSE_PATH%
    exit /b 1
)

del /q "%RESPONSE_PATH%" >nul 2>nul
echo.
echo Starting the common local-workspace build in Arcode mode...
set "ARCRHO_BUILD_PRODUCT=arcode"
call "%LOCAL_BUILD_WRAPPER%" %*
set "BUILD_EXIT_CODE=%ERRORLEVEL%"
if not "%BUILD_EXIT_CODE%"=="0" (
    echo ERROR: Automated Arcode build failed with exit code %BUILD_EXIT_CODE%.
    exit /b %BUILD_EXIT_CODE%
)
exit /b 0

:wait_for_response_delay
timeout /t 3 /nobreak >nul
goto wait_for_response
