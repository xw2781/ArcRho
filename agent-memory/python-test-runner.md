---
name: python-test-runner
description: No interpreter on this dev PC has pytest; install it into a repo-local --target dir to run python-api tests
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 49fe14c4-94ee-453f-a0ac-d42ea1b6f43e
  modified: 2026-08-12T16:58:40.548Z
---

No Python interpreter on this machine has `pytest` installed — not `C:\Program Files\Python310`, not `Python314`, and none of the `data-engine/venvs/*` environments. To run `python-api/tests`, install it into a throwaway directory **inside the repo** and put that on `PYTHONPATH`:

```
python -m pip install --quiet --target e:/XWSpace/Repos/ArcRho/.pytest-tools "pytest>=8"
PYTHONPATH="e:/.../.pytest-tools;e:/.../python-api/src" python -m pytest python-api/tests -q
```

**Why:** AGENTS.md forbids validation commands from writing to the C drive, so a user-site or venv install is out; a repo-local `--target` keeps everything on E: and is trivially removable.

**How to apply:** Delete `.pytest-tools` when finished so it never reaches a commit. Three pre-existing conditions are not your fault: `tests/test_arcrho_api.py` fails collection (a helper named `test_log` takes a non-fixture argument), so exclude it; 6 tests in `test_resq_data_migration_graph.py` / `test_validate_engine_resq_parity.py` already fail on a clean `main`; and `frontend/tests/test_result_selection_cross_producer_contract.py` fails at HEAD too (bridge payload lacks the `_sidecar_status` key the migration payload carries) — confirmed 2026-08-12 via a detached `git worktree` at HEAD.

`frontend/tests/*.py` run under plain `unittest` with the bridge venv python and `PYTHONPATH=frontend;python-api/src;data-engine/src`; no pytest needed. `unittest discover` refuses `-s frontend/tests` (not an importable package) — `cd` into the tests folder and use `-s .` with absolute paths on `PYTHONPATH`.

On the **Client PC clone** (`C:\Users\xwei\Repos\ArcRho`, 2026-08-14) the bridge venv lacks `openpyxl`, so use `data-engine/venvs/arcrho_engine/Scripts/python.exe` instead. Baseline there: 588 frontend tests with 4 failures that are not yours — `test_sql_formatting_service` (no `sqlfluff`), `test_dataset_number_format_defaults` (needs an "Example Project" folder), `test_result_selection_cross_producer_contract` (known), and `test_engine_dataset_sidecar_contract`, which fails only on a machine whose real `username_index.json` maps the login, because the runtime writer resolves a full name while the migration fixture expects `tester`. `test_class_folder_scan_cache` is timing-flaky. `data-engine/tests` is clean except `test_multi_user_instances` (no `psutil`). A worktree baseline also needs `mklink /J <worktree>\frontend\node-portable` to the real one, since node-portable is gitignored and some tests shell out to it. Related: [[shared-macro-library-deploy]], [[frontend-node-test-suite]].
