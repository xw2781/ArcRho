# Manual Input Triangles at a Coarser Method Period

Status: Future work — not started. Recorded 2026-09-04 after an investigation; no code changed.
Last updated: 2026-09-04

## The question that started this

A user enters a 120×120 monthly triangle by hand (an Excel range link). Can an annual DFM (10×10) use it as its input triangle?

Today the answer is "it looks like yes, then no":

1. The DFM Data tab asks the runtime for the dataset at the method's own period with `AllowDerived: true` and `WriteSidecar: false` ([data_tab_request_controller.js:586-602](../../frontend/ui/shared/tabs/data/data_tab_request_controller.js#L586-L602)). The runtime finds the 1‑month cache, derives a 12‑month cache beside it, and the grid shows a 10×10 triangle.
2. Every server‑side recompute of the DFM (first save, a save that changes the input name, dependent propagation, refresh, Result Selection restatement) reads the input's sidecar and compares its stored period with the method's. Only an Engine‑generated dataset is rebuilt at the method's period; anything else is refused with `422 … incompatible origin period length (1; expected 12)` ([dfm_service.py:272-306](../../frontend/app_server/services/dfm_service.py#L272-L306)). The refusal is pinned by `test_missing_sidecar_labels_do_not_hide_row_or_period_mismatches` in [test_dfm_service.py](../../frontend/tests/test_dfm_service.py).

Extending the Engine‑only branch to hand‑entered inputs is a few lines. It must not be done on its own, for the two reasons below.

## Why the obvious fix is unsafe

### 1. The roll‑up arithmetic is wrong for a normal triangle

`_derive_triangle_cache` ([arcrho_runtime_service.py:895-930](../../frontend/app_server/services/arcrho_runtime_service.py#L895-L930)) builds each coarse cell by summing the **same development column** across the 12 monthly origin rows of a block (cumulative), or the 12×12 square sub‑block (incremental). Those cells are valued at 12 different dates, and past the diagonal most of them are blank. An annual cell should sum each month's value at the **same valuation date**, i.e. along the calendar diagonal, which is how the Engine builds an annual triangle from source tables and how ResQ defines one.

Measured 2026-09-04 by calling the function on a synthetic 24‑month cumulative, dev‑aligned triangle in which every cell equals 100 × age in months (row *i* holds 24 − *i* cells):

| Annual cell | Current roll‑up | Calendar‑consistent |
| :--- | :--- | :--- |
| Year 1, dev 1 | 14,400 | 7,800 |
| Year 1, dev 2 | 2,400 | 22,200 |
| Year 2, dev 1 | 1,200 | 7,800 |

Every cell is off, not only the last diagonal. This already affects the Data tab view of any hand‑entered triangle opened at a coarser period; a DFM wired to it would inherit the numbers silently.

### 2. A derived cache is trusted forever

For a sidecar whose `source_kind` is `input`, `_processing_config_matches` returns `True` without looking at the file ([arcrho_runtime_service.py:562-575](../../frontend/app_server/services/arcrho_runtime_service.py#L562-L575)), and `arcrho_tri_cache_matches` never compares the sidecar's `csv_file` with the cache being validated. So once a `@12@12` variant exists it is reported as `cache_exact` on every later load. A dataset save rewrites only the sidecar's own CSV ([dataset_service.py:927-975](../../frontend/app_server/services/dataset_service.py#L927-L975)) and leaves sibling period variants in place. After an Excel refresh changes the monthly numbers, every 12‑month load keeps serving the old roll‑up.

The shared precedent resolver used by Result Selection has the same exposure: for a non‑Engine dataset it looks up a same‑period cache file by name on disk ([precedent_cache_service.py:82-127](../../frontend/app_server/services/precedent_cache_service.py#L82-L127)).

## Plan

One commit per step; do not start a step until the previous one is committed.

### Step 1 — Correct, shared roll‑up helper

- [ ] Add one function (suggested home: `python-api/src/arcrho_api/`, next to the triangle helpers, so both the app server and the Engine bundle carry it) that aggregates a finer dev‑aligned triangle to a coarser one along calendar diagonals, for both cumulative and incremental input, honouring the blank cells beyond the diagonal.
- [ ] Unit test pinned to a hand‑built expectation (the 24‑month synthetic above is a good start; add an incremental case and a non‑square case such as 1‑month origins with 3‑month development).
- [ ] Make `_derive_triangle_cache` call the helper, so the Data tab shows what the DFM will compute.
- [ ] Confirm the origin alignment assumption: both geometries come from the project's General Settings origin start month, so blocks line up. Reject the roll‑up (with a clear message) when the target period is not a whole multiple of the source, as `_can_derive_cache` already does.
- [ ] Commit.

### Step 2 — Roll up in memory for the DFM

- [ ] In `_load_source_snapshot`, when a non‑Engine input's period is finer than the method's and a whole multiple of it, read the sidecar's own CSV and roll it up in memory through the Step 1 helper. No variant file is written and nothing can go stale. A 120×120 grid is small; the cost is negligible next to the share round trips already paid.
- [ ] Keep the `422` refusal for every other mismatch (coarser source, non‑multiple, development length that cannot be derived), and keep the Engine branch as it is.
- [ ] Extend `test_dfm_service.py` with: a monthly manual input feeding an annual DFM (save, refresh_dependents, save_propagation_roots), and a stale on‑disk `@12@12` variant that must be ignored.
- [ ] Do the same in `precedent_cache_service.precedent_csv_path` for Result Selection, or have it return the rolled‑up frame through a shared code path with the DFM loader.
- [ ] Commit.

### Step 3 — Stop trusting on‑disk variants of hand‑entered datasets

Pick one; the first is simpler.

- [ ] Option A — stop materialising variants for `source_kind == "input"` in the runtime; derive in memory for the view exactly as Step 2 does for the DFM.
- [ ] Option B — record the source file's fingerprint in the derived cache's runtime provenance and have `_runtime_cache_provenance_matches` check it, so a changed monthly CSV invalidates the variant.
- [ ] Test: change the monthly CSV, reload at 12 months, expect the new numbers.
- [ ] Commit.

### Step 4 — Deploy

- [ ] Hosted saves and propagation run the loader on the Engine's bundled app_server copy, so this is not live until Engine and Gateway are redeployed via `server-components/deploy.py` (see the memory notes on remote component deploy and deploy staleness).
- [ ] Verify against the deployed `arcrho_canonical` copy before declaring it live.

## Verification

- `frontend/tests/test_dfm_service.py` and the new roll‑up unit test pass locally.
- Manual check on a test project: enter a monthly triangle by hand, open it at 12 months in the Dataset Viewer and compare a cell with a hand sum along the calendar diagonal; create an annual DFM on it, save, refresh the Excel link with changed numbers, and confirm the DFM refreshes to the new values.

## Reproduction script

The measurement above came from a throwaway script that imports `_derive_triangle_cache` from `app_server.services.arcrho_runtime_service` (run from `frontend/` with the `arcrho_engine` venv Python, which has pandas and fastapi), writes the synthetic monthly CSV to a temp folder, derives at 12/12, and prints both frames. Rebuild it from the description when needed; it was not kept.

## Rough size

About a day including tests, dominated by Step 1. Steps 2 and 3 are small once the helper exists.
