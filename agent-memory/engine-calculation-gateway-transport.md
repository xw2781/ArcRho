---
name: engine-calculation-gateway-transport
description: "Phase 2 of the hosted-transport plan is live (2026-08-16): ArcRhoTri/Vec/Headers exchange AND the whole /arcrho/tri* run (dataset_run/dataset_precheck) plus GET /dataset/{id} run on the Gateway; the DSV length change went 13.4 s -> ~1 s; profile breakdown and safe probe recipe"
metadata: 
  node_type: memory
  type: project
  originSessionId: 00652edb-ffac-4004-86c2-b835117aa15d
  modified: 2026-08-16T18:00:06.946Z
---

Implemented 2026-08-16 and deployed to the live Gateway: `POST /api/engine-calculations`
(`python-api/src/arcrho_engine_calculation_contract.py`, `server-components/src/arcrho_gateway/engine_calculations.py`,
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

**Second finding, same day:** hosting only the exchange barely moved the DSV origin/dev-length change
(user saw 7.6 s+). Profiling `/arcrho/tri/refresh` from this PC (per-phase SMB op counts via patched
`os.stat/open/...` — script pattern: wrap `arcrho_runtime_service` phases and count ops on `E:` paths):
13.4 s total = resolve_local_triangle_cache 0.8 s, exchange 3.2 s (1.7 s Engine compute + ~1.3 s client
visibility probe), **_write_dataset_sidecar 6.1 s (15 opens/23 stats)**, dependents enqueue 2.6 s, then
`GET /dataset/{id}` 1.4 s. So the run's *surrounding* SMB work dominated. Fix shipped the same day:
`Operation: dataset_run | dataset_precheck` on `/api/engine-calculations` runs the whole
`run_arcrho_tri` / `arcrho_precheck` on the Gateway (`arcrho_router` → `run_hosted_dataset_operation`,
client registers the returned `ds_id`), and `GET /dataset/{id}` is the `dataset_grid_load` workspace read
(falls back locally when the Gateway does not know the handle). Re-measured: `/arcrho/tri/refresh`
13.4 s → ~1.0 s (Engine warm), route-side SMB ops 1 open + 1 stat.

Not moved (still SMB from the client): direct `run_arcrho_tri` callers outside `/arcrho/*` (RS source
materialization, calculated-input recursion inside a local run) do their sidecar/dependent work over SMB;
the DFM/RS RPC-bridge request files (`requests/RPC bridge/`,
consumed by the Bridge, not the Engine). Related: [[pi-path-load-smb-cost]], [[gateway-deploy-swap-lock]].
