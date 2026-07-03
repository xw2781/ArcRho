# Dataset Scenario Matrix

## Purpose
This note defines how dataset type metadata, dataset instances, and cache rebuild behavior should be categorized. It is intended to keep the frontend app, app server, Excel add-in, and data engine aligned on the same dataset rules.

## Scenario Matrix

| Scenario | Canonical `source_kind` | Instances Per Dataset Type | Editable Cells | Calculated | Engine Request | Cache Rebuild / Clear Behavior | Primary Rebuild Trigger | Storage |
| --- | --- | ---: | --- | --- | --- | --- | --- | --- |
| Pure data-engine dataset | `engine` | 1 | No | No | Yes | Existing cache may be reused. Force refresh / `removeData=True` may delete the matching CSV and request a fresh engine output. | User run, Excel formula refresh, frontend force refresh | `data/<ReservingClass>/datasets/*.csv` plus `sidecars/*.json` |
| Calculated from only generated/rebuildable components | `calculated` | 1 | No | Yes | Yes, allowed when the engine can resolve every formula dependency | Treat as generated-class for refresh purposes. Force refresh / `removeData=True` may clear the matching CSV and request a fresh output, or the app may recalculate eagerly after a component rebuild. | Direct request, component engine output save, or explicit recalculation | `data/<ReservingClass>/datasets/*.csv` plus `sidecars/*.json` |
| Calculated from any manual/imported component | `calculated` | 1 | No | Yes | No | Treat as non-generated-class for cache-clearing purposes. Do not delete because of Excel `removeData=True`; recalculate eagerly when editable/imported components change. | Component save/import or explicit recalculation | `data/<ReservingClass>/datasets/*.csv` plus `sidecars/*.json` |
| Manual user-entered dataset | `input` | Many allowed | Yes | No | No | Never cleared by data-engine refresh or Excel `removeData=True`. Users can paste/edit values. | User save / paste | `data/<ReservingClass>/datasets/*.csv` plus `sidecars/*.json` |
| Imported dataset | `import` | Many allowed unless a type explicitly opts into single-instance | Usually no after import; optionally editable if the import flow marks it editable | No | No | Never cleared by data-engine refresh or Excel `removeData=True`. Replaced only by an import action or an explicit user save if editable. | Import action / optional user save | `data/<ReservingClass>/datasets/*.csv` plus `sidecars/*.json` |
| Method-owned dataset output, such as DFM result data | `method` | Usually 1 per method output name | No for output cells; method settings are edited through method UI | Yes, method-calculated | No direct ArcRhoTri engine request | Rebuilt when the owning method is saved or recalculated. The dataset cache should not be manually edited. | Method save / method recalculation | `data/<ReservingClass>/datasets/*.csv`, `methods/*.json`, plus `sidecars/*.json` when needed |
| Helper cache, such as headers/project settings | `helper` | Not a dataset instance | No | No | May request engine/helper output | Not listed as a reserving-class dataset instance. May use project data-root helper cache files. | Helper request | `data/*.csv` or another helper-specific cache path |

## Derived Behavior

| Derived Behavior | Rule |
| --- | --- |
| `editable` | True only for `source_kind=input`, and optionally for imported datasets when the import flow explicitly allows user edits. False for `engine`, `calculated`, `method`, and `helper`. |
| `calculated` | True for `source_kind=calculated` or `source_kind=method`; false for `engine`, `input`, `import`, and `helper`. |
| `single_instance` | True for `engine`, `calculated`, and method-owned outputs. False for manual/imported input types unless a type-specific rule says otherwise. |
| `engine_request` | True for `source_kind=engine` and engine-backed helper caches. Also true for `source_kind=calculated` when every formula dependency is generated/rebuildable and the engine can resolve the formula. False for calculated outputs with any input/import/manual-bound dependency. |
| `generated_class` | True for `source_kind=engine`; true for `source_kind=calculated` only when every dependency is generated-class. False when any dependency is input/import/manual-bound. |
| Excel `removeData=True` clear | Allowed for generated-class engine request outputs, including calculated outputs whose dependencies are all generated/rebuildable. Never clear input/import/manual-bound datasets. |
| User can create multiple instances | Only useful for manual/imported source kinds. Generated and calculated dataset types should stay single-instance because duplicate instances would have the same deterministic result unless the type has explicit parameters. |

## Minimal JSON Categorization

Use one authoritative type-level field instead of several independent booleans:

```json
{
  "name": "Expected Net Loss % * Earned Premium",
  "source_kind": "calculated",
  "formula": "[Expected Net Loss %] * [Earned Premium]"
}
```

Recommended canonical fields:

| Field | Level | Required | Purpose |
| --- | --- | --- | --- |
| `name` | dataset type | Yes | Stable dataset type name. |
| `source_kind` | dataset type | Yes | One of `engine`, `input`, `import`, `calculated`, `method`, or `helper`. This replaces independent `Generated`, `Calculated`, and default editability flags. |
| `formula` | dataset type | Only for calculated types | Formula used to derive app-calculated outputs and dependency graph. |
| `instance_name` | dataset instance sidecar | Yes for instance metadata | User-visible instance Name. May differ from dataset type for `input`/`import`. Usually equals type name for `engine`/`calculated`. |
| `dataset_type` | dataset instance sidecar | Yes for instance metadata | Links an instance back to its dataset type rule. |
| `csv_file` | dataset instance sidecar | Yes for instance metadata | Physical cache filename for the current instance. |

Fields that should be derived instead of user-authored in `dataset_types.json`:

| Derived Field | Derive From |
| --- | --- |
| `editable` | `source_kind`, plus optional import edit policy. |
| `calculated` | `source_kind`. |
| `single_instance` | `source_kind`. |
| `generated_class` | `source_kind` plus calculated dependency graph. |
| `cache_clear_allowed` | `generated_class` and whether the output is an engine request output. |

Persisting derived values in sidecars or `index.json` is acceptable as a cache snapshot for fast UI rendering, but the source of truth should remain `source_kind`, `formula`, and the dependency graph.

## Instance Naming Rule

Dataset type name and instance name are distinct:

- `dataset_type` identifies the row in `dataset_types.json` and determines source behavior.
- `instance_name` identifies the user-visible dataset instance and physical CSV/sidecar identity.
- `engine`, `calculated`, and method output types should normally force `instance_name == dataset_type`.
- `input` and `import` types may allow multiple instance names for the same dataset type.

## Excel Add-In Lookup Rule

For `ArcRhoTri`, the Excel add-in has the full cache identity in the UDF arguments: path, triangle or instance name, origin length, development length, cumulative mode, and calendar/development mode. It should therefore build the exact current CSV cache path directly:

`data/<ReservingClass>/datasets/<InstanceName>@<OriginLength>@<DevelopmentLength>@<cum|inc>@<dev|cal>.csv`

For `ArcRhoVec`, the cache identity only needs the vector period length:

`data/<ReservingClass>/datasets/<InstanceName>@<PeriodLength>.csv`

If the triangle/instance name is not found in `dataset_types.json`, Excel should treat it as a non-generated dataset instance, load that exact CSV if it exists, and never clear it because of `removeData=True`. No legacy unsuffixed CSV fallback is required.
