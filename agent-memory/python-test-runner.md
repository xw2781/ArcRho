---
name: python-test-runner
description: No interpreter on this dev PC has pytest; install it into a repo-local --target dir to run python-api tests
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 49fe14c4-94ee-453f-a0ac-d42ea1b6f43e
  modified: 2026-08-27T22:38:12.288Z
---

No Python interpreter on this machine has `pytest` installed — not `C:\Program Files\Python310`, not `Python314`, and none of the `server-components/venvs/*` environments. To run `python-api/tests`, install it into a throwaway directory **inside the repo** and put that on `PYTHONPATH`:

```
python -m pip install --quiet --target e:/XWSpace/Repos/ArcRho/.pytest-tools "pytest>=8"
PYTHONPATH="e:/.../.pytest-tools;e:/.../python-api/src" python -m pytest python-api/tests -q
```

**Why:** AGENTS.md forbids validation commands from writing to the C drive, so a user-site or venv install is out; a repo-local `--target` keeps everything on E: and is trivially removable.

**How to apply:** Delete `.pytest-tools` when finished so it never reaches a commit. Three pre-existing conditions are not your fault: `tests/test_arcrho_api.py` fails collection (a helper named `test_log` takes a non-fixture argument), so exclude it; 6 tests in `test_resq_data_migration_graph.py` / `test_validate_engine_resq_parity.py` already fail on a clean `main`; and `frontend/tests/test_result_selection_cross_producer_contract.py` fails at HEAD too (bridge payload lacks the `_sidecar_status` key the migration payload carries) — confirmed 2026-08-12 via a detached `git worktree` at HEAD.

`frontend/tests/*.py` run under plain `unittest` with the bridge venv python and `PYTHONPATH=frontend;python-api/src;server-components/src`; no pytest needed. `unittest discover` refuses `-s frontend/tests` (not an importable package) — `cd` into the tests folder and use `-s .` with absolute paths on `PYTHONPATH`.

On the **Client PC clone** (`C:\Users\xwei\Repos\ArcRho`, 2026-08-14) the bridge venv lacks `openpyxl`, so use `server-components/venvs/arcrho_engine/Scripts/python.exe` instead. Baseline there: 588 frontend tests with 4 failures that are not yours — `test_sql_formatting_service` (no `sqlfluff`), `test_dataset_number_format_defaults` (needs an "Example Project" folder), `test_result_selection_cross_producer_contract` (known), and `test_engine_dataset_sidecar_contract`, which fails only on a machine whose real `username_index.json` maps the login, because the runtime writer resolves a full name while the migration fixture expects `tester`. `test_class_folder_scan_cache` is timing-flaky. `server-components/tests` is clean except `test_multi_user_instances` (no `psutil`). A worktree baseline also needs `mklink /J <worktree>\frontend\node-portable` to the real one, since node-portable is gitignored and some tests shell out to it. Related: [[shared-macro-library-deploy]], [[frontend-node-test-suite]], [[app-server-route-smoke-test]].

On the `E:\XWSpace\Repos\ArcRho` clone under user `xwei.PRCINS` (2026-08-27): there is no `server-components/venvs` folder at all, and the sandbox denies a Bash `ls` of that path, so do not look for a venv. `py -3.10` (3.10.6) runs the python-api and server-components suites directly: `cd python-api\tests; py -3.10 -m unittest test_resq_sync_plan test_resq_sync_session ...` — each test file inserts its own roots. Run it through the PowerShell tool; the `.....` progress dots come back as a NativeCommandError line that is not a failure, read the `Ran N tests ... OK` tail.

Better on the Client PC (2026-08-17): the user-scoped interpreter `py -3.10` (`C:\Users\xwei\AppData\Local\Programs\Python\Python310`) has fastapi, pydantic, uvicorn, sqlfluff, snowflake-connector, **and pyodbc**, so `cd frontend && py -3.10 -m unittest discover -s tests -p "test_*.py"` runs the whole frontend suite with no PYTHONPATH juggling — each test file inserts the repo roots itself. Baseline that day: 667 tests, 3 failures (`test_dataset_number_format_defaults`, `test_engine_dataset_sidecar_contract`, `test_result_selection_cross_producer_contract`), all reproduced in a detached HEAD worktree.

On `E:\XWSpace\Repos\ArcRho` under `xwei.PRCINS` (2026-08-27, corrected): the system `C:\Program Files\Python310\python.exe` (3.10.6) does have fastapi, pydantic, pandas, numpy and pywin32 — only pytest is missing — so frontend service tests run with `cd frontend/tests && "C:\Program Files\Python310\python.exe" -m unittest test_result_selection_service` (module names, from the tests folder so the workspace stub imports). `python` (3.14) plus the repo-local `.pytest-tools` on `PYTHONPATH` runs the python-api suites. Frontend test runs can leave `tmp*` folders at the repo root; delete them before committing.

**Module order pollutes `python-api/tests` (2026-08-29).** Running `test_import_resq_reserving_classes_macro` in the same `unittest` invocation as the other `test_resq_*` modules fails 3 of its 13 tests (`default_rc_paths` returns the real 17-entry `RC_PATH` instead of `[]`, and the preselection rows come back unticked). An earlier module puts `python-api/migration` on `sys.path`, so the macro's `import resq_data_migration` fallback succeeds instead of raising `ImportError`. The module passes 13/13 when run alone, and the 3 failures reproduce identically at a clean HEAD worktree — so never blame a working-tree change for them. `server-components/tests/test_bridge_import_request_protocol.test_client_delegates_full_import_to_the_canonical_runner` also fails at HEAD (the client now passes `resq_credentials` the test does not expect).
