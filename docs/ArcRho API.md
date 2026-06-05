# ArcRho Python API Plan

## Goal

Create a first-party Python package that lets users script ArcRho project and DFM workflows directly against an ArcRho Server root folder. The package should make common read/write operations reliable, discoverable, and consistent with ArcRho GUI terminology while still feeling natural to Python users.

The API should not duplicate the desktop UI or FastAPI app-server. It should expose the same project files, method files, dataset outputs, and naming rules through a stable Python interface that can be used from notebooks, scripts, automation jobs, and future ArcRho tools.

## References

Reference review status: completed on 2026-05-15 for the planning pass. The CHM was decompiled to searchable HTML under `C:\tmp\resq_help_manual_extracted`; the production notebooks and legacy module were parsed for common class, function, and call patterns.

- `C:\Users\xwei\Documents\resq_help_manual.chm`
  - Use this as a conceptual reference for object hierarchy and scripting workflows.
  - Do not copy misleading names or argument conventions when ArcRho can provide clearer Python names.
- `F:\NewJersey\XWei\ResQ\ResQToolBox2.py`
  - Use this as a prior scripting example and migration reference.
  - Treat it as illustrative, not as a structure to preserve.
- Production reserve-review notebooks:
  - `E:\ResQ\Automations\Reserve Review\2026Q1\2026Q1 COL.ipynb`
  - `E:\ResQ\Automations\Reserve Review\2026Q1\2026Q1 HOL.ipynb`
  - `E:\ResQ\Automations\Reserve Review\2026Q1\2026Q1 CMPxCAT.ipynb`
  - Use these as high-priority references for the most common production project and DFM object workflows.
  - Use them to identify migration pain points, common call patterns, required convenience methods, and naming conventions that users already recognize.
  - Do not let the notebooks force the new package to preserve weaker legacy practices when a clearer, safer, or more Pythonic API would reduce long-term maintenance cost.
- Existing ArcRho repo behavior:
  - `frontend/app_server/config.py` for server-root and project path conventions.
  - `frontend/app_server/services/dfm_method_index_service.py` for DFM method filename and index conventions.
  - `frontend/docs/ui/dfm.md` and `frontend/docs/ui/dfm_json_format.md` for current DFM JSON behavior.
  - `README.md` for user-facing ArcRho terminology and Excel function vocabulary.

## Reference Review Findings

### ResQ Help Manual Concepts To Preserve

The ResQ COM/Scripting API is organized around an object hierarchy:

```text
Application
  Projects
    Project
      ReservingClasses
        ReservingClass
          Triangles
          Vectors
          Methods / DFM methods
```

Important concepts to carry into ArcRho:

1. A project is the main container; a reserving class path scopes datasets and methods.
2. A method belongs to a reserving class and exposes input/output dataset links.
3. DFM method concepts map cleanly to ArcRho GUI tabs:
   - Details: `InputTriangle`, `OutputVector`, method name, lengths.
   - Ratios: included/excluded ratios, selected ratio averages, selected ratio values, average ratio values.
   - Results: ultimates and ultimate triangles.
   - Notes: method notes and cell/tab notes.
4. ResQ's own help repeatedly recommends accessing methods through reserving-class or dataset context instead of relying on broad project-level method collections. ArcRho should follow that scoping model.
5. ResQ's `AddMethod` / `GetDFMMethod` ideas are useful, but ArcRho should expose clearer Python names such as `new_dfm`, `dfm`, `list_dfm_methods`, and `save`.

### Legacy `ResQToolBox2.py` Patterns

The legacy module wraps the ResQ COM layer with these important objects:

- `Project`
- `Reserving_Class`
- `Triangle`
- `Vector`
- `DFM`
- `BF_Method`
- `Cape_Code_Method`
- `Result_Selection`

The production-relevant DFM surface is much richer than simple JSON load/save. Common legacy DFM methods include:

- Navigation and inspection: `view`, `prior`, `view_prior`, `plot_diagnostics`, `plot_ultimates`, `quick_preview`.
- Reset and notes: `clear`, `add_notes`, `clear_notes`.
- Ratio exclusions: `ex_hi`, `ex_lo`, `ex_LDF`, `ex_row`, `ex_AY`, `ex_COVID_AY`, `ex_diagonal`, `include_all_ratios`.
- Average selection: `set_selected_estimate`, `set_user_value`, `set_custom_averages`.
- Pattern copying: `set_ratio_patterns`, `set_average_formula_patterns`.
- Tail workflows: `set_tail_value`.
- High-level adjustment workflows should live as editable app macros under `Documents\ArcRho\scripts`.
- Save workflow: `save`.

The new package should not reproduce COM internals, Excel preview logic, or plotting behavior in phase one. It should, however, provide enough DFM editing primitives to migrate the common reserve-review scripts without forcing users to hand-edit raw JSON matrices.

### Production Notebook Patterns

The three 2026Q1 production notebooks use a shared style:

1. Set project and reserving-class context once near the top.
2. Work by method name through short calls such as `DFM("...")`, `Vector("...")`, `BF_Method("...")`, and `Result_Selection("...")`.
3. Repeatedly run this pattern:

```python
dfm = DFM("Method Name")
dfm.clear()
dfm.ex_COVID_AY()
dfm.select_low(...)
dfm.set_selected_estimate(...)
# Run the app macro "Apply Growth Adjustments" when adjustment logic is needed.
dfm.save()
dfm.view()
```

Observed production usage in the reviewed notebooks:

| Notebook | DFM calls | Vector calls | Triangle calls | BF calls | Result Selection calls | Notable patterns |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| `2026Q1 COL.ipynb` | 35 | 22 | 0 | 4 | 14 | selected averages, exclusions, BF prior vectors, result selections |
| `2026Q1 HOL.ipynb` | 45 | 16 | 9 | 6 | 17 | tail-value overrides, copied average patterns, imported Excel triangle values |
| `2026Q1 CMPxCAT.ipynb` | 36 | 14 | 0 | 3 | 12 | COVID/latest-diagonal exclusions, selected averages, Cape Cod/BF support |

Migration implications:

1. Users need a concise context-bound access style. The main API should support explicit scoping, while migration helpers can offer a shorter session style.
2. DFM operations should be named clearly but should map back to familiar verbs:
   - `clear`
   - `exclude_high` / `exclude_low`
   - `exclude_origin_year`
   - `exclude_covid_years`
   - `select_high` / `select_low`
   - `set_selected_average`
   - `set_user_ratio`
   - `copy_average_formula_patterns`
   - `set_tail_value`
   - `save`
3. The API should let users work by method name within a scoped reserving class, because most production scripts assume the project and reserving class are already selected.
4. `view`, plotting, BF, Cape Cod, Result Selection, and full Vector/Triangle editing are important migration areas, but they can follow after the phase-one project/DFM package if the first API leaves clear extension points.

## Design Principles

1. Use ArcRho GUI terms for domain objects: `Project`, `Reserving Class`, `Dataset`, `DFM`, `Method`, `Input Triangle`, `Output Vector`, `Origin Length`, and `Development Length`.
2. Use Python naming conventions for the package surface: `snake_case` methods, `PascalCase` classes, typed dataclasses where useful, and explicit keyword arguments for optional behavior.
3. Keep filesystem writes safe:
   - Validate project names and paths before writing.
   - Use atomic writes for JSON updates.
   - Preserve unknown JSON fields unless the method intentionally replaces a full object.
   - Prefer dry-run or preview helpers for destructive actions.
4. Treat migration difficulty as a first-class design input:
   - Study production notebook workflows before finalizing method names and helper coverage.
   - Provide a practical migration path for common ResQ/legacy automation patterns.
   - Prefer compatibility helpers, examples, or adapters over compromising the main API design.
5. Treat existing ArcRho files as the source of truth. The API should read current server-root folders and JSON files rather than maintaining a separate database.
6. Keep phase-one scope narrow: project discovery/settings and DFM method read/write only.

## Proposed Package Shape

```text
python-api/
  pyproject.toml
  README.md
  src/
    arcrho_api/
      __init__.py
      client.py
      project.py
      reserving_class.py
      dfm.py
      paths.py
      models.py
      exceptions.py
      io.py
      migration.py
      docs/
  tests/
```

Approved package location: top-level `python-api/`. The package should be independent enough to become a public Python package rather than being embedded inside `frontend/` or `data-engine/`.

Primary import:

```python
from arcrho_api import ArcRhoClient

client = ArcRhoClient(r"E:\ArcRho Server")
project = client.project("Current Reserve Review")
reserving_class = project.reserving_class("Auto\\Private Passenger")
dfm = reserving_class.dfm("Paid Loss Ultimate")
```

Release packaging:

- `python-api/tools/build_wheel.py` builds a standard pure-Python wheel with only the Python standard library.
- `frontend/package.json` runs that wheel build before Electron packaging and ships the result under app resources as `python_packages/`.
- `frontend/build/server.spec` includes `arcrho_api` in the frozen app server so the ArcRho scripting console can import it in packaged installs.
- External user notebooks should install from the shipped wheel with `python -m pip install <wheel path>`; the ArcRho installer should not silently modify an arbitrary global Python environment.

## Core Object Model

### `ArcRhoClient`

Represents one ArcRho Server root.

Responsibilities:

- Validate the server-root structure.
- Resolve standard folders such as `projects`, `requests`, and project-specific `methods`.
- List projects.
- Open a `Project` object by name.
- Provide package-level configuration such as read-only mode, atomic-write behavior, and strict validation.

Candidate methods:

```python
client.list_projects() -> list[str]
client.project(name: str) -> Project
client.project_exists(name: str) -> bool
client.resolve_project_path(name: str) -> Path
```

### `Project`

Represents one project folder under `<server_root>\projects`.

Responsibilities:

- Read project metadata and settings.
- Resolve project subfolders such as `data`, `methods`, `users`, and settings files.
- List DFM methods.
- Open, create, save, and delete DFM method objects.

Candidate methods:

```python
project.settings() -> ProjectSettings
project.reload_settings() -> ProjectSettings
project.reserving_class(path: str) -> ReservingClass
project.list_dfm_methods(refresh: bool = False) -> list[DfmMethodRef]
project.dfm(reserving_class: str, name: str) -> DfmMethod  # convenience wrapper
project.new_dfm(reserving_class: str, name: str, **details) -> DfmMethod  # convenience wrapper
project.dfm_exists(reserving_class: str, name: str) -> bool
project.rebuild_dfm_index() -> list[DfmMethodRef]
```

### `ReservingClass`

Represents one reserving-class path inside a project.

Responsibilities:

- Provide context-bound access to project objects.
- Keep method and dataset calls scoped to one reserving-class path.
- Make migration from `set_project(...)` / `set_reserving_class(...)` scripts straightforward without relying on global state in the main API.

Candidate methods:

```python
reserving_class.dfm(name: str) -> DfmMethod
reserving_class.new_dfm(name: str, **details) -> DfmMethod
reserving_class.dfm_exists(name: str) -> bool
reserving_class.list_dfm_methods(refresh: bool = False) -> list[DfmMethodRef]
```

### `DfmMethod`

Represents one DFM method JSON file:

```text
<server_root>\projects\<project>\data\<ReservingClassFolder>\DFM@<Name>.json
```

Responsibilities:

- Load and validate the current grouped DFM JSON shape.
- Expose common Details, Ratios, Results, and Notes fields through typed properties.
- Preserve unsupported or future JSON fields during round-trip saves.
- Save updates using the same filename and JSON conventions as the GUI.

Candidate properties:

```python
dfm.project_name
dfm.reserving_class
dfm.name
dfm.output_vector
dfm.input_triangle
dfm.origin_length
dfm.development_length
dfm.decimal_places
dfm.notes
dfm.last_modified
```

Candidate methods:

```python
dfm.load() -> DfmMethod
dfm.save() -> Path
dfm.to_dict() -> dict
dfm.update_details(**fields) -> DfmMethod
dfm.update_notes(text: str) -> DfmMethod
dfm.selected_average_formulas() -> dict
dfm.set_ratio_exclusions(matrix: list[list[bool | int]]) -> DfmMethod
dfm.results_dataframe() -> pandas.DataFrame
```

Phase-one DFM editing helpers should cover the most common production script operations:

```python
dfm.clear() -> DfmMethod
dfm.add_notes(text: str, *, append: bool = True) -> DfmMethod
dfm.clear_notes() -> DfmMethod
dfm.exclude_high(dev_period: int, count: int = 1, reason: str = "") -> DfmMethod
dfm.exclude_low(dev_period: int, count: int = 1, reason: str = "") -> DfmMethod
dfm.exclude_origin_year(origin_year: int, reason: str = "") -> DfmMethod
dfm.exclude_covid_years(years: Iterable[int] | None = None) -> DfmMethod
dfm.select_high(dev_period: int, count: int = 1, reason: str = "") -> DfmMethod
dfm.select_low(dev_period: int, count: int = 1, reason: str = "") -> DfmMethod
dfm.set_selected_average(label: str, dev_periods: int | Iterable[int] | str = "all") -> DfmMethod
dfm.set_user_ratio(value: float, dev_period: int, row_index: int | None = None) -> DfmMethod
dfm.copy_average_formula_patterns(source: DfmMethod) -> DfmMethod
dfm.set_tail_value(dev_period: int, values: Iterable[float], *, years: int | None = None, exclude: str | None = None) -> DfmMethod
```

These helpers should operate on ArcRho's grouped DFM JSON, not on ResQ COM objects.

### Migration Session Helper

The main API should stay explicit and object-scoped. A small optional migration helper can reduce notebook migration effort:

```python
from arcrho_api.migration import ArcRhoSession

session = ArcRhoSession(r"E:\ArcRho Server")
session.set_project("Current Reserve Review")
session.set_reserving_class("Auto\\Private Passenger")

dfm = session.DFM("Paid Loss Ultimate")
dfm.clear().set_selected_average("Simple - 3").save()
```

This helper should be documented as a migration convenience, not as the preferred long-term API.

## Phase One Scope

Phase one should implement only project and DFM-related functionality.

Included:

1. Package initialization and local import support.
2. Server-root validation.
3. Project listing and project opening.
4. Project settings read access for fields needed by DFM workflows.
5. Reserving-class scoped object access.
6. DFM method discovery from the `methods` folder.
7. DFM filename sanitization consistent with the current GUI/app-server rules.
8. DFM method JSON load, inspect, edit, and save.
9. DFM editing helpers for the common production operations listed above.
10. DFM method index rebuild/read support.
11. A compact exception model with clear error messages for missing projects, invalid DFM JSON, locked files, and validation failures.
12. Migration-oriented examples based on the production reserve-review notebooks' most common project and DFM workflows.
13. User-facing HTML examples.
14. Agent-facing Markdown reference.

Excluded from phase one:

1. Full dataset generation.
2. Full Excel add-in parity.
3. RPC bridge request orchestration.
4. Project creation/deletion.
5. GUI automation and Excel workbook preview/view behavior.
6. BF, Cape Cod, Result Selection, and full Vector/Triangle editing APIs.
7. Backward migration for old DFM JSON shapes unless a real current file requires it.

## API Behavior Details

### Path Resolution

The client accepts an explicit server root for one-off use:

```python
ArcRhoClient(r"E:\ArcRho Server")
```

The public module also resolves a default server root from the ArcRho host app config file at `%APPDATA%\ArcRho\workspace_paths.json`. The API does not scan drives or maintain a separate Python-only default.

Users can inspect or persist the default root:

```python
from arcrho_api import ArcRhoClient, get_server_root, set_server_root

set_server_root(r"E:\ArcRho Server")
client = ArcRhoClient()
```

The client should be read/write by default, but writes must be explicit. In-memory mutations such as `dfm.clear()` or `dfm.set_selected_average(...)` should not touch disk until `dfm.save()` is called.

Read-only audit mode should be available:

```python
ArcRhoClient(r"E:\ArcRho Server", read_only=True)
```

In `read_only=True`, save and destructive write operations should raise a clear package-specific error.

### DFM Filename Rules

Use the current local DFM method identity:

```text
data\<ReservingClassFolder>\DFM@<Name>.json
```

Where:

- `Project` is represented by the containing project folder.
- `ReservingClassFolder` is a single sanitized folder name under `data`; Windows-invalid filename characters and path separators are replaced with `^`.
- `Name` is the method identity within a project/reserving-class pair.
- `Origin Length`, `Development Length`, and `Input Triangle` are saved method details, not filename identity fields.
- ArcRhoTri dataset CSV files use the same reserving-class folder and are saved as `data\<ReservingClassFolder>\<DatasetName>.csv`.

### DFM JSON Rules

Use the current grouped shape:

```text
json format = arcrho-dfm-method-by-tab-v1
details tab
data tab
ratios tab
results tab
notes tab
method metadata
```

The API should expose convenient properties but keep `to_dict()` and raw-section access available for advanced users.

When saving:

- Update `method metadata.last modified`.
- Preserve unknown keys.
- Write UTF-8 JSON with deterministic formatting.
- Use a temporary file followed by atomic replace.
- Rebuild or update the reserving-class folder's `method_index.json` when method identity or output dataset association changes, or when a new method is saved.

## Documentation Deliverables

### User-Facing HTML

Create or update a user-facing HTML guide with:

1. Install/import instructions.
2. Basic connection example.
3. List projects example.
4. Open a project and list DFM methods.
5. Read DFM Details and Notes.
6. Update DFM Notes.
7. Create a new DFM method from a minimal template.
8. Save changes and rebuild the DFM index.
9. Migrate representative reserve-review notebook snippets:
   - `DFM(...).clear().set_selected_estimate(...).save()`, with high-level adjustment recipes handled by app macros.
   - high/low ratio exclusions.
   - copied average-formula patterns.
   - tail-value overrides.
   - notes updates.

The examples should use realistic ArcRho terms and avoid internal implementation jargon unless needed.

### Agent-Facing Markdown

Create or update a Markdown reference for AI agents with:

1. Package layout and ownership.
2. Public API contracts.
3. DFM JSON schema notes.
4. Filename/path rules.
5. Safe-write requirements.
6. Testing commands.
7. Known out-of-scope areas.

This document should be concise enough for agents to read before editing the package.

## Testing Plan

Add focused tests using temporary ArcRho Server fixtures.

Minimum tests:

1. Client validates a server root with `projects`.
2. Project listing handles normal, empty, and missing folders.
3. DFM filename sanitization matches current app-server behavior.
4. DFM method discovery ignores non-DFM files.
5. DFM JSON loads grouped `arcrho-dfm-method-by-tab-v1` payloads.
6. Updating details preserves unrelated JSON fields.
7. Saving writes atomically and updates `last modified`.
8. Rebuilding `method_index.json` produces sorted `{dataset_name, method_type}` entries in each reserving-class folder.
9. Missing project and malformed JSON raise package-specific exceptions.
10. Production-style DFM helper calls update the expected grouped JSON sections without dropping unrelated fields.
11. Migration session helper can scope project/reserving class and open `DFM(name)` without global process state.

## Acceptance Criteria

Phase one is complete when:

1. A user can install/import the package locally and create `ArcRhoClient(server_root)`.
2. The user can list projects and open a project.
3. The user can list DFM methods for a project.
4. The user can load a DFM method, inspect common Details fields and Notes, update a supported field, and save it.
5. Saves preserve existing DFM JSON content not explicitly changed by the API.
6. DFM method filenames and index entries match current GUI/app-server conventions.
7. Common production DFM operations from the reviewed notebooks have direct helpers or documented migration examples.
8. User-facing HTML examples and agent-facing Markdown reference are present.
9. Phase-one tests pass.

## Open Decisions

Resolved decisions:

1. Package location: top-level `python-api/`.
2. Write behavior: read/write by default, with explicit `.save()` required for disk writes and `read_only=True` supported for audit/exploration workflows.
3. Dependency policy: keep the core package standard-library only; expose dataframe helpers through an optional `pandas` extra.
4. DFM creation template: `project.new_dfm(...)` should create the current grouped GUI JSON shape, `arcrho-dfm-method-by-tab-v1`, with required details for reserving class, name, output vector, input triangle, origin length, and development length.

Remaining open decisions:

None for phase-one planning.
