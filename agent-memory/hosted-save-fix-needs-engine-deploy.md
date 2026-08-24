---
name: hosted-save-fix-needs-engine-deploy
description: "An app_server fix to a method save (DFM/BF/CC/Bootstrap/Result Selection) is not live until the Engine and Gateway are redeployed, because those saves run as hosted jobs on the Engine's bundled copy of app_server; the local dev app server only forwards them"
metadata: 
  node_type: memory
  type: project
  originSessionId: 1d375406-5cae-43be-842e-067853a1e145
  modified: 2026-08-24T19:17:36.058Z
---

Method saves are hosted Engine jobs (`arcrho_engine_save_contract.SAVE_JOB_KINDS`, e.g. `result_selection_method`). The Engine and Gateway each bundle their own copy of `frontend/app_server` and `python-api/src` under `E:\ArcRho Server\apps\<App>\_internal\arcrho_canonical\`, so a fix made in the working tree and picked up by a restarted dev app server still produces the *old* result when the user saves, because the app server just forwards the save to the Engine.

**Why:** On 2026-08-24 the Result Selection bare-name precedents fix was verified in tests and the dev app server was restarted, yet the user's next save still wrote bare names — the hosted_saves.log showed the job ran on the Engine built the day before.

**How to apply:** after changing any app_server code that a hosted save kind runs, check `grep -c <old symbol>` in the deployed canonical copy under `E:\ArcRho Server\apps\ArcRho Engine\_internal\arcrho_canonical\...` before telling the user the fix is live, and deploy Engine + Gateway via `py -3.10 data-engine/deploy.py` (see [[remote-component-deploy]]; deploy one component per run if the status-file WinError 5 recurs, and retry once on the request-read Errno 13 from [[build-listener-request-read-race]]). A live Admin Control on the server blocks the `admin` component and, in a no-argument run, everything after it — name the components explicitly instead. Related: [[adding-a-hosted-save-kind]].
