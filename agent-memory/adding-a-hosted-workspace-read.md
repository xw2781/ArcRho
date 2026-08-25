---
name: adding-a-hosted-workspace-read
description: "Recipe for putting a page load on the Gateway: register the kind in arcrho_workspace_read_contract, add the app_server service + router, rebuild the Gateway; hidden imports and the build-time import probe are derived from the contract automatically"
metadata: 
  node_type: memory
  type: project
  originSessionId: 4594cfec-63da-4dd1-a02e-09af167778f5
  modified: 2026-08-16T22:09:18.507Z
---

Moving a page's load off SMB onto the Gateway is four edits plus a Gateway rebuild:

1. `python-api/src/arcrho_workspace_read_contract.py` — add a `WorkspaceReadKind(module, function,
   required, optional)` to `WORKSPACE_READ_KINDS`. `module` is a bare `app_server.services` module
   name; `required`/`optional` are the exact kwargs a client may pass. `HTTP_WORKSPACE_READ_KINDS`
   and the Gateway's advertised capability list derive from this dict — there is no second table.
2. `frontend/app_server/services/<x>_service.py` — the read itself. Its signature must match the
   contract's arg names exactly; a mismatch only fails on the Gateway, never locally.
3. `frontend/app_server/api/<x>_router.py` — `workspace_read_client.run_workspace_read(kind, kwargs,
   local=lambda: service(...))`. Register in `app_server/api/__init__.py` **and** `app_server/main.py`.
4. Rebuild the Gateway (`server-components/src/arcrho_gateway/build_exe.py`). Its `--hidden-import` list and
   its pre-build "Validating canonical workspace-read dependencies" probe are both generated from
   `WORKSPACE_READ_KINDS`, so a new module is picked up with no build-script edit.

Notes that cost time to rediscover:
- `rebase_workspace_paths` walks the **whole** response recursively, so any server-rooted path at any
  depth (nested `sidecar.path`, a new `method_path`) is rebased onto the client's root for free.
- Verify without the UI: `GET http://<server>:28767/api/capabilities` lists `workspace_read_kinds`;
  then call `workspace_read_client.run_workspace_read(...)` from a repo-rooted Python 3.10 shell with
  `sys.path` = `['frontend', 'python-api/src', 'server-components/src']` and read the transport back out of
  `%LOCALAPPDATA%\ArcRho\logs\client_read_latency.jsonl` (`transport: http_gateway|smb`, `remote_ms`).
- A read whose identity comes from the browser (a method type picking a filename prefix) must be
  allowlisted in the service. The read runs on the server host under the caller's identity, so an
  unchecked type would let one page's route open another method type's JSON.
- `app_server/services/__init__.py` lazily resolves only the names in its `__all__`; method services
  (BF, CC, bootstrap, B&S) are not listed and are reached as plain submodule imports. Follow that.

Measured 2026-08-16 adding `berquist_sherman_load`: same read 1.6–2.7 s over SMB, 64 ms warm over the
Gateway. Related: [[engine-calculation-gateway-transport]], [[pi-path-load-smb-cost]],
[[gateway-deploy-swap-lock]].
