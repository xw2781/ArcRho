---
name: scripts-save-through-gateway-client
description: "notebooks/scripts that write Arco data use arcrho_api.gateway.GatewayClient, never the local app URL; audit log must show the user"
metadata:
  node_type: memory
  type: feedback
  originSessionId: 995ff494-bf42-47e2-a093-4e600105cfd4
  modified: 2026-09-24T14:58:35.139Z
---

Notebooks and scripts that read or save Arco project data go through `arcrho_api.gateway.GatewayClient` (signed with the user's own `%APPDATA%\ArcRho\arcrho_gateway.json`), not the local app URL from `arcrho_api.ui`.

**Why:** 2026-09-24, on the shared Server PC NE7SASWPN02 the default app port 28765 belonged to another user's Arco (Jianming Zhang), so a reserve-range notebook's saves were logged under his name. The user wants the audit log to show their own name, and does not want to depend on Arco being open.

**How to apply:** build script saves as `gateway.read(...)` / `gateway.mutate("propagation_submit", ...)` / `gateway.save(kind, project, rc, *service_args)`; poll the `propagation_busy` read before each save. Example: `E:\ResQ\Automations\Reserve Review\2026Q3\3.1 Reserve Ranges (Arco).ipynb`. Related: [[engine-calculation-gateway-transport]], [[propagation-hold-and-test-isolation]].
