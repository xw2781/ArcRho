# Custom Data Processing Rules Plan

## Status

Implemented on 2026-07-16. This document records the replacement for the data
engine's special-purpose `EEX Formula` behavior and the operational migration that
must be run for legacy projects.

The implemented design is:

- Store project-specific rules in `data_processing_rules.json`.
- Let users create and maintain rules through Project Settings UI.
- Treat custom rules as row filters that run before aggregation.
- Keep normal Reserving Class `Formula` / `Source` logic responsible for `+` and `-`
  aggregation signs.
- Do not execute arbitrary project Python code.
- Reject legacy `EEX Formula` files until they are converted with the explicit
  migration tool.

This is a cross-component change involving Project Settings, app-server persistence,
data-engine processing, generated-cache validity, and existing project migration.

Implementation note: generated sidecars persist the processing configuration hash,
rules format, and rules revision. `applied_rule_ids` is intentionally not persisted
because the current file-based engine result protocol does not return matched-rule
diagnostics.

## Goals

1. Generalize the existing Earned Exposure adjustment so it can target any raw source
   measure used by a requested dataset.
2. Allow rule conditions to inspect raw source-table rows, including fields such as
   `STATE_CD`.
3. Allow the rule to depend on the reserving-class type selected in the request, such
   as level-5 `TOTAL PA`.
4. Apply different row filters to different source measures inside the same requested
   calculated dataset.
5. Preserve the normal Reserving Class Formula's positive and negative member signs.
6. Make all configuration editable and explainable through Project Settings UI.
7. Validate rules before saving and fail calculations explicitly when a stored rule
   contract is invalid.
8. Invalidate or reject stale generated caches after a rule change.

## Non-goals

- Running arbitrary Python or JavaScript from a project settings file.
- Changing source values after aggregation.
- Replacing Dataset Type formulas.
- Letting custom rules add rows that are not already included by the selected
  Reserving Class Formula.
- Letting custom rules change a normal Formula member from positive to negative or
  negative to positive.
- Applying raw-row filters retroactively to a pre-aggregated imported dataset when the
  original source rows are unavailable.
- Requiring users to edit `data_processing_rules.json` manually.

## Terminology

| Term | Meaning |
| --- | --- |
| Requested dataset type | The user-facing Dataset Type selected by ArcRho, such as `Total Earned Exposure`. |
| Source measure | An atomic source-table column required by the Dataset Type `Source`, such as `Earned_Exposure`. |
| Selected reserving-class type | A type selected in the requested reserving-class path, such as level-5 `TOTAL PA`. |
| Source row | One row from the project's raw source table before origin/development aggregation. |
| Base coefficient | The signed coefficient derived from normal Reserving Class `Source` expressions. It is normally `1`, `-1`, or `0`. |
| Custom mask | A measure-specific `0` or `1` row mask produced by `data_processing_rules.json`. |
| Final row weight | `base coefficient * custom mask` for one source measure and one source row. |

The distinction between a selected reserving-class type and a source-row condition is
important:

- `IBNRCAT == TOTAL PA` identifies the level-5 aggregate selected in the request.
  `TOTAL PA` is normally not a literal value in raw source rows.
- `STATE_CD == NJ` is evaluated against every raw source row. If the request selects
  `All States`, the adjustment still applies to its NJ rows while other states retain
  normal behavior.

## Existing Data-Engine Behavior

### Dataset and source-measure resolution

`_get_dataset_info()` currently:

1. Reads the request's `DatasetName`.
2. Looks up that Dataset Type's `Source`.
3. Parses the `Source` into `required_datasets`, which are raw source measures.
4. Reads the reserving-class fields from `field_mapping.json`.
5. Processes each selected reserving-class path segment.

This means the current EEX behavior is source-measure based. It runs when
`Earned_Exposure` is one of the required source measures, including when
`Earned_Exposure` is only one component of a larger calculated Dataset Type.

### Normal Reserving Class Formula processing

For every selected path level, the current code builds three parallel lists:

- `included_rsv_cls_types`
  - The selected reserving-class name.
  - Names found in its derived `Source`.
  - Names found in its user-authored `Formula`.
- `excluded_rsv_cls_types`
  - Members preceded by `-` in `Source` or `Formula`.
- `adjusted_rsv_cls_types`
  - Same-level names that are not listed in `EEX Formula`.

The engine then:

1. Filters the raw table to rows contained in `included_rsv_cls_types` at every
   selected hierarchy level.
2. Multiplies every numeric non-date source measure by `-1` for rows whose
   reserving-class value appears in `excluded_rsv_cls_types`.

The excluded list is therefore not a custom adjustment. It is an indirect
representation of the `-` sign in the normal Reserving Class Formula.

### Current EEX behavior

After the general row filtering and negative-member processing, the engine performs a
separate EEX step:

- It runs only when `Earned_Exposure` is required.
- It is hard-coded to level 5 / list index 4.
- It sets `Earned_Exposure` to zero for level-5 values that are not named by
  `EEX Formula`.
- It does not apply the EEX adjustment to any other source measure.

Consequently, `EEX Formula` is not a true replacement aggregation formula. It is a
measure-specific row-narrowing step applied on top of the normal Formula.

It can remove members from the normal Formula, but it cannot safely:

- Add a member that the normal Formula excluded.
- Express a new negative sign independently.
- Apply conditions using other source-row fields.
- Apply different filters to multiple source measures.
- Address a hierarchy level other than the hard-coded fifth level.

### Final aggregation

After these adjustments, the engine:

1. Groups each required source measure by origin and development period.
2. Builds a triangle or vector for each source measure.
3. Evaluates the requested Dataset Type `Source` expression across those aggregated
   source-measure results.

Custom rules must remain before step 1 so they operate on raw rows rather than already
aggregated values.

### Existing implementation weaknesses to remove

- Reserving-class names are looked up globally instead of by
  `(field, level, name)`, even though the same name may exist at different levels.
- Reserving-class field order depends on field-mapping row order instead of explicitly
  sorting and validating `Level`.
- `included_rsv_cls_types`, `excluded_rsv_cls_types`, and
  `adjusted_rsv_cls_types` can disagree because they represent related algebra through
  separate lists.
- Both `Source` and `Formula` are parsed into sets/lists, which loses expression
  structure and duplicate/cancellation information.
- `split_formula_with_ops()` is a token scanner rather than a complete additive
  expression parser.
- EEX assumes level 5 exists.
- In-place value mutation makes measure-specific behavior harder to reason about.
- A broad runtime exception currently becomes an output containing `0`, which is not
  an acceptable failure mode for an invalid processing rule.

## New Processing Model

### Core rule

Normal Reserving Class formulas define signed membership. Custom data-processing rules
only filter that membership.

The calculation is:

```text
ArcRho request
    -> resolve requested Dataset Type into source measures
    -> compile selected Reserving Class Sources into base row coefficients
    -> build an independent custom 0/1 mask for each source measure
    -> multiply raw values by base coefficient and custom mask
    -> group by origin/development period
    -> evaluate the requested Dataset Type Source expression
```

### Normal Formula coefficients

The app server already persists a recursively derived `Source` expression for each
Reserving Class Type. The engine should use that resolved expression as the canonical
input for raw member selection.

For example, the resolved level-5 source for `TOTAL PA` should compile to a map like:

```text
BI       ->  1
UMBI     ->  1
BIR51    ->  1
UMBIR51  ->  1
PD       ->  1
UMPD     ->  1
MP       ->  1
PIP      ->  1
CMP      ->  1
CMP_CAT  -> -1
COL      ->  1
```

For each selected hierarchy field, a raw row receives the coefficient assigned to its
atomic member. A member absent from the map receives `0`.

The row's base coefficient is the product of the selected hierarchy-field
coefficients:

```text
base_row_coefficient =
    level_1_coefficient
  * level_2_coefficient
  * ...
```

This single representation handles:

- Normal inclusion with coefficient `1`.
- Normal subtraction with coefficient `-1`.
- Normal exclusion with coefficient `0`.

`included_rsv_cls_types` and `excluded_rsv_cls_types` should therefore be replaced by
compiled coefficient maps. In particular, `excluded_rsv_cls_types` should not be
carried into the custom-rule design.

The additive Reserving Class compiler should:

- Resolve identities by `(field, level, canonical name)`.
- Support quoted member names, `+`, `-`, and parentheses.
- Resolve calculated Reserving Class Types to atomic source members.
- Detect cycles and unknown references.
- Inventory and reject unsupported `*` or `/` membership expressions before rollout.
- Reject or explicitly report repeated expansions that produce unsupported
  coefficients outside the agreed range.

### Custom filter masks

Each custom rule targets one source measure. For that measure:

1. Start with a custom mask of `1` for every row.
2. Select rules whose request conditions match the requested reserving-class context.
3. Evaluate each selected rule's row conditions against the raw source table.
4. Apply the rule's `keep_members` or `exclude_members` action only to rows whose row
   conditions matched.
5. Multiply the rule masks together.
6. Multiply the raw source measure by the base coefficient and resulting custom mask.

Rows whose row conditions do not match retain mask `1`, so they keep normal Formula
behavior.

All custom actions are monotonic: they can change a row from included to excluded, but
they cannot re-include a row or change its sign. Multiple applicable rules therefore
compose by intersection without priority or file-order behavior.

### Vectorized implementation shape

The engine should not mutate the cached source DataFrame. It should work from a copy of
the required date, hierarchy, rule-condition, rule-action, and source-measure columns.

Conceptually:

```python
base_weight = build_base_row_coefficients(source_rows, selected_path)

for source_measure in required_source_measures:
    custom_mask = ones_for_all_rows()

    for rule in applicable_rules(source_measure, selected_path):
        condition_mask = evaluate_row_conditions(source_rows, rule)
        action_mask = evaluate_filter_action(source_rows, rule)
        custom_mask *= where(condition_mask, action_mask, 1)

    working[source_measure] = (
        source_rows[source_measure]
        * base_weight
        * custom_mask
    )

aggregate working source measures
evaluate requested Dataset Type Source
```

Equality, membership, and numeric comparisons should use vectorized pandas operations,
not per-row Python callbacks.

## `data_processing_rules.json` Contract

### Location and ownership

The file should live at:

```text
projects/<ProjectName>/data_processing_rules.json
```

It is a project-level settings file alongside:

- `field_mapping.json`
- `dataset_types.json`
- `reserving_class_types.json`
- `general_settings.json`

The app server is the authoritative writer. The data engine is a read-only consumer.
The normal user workflow edits the rules through Project Settings UI.

The nested rule structure should remain JSON-only; it should not have an XLSX mirror.

### Proposed version-1 example

The following replaces the original fake Python examples:

```json
{
  "json_format": "arcrho-data-processing-rules-v1",
  "revision": 1,
  "updated_at": "2026-07-16T00:00:00Z",
  "updated_by": "user",
  "rules": [
    {
      "id": "earned-exposure-physd",
      "name": "Earned Exposure - PhysD keeps CMP",
      "enabled": true,
      "target": {
        "source_measure": "Earned_Exposure"
      },
      "request_conditions": {
        "all": [
          {
            "field": "IBNRCAT",
            "level": 5,
            "operator": "equals",
            "value": "PhysD"
          }
        ]
      },
      "row_conditions": {
        "all": []
      },
      "action": {
        "type": "keep_members",
        "field": "IBNRCAT",
        "level": 5,
        "members": [
          "CMP"
        ]
      }
    },
    {
      "id": "earned-exposure-bi-total",
      "name": "Earned Exposure - BI Total keeps BI",
      "enabled": true,
      "target": {
        "source_measure": "Earned_Exposure"
      },
      "request_conditions": {
        "all": [
          {
            "field": "IBNRCAT",
            "level": 5,
            "operator": "equals",
            "value": "BI Total"
          }
        ]
      },
      "row_conditions": {
        "all": []
      },
      "action": {
        "type": "keep_members",
        "field": "IBNRCAT",
        "level": 5,
        "members": [
          "BI"
        ]
      }
    },
    {
      "id": "earned-exposure-total-pa",
      "name": "Earned Exposure - TOTAL PA keeps PD",
      "enabled": true,
      "target": {
        "source_measure": "Earned_Exposure"
      },
      "request_conditions": {
        "all": [
          {
            "field": "IBNRCAT",
            "level": 5,
            "operator": "equals",
            "value": "TOTAL PA"
          }
        ]
      },
      "row_conditions": {
        "all": []
      },
      "action": {
        "type": "keep_members",
        "field": "IBNRCAT",
        "level": 5,
        "members": [
          "PD"
        ]
      }
    },
    {
      "id": "remaining-budget-exposure-total-pa",
      "name": "Remaining Budget Exposure - TOTAL PA keeps PD and UMPD",
      "enabled": true,
      "target": {
        "source_measure": "Remaining_Budget_Exposure"
      },
      "request_conditions": {
        "all": [
          {
            "field": "IBNRCAT",
            "level": 5,
            "operator": "equals",
            "value": "TOTAL PA"
          }
        ]
      },
      "row_conditions": {
        "all": []
      },
      "action": {
        "type": "keep_members",
        "field": "IBNRCAT",
        "level": 5,
        "members": [
          "PD",
          "UMPD"
        ]
      }
    },
    {
      "id": "earned-premium-nj-total-pa",
      "name": "NJ Earned Premium - TOTAL PA excludes BI and UMBI",
      "enabled": true,
      "target": {
        "source_measure": "Earned_Premium"
      },
      "request_conditions": {
        "all": [
          {
            "field": "IBNRCAT",
            "level": 5,
            "operator": "equals",
            "value": "TOTAL PA"
          }
        ]
      },
      "row_conditions": {
        "all": [
          {
            "field": "STATE_CD",
            "operator": "equals",
            "value": "NJ"
          }
        ]
      },
      "action": {
        "type": "exclude_members",
        "field": "IBNRCAT",
        "level": 5,
        "members": [
          "BI",
          "UMBI"
        ]
      }
    },
    {
      "id": "earned-premium-nj-bi-total",
      "name": "NJ Earned Premium - BI Total excludes BI and UMBI",
      "enabled": true,
      "target": {
        "source_measure": "Earned_Premium"
      },
      "request_conditions": {
        "all": [
          {
            "field": "IBNRCAT",
            "level": 5,
            "operator": "equals",
            "value": "BI Total"
          }
        ]
      },
      "row_conditions": {
        "all": [
          {
            "field": "STATE_CD",
            "operator": "equals",
            "value": "NJ"
          }
        ]
      },
      "action": {
        "type": "exclude_members",
        "field": "IBNRCAT",
        "level": 5,
        "members": [
          "BI",
          "UMBI"
        ]
      }
    }
  ]
}
```

### Contract field semantics

| Field | Semantics |
| --- | --- |
| `json_format` | Required exact schema identifier. Unsupported versions are errors. |
| `revision` | Monotonically increasing server-managed revision. |
| `updated_at`, `updated_by` | Server-managed audit metadata. |
| `rules[].id` | Stable unique identifier used by audit, diagnostics, and sidecar provenance. |
| `rules[].name` | User-facing description. |
| `rules[].enabled` | Disabled rules remain stored but do not affect calculations. |
| `target.source_measure` | Atomic raw source measure to which the custom mask applies. |
| `request_conditions` | Conditions evaluated against the selected reserving-class request context, not raw source rows. |
| `row_conditions` | Conditions evaluated independently against each raw source row. |
| `action.field` | Raw source field whose atomic values are kept or excluded. |
| `action.level` | Validation guard when the action field is a mapped reserving-class field. |
| `action.members` | Atomic raw values, without formula quotes or `+` / `-` syntax. |

Request conditions should initially support:

- `equals`
- `not_equals`
- `in`
- `not_in`

Row conditions should initially support:

- `equals`
- `not_equals`
- `in`
- `not_in`
- `is_blank`
- `is_not_blank`
- Numeric/date comparisons when the source field has a compatible type.

All conditions inside `all` use AND semantics. Cross-field OR/NOT expression trees
should be deferred until the UI can represent and explain them clearly.

### Action semantics

For a row whose `row_conditions` do not match, either action returns mask `1`.

For a row whose `row_conditions` match:

- `keep_members`
  - Mask is `1` when `row[action.field]` is in `action.members`.
  - Mask is `0` otherwise.
- `exclude_members`
  - Mask is `0` when `row[action.field]` is in `action.members`.
  - Mask is `1` otherwise.

The action is applied only to `target.source_measure`.

`action.members` must resolve to rows already present in the selected normal
Reserving Class Source. A custom rule cannot add a row whose base coefficient is zero.

The Earned Premium example therefore does not store:

```text
BIR51 + UMBIR51 + ... - CMP_CAT + COL
```

It stores only the filter instruction to exclude `BI` and `UMBI`. `CMP_CAT` remains
negative because its base coefficient comes from the normal `TOTAL PA` Formula.

### Missing and invalid files

- A missing `data_processing_rules.json` means an empty rule set.
- A valid file with `rules: []` also means no custom processing.
- A malformed file, unsupported `json_format`, duplicate rule ID, or invalid reference
  must fail validation. It must not silently become an empty rule set.
- The data engine should load and compile the file once per project configuration
  revision rather than reparsing it for every row.

## Project Settings UI

### Main workspace

Add a `Data Processing Rules` page to Project Settings. It should be a dense,
table-first operational workspace rather than a raw JSON editor.

The rule table should use compact rows and a single continuous frame with columns such
as:

- Enabled
- Rule Name
- Source Measure
- Request Scope
- Row Conditions
- Filter Action
- Validation Status

The toolbar should provide:

- Add Rule
- Duplicate
- Delete
- Enable / Disable
- Validate All
- Preview
- View JSON

`View JSON` should be read-only by default. Users should not need to understand the
stored contract to create a rule.

### Rule editor

Add/Edit should open a resizable in-app editor with these sections:

1. **Rule**
   - Name
   - Enabled
2. **Target measure**
   - Picker showing both Dataset Type label and raw source field, for example
     `Earned Exposure — Earned_Exposure`.
   - Only atomic source measures should be persisted.
3. **Request scope**
   - Reserving-class field picker.
   - Read-only mapped level.
   - Selected Reserving Class Type picker.
   - Multiple rows use AND.
4. **Raw-row conditions**
   - Source-table field picker.
   - Type-appropriate operator.
   - Value or multi-value picker.
   - An empty section means every source row.
5. **Filter action**
   - `Keep only` or `Exclude`.
   - Action field and validated level.
   - Multi-select atomic member tray.
   - Clicking or dragging values between available and selected trays should update an
     immediate plain-language summary.
6. **Effect summary**
   - Example:
     `For Earned_Premium when selected IBNRCAT is TOTAL PA, exclude IBNRCAT BI and UMBI only on rows where STATE_CD is NJ.`

The editor should show explicit empty, loading, validation-error, and stale-source
states. It should use the existing compact Project Settings controls, refined
dropdowns, app tooltips, and restrained status indicators.

### Preview

Preview should be available before saving and should show:

- Request context used for the preview.
- Source measures required by the chosen Dataset Type.
- Matching rule IDs and names.
- Normal signed members for each selected reserving-class type.
- Rule-condition row counts.
- Rows excluded and rows remaining for each affected source measure.
- A warning when a rule has no effect or filters every eligible row.

Preview should not save the rule or write dataset caches.

### Save behavior

- Editing fields should not write the JSON immediately.
- `Apply` is the intentional mutation point and sends the complete canonical rules
  payload to the app server. Do not save on individual keystrokes or picker changes.
- The request includes the revision that the editor originally loaded.
- The server validates and writes atomically.
- A stale revision returns a conflict instead of overwriting another user's changes.
- The save response reports affected source measures, invalidated caches, and
  downstream calculated datasets requiring refresh.

## App-Server and Persistence Plan

Use normal ArcRho layering:

- Router: transport and response status.
- Schema: typed file and rule payload.
- Service: normalization, validation, atomic persistence, revisioning, audit, and
  cache-impact analysis.
- Config: filename and project path helper.

Proposed endpoints:

```text
GET  /data_processing_rules?project_name=<name>
POST /data_processing_rules
POST /data_processing_rules/validate
POST /data_processing_rules/preview
```

Persistence requirements:

- Project-scoped write lock.
- Temporary file plus atomic replace.
- Stable rule IDs.
- Server-managed revision and audit fields.
- `expected_revision` conflict checking with a distinct conflict response.
- Revision increments only after a semantic change.
- A canonical semantic rules hash that excludes `revision`, `updated_at`, and
  `updated_by`, so an audit-only or no-op save does not invalidate caches.
- Project audit-log entry describing added, edited, removed, enabled, and disabled
  rules.
- Project creation produces either no file or a canonical empty file.
- Project duplication copies the file with the rest of the project settings.
- Field Mapping or Reserving Class Type changes revalidate stored rules and surface
  stale references in Project Settings.

## Data-Engine Configuration and Hot Reload

`data_processing_rules.json` must participate in project configuration loading and
change detection.

The current maximum-mtime approach should be replaced or extended with a composite
configuration signature that detects:

- File creation.
- File modification.
- File deletion.
- A rules revision change.

The compiled project configuration should contain:

- Field-to-level mapping.
- Reserving-class type lookup keyed by field/level/name.
- Compiled normal member coefficients.
- Validated and compiled data-processing rules.
- Rule/configuration hash used by generated-cache provenance.

## Cache Invalidation and Processing Provenance

A rule edit changes generated numbers even when the requested dataset filename and
reserving-class path are unchanged. File existence and dataset identity are therefore
not sufficient cache-validity checks.

Generated dataset sidecars should record processing provenance, for example:

```json
{
  "processing": {
    "config_hash": "sha256:...",
    "rules_format": "arcrho-data-processing-rules-v1",
    "rules_revision": 1,
    "applied_rule_ids": [
      "earned-premium-nj-total-pa"
    ]
  }
}
```

The processing hash should cover every project configuration input that can affect the
generated value, including:

- Data-engine processing algorithm version.
- Field Mapping.
- Dataset Types.
- Reserving Class Types and their resolved Sources.
- General date settings that affect output shape.
- Data Processing Rules.
- Source table path, modification time, and size.

Generated-cache matching should reject a sidecar whose processing hash differs from
the current project hash.

On rules save:

1. Resolve the source measures targeted by changed rules.
2. Find Dataset Types whose Sources transitively depend on those measures.
3. Invalidate matching engine-generated caches and dependent calculated outputs.
4. Preserve manual input, imported snapshot, and method-owned datasets.
5. Rebuild affected reserving-class indexes or mark them for refresh.
6. Mark transitive calculated and method consumers stale or review-required until
   their engine precedents are regenerated.
7. Invalidate temporary-view caches or include the processing hash in their cache key.
8. Return a visible refresh report to Project Settings.

If precise impact analysis is uncertain, invalidating all engine-generated caches for
the project is safer than leaving potentially incorrect results.

If `applied_rule_ids` are persisted, the engine request/result protocol must return
the matched-rule diagnostics through a companion result payload or equivalent
structured response.

## Existing EEX Migration and Removal

The permitted sample project currently has 17 non-empty EEX values, all at level 5.
Migration should still validate every project rather than assuming the same shape
everywhere.

Provide an explicit one-time migration tool:

1. Read `reserving_class_types.json`.
2. For every non-empty `EEX Formula`:
   - Target `Earned_Exposure`.
   - Scope the rule to the row's Reserving Class Type name and level.
   - Resolve EEX members to atomic raw values.
   - Create a `keep_members` rule with no row conditions.
3. Verify every kept member is already present in the normal resolved Source.
4. Fail with a detailed report for unsupported syntax or ambiguous names.
5. Write `data_processing_rules.json` atomically.
6. Compare old and new results for representative reserving-class paths.
7. Remove the `EEX Formula` column from JSON/XLSX persistence, import/export,
   validation, UI, documentation, and data-engine code in the coordinated release.

The deployed design should have one active rule system. A temporary dual-reader should
only be added if a rolling deployment explicitly requires it.

Old local Reserving Class Types JSON/XLSX templates containing `EEX Formula` need an
explicit conversion tool or a clear validation error; the column must not be silently
ignored.

The implemented tool is `tools/migrate_eex_formulas.py`. Run a dry-run first, review
the proposed rules, then apply:

```powershell
py -3.10 tools/migrate_eex_formulas.py `
  --project-path "E:\ArcRho Server\projects\<project>" `
  --dry-run

py -3.10 tools/migrate_eex_formulas.py `
  --project-path "E:\ArcRho Server\projects\<project>" `
  --apply
```

The tool requires the legacy JSON/XLSX pair to agree, refuses to overwrite an
existing `data_processing_rules.json`, preserves other workbook sheets, and rolls
back the Reserving Class files if the coordinated write fails. It does not perform
the representative old/new numerical parity comparison automatically; that remains
an explicit rollout verification step before accepting each migrated project.

## ResQ and Imported Dataset Behavior

These rules operate on raw project source-table rows. A ResQ-imported dataset is
already aggregated and cannot be re-filtered without its original source rows.

Therefore:

- Import does not apply `data_processing_rules.json` to imported numeric snapshots.
- Imported sidecars must identify import provenance.
- An imported snapshot must not be treated as a generated cache produced under the
  current processing hash.
- If the user explicitly requests an ArcRho engine rebuild, cache matching must force
  regeneration from the project source table.

If the sidecar or `index.json` processing-provenance contract changes, update the ResQ
migration writers, macro-source flows, frontend readers/writers, and Python API
documentation together.

## Validation Rules

### File validation

- Exact supported `json_format`.
- Integer revision.
- Unique non-empty rule IDs.
- Valid rule and metadata types.
- No unknown action type.

### Target validation

- `source_measure` exists in the source table.
- It is reachable from at least one Dataset Type Source.
- A calculated requested Dataset Type may contain several independently targeted
  source measures.

### Request-condition validation

- Field is mapped as a Reserving Class field.
- Stored level matches Field Mapping.
- Referenced type exists at that field/level.
- Duplicate type names at other levels do not create ambiguity.

### Row-condition validation

- Field exists in the current source table, including fields not otherwise needed by
  the requested Dataset Type.
- Operator is compatible with the field's data type.
- Null/blank behavior is explicit.
- Multi-value lists are non-empty and contain compatible values.

### Action validation

- Action field exists.
- Stored level matches when the field is a mapped Reserving Class field.
- Members are atomic source-row values.
- `keep_members` is non-empty.
- Kept members are a subset of the normal nonzero selected-type members.
- Excluded members are valid values; values outside the normal selected membership
  produce a warning because they have no effect.

### Runtime failure behavior

- No matching rules means normal processing.
- A disabled rule is ignored.
- A valid rule matching no source rows returns normal data plus preview/diagnostic
  information.
- An invalid stored contract returns an explicit processing error.
- Invalid configuration must never fall back to a plausible zero-valued dataset.

## Acceptance Criteria

### Required business cases

1. `Earned_Exposure`, selected `PhysD`
   - Normal formula is `CMP + COL`.
   - Custom result keeps only `CMP`.
2. `Earned_Exposure`, selected `BI Total`
   - Custom result keeps only `BI`.
3. `Earned_Exposure`, selected `TOTAL PA`
   - Custom result keeps only `PD`.
4. `Remaining_Budget_Exposure`, selected `TOTAL PA`
   - Custom result keeps `PD` and `UMPD`.
5. `Earned_Premium`, selected `TOTAL PA`
   - NJ source rows exclude `BI` and `UMBI`.
   - NJ rows retain `CMP_CAT` with the normal Formula's negative coefficient.
   - Non-NJ rows retain the complete normal `TOTAL PA` Formula.
6. `Earned_Premium`, selected `BI Total`
   - NJ source rows exclude `BI` and `UMBI`, leaving `BIR51 + UMBIR51`.
   - Non-NJ rows retain the complete normal `BI Total` Formula.
7. `Earned_Premium`, selected `All States/.../TOTAL PA`
   - The rule adjusts only raw rows where `STATE_CD == NJ`.
   - Other states remain unchanged.

### Regression and edge-case matrix

- Direct source-measure dataset.
- Calculated Dataset Type containing one adjusted source measure.
- Calculated Dataset Type containing multiple source measures with different rules.
- Triangle and vector requests.
- Cumulative, incremental, development, and calendar output modes.
- No matching rule.
- Multiple intersecting rules.
- Disabled rule.
- Missing empty rule file.
- Malformed or unsupported rule file.
- Partial reserving-class paths and projects with fewer than five levels.
- Duplicate names at different levels.
- Names containing spaces or operator characters.
- Nested normal formulas and cycle detection.
- Negative normal Formula members retained by a custom rule.
- Custom keep list attempting to add a base-excluded member.
- Row conditions using a source field not otherwise selected by the calculation.
- Rule save followed by a request with an existing generated cache.
- Imported ResQ snapshot followed by an explicit ArcRho engine refresh.

## Test Plan

### Data-engine unit tests

Create executable Python tests for pure functions that:

- Compile normal Reserving Class Sources into atomic coefficients.
- Build base row weights across multiple hierarchy dimensions.
- Evaluate typed row conditions.
- Apply `keep_members` and `exclude_members`.
- Intersect multiple custom masks.
- Apply independent masks to multiple source measures.
- Preserve cached source DataFrame immutability.

Use small synthetic DataFrames with exact expected values.

### Characterization tests

Before deleting old code:

- Capture current normal Formula results for positive and negative members.
- Capture current EEX results for representative sample-project types.
- Convert EEX settings to rules.
- Assert old and new results are identical for supported legacy cases.

The development branch may run both paths for comparison, but the deployed contract
should use only the new rule system after migration.

### App-server contract tests

- GET returns canonical empty and populated payloads.
- POST validates references and writes atomically.
- Revision increments only after a successful write.
- Lock/contention errors remain distinct.
- Preview performs no writes.
- Rule changes report affected caches.

### Frontend tests

- Add, edit, duplicate, delete, enable, and disable rules.
- Target and condition pickers restrict values correctly.
- Add/remove condition rows.
- Keep/exclude member tray behavior.
- Plain-language effect summary.
- Empty, loading, invalid, and stale-reference states.
- Read-only JSON preview.
- Save/refresh report behavior.

### Integration tests

- Project Settings save is observed by a running data engine without restart.
- A changed rule invalidates or rejects stale generated caches.
- Sidecar processing hash matches the configuration used for calculation.
- Downstream calculated datasets refresh consistently.

## Implementation Phases

### Phase 1: Characterize and isolate current behavior

- Add tests around normal Formula signs and EEX outputs.
- Inventory existing Reserving Class formulas for unsupported syntax.
- Inventory non-empty EEX values before migration.

### Phase 2: Refactor normal Formula processing

- Introduce field/level/name-qualified lookups.
- Compile resolved Sources into member coefficients.
- Replace included/excluded list mutation with base row weights.
- Keep output identical before adding custom rules.

### Phase 3: Add the rule contract and engine evaluator

- Add config path and typed schema.
- Add app-server read/write/validate services.
- Add data-engine loading, compilation, and vectorized masks.
- Treat a missing rule file as an empty rule set.
- Return explicit rule errors.

### Phase 4: Add cache provenance and invalidation

- Compute the processing configuration hash.
- Persist it in generated sidecars.
- Reject stale caches.
- Add targeted invalidation with safe project-wide fallback.

### Phase 5: Build Project Settings UI

- Add the rules table and editor.
- Add request-scope, raw-row-condition, and member-filter controls.
- Add validation, preview, read-only JSON view, and refresh reporting.

### Phase 6: Convert EEX and remove the old contract

- Run the migration tool.
- Run parity checks.
- Remove EEX from engine, backend constants/services, JSON/XLSX, templates, UI, and
  docs in one coordinated change.

### Phase 7: Rollout verification

- Verify direct, calculated, triangle, vector, and Excel-triggered requests.
- Verify ResQ import versus engine-refresh behavior.
- Update user manual, architecture/business-logic docs, API docs when applicable, and
  release notes.

## Expected Implementation Surface

Likely implementation areas include:

- `data-engine/src/arcrho_engine/data_processing.py`
- `data-engine/src/arcrho_engine/general_utils.py`
- New data-engine tests
- `frontend/app_server/config.py`
- New app-server schema, service, and router for data-processing rules
- `frontend/app_server/services/arcrho_runtime_service.py`
- `frontend/app_server/services/reserving_class_service.py`
- `frontend/ui/project_settings/`
- Project Settings, data-engine, and app-server documentation
- Frontend release fragment
- One-time EEX migration tooling
- ResQ migration and macro-source files if sidecar/index provenance changes
- Python API documentation if rule management is later exposed to agents

## Final Design Decisions

- `data_processing_rules.json` is the authoritative custom-rule file.
- Users edit it through Project Settings UI.
- Rules target atomic source measures, not only requested Dataset Type names.
- Selected reserving-class request scope and raw source-row conditions are separate.
- `STATE_CD == NJ` is a raw-row condition and still applies inside an `All States`
  request.
- Custom rules only filter rows with `0/1` masks.
- Normal Reserving Class Sources own all positive and negative coefficients.
- `excluded_rsv_cls_types` is replaced by compiled normal Formula coefficients.
- Multiple matching custom rules intersect; no rule priority is required.
- Rules run before origin/development aggregation.
- Arbitrary custom scripts are out of scope.
- Existing EEX values are migrated and the old column is removed.
