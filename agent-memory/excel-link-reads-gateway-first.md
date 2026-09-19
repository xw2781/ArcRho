---
name: excel-link-reads-gateway-first
description: Reading linked Excel workbooks goes through the Gateway by default with an SMB (local) fallback; the user asked for this explicitly on 2026-09-18
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 4599da27-7ddb-489f-9302-174baa3258cd
  modified: 2026-09-18T22:13:36.347Z
---

When a feature reads linked Excel workbooks (the Manage Excel Links value check, a link refresh, a retarget), the read runs on the Gateway host by default and falls back to the client-side read over the mapped drive only when no gateway offers it. The user stated this directly on 2026-09-18 while the value check was being designed.

**Why:** the Server PC is the machine that must be able to open every linked workbook for a refresh or retarget to work, and a Client PC's own drive mappings say nothing about that; reading over SMB is also the transport being retired. The user still wants the local path kept as a fallback here, unlike the general "no new SMB fallback" rule in AGENT_GUIDELINES.md.

**How to apply:** register the read in `arcrho_workspace_read_contract.WORKSPACE_READ_KINDS` and route it through `workspace_read_client.run_workspace_read(kind, args, local=...)`, exactly as `excel_link_listing` and `excel_link_value_check` do; a write goes through a `SAVE_JOB_KINDS` hosted-save kind. Both need an Engine and Gateway redeploy before the new kind is served over HTTP ([[hosted-save-fix-needs-engine-deploy]]).

Since 2026-09-19 the plain cell read itself is hosted: `/excel/read_cells_batch` is the `excel_cell_values` read kind, so every window's workbook read - the freshness check a Dataset or DFM window runs when it opens, a Links-tab refresh, a formula committed in the formula bar, the B&S CRA check - opens the workbook on the server. That kind is the only registered one naming no project or reserving class: each item carries its own workbook path. A request with no item is served locally, because the contract refuses a request whose only argument is empty, and a gateway refusal (including a 413 over the 256 KB request cap) falls back to the local read.
