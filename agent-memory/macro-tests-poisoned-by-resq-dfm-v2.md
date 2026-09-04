---
name: macro-tests-poisoned-by-resq-dfm-v2
description: "Running python-api/tests/test_resq_dfm_v2.py in the same pytest process before the ResQ import macro tests makes 24 of them fail and each wait ~30s; pre-existing at b3a39003, so run macro test files one per process"
metadata: 
  node_type: memory
  type: project
  originSessionId: a1921f8a-ec56-44c0-8e86-254d14c0a66f
  modified: 2026-09-04T03:32:12.065Z
---

`python-api/tests/test_resq_dfm_v2.py` and `python-api/tests/test_import_resq_reserving_class(es)_macro.py` cannot share one pytest process. Run alone, each file passes (12 / 52 / 39 / 18 tests). Run together, 24 of the macro tests fail and the whole run takes ~17 minutes instead of seconds.

Confirmed pre-existing on 2026-09-03: the same three tests fail identically at commit `b3a39003`, before the Curves-tab and pre-import-backup work. The stubbing mechanism (`_macro_modules` → `patch.dict(sys.modules, {"arcrho_api": fake})`) is untouched by that work; `test_resq_dfm_v2.py` inserts `python-api/src`, `python-api/migration` and `frontend` on `sys.path` and imports the real `arcrho_api` plus `app_server.services.dfm_service` at module scope, which is what defeats the stub.

**Why:** a green per-file run and a red combined run is the kind of thing that gets blamed on the change under review. It is not the change; it is the file pairing.

**How to apply:**
- Run these macro test files one per pytest process, and never quote a combined-run result as a regression without checking the same pairing at the base commit first — use a `git worktree` at the merge-base, as in [[frontend-node-test-suite]].
- The ~30s per failing test is `REQUEST_CLAIM_TIMEOUT_SEC`: the macro publishes into its **temp** server root and waits for a Bridge claim that never comes. Verified on 2026-09-03 that nothing reached `E:\ArcRho Server\requests\RPC bridge\` during such a run, so this is slow, not destructive — unlike the live-data hazard in [[offline-dependent-walk-replay]].
- pytest lives in the repo-local `.pytest-tools`; the bundled `pytest.exe` fails with `No module named '_pytest'`, so invoke it as `PYTHONPATH=<repo>\.pytest-tools "C:\Program Files\Python310\python.exe" -m pytest`. See [[python-test-runner]].
