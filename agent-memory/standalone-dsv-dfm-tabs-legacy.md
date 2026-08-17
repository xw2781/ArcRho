---
name: standalone-dsv-dfm-tabs-legacy
description: Standalone shell tabs for Dataset Viewer and DFM are legacy and are being dropped; PI windows and Workflow steps are the live hosts
metadata: 
  node_type: memory
  type: project
  originSessionId: 87683c39-92dd-4938-9317-19cb7e79e94b
  modified: 2026-08-17T17:38:53.957Z
---

Standalone shell tabs for the Dataset Viewer and DFM (tab-strip `+` -> dataset, Browsing History restore, `openDatasetTab`/`openDFMTab` in `frontend/ui/shell/tab_actions.js`, and the matching branches in `frontend/ui/shell/iframe_host.js`) are legacy designs. The user confirmed on 2026-08-17 that they are to be dropped completely and that no standalone DSV/DFM tab will exist going forward.

**Why:** it changes what counts as a supported host when deciding whether a page's Details tab must still offer a Project picker. The only hosts that stay are Project Instance floating windows (`project_instance=1`) and Workflow steps (`wf=<instanceId>`); PI fixes the project, and only a Workflow step still lets the user choose one inside the embedded page.

**How to apply:** do not preserve or design around standalone DSV/DFM tab behaviour; treat PI and Workflow as the two live hosts. A host-fixed field such as the Details Project row is hidden everywhere except a Workflow-hosted page - see [[details-tab-shared-primitive]].
