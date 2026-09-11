---
name: excel-addin-build-needs-server-clone
description: "the Excel add-in .xlam cannot be built or released from the Client PC clone; the beta workbook and VBA signature files exist only in E:\\XWSpace\\Repos\\ArcRho, and the release moves the previous ArcRho.xlam into that clone's beta\\Archive"
metadata: 
  node_type: memory
  type: project
  originSessionId: 77f89e08-e1c5-4e9e-93b2-da102d57416d
  modified: 2026-09-11T20:38:55.632Z
---

`excel-addin/beta/` and `excel-addin/signature/` are gitignored and exist **only** in the Server PC clone `E:\XWSpace\Repos\ArcRho`. A fresh clone (including the Client PC working clone `C:\Users\xwei\Repos\ArcRho`) has neither, so `tools/build_xlam.ps1` stops at "Target XLAM not found" and `tools/release_xlam.ps1` stops at "Signature folder not found".

Three reasons the build belongs on that clone and nowhere else:

- `build_xlam.ps1` updates `beta\ARCRHO_BETA.xlam` **in place** through Excel COM; it never creates the workbook, which carries the ribbon and the userform package.
- `release_xlam.ps1` needs `signature\vbaProjectSignature*.bin` to re-sign the VBA project. Without them a release would publish an unsigned add-in to every user.
- `release_xlam.ps1` **moves** the live `E:\ArcRho Server\Excel Add-ins\ArcRho.xlam` into `..\beta\Archive` of whichever clone ran it. Running it from a second clone splits the rollback history across two machines.

So a VBA change is finished in two hops: commit and push from the working clone, then on the Server PC pull `E:\XWSpace\Repos\ArcRho` and run the two scripts there (build, then release). Excel COM itself does work from the Client PC (Excel 16.0), so the blocker is the missing artifacts, not the automation.

Related: [[arcrho-local-release-build]], [[dev-pc-and-client-pc-identity]], [[deploy-without-asking]].
