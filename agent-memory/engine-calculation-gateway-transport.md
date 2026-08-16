---
name: engine-calculation-gateway-transport
description: "Phase 2 of the hosted-transport plan is live (2026-08-16): ArcRhoTri/Vec/Headers publish-and-wait runs on the Gateway; measured ~300 ms vs ~1.2 s per exchange from the Client PC, and how to probe it safely"
metadata: 
  node_type: memory
  type: project
  originSessionId: 00652edb-ffac-4004-86c2-b835117aa15d
  modified: 2026-08-16T18:00:06.946Z
---

Implemented 2026-08-16 and deployed to the live Gateway: `POST /api/engine-calculations`
(`python-api/src/arcrho_engine_calculation_contract.py`, `data-engine/src/arcrho_gateway/engine_calculations.py`,
`frontend/app_server/services/engine_calculation_service.py`). Every `arcrho_runtime_service`
request site now calls `engine_calculation_service.run_engine_calculation(pairs, data_path, timeout)`.
Docs: `frontend/docs/app_server/domains/engine_calculations.md`; contract rule 18.

**Measured from the Client PC (L-H2MQ6280FVP), ArcRhoHeaders on NJ_Annual_Prod_202605_Fake, warm Engine:**
hosted ≈ 300 ms end-to-end (remote ≈ 195 ms, of which server-side wait ≈ 115 ms; visibility check ≈ 100 ms)
vs SMB publish-and-poll ≈ 1.1–2.4 s. When the Engine itself is cold (~1.2 s compute) both paths are
dominated by that; the transport saves ~0.8–2 s per exchange, and a dataset run chains several exchanges.
Records land in `%LOCALAPPDATA%\ArcRho\logs\client_read_latency.jsonl` with `read_kind: engine_calculation`
(`total_ms`, `remote_ms`, `server_wait_ms`, `reason`).

**Why the transport decides on `is_network_path(data_path)`, not the workspace root:** many frontend
tests call `run_arcrho_tri` with temp-dir data paths while `config.get_root_path()` still resolves the real
E:\ and the local `arcrho_gateway.json` credential is *enabled* on this PC — deciding on the root would make
those tests POST real requests to the live Gateway. Local data path → local exchange, always. Tests that need
the HTTP branch patch `engine_calculation_service.is_network_path` to True.

**Safe live probe:** `_header_cache_pairs(project, 0, False, <unusual length e.g. 36>, False)` →
`set_data_path_like_vba` → delete the cache file → `run_engine_calculation` → delete the file again. Force the
SMB path with `patch.object(engine_calculation_service, "gateway_supports_engine_function", return_value=False)`.
Server-side entries appear in `E:\ArcRho Server\runtime\logs\gateway.log` as `calculation=<id> ... wait_ms=`.

**Existing test patches moved:** tests that used to patch `arcrho_runtime_service.send_request_like_vba` /
`wait_for_file` now patch them on `engine_calculation_service` (the runtime service no longer imports them).

Not moved (still SMB from the client): stale-cache removal before the request, and the sidecar write,
dependent enqueue, and index refresh after it; the DFM/RS RPC-bridge request files (`requests/RPC bridge/`,
consumed by the Bridge, not the Engine). Related: [[pi-path-load-smb-cost]], [[gateway-deploy-swap-lock]].
