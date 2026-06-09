# ArcRho API Agent Reference

## Package Scope

The package lives under `python-api/` and imports as `arcrho_api`.

Phase one covers:

- ArcRho Server root validation.
- Project listing/opening.
- Reserving-class scoped access.
- DFM method discovery, load, create, mutate, and save.
- Production DFM helper methods used by reserve-review notebooks.

Phase one does not cover full dataset generation, Excel preview automation, RPC bridge orchestration, BF/Cape Cod/Result Selection APIs, or full Vector/Triangle editing.

## Public Entry Points

```python
from arcrho_api import ArcRhoClient

client = ArcRhoClient()
project = client.project("Project Name")
rc = project.reserving_class(r"Segment\Path")
dfm = rc.dfm("Method Name")
```

`ArcRhoClient()` uses the default server root from the ArcRho host app config file: `%APPDATA%\ArcRho\workspace_paths.json`. Use `set_server_root(path)` to update that shared host config, `get_server_root()` to inspect it, or pass `ArcRhoClient(path)` for a one-off explicit root.

Legacy migration:

```python
from arcrho_api.migration import ArcRhoSession

session = ArcRhoSession()
session.set_project("Project Name")
session.set_reserving_class(r"Segment\Path")
dfm = session.DFM("Method Name")
```

## DFM JSON Contract

Only the grouped GUI shape is supported:

```text
json format = arcrho-dfm-method-by-tab-v1
details tab
data tab
ratios tab
results tab
notes tab
method metadata
```

Save behavior:

- Preserve unknown JSON fields.
- Update `method metadata.last modified`.
- Write with a temporary file and atomic replace.
- Rebuild each reserving-class folder's `index.json`.
- Refuse writes when the client is `read_only=True`.

DFM cell notes use the grouped `ratios tab.cell notes` shape keyed by visible row label, then visible development label. Use `set_cell_note(row_label, development, note)`, `clear_cell_notes_for_development(development)`, or `set_selected_average_cell_note(development, note, clear_column=True)` for average-formula notes.

User Entry formulas can store both the cached numeric value and formula text. Use `set_user_formula(formula, value, development)` to write `average formulas.values` plus aligned `average formulas.inputs` so the GUI shows the same calculated User Entry value while retaining the decomposed formula.

## Filename Rules

DFM methods are stored as:

```text
projects/<project>/data/<ReservingClassFolder>/methods/DFM@<Name>.json
```

ArcRhoTri dataset CSV files live under:

```text
projects/<project>/data/<ReservingClassFolder>/datasets/<DatasetName>.csv
```

Dataset sidecar metadata lives under:

```text
projects/<project>/data/<ReservingClassFolder>/sidecars/<DatasetName>.json
```

The reserving-class filename component uses `^` for Windows-invalid filename characters. The method-name component uses `_` for invalid filename characters.

## ArcBot Agent Helper

ArcBot should prefer one bundled inspection call for DFM read/planning work:

```powershell
python -m arcrho_api.agent --file active-method.json inspect --include summary,average-formulas
python -m arcrho_api.agent --file active-method.json inspect --include summary,average-formulas,ratio-triangle --origin 2020
```

The `inspect` command returns `DfmMethod.agent_inspect` with requested components and optional ratio rows in one JSON payload. Use edit helpers such as `exclude-ratio`, `include-ratio`, `select-average`, or `set-user-entry` only when modifying the temp file, then run `validate` after an edit. Avoid repeated `summary` or `component` reads in the same ArcBot turn.

## Testing

From repo root:

```powershell
python python-api\tools\run_with_timeout.py --timeout 115 -- python -m unittest discover -s python-api\tests
```
