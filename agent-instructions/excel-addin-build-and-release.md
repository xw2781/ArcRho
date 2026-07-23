# Excel Add-in Build and Release

After making changes under `excel-addin/`, automatically run the non-interactive build and release scripts unless the user explicitly asks not to build or release:

- Step 1: `powershell -NoProfile -ExecutionPolicy Bypass -File "E:\XWSpace\Repos\ArcRho\excel-addin\tools\build_xlam.ps1"`
- Step 2: `powershell -NoProfile -ExecutionPolicy Bypass -File "E:\XWSpace\Repos\ArcRho\excel-addin\tools\release_xlam.ps1"`

Treat this as pre-approved by the repository instructions for Excel add-in changes, but still follow environment requirements for sandbox escalation because the scripts update the beta add-in and release add-in outside the repository. Do not use `Step 1+2 - Build and Release ArcRho.bat` for agent validation because its interactive prompt can hang in agent terminals. If either direct script is blocked, fails, or times out, report that clearly.
