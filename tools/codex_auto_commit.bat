@echo off
setlocal EnableExtensions EnableDelayedExpansion

set "REPO_ROOT=%~dp0.."
for %%I in ("%REPO_ROOT%") do set "REPO_ROOT=%%~fI"
set "WORKSPACE_ROOT=%REPO_ROOT%\..\.."
for %%I in ("%WORKSPACE_ROOT%") do set "WORKSPACE_ROOT=%%~fI"
set "CODEX_MODEL=gpt-5.6-sol"
set "CODEX_REASONING_EFFORT=medium"
set "CHECK_ONLY=0"

if /I "%~1"=="--help" goto :help
if /I "%~1"=="-h" goto :help
if /I "%~1"=="--check" set "CHECK_ONLY=1"

set "CODEX_EXE="
for /f "delims=" %%I in ('where codex 2^>nul') do if not defined CODEX_EXE set "CODEX_EXE=%%I"
if not defined CODEX_EXE call :find_codex "%WORKSPACE_ROOT%\VSCode\extensions"
if not defined CODEX_EXE call :find_codex "%USERPROFILE%\.vscode\extensions"
if not defined CODEX_EXE call :find_codex "%USERPROFILE%\.vscode-insiders\extensions"

if not defined CODEX_EXE (
    echo ERROR: Codex CLI was not found on PATH or in a VS Code extension.
    echo Searched: %WORKSPACE_ROOT%\VSCode\extensions
    echo Searched: %USERPROFILE%\.vscode\extensions
    echo Searched: %USERPROFILE%\.vscode-insiders\extensions
    set "CODEX_EXIT=1"
    goto :result
)

where git >nul 2>&1
if errorlevel 1 (
    echo ERROR: Git was not found on PATH.
    set "CODEX_EXIT=1"
    goto :result
)

set "DETECTED_ROOT="
for /f "delims=" %%I in ('git -C "%REPO_ROOT%" rev-parse --show-toplevel 2^>nul') do set "DETECTED_ROOT=%%I"
if not defined DETECTED_ROOT (
    echo ERROR: "%REPO_ROOT%" is not a Git repository.
    set "CODEX_EXIT=1"
    goto :result
)
for %%I in ("%DETECTED_ROOT%") do set "DETECTED_ROOT=%%~fI"

if /I not "%DETECTED_ROOT%"=="%REPO_ROOT%" (
    echo ERROR: Repository root mismatch.
    echo Expected: %REPO_ROOT%
    echo Found:    %DETECTED_ROOT%
    set "CODEX_EXIT=1"
    goto :result
)

if "%CHECK_ONLY%"=="1" (
    echo Codex CLI: %CODEX_EXE%
    echo Model:     %CODEX_MODEL%
    echo Reasoning: %CODEX_REASONING_EFFORT%
    call "%CODEX_EXE%" --version
    exit /b !ERRORLEVEL!
)

set "START_HEAD="
for /f "delims=" %%I in ('git -C "%REPO_ROOT%" rev-parse HEAD 2^>nul') do set "START_HEAD=%%I"

echo ArcRho automatic commit workflow
echo Repository: %REPO_ROOT%
echo Codex CLI:  %CODEX_EXE%
echo Model:      %CODEX_MODEL%
echo Reasoning:  %CODEX_REASONING_EFFORT%
echo.
echo Codex will inspect, validate, group, stage, and commit the current worktree.
echo Pushes and remote changes are forbidden.
echo Security: danger-full-access is enabled so Codex can update Git metadata.
echo.

call "%CODEX_EXE%" --model "%CODEX_MODEL%" --config "model_reasoning_effort=%CODEX_REASONING_EFFORT%" --ask-for-approval never --sandbox danger-full-access exec --cd "%REPO_ROOT%" --color always "Use $arcrho-commit-workflow to inspect and commit all appropriate current worktree changes in this ArcRho repository. This invocation explicitly authorizes git add and git commit for the full current worktree, so proceed without asking for any additional approval or confirmation. Read every applicable AGENTS.md and tools/agent_commit_workflow.md. Review the diffs, group the work into one to seven logical commits, run appropriate targeted validations within the repository time limit, stage only each exact logical group, verify each staged diff, and create clear commit messages. Exclude secrets, local-only files, debug artifacts, and build output; report every exclusion. Do not push, fetch, pull, change remotes, or otherwise contact a remote. Do not ask questions: if a safe commit cannot be made, leave the affected changes uncommitted and explain why. Finish with a concise result containing commit hashes and messages, validation results, exclusions, and final worktree status."
set "CODEX_EXIT=%ERRORLEVEL%"

:result
echo.
echo ============================================================
echo Automatic commit result
echo ============================================================
echo Codex exit code: %CODEX_EXIT%

if defined START_HEAD (
    set "END_HEAD="
    for /f "delims=" %%I in ('git -C "%REPO_ROOT%" rev-parse HEAD 2^>nul') do set "END_HEAD=%%I"
    if defined END_HEAD (
        echo.
        echo Commits created by this run:
        if /I "%START_HEAD%"=="!END_HEAD!" (
            echo   None
        ) else (
            git -C "%REPO_ROOT%" log --oneline "%START_HEAD%..!END_HEAD!"
        )
    )
)

if defined DETECTED_ROOT (
    echo.
    echo Final repository status:
    git -C "%REPO_ROOT%" status --short --branch
)

echo.
echo Press any key to close this window.
pause >nul
exit /b %CODEX_EXIT%

:find_codex
if not exist "%~1" exit /b 0
for /d %%D in ("%~1\openai.chatgpt-*") do (
    if exist "%%~fD\bin\windows-x86_64\codex.exe" set "CODEX_EXE=%%~fD\bin\windows-x86_64\codex.exe"
    if exist "%%~fD\bin\windows-arm64\codex.exe" set "CODEX_EXE=%%~fD\bin\windows-arm64\codex.exe"
)
exit /b 0

:help
echo Usage: %~nx0 [--check]
echo.
echo Runs Codex CLI non-interactively in the ArcRho repository. Codex follows
echo $arcrho-commit-workflow, commits appropriate local changes without another
echo approval prompt, always uses gpt-5.6-sol with medium reasoning, never
echo pushes, and prints the resulting commits and status.
echo.
echo --check resolves Codex and prints its version without creating a commit.
exit /b 0
