---
name: release-vs-source-comparison
description: "How to check whether a released ArcRho client is affected by a server deploy — diff the installed app's frozen UI and wheel and the deployed arcrho_canonical copies against the working tree, not against git HEAD"
metadata: 
  node_type: memory
  type: project
  originSessionId: 6c265796-c96a-460a-924b-51a1d87b7f5d
  modified: 2026-09-10T21:06:34.066Z
---

To answer "does this server rebuild affect users on the released app?", compare three things against the **working tree** (a deploy ships uncommitted edits, so `git diff <release>..HEAD` can show nothing while the server still changed):

- The installed release on the Client PC lives at `%LOCALAPPDATA%\Programs\ArcRho`; its exe ProductVersion is the release number, its UI is under `resources\arcrho_server\_internal\ui\`, and its Python API is the wheel under `resources\python_packages\` (the frozen server's own Python is inside the exe, so unzip the wheel to a scratch folder and diff with `--strip-trailing-cr`).
- The deployed server copies are `E:\ArcRho Server\apps\ArcRho Engine\_internal\arcrho_canonical\...` and the same under `ArcRho Gateway`; the Bridge keeps its copy under `_internal\resq_importer\python-api\src\arcrho_api\`. Use direct paths — `find` over E: times out.
- `deploy.py --stale` answers only "is the tree newer than the exe right now"; an edit made after a deploy flips it, so a deployed copy can be behind the tree by one later edit.

**Why:** On 2026-09-10 the DFM Notes work added a `notes_source` sidecar field on the server side while uncommitted; the deploy carried it, and git alone said the server was unchanged since release 1.5.1.

**How to apply:** Run the three diffs before saying a release is or is not affected; see [[deploy-staleness-is-mtime-based]] and [[hosted-save-fix-needs-engine-deploy]].
