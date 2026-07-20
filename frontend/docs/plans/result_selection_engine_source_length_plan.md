# Result Selection — Accept Engine-Generated Sources at Any Length/Shape

Version: v0.1
Last updated: 2026-06-30
Status: Planned (for implementation by Codex)

---

## 1. Goal

Allow a Result Selection (RS) method to use a finer origin length (e.g. quarterly `3`)
than some of its source datasets, **as long as the coarser sources are engine-generated**.
Today the RS editor clamps the RS origin length up to the *coarsest* source's stored
length, so an RS that ResQ defines as quarterly (`OriginLength = 3`) is forced to annual
(`12`) whenever any source (e.g. an annual `Claim Counts--CWP` triangle) is stored at `12`.

Target behavior:

1. Source datasets with `source_kind == "engine"` impose **no** floor on the RS origin
   length. They can be accepted at any valid length/shape.
2. When the RS origin length differs from an engine source's stored length, the editor
   requests the data engine to materialize that source **at the RS length** and uses the
   resulting length-scoped cache for the grid values.
3. The engine source's own sidecar and stored cache (e.g. `…@12@12@cum@dev.csv`) are
   **never modified**. Only an additional length-scoped cache (e.g. `…@3@3@cum@dev.csv`)
   is produced by the engine.
4. Non-engine sources (`input`, `dfm`, `calculated`, `result_selection`) keep the existing
   constraint (they still contribute their stored length to the allowed floor), because
   they cannot be re-derived at arbitrary granularity from a monthly detail table.

Non-goals: changing the migration script, changing ResQ, or altering how non-engine
sources are loaded.

---

## 2. Root Cause (verified)

File: `frontend/ui/method_pages/result_selection/result_selection_main.js`

- On load, `applyPayload` correctly sets the RS length from the method JSON / output
  sidecar (`origin_length = 3`), then calls `syncOriginLengthOptions()`
  (`result_selection_main.js:1676`).
- `syncOriginLengthOptions()` (`:479`) rebuilds the allowed dropdown values from
  `allowedOriginLengthsForSources()` (`:471`):

  ```js
  const required = state.sources.reduce((max, source) => {
    const originLength = validSourceOriginLength(source?.originLength);
    return originLength ? Math.max(max, originLength) : max;
  }, 0);
  return VALID_ORIGIN_LENGTHS.filter((originLength) => !required || originLength >= required);
  ```

  With an annual source (`originLength = 12`), `required = 12`, so `allowed = [12]`. The
  current value `3` is not allowed, so it is clamped to `fallback = 12` (`:484-485`),
  `sidecarOriginLength` is cleared (`:500`), the 40 quarterly labels are rejected by
  `shouldRejectOriginLabels` (`:455`), and 10 annual rows are regenerated.

This is independent of the migration (which now correctly exports `origin_length = 3`) and
independent of caches (verified: `/dataset/sidecar/load` returns `3` live).

### Confirmed source kinds for `C 91 -  Current Qtr Indicated` (NY MP+PIP)

| Source | data_format | source_kind | stored origin_length |
| --- | --- | --- | --- |
| Claim Counts--CWP | Triangle | engine | 12 |
| Claim Counts--Reported ex CWOP | Triangle | engine | 12 |
| C 41 - BF Reported ex CWOP | Vector | input | 3 |
| C 42 - Reported ex CWOP DFM w/ Selected LDFs | Vector | dfm | 3 |
| C 61 Reported - CWOP | Vector | calculated | 3 |
| C 62 Reported *(CWOP/Reported) CDF | Vector | calculated | 3 |

Only the two `engine` triangles are coarse; excluding them from the floor lets the RS stay
at `3` for this object. The vector-engine path (section 5) is required for generality, not
for this specific RS.

---

## 3. Data-Engine Capability (verified)

The engine already supports vector generation at an arbitrary period length; only the
frontend HTTP route is missing.

- Function aliases (`data-engine/src/utils.py:225-230`):
  `ArcRhoTri → ADASTri`, `ArcRhoVec → ADASVec`.
- Both dispatch to `UDF_ADASTri(arg)` (`data-engine/src/arcrho_engine/main.py:115-116`).
- Vector mode is detected by `is_vector_function(arg['Function'])`
  (`data-engine/src/arcrho_engine/data_processing.py:877-878`); the engine builds the full
  matrix at the requested length and returns the first column for vectors.
- The VBA `ArcRhoVec` maps a single `PeriodLength` to **both** `OriginLength` and
  `DevelopmentLength` (`excel-addin/src_vba/UDF_ArcRho.bas:190-217`).
- Output cache naming is shared/length-scoped via
  `build_length_scoped_dataset_file_name` (`frontend/app_server/helpers.py:62-76`):
  `Name@<origin>@<development>@<cum|inc>@<dev|cal>.csv`.

Existing triangle bridge to mirror:

- Route: `POST /arcrho/tri` and `/arcrho/tri/refresh`, plus `/arcrho/tri/precheck`
  (`frontend/app_server/api/arcrho_router.py:64-119`).
- Service: `arcrho_runtime_service.run_arcrho_tri(...)`,
  `resolve_local_triangle_cache(...)` (`frontend/app_server/services/arcrho_runtime_service.py`).
- Schema: `ArcRhoTriRequest` (`frontend/app_server/schemas/arcrho.py:6-19`).
- Client usage pattern: `frontend/ui/shared/dataset/dataset_run_controller.js:247-345`
  (`precheckArcRhoTriCsv` → `/arcrho/tri` → load length-scoped cache).

---

## 4. Mandatory Reading Before Implementation

Per `frontend/FRONTEND_AGENT_GUIDELINES.md`, before editing the RS feature files or app_server routes/services,
read and comply with:

1. `frontend/docs/contracts/frontend_behavior_contract.md`
2. `frontend/docs/contracts/business_logic_contract.md`
3. `frontend/docs/architecture/architecture_guardrails.md`

Layering rule to preserve: router → service → schema/config. Do not put business logic in
routers. Keep `arcrho:*` message names backward compatible.

---

## 5. Backend Changes (expose vector generation)

### 5.1 Schema — `frontend/app_server/schemas/arcrho.py`

Add `ArcRhoVecRequest` mirroring `ArcRhoTriRequest`. A vector uses a single period length;
accept `PeriodLength` and map it to both origin and development internally. Keep
`InstanceName`, `DatasetTypeName`, `ProjectName`, `Path`, `Cumulative`, `Calendar`,
`Transposed`, `LocalOnly`, `AllowDerived`, `timeout_sec` consistent with the tri request.

```python
class ArcRhoVecRequest(BaseModel):
    Path: str
    ProjectName: str
    InstanceName: Optional[str] = None
    DatasetTypeName: Optional[str] = None
    VectorName: Optional[str] = None        # accepted alias for DatasetTypeName
    PeriodLength: int = 12
    Cumulative: bool = True
    Calendar: bool = False
    Transposed: bool = False
    LocalOnly: bool = False
    AllowDerived: bool = False
    timeout_sec: float = ...                 # match ArcRhoTriRequest default
```

### 5.2 Router — `frontend/app_server/api/arcrho_router.py`

Add a `_arcrho_vec_pairs(req)` builder that sets `("Function", "ArcRhoVec")` and maps
`PeriodLength` to both `OriginLength` and `DevelopmentLength` (matching the VBA contract):

```python
def _arcrho_vec_pairs(req: ArcRhoVecRequest) -> list:
    dataset_type = str(req.DatasetTypeName or req.VectorName or "").strip()
    instance_name = str(req.InstanceName or "").strip()
    pairs = [
        ("Function", "ArcRhoVec"),
        ("Path", req.Path),
        ("DatasetName", dataset_type),
    ]
    if instance_name:
        pairs.append(("InstanceName", instance_name))
    pairs.extend([
        ("Cumulative", str(req.Cumulative)),
        ("Transposed", str(False)),
        ("Calendar", str(req.Calendar)),
        ("ProjectName", req.ProjectName),
        ("OriginLength", str(req.PeriodLength)),
        ("DevelopmentLength", str(req.PeriodLength)),
    ])
    return pairs
```

Add routes mirroring the triangle ones:

- `POST /arcrho/vec/precheck` → `resolve_local_triangle_cache(...)` (the resolver is shape
  agnostic; it works on the data path/pairs). Return the same precheck shape.
- `POST /arcrho/vec` → `run_arcrho_tri(...)` (shared engine handler; no separate service
  function is required because `Function = ArcRhoVec` selects vector mode in the engine).
- `POST /arcrho/vec/refresh` → `run_arcrho_tri(..., force_refresh=True)`.

> Note: the service layer can be reused as-is because the only behavioral switch is the
> `Function` value carried in `pairs`. If a dedicated wrapper is preferred for clarity, add
> `arcrho_runtime_service.run_arcrho_vec(...)` that simply forwards to the shared
> implementation. Do not duplicate the request/wait logic.

### 5.3 Generated route docs

After adding routes, regenerate `frontend/docs/generated/app_server_routes.md` via the
docs index builder (section 8).

---

## 6. Frontend Changes — `frontend/ui/method_pages/result_selection/result_selection_main.js`

### 6.1 Identify engine sources

`cachedRows`/source records already carry `sourceKind` (`normalizeDatasetRows` at `:303`,
`buildSourceFromRecord` reads `record.sourceKind`/`existing.source_kind`). Treat a source as
engine-regeneratable when `norm(sourceKind) === "engine"`. Add a helper:

```js
function isEngineSource(source) {
  return norm(source?.sourceKind || source?.source_kind) === "engine";
}
```

Ensure `buildSourceFromRecord` (`:394`) preserves `sourceKind` on the built source object
(currently it sets `name/datasetType/dataFormat/originLength/methodType/category/...` but
not `sourceKind`). Add `sourceKind` to the built source.

### 6.2 Relax the allowed-length floor

In `allowedOriginLengthsForSources` (`:471`), exclude engine sources from `required`:

```js
function allowedOriginLengthsForSources() {
  const required = state.sources.reduce((max, source) => {
    if (isEngineSource(source)) return max;          // engine sources impose no floor
    const originLength = validSourceOriginLength(source?.originLength);
    return originLength ? Math.max(max, originLength) : max;
  }, 0);
  return VALID_ORIGIN_LENGTHS.filter((originLength) => !required || originLength >= required);
}
```

This keeps the guard for non-engine sources while letting engine sources be used at any
valid length. `syncOriginLengthOptions` (`:479`) then no longer clamps `3 → 12` for C 91.

### 6.3 Load engine sources at the RS length on demand

`buildSourceFromRecord` (`:394`) currently always reads the stored cache through
`loadDatasetValues` → `POST /dataset/cache/load` (`:357`), which returns the source's stored
length values (e.g. annual). Change the value-loading step so that when:

- `isEngineSource(source)` is true, **and**
- the source's stored `originLength` differs from the RS origin length (`getDetails().originLength`),

the editor requests a length-scoped materialization at the RS length instead of reading the
stored cache:

1. Build the request inputs: `project`, `path` (reserving class), `instanceName = source.name`,
   `datasetTypeName = source.datasetType`, `periodLength = RS originLength`,
   `cumulative = true`, `calendar = false`.
2. Triangle (`norm(source.dataFormat) === "triangle"`): call the existing tri flow
   (`precheckArcRhoTriCsv` → `/arcrho/tri`).
3. Vector: call the new `/arcrho/vec` flow added in section 5.
4. After the engine confirms the cache, load the length-scoped values. Prefer loading the
   produced cache via the same mechanism the dataset viewer uses after `/arcrho/tri`
   (length-scoped CSV). If `/dataset/cache/load` is used, it must resolve the **length-scoped**
   candidate for the RS length — see `_cached_csv_candidates`
   (`frontend/app_server/services/dataset_service.py:722`); confirm it can pick
   `Name@<rsLen>@<rsLen>@cum@dev.csv`. If it cannot, load the produced CSV path returned by
   the engine route directly.
5. Continue using existing extraction: `latestDiagonal(payload.values)` for triangles,
   `vectorValues(payload.values)` for vectors (`:374-392`). The regenerated triangle is
   quarterly, so `latestDiagonal` yields one value per quarterly origin.

Implementation notes:

- Factor the request/precheck/load sequence into a small client helper (e.g.
  `loadEngineSourceAtLength(source, rsOriginLength)`); reuse `precheckArcRhoTriCsv` /
  `buildTriRequestPayload` from the dataset client module rather than re-implementing the
  request payload. Add the vec equivalents alongside.
- Reuse the dataset loading popup/status UX pattern from
  `dataset_run_controller.js:252-345` (precheck decides whether to show the spinner). First
  open at a new length triggers an engine round-trip; subsequent opens hit the cache.
- On failure (engine cannot produce the length, timeout, or source not regeneratable), mark
  `source.unavailable = true` (as the current `catch` does at `:414-417`) and surface a
  status message; do not silently fall back to the annual cache.

### 6.4 Origin labels

Once the RS length is no longer clamped, the existing label logic uses the method JSON's
quarterly labels (`applyPayload:1678-1685`) and `shouldRejectOriginLabels` no longer rejects
them (length is `3`, not `12`). No change required beyond 6.2, but verify labels render as
40 quarterly rows after the fix.

### 6.5 Persistence

- Keep persisting the RS `origin_length` (the editor value) in the method JSON
  (`buildPayload:1620`, `:1802-1803`).
- For each source, continue persisting the source's **native** length
  (`buildPayload:1633 origin_length: source.originLength || null`). Do **not** overwrite a
  source's stored length with the RS length. The on-demand regeneration is a load-time
  concern, not a stored attribute of the source.

---

## 7. Edge Cases & Rules

1. Non-engine coarse source present (e.g. an annual `input` triangle): the floor still
   applies; the RS cannot select a finer length than that source. Document this in the RS
   manual.
2. Mixed lengths among engine sources: each engine source is independently materialized at
   the RS length; no cross-source alignment beyond shared origin labels.
3. Engine source that lacks monthly detail (engine returns error/timeout): treat as
   unavailable for the chosen length; show a clear message and keep the cell blank.
4. Changing the RS length in the UI after load must re-run the on-demand load for engine
   sources whose stored length ≠ the new RS length (hook into the existing originLength
   change handler that already calls `refreshOriginLabels`/re-renders).
5. Do not modify any source sidecar or the source's stored cache. Verify after a run that
   the source `@12@12` cache and sidecar are unchanged and a new `@<rsLen>@<rsLen>` cache
   exists.
6. Keep `cumulative=True, calendar=false (dev)` for regenerated sources to match the grid's
   current latest-diagonal reading.

---

## 8. Documentation & Release Obligations (frontend/FRONTEND_AGENT_GUIDELINES.md)

1. Update the RS module doc under `frontend/docs/ui/result_selection.md` (behavior: engine
   sources accepted at any length; on-demand materialization; sidecars untouched).
2. Update `frontend/docs/app_server/domains/arcrho.md` for the new `/arcrho/vec*` routes.
3. State contract impact explicitly in the PR (behavior change to RS origin-length rule).
4. Add a release fragment under `frontend/changes/unreleased/` (read
   `frontend/changes/README.md` first). Suggested:

   ```json
   {
     "type": "improvement",
     "scope": "result_selection",
     "audience": "user",
     "summary": "Result Selection now accepts engine-generated sources at any origin length, generating the needed length on demand.",
     "details": [
       "Engine-generated triangle/vector sources no longer force the Result Selection origin length up to their stored length.",
       "Sources are materialized at the selected length via the data engine; their stored caches and sidecars are left unchanged."
     ]
   }
   ```

5. Run `python tools/docs_index_builder.py --write` then `--check`; fix docs until `--check`
   passes. Run `python build/release_notes.py check` for the fragment.

---

## 9. Test Plan

Backend:

- Unit test `_arcrho_vec_pairs` builds `Function = ArcRhoVec` and maps `PeriodLength` to both
  `OriginLength` and `DevelopmentLength`.
- Route smoke test for `/arcrho/vec/precheck` and `/arcrho/vec` (mock the engine request/wait
  layer; assert length-scoped data path and `ds_id`).

Frontend / integration (manual against `NJ_Annual_Prod_2026 Q2-May`, RC
`PRNJ - PA\PA\NY\Direct Group\MP+PIP`):

- Open `C 91 -  Current Qtr Indicated`. Expect Origin Length = `3`, 40 quarterly rows
  (`2017 Q1 … 2026 Q4`).
- Verify `Claim Counts--CWP` and `Claim Counts--Reported ex CWOP` columns are populated at
  quarterly granularity (engine-materialized at length 3).
- Verify on disk: `sidecars/Claim Counts--CWP.json` still `origin_length = 12`; a new
  `datasets/Claim Counts--CWP@3@3@cum@dev.csv` exists; the `@12@12` cache is unchanged.
- Switch Origin Length to `12` and back to `3`; confirm sources reload correctly each time.
- Regression: an RS whose coarse source is **non-engine** still cannot be set finer than that
  source (dropdown floor preserved).

---

## 10. File Touch List

- `frontend/app_server/schemas/arcrho.py` — add `ArcRhoVecRequest`.
- `frontend/app_server/api/arcrho_router.py` — add `_arcrho_vec_pairs` + `/arcrho/vec`,
  `/arcrho/vec/refresh`, `/arcrho/vec/precheck`.
- `frontend/app_server/services/arcrho_runtime_service.py` — optional thin
  `run_arcrho_vec` wrapper (only if a named wrapper is preferred; otherwise reuse
  `run_arcrho_tri` with vec pairs).
- `frontend/ui/method_pages/result_selection/result_selection_main.js` — `isEngineSource`,
  relax `allowedOriginLengthsForSources`, on-demand engine-source loading, preserve
  `sourceKind` in `buildSourceFromRecord`.
- Dataset client module that exports `precheckArcRhoTriCsv` / `buildTriRequestPayload`
  (imported by `dataset_run_controller.js`) — add vec equivalents
  (`precheckArcRhoVecCsv` / `buildVecRequestPayload`) for reuse.
- `frontend/docs/ui/result_selection.md`, `frontend/docs/app_server/domains/arcrho.md`,
  `frontend/docs/generated/app_server_routes.md` — docs.
- `frontend/changes/unreleased/<fragment>.json` — release fragment.

---

## 11. Out of Scope

- Migration script (`python-api/migration/...`) — already exports correct `origin_length`.
- ResQ writes — none.
- Non-engine source regeneration — explicitly excluded; existing floor preserved.
