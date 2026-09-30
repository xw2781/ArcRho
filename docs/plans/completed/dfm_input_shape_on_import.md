# A quarterly DFM reads its input at its own shape

Status: Closed 2026-09-30. Cause found and fixed in the source; the app release and the Bridge, Engine and Gateway redeploy are planned before the next quarter's reserve review, and the MA Direct Group re-import after that will show whether the twelve refusals are gone.
Last updated: 2026-09-30
Related: [completed/manual_input_period_rollup.md](manual_input_period_rollup.md) (the roll-up rules for hand-entered datasets), [../reference/resq_stored_and_display_lengths.md](../../reference/resq_stored_and_display_lengths.md)

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

## Root cause (reproduced 2026-09-30)

The Fake project (`NJ_Annual_Prod_202605_Fake`, class `PRNJ - PA\PA\MA\Direct Group\BI Total`) has the same quarterly `C 12 - CWP DFM w/ Selected LDFs` over the Engine dataset `Claim Counts--CWP`, and loading its input failed with the same message.

- The project's origins run 2017 Q1 to 2026 Q4, which is 40 quarters. Its Development End Date is 2026-05, which allows 38 development columns.
- The Engine writes a triangle as wide as it has origins, so the quarterly file has **40 columns**; the last two are blank in every row (the first row holds 38 values). The method's saved development labels, written from the valuation date, number **38**.
- The loader took the file's raw width, 40, and compared it with 38. The check refused a file that holds exactly the data the method expects, plus blank padding.

A yearly method never trips it, because a year-long axis has as many columns as origins (10 and 10). Any monthly or quarterly axis whose origins end more than one period past the Development End Date does. Neither the labels nor the Engine's geometry were wrong.

## How a DFM reads its input

`frontend/app_server/services/dfm_service.py`, `_load_source_snapshot`, called from the refresh with the method's own `origin_length`, `development_length` and its saved `development_labels`:

1. It reads the input's sidecar and takes the pair the dataset is **stored** at (`stored_origin_length`, `stored_development_length`). For an Engine-generated dataset that pair is the source table's granularity (monthly in this project), never the shape of the file it names; for a hand-entered one it is the shape of the file.
2. When the stored pair differs from the method's pair:
   - an **Engine-generated** input is rebuilt at the method's lengths (`precedent_cache_service.materialize_engine_source`, one `ArcRhoTri` request with the method's `OriginLength` and `DevelopmentLength`), and the method reads that fresh file;
   - a **hand-entered** input is read from its own file and rolled up in memory to the method's lengths;
   - anything else is refused with `incompatible origin period length` or `incompatible development period length`.
3. When the pairs match, it reads the file the sidecar names as it is.
4. It then compares the file's width with the number of development labels the method saved and refuses with `has incompatible development geometry` when they differ. After the fix, blank columns to the right of the last label are dropped first, so only a file that holds values beyond the method's labels, or fewer columns than labels, is refused.

The import side (`server-components/src/arcrho_engine/source_table_refresh.py`, `_regeneration_request`) regenerates each Engine dataset at the shape its sidecar **displays** (12/12 in these classes) onto the same cache file, and the sidecar write keeps `stored_*` at the source granularity. A quarterly DFM therefore always goes through step 2 and asks the Engine for a quarterly copy.

## Required behaviour

Three rules, agreed 2026-09-18:

1. **A quarterly DFM always looks for its input at the same quarterly shape.** The method's own origin and length settings decide what it reads, and the shape the dataset window happens to display the input at never enters the method's read. Already true: the loader rebuilds the input at the method's lengths (step 2 above).
2. **An Engine-generated triangle is never refused for its shape.** Met by the 2026-09-30 fix: the padding the Engine adds past the valuation date is dropped, and the method keeps its own labels. A file that holds values past the labels is still refused, because that is a real disagreement.
3. **A hand-entered triangle is never touched by the import and refresh job.** Already true: the job regenerates only instances whose source kind is `engine` (`source_table_refresh.py`, the instance listing), and a coarser method rolls a hand-entered input up in memory from its own file.

## Done

- The loader drops blank columns past the method's last label before comparing widths (`_load_source_snapshot` in `frontend/app_server/services/dfm_service.py`).
- A test in `frontend/tests/test_dfm_service.py` covers a padded file (accepted) and a file with a value past the labels (still refused). It fails without the fix.
- Reproduced and checked against the Fake project: `Claim Counts--CWP` at 3/3 now loads as 40 origins by 38 development columns.

## Left for the release (archived 2026-09-30)

- Ship the desktop app and redeploy the Engine, Bridge and Gateway (method refreshes run on the Engine's bundled app server copy); both are planned before the next quarter's reserve review.
- Re-run the import for the MA Direct Group classes with all dataset types, then check that the twelve refusals are gone. Any refusal that remains is a different cause.
- BF, Cape Cod and Result Selection read their DFM and input files through their own code and have no such width check; nothing to change there unless the re-import shows otherwise.
