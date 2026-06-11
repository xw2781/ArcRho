# DFM JSON Format Notes

This note tracks recent DFM JSON format decisions so future ArcBot and DFM changes keep the saved method file, remote-sync file, and ArcBot active-context file consistent.

## Canonical DFM Method JSON

DFM method JSON now uses the GUI-tab grouped shape as the canonical save/load format. Old flat top-level method JSON is intentionally out of scope for the frontend/app-server readers.

Top-level sections:

- `json format`: currently `arcrho-dfm-method-by-tab-v1`.
- `details tab`: `name`, `output type`, `input triangle`, `origin length`, `development length`, and `decimal places`.
- `data tab`: `origin labels`, raw Data-tab `development labels` such as `2m` and `14m`, `input data triangle values`, and mode-qualified `input data triangle csv path`.
- `ratios tab`: `ratio triangle`, `average formulas`, and `cell notes`.
- `ratios tab`.`ratio triangle`: `origin labels`, GUI-display Ratios-tab `development labels` such as `(1) 2-14`, `ratio values`, and `excluded`.
- `results tab`: `ratio basis dataset`, `ultimate ratio decimal places`, and `ultimate vector`.
- `notes tab`: `notes`.
- `method metadata`: `last modified`.

Data-engine readers should read fields from these sections directly rather than expecting flat top-level keys.

The formatter writes any 2D array with one child row per JSON line.

`ratios tab`.`average formulas` is a columnar object. `label` is the persistent formula identity and row order. `selected` is the former `average index` matrix. `values` is the former `average formula values` analysis matrix. `inputs` stores User Entry formula/input text aligned with `label` and `values`; blank input rows may be omitted or empty arrays. Formula metadata arrays live under `custom average formula settings`; arrays such as `averageType`, `base`, `periods`, and `exclude` align by index with `label`.

`summary rows` and `summary order` are not part of the JSON contract. Runtime-only formula row `id` values are generated after load for DOM rows, selection maps, drag handling, and other in-session UI mechanics; `id` is not saved in DFM method JSON.

`ratios tab`.`cell notes` stores user-entered comments for Ratios-tab cells. Each table stores notes as a nested object keyed by the visible row label and visible development-column label, for example `ratio main table`.`2026`.`(1) 12-24` or `ratio summary table`.`Volume - all`.`(1) 12-24`. Empty notes are omitted. Older flat index keys such as `"0,0"` and `"rowId,0"` are still accepted on load and are migrated to label keys on the next save.

## Analysis Snapshots

Saved DFM method JSON and ArcBot context include read-analysis snapshots:

- `input data triangle values`
- `input data triangle csv path`
- `ratios tab`.`ratio triangle`.`ratio values`
- `ratios tab`.`average formulas`.`values`

Numeric snapshot values for input-data and ratio arrays are rounded to 4 decimals. `ratios tab`.`average formulas`.`values` is rounded to 6 decimals so cached User Entry formula results can still display an accurate fourth decimal in the UI. For triangle-shaped arrays, each row trims only trailing `null` values to reduce file size and token usage; internal `null` values remain in place so column position is still recoverable from the row and labels.

These analysis snapshots are ignored when restoring editable method selections. Editable restore behavior remains driven by `ratios tab`.`ratio triangle`.`excluded`, `ratios tab`.`average formulas`.`selected`, and related canonical selection fields.

`ratios tab`.`ratio triangle`.`excluded` uses the same row shape as `ratio values`: each excluded row is clipped to the corresponding ratio-value row length, so non-value columns such as the trailing Ult mask column are not persisted. RPC server sync payloads may intentionally keep `input data triangle values` and `ratio values` empty to avoid copying full triangles back to the local method. For `ratios tab`.`average formulas`.`values`, RPC server sync only needs to populate the first `User Entry` formula row with stored RPC server values; non-user formula value rows can remain empty arrays while preserving row alignment with `average formulas`.`label`.

## Average Formula Space Savings

The former `average formulas` label list, `summary rows` metadata list, `average index`, and `average formula values` are combined under one `ratios tab`.`average formulas` object. Formula metadata is grouped under `custom average formula settings` to keep identity/selection/value arrays separate from custom formula configuration, while keeping the row order explicit through `label`.

## ArcBot Active Context

ArcBot receives and edits the same canonical grouped DFM method JSON shape. The Electron host no longer flattens ArcBot edits before applying them; it validates the target path, backs up the existing JSON or active-page snapshot, and writes the grouped JSON with the shared row-compact formatter.

This keeps ArcBot, normal DFM save/load, and RPC sync on one schema.
