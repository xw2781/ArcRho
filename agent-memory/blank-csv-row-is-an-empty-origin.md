---
name: blank-csv-row-is-an-empty-origin
description: "An empty line in an ArcRho dataset CSV is an origin with no value; pandas drops it by default, which is what produced \"returned 39 values; expected 40\" — every dataset read now goes through helpers.read_dataset_csv"
metadata:
  type: project
---

Every dataset-cache CSV writer emits an **empty line** for a `None` — see
`dfm_service._csv_text`. A method output whose newest origin has no ultimate
yet therefore ends on a blank line, and that line is data: it is the origin,
holding nothing.

`pandas.read_csv` defaults to `skip_blank_lines=True`, so each reader silently
returned one row fewer per empty origin. In `NJ_Annual_Prod_2026 Q3-Aug` the
quarterly `F 23 - Incurred DFM w/ Selected LDFs@3.csv` holds 40 rows with the
40th blank; every reader saw 39, and `F 91 - Current Qtr Indicated` refused to
refresh with *"Source '…' returned 39 values; expected 40"*. A blank row in the
**middle** was worse: it shifted every row after it with no error at all.

**Fix (2026-09-15, Engine + Gateway deployed):** `app_server.helpers.read_dataset_csv`
owns the read — `header=None`, `float_precision="round_trip"`,
`skip_blank_lines=False` — and all eleven dataset-CSV reads call it (DFM, BF,
Cape Cod, Bootstrap, Berquist-Sherman, Result Selection, calculated datasets,
dataset service, runtime roll-up). `skip_blank_lines=False` is a no-op on a
file with no blank rows and never invents a row from the final newline.

**How to apply:**
- Never write a bare `pd.read_csv` for a dataset cache CSV; call the helper and
  pass only `dtype`/`keep_default_na` as overrides. Source-table reads (data
  processing, field mapping, table summary) are a different contract and keep
  their own calls.
- "returned N values; expected N+1" means empty origins, not a broken method.
  Compare the file's newline count with what pandas reads to confirm.

Related: [[pandas-read-csv-not-round-trip]], [[origin-length-is-not-row-count]],
[[refresh-problem-diagnosis-logs]], [[hosted-save-fix-needs-engine-deploy]]
