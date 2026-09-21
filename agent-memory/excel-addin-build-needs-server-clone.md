---
name: excel-addin-build-needs-server-clone
description: "the Excel add-in builds and releases from the Client PC by running the E:\\XWSpace\\Repos\\ArcRho scripts with -SourceDir pointed at the working clone; the beta workbook, signature files, and rollback archive live only in that server clone"
metadata:
  node_type: memory
  type: project
  originSessionId: 77f89e08-e1c5-4e9e-93b2-da102d57416d
  modified: 2026-09-21T20:20:38.590Z
---

`excel-addin/beta/` and `excel-addin/signature/` are gitignored and exist **only** in the server clone `E:\XWSpace\Repos\ArcRho`. A fresh clone (including the Client PC working clone `C:\Users\xwei\Repos\ArcRho`) has neither, so its own `tools/build_xlam.ps1` stops at "Target XLAM not found" and `tools/release_xlam.ps1` at "Signature folder not found".

**Working recipe from the Client PC (used 2026-09-21 for 4.0.1, no commit or pull needed):** E: is the same share, so run the server clone's scripts but feed them the working clone's sources:

```
powershell -NoProfile -ExecutionPolicy Bypass -File "E:\XWSpace\Repos\ArcRho\excel-addin\tools\build_xlam.ps1" -SourceDir "C:\Users\xwei\Repos\ArcRho\excel-addin\src_vba" -CustomUIPath "C:\Users\xwei\Repos\ArcRho\excel-addin\tools\customUI.xml"
py -3.10 excel-addin\tools\verify_built_addin.py "E:\XWSpace\Repos\ArcRho\excel-addin\beta\ARCRHO_BETA.xlam"
powershell -NoProfile -ExecutionPolicy Bypass -File "E:\XWSpace\Repos\ArcRho\excel-addin\tools\release_xlam.ps1"
```

- `git` refuses the E: clone ("dubious ownership") unless run with `-c safe.directory='*'`; it is usually behind and dirty with other work, which does not matter because only its gitignored `beta\` and `signature\` folders are used.
- The build can fail once with "ARCRHO_BETA.xlam ... being used by another process" right after it rewrote the ribbon XML inside the zip. That is a share write race, not a user's Excel; rerun the same command. The user's own Excel windows never need closing.
- "Importing new UserForm ufBuildTriangle.frm" is a benign build warning; the verify script still reports all modules matching.
- Excel COM refuses to set `Application.Calculation` before a workbook exists; add the workbook first in any probe script.

Why the build stays on that clone's artifacts: `build_xlam.ps1` updates `beta\ARCRHO_BETA.xlam` **in place** (it never creates the workbook, which carries the ribbon and userform package); `release_xlam.ps1` needs `signature\vbaProjectSignature*.bin` to re-sign the VBA project; and the release **moves** the live `E:\ArcRho Server\Excel Add-ins\ArcRho.xlam` into that clone's `beta\Archive`, so one archive keeps the whole rollback history.

Related: [[arcrho-local-release-build]], [[dev-pc-and-client-pc-identity]], [[deploy-without-asking]], [[build-listener-request-read-race]].
