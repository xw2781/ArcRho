# A quarterly DFM reads its input at its own shape

Status: Diagnosed 2026-09-18 from the `NJ_Annual_Prod_2026 Q3-Aug` import; required behaviour agreed the same day; not broken into steps and not started.
Last updated: 2026-09-18
Related: [completed/manual_input_period_rollup.md](completed/manual_input_period_rollup.md) (the roll-up rules for hand-entered datasets), [../reference/resq_stored_and_display_lengths.md](../reference/resq_stored_and_display_lengths.md)

## What happened

The Source Data import of 2026-09-18 (CSV `ResQ_Channel_202608.csv`, 357,300 rows, 34 columns) ran as four Engine jobs. The first one refreshed every dataset type in the three `PRNJ - PA\PA\MA\Direct Group` classes. Its import step and all 120 dataset regenerations succeeded, but the dependent walk that followed refused twelve Development Factor Methods in `BI Total` and `MP+PIP`, every one with the same message:

```
C 12 - CWP DFM w/ Selected LDFs: 422: DFM input 'Claim Counts--CWP' has incompatible development geometry.
C 32 - Reported DFM w/ Selected LDFs: 422: DFM input 'Claim Counts--Reported' has incompatible development geometry.
C 42 - Reported ex CWOP DFM w/ Selected LDFs: 422: DFM input 'Claim Counts--Reported ex CWOP' has incompatible development geometry.
C 52 - CWOP/Reported DFM w/ Selected LDFs: 422: DFM input 'CWOP as % of Reported Claims' has incompatible development geometry.
F 13 / F 23 (BI Total), D 13 / D 23 (MP+PIP): the same for Net Loss--Paid, Net Loss--Incurred, Gross Loss--Paid, Gross Loss--Incurred
G 22 A / G 22 B: the same for ALAE--as % of Gross/Net Paid Loss
E 21 / E 22 (MP+PIP): the same for Recoveries/as % of Gross Paid Loss
```

Everything downstream was skipped in turn: the BF methods, the calculated datasets built on the DFM outputs, and the Current Qtr Indicated and Current Qtr Selected result selections. The job's status file counts 24 methods updated across the three classes and lists 23 and 31 reasons for the two classes.

The same two classes failed the dependent walk on every whole-project import since 2026-09-01 (jobs of 2026-09-01, 2026-09-03 and 2026-09-05 all list `MA\Direct Group\BI Total` and `MP+PIP`), so the shape refusal predates the 2026-09-18 file. The last job of 2026-09-18 refreshed all 78 classes but only the six premium and exposure dataset types, so it never reached these DFMs; their last successful refresh is still older than the import.

Evidence: `E:\ArcRho Server\runtime\logs\source_table_refresh.log` (the `psrefresh_4cf3f485…` job, the per-class `dependent refresh reported errors` lines) and `E:\ArcRho Server\requests\source_table_refresh\statuses\psrefresh_4cf3f485-a6b2-481e-af75-e232849ef093.json`.

The Cape Cod refusals in the same classes (`Cape Cod precedent 'F 23 …' uses 3-month origins; expected 12`) are a neighbouring, already-known gap: a method output at one period feeding a method at another. They are out of scope here.

## How a DFM reads its input today

`frontend/app_server/services/dfm_service.py`, `_load_source_snapshot`, called from the refresh with the method's own `origin_length`, `development_length` and its saved `development_labels`:

1. It reads the input's sidecar and takes the pair the dataset is **stored** at (`stored_origin_length`, `stored_development_length`). For an Engine-generated dataset that pair is the source table's granularity (monthly in this project), never the shape of the file it names; for a hand-entered one it is the shape of the file.
2. When the stored pair differs from the method's pair:
   - an **Engine-generated** input is rebuilt at the method's lengths (`precedent_cache_service.materialize_engine_source`, one `ArcRhoTri` request with the method's `OriginLength` and `DevelopmentLength`), and the method reads that fresh file;
   - a **hand-entered** input is read from its own file and rolled up in memory to the method's lengths;
   - anything else is refused with `incompatible origin period length` or `incompatible development period length`.
3. When the pairs match, it reads the file the sidecar names as it is.
4. It then compares the file's column count with the number of development labels the method saved and refuses with `has incompatible development geometry` when they differ. This is the check that fired. It runs after step 2, so it fires even when the input was just rebuilt at the method's own shape.

The import side (`server-components/src/arcrho_engine/source_table_refresh.py`, `_regeneration_request`) regenerates each Engine dataset at the shape its sidecar **displays** (`origin_length` / `development_length`, 12/12 in these classes) onto the same cache file, and the sidecar write keeps `stored_*` at the source granularity. A quarterly DFM therefore always goes through step 2 and asks the Engine for a quarterly copy; what it then refuses is that copy's width against its own saved labels.

Why the two counts differ has not been pinned to a number: the live project's method and sidecar files may not be opened by an agent without permission for that project, and the fake project (`NJ_Annual_Prod_202605_Fake`) holds no quarterly DFM to compare against. The method's development labels were written by the ResQ import from ResQ's own view of the input (`python-api/migration/resq_migration/dfm.py`, `export_triangle(input_triangle)`), while the Engine sizes a triangle as `(Development End − Origin Start) // development_length + 1` columns from the project's General Settings, so a one-column difference between ResQ's quarterly axis and the Engine's is the first thing to check.

## Required behaviour

Three rules, agreed 2026-09-18:

1. **A quarterly DFM always looks for its input at the same quarterly shape.** The method's own origin and development lengths decide what it reads, and the shape the dataset window happens to display the input at never enters the method's read, whether the method is being opened, saved, or refreshed by an import.
2. **An Engine-generated triangle always supports being brought to the method's shape and is never refused for its shape.** The Engine can produce it at any period from the source table. A width that differs from the labels the method saved is not a reason to fail the method: the method takes the input's development axis at the requested shape (and re-derives its labels from it), rather than comparing it against a label list written at import time.
3. **A hand-entered triangle is never touched by the import and refresh job.** It is not regenerated, rewritten, or reshaped; a coarser method reads it from its own file and rolls it up in memory, as today.

## Next steps

- With permission for `NJ_Annual_Prod_2026 Q3-Aug`, read `C 12 - CWP DFM w/ Selected LDFs` and the `Claim Counts--CWP` sidecar in `PRNJ - PA\PA\MA\Direct Group\BI Total`: the method's lengths and label count, the sidecar's stored and displayed lengths, and the column count of the quarterly file the Engine builds for it. That fixes which side is one column out and whether rule 2 needs the labels re-derived or the Engine's quarterly geometry corrected.
- Decide where rule 2 lives: the DFM loader alone (drop the width check for Engine inputs and adopt the axis), or the DFM contract (labels derived from the input at every load). The BF, Cape Cod and Result Selection readers that share `precedent_cache_service` should follow the same rule for Engine inputs.
- Add a test with a quarterly DFM over an Engine input whose displayed shape is yearly, asserting that a refresh reads a quarterly copy and never fails on width, and one asserting that an import leaves a hand-entered input's file and sidecar byte-identical.
- Re-run the import for the MA Direct Group classes with all dataset types once the fix is deployed to the Engine and the Gateway (method refreshes run on the Engine's bundled app server copy).
