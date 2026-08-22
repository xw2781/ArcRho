# Persisted JSON Contract v4: One Naming Convention, Fewer Fields, One Audit Policy

Status: In progress — Steps 1-2 landed 2026-08-22
Last updated: 2026-08-22

## Progress Checklist

One box per task, in the order the work must land. Each step is its own commit; do not start a step until the previous one is committed. The model and effort beside each step are the recommendation for driving it (`ultracode` = multi-agent workflow; start the step with `ultracode — implement step N of docs/plans/persisted_json_contract_v4.md`). Steps 6 and 7 touch the shared server and are run by a person, not an agent fleet.

### Step 1 — Fingerprint decoupling · Fable 5 · `xhigh`

- [x] Make the three self-fingerprints (`owned`, `derived`, `publication`) hash a vocabulary independent of the persisted key spelling, in every method contract (DFM, BF, CC, Bootstrap).
- [x] Make the `source revision` fingerprints spelling-independent the same way, so a converted precedent still matches a downstream method's stored value.
- [x] Move fingerprint production into one function and truncate there to `sha256:` + 16 hex characters (rule 2a), including the processing-rules `config_hash`.
- [x] Prove it: a real method file loads, re-normalises and rewrites byte for byte before and after the change, with only the fingerprint values differing.
- [x] Commit.

### Step 2 — Reconcile the two method writers · Fable 5 · `xhigh`

- [x] Make `dfm_service._publish` write through `persisted_projection`, so both DFM writers emit one shape.
- [x] Check BF, CC, Bootstrap, RS and B&S for the same split (service writer vs contract projection) and close any found.
- [x] Route the browser-side Berquist Sherman save (`berquist_sherman_main.js` → `save-json-file` IPC) through the app server instead of `fs.writeFileSync` (Trap 3).
- [x] Collapse the four JSON text writers onto the canonical `arcrho_api/io.py` behaviour (Bridge, `host_support.js`, `arcbot_host.js`).
- [x] Commit.

### Step 3 — Audit log and shared sidecar validator · Fable 5 · `high`

- [ ] Stop `_normalize_dataset_audit_log` discarding `Auto Refresh`; keep every action, collapse consecutive automatic entries to the most recent.
- [ ] One shared cap constant: 200 per dataset, 500 per project; remove the 50, 1 and 5000 figures.
- [ ] Add the shared sidecar-core validator (rule 9): common core present, `audit_log` last, method-only fields allowed on top; every sidecar writer calls it (engine contract + four method-output contracts).
- [ ] Cross-writer test that runs all five producers against the validator.
- [ ] Commit.

### Step 4 — Rename, drop fields, delete legacy readers · Fable 5 · `xhigh` (one commit; `ultracode` fan-out by contract, test sweep at `low`)

- [ ] Migrate `notes_tab` text from the four BF method files into their dataset sidecars' `notes` **before** any deletion (Trap 1) — a one-time fix in the style of `migrate_legacy_notes_files`.
- [ ] Fix the `notes_tab` guard test: pattern that matches `"notes_tab": {}` in Python, and every producer on its file list.
- [ ] DFM: rename the 48 spaced keys in `dfm_contract.py` and the 46 in `dfm_persistence.js`; keep the `ratios tab` labels (Decision 6); drop `results tab.ratio basis origin labels`.
- [ ] All method kinds: `json_format` → `arcrho-<kind>-v4`, no `-by-tab`; delete the always-empty placeholder sections (`validation_tab`, `results_tab`, `audit_log_tab`, `chart_tab`, `ultimates_tab`, `ratios_tab` where empty); remove the audit log from method files (rule 8).
- [ ] Dataset sidecars: `Precedents`/`Dependents` → `precedents`/`dependents`; one entry shape `{dataset_name, method_type?}` plus optional `reserving_class` / `project` (rule 7); drop `path`, `mtime`, `mtime_ns`, `method_type_code`, `data_format_code`, `origin_count`, `user`, `formula`, `processing_by_csv`.
- [ ] Redirect the one `processing_by_csv` reader (`data_processing_rules_service.py:1324-1336`) to the flat `processing` copy (Decision 5).
- [ ] Timestamps: ISO-8601 UTC, millisecond precision, `Z` suffix, everywhere (rule 3).
- [ ] Project `audit_log.json`: adopt the sidecar record shape (Decision 4).
- [ ] Restamp the three extra on-server files: cache provenance (`format` → `json_format`), `dataset_number_formats.json`, `source_import.json` (`version` → `json_format`).
- [ ] Delete every legacy/dual-spelling reader: `dataset_index_contract.py`, `arcrho_api/dfm.py`, `result_selection_service.py`, `dfm_service.py`, the `_snapshot_field(spaced, snake)` helpers in BF and CC contracts.
- [ ] Update the spaced keys in `export_reserving_class_to_resq.py`, `sync_reserving_class_with_resq.py`, and `python-api/migration/resq_migration/{catalog,dfm,extractors,merge,sync_session}.py`.
- [ ] Sweep the ~47 test files / 334 literal occurrences (`"json format"`, `"details tab"`, `"ratios tab"`, `"method metadata"`, `dataset_type_name`, …) and `test_persisted_json_text.py`.
- [ ] Regenerate `tmp_data/json_contract_v4_samples/` and make `check_samples.py` pass rules 1–5 plus the Decision 6 exception.
- [ ] Verify no reader of the old shape remains (grep for every old key across `python-api/`, `frontend/`, `data-engine/`).
- [ ] Run `/code-review ultra` on the branch.
- [ ] Commit.

### Step 5 — Tests and documentation · Opus 5 · `high`

- [ ] Rewrite `frontend/docs/ui/dfm_json_format.md` for v4 (not an edit — it is spaced names throughout).
- [ ] Regenerate the generated docs under `frontend/docs/generated/`.
- [ ] Release fragment under `frontend/changes/unreleased/` for the format change and the forced update.
- [ ] Full Python and frontend test suites green (baseline the pre-existing failures first — see agent memory).
- [ ] Commit.

### Step 6 — Conversion script and server rehearsal · Fable 5 · `max` for the verify/rollback path · run on the Server PC

- [ ] Write `tools/migrate_persisted_json_v4.py` in the `migrate_eex_formulas.py` style: `--dry-run` / `--apply`, per-file backup, rollback.
- [ ] Walk `projects/*/data/*/{methods,sidecars}`, the project root files, `.arcrho-cache-provenance/`, and `.arcrho-resq-import-staging/` (Trap 5) — decide rewrite vs delete for the staging root.
- [ ] Rewrite only through the canonical contract modules; verify each converted file by re-normalising it and asserting it is unchanged.
- [ ] Dry run on `NJ_Annual_Prod_202605_Fake`; compare file counts and sizes against the Measured Impact table.
- [ ] Apply to `NJ_Annual_Prod_202605_Fake`; open DFM, BF, CC, Bootstrap, RS and B&S methods and a plain dataset in the app; save one of each and confirm the byte-identical round trip.
- [ ] Apply to the remaining 36 projects on the Server PC, not across the mapped drive.
- [ ] Commit the script.

### Step 7 — Release every component together · Opus 5 · `high` · person-driven

- [ ] Rebuild and deploy Engine, Bridge and Gateway (bundled sources carry the contracts — Trap 4); check the bridge auto-create setting afterwards.
- [ ] Republish the active macros to the shared library (`publish_macro_library.py`).
- [ ] Build and force the frontend release; confirm an old client cannot open a converted workspace silently.
- [ ] Update `Status:` at the top of this document to Implemented, with the date.

## Summary

Every persisted ArcRho JSON file is to move to one convention in a single breaking change, with no legacy fallback and every old file converted in place. The frontend release that adopts v4 will be forced onto all users, so no producer or reader needs to tolerate the old shape.

Three things drive the work: DFM method JSON is the only family still using spaced field names; several persisted fields restate other fields or store machine-local paths; and the audit log obeys four mutually inconsistent policies, two of which lose history.

The conversion itself is low risk and provably correct — loading a real method file, running it through the canonical normalise-and-write pipeline and writing it back reproduces the file byte for byte. The risk lives in the prerequisites, not the rename. Read [Traps and Prerequisites](#traps-and-prerequisites) before touching anything.

## Goals

- One field-naming convention across every persisted file: `snake_case`, no spaces, no capitals, no camelCase, at any nesting depth.
- Remove fields that restate another field, that nothing reads, or that bind a shared file to one machine.
- One audit-log policy: same record shape everywhere, `audit_log` always the last field, capped at 200 records per dataset and 500 per project.
- Delete every legacy-format reader outright rather than keeping a fallback.
- Convert every existing project on `E:\ArcRho Server` in place. Deleting datasets and re-importing from ResQ is explicitly rejected — see [Migration](#migration).

## Non-Goals

- No change to what any method computes. This is a serialization and naming change only.
- No restructuring of the tab layout inside method files. Section names change; the sections themselves do not.
- No change to reserving-class `index.json`, which already satisfies the convention.
- No move of state between files, with one exception: notes stranded in method files move to the dataset sidecar that already owns notes.

## Current State

### Naming: DFM is the only holdout

Measured across project `NJ_Annual_Prod_202605_Fake` (29 reserving classes, 558 method files):

| Kind | Files | Naming |
| --- | ---: | --- |
| DFM | 345 | spaced lower |
| Result Selection | 116 | `snake_case` |
| Bornhuetter Ferguson | 67 | `snake_case` |
| Cape Cod | 16 | `snake_case` |
| Berquist Sherman (BSCRA + BSSR) | 14 | `snake_case` |

The split is exact — no file mixes the two. `dfm_contract.py` holds 48 distinct spaced keys and `frontend/ui/method_pages/dfm/dfm_persistence.js` mirrors 46 of them. Every other method contract uses `details_tab` / `method_tab` / `method_metadata`.

Format stamps are also out of step: DFM says `arcrho-dfm-method-by-tab-v2`, BF already says `arcrho-bornhuetter-ferguson-method-by-tab-v3`, and dataset sidecars carry no `json_format` key at all. Hence v4 for every kind at once.

Spaced keys also appear in `python-api/macros/export_reserving_class_to_resq.py`, `sync_reserving_class_with_resq.py`, and `python-api/migration/resq_migration/{catalog,dfm,extractors,merge,sync_session}.py`.

### Redundant and location-dependent fields

Forced copies in DFM method JSON — the contract raises if any differs from the field it copies, so none can carry information:

- `ratios tab.ratio triangle.origin labels` must equal `data tab.origin labels` — `dfm_contract.py:561-562`
- `ratios tab.ratio triangle.development labels` is derived from `data tab.development labels` — `dfm_contract.py:563-564`. Not a byte copy: they are display strings such as `(1) 12-24` … `120 - Ult`, built pairwise by `_ratio_development_labels` (`dfm_contract.py:1196-1205`). **Both ratio label sets stay on disk** — Decision 6.
- `results tab.ratio basis origin labels` must equal `data tab.origin labels` — `dfm_contract.py:588-589`

`data tab.input data triangle mask` is already omitted on disk by `persisted_projection` (`dfm_contract.py:888`) because a cell is inside the triangle iff it holds a value, and is re-derived at `dfm_contract.py:388`.

In dataset sidecars:

- `Precedents` / `Dependents` are Title Case in an otherwise `snake_case` file, written from ten modules including `dfm_contract.py:1043-1044` and `engine_dataset_sidecar_contract.py:101-102`.
- Dependency entries embed `path`, `mtime` and `mtime_ns`. In one reserving class, 118 of 214 entries carried an absolute path, some pointing into the `\r\<guid>\` import staging root. This violates the location-independence rule in `AGENT_GUIDELINES.md`.
- The same key holds three shapes: a plain string (Berquist Sherman), a one-field object, and an eight-field object.
- `method_type_code` and `data_format_code` restate `method_type` and `data_format`; `origin_count` equals `len(origin_labels)`; `user` duplicates `modified_by`; `formula` is hydrated from `dataset_types.json` on read.
- `engine_dataset_sidecar_contract.py:88-93` writes `processing` and `processing_by_csv` as two deep copies of the same dict — the per-CSV map always holds exactly one entry, keyed by the sidecar's own `csv_file`. This is also the "second fingerprint" of Decision 5: each copy carries the same `config_hash`. One reader prefers the map (`data_processing_rules_service.py:1324-1336`, stale-count); three read the flat copy (`:1337-1344`, `arcrho_runtime_service.py:185`, `runtime_cache_provenance_service.py:95`); one test pins the map (`test_resq_data_migration_engine.py:207`).

Always-empty placeholder sections, counted project-wide — 428 in total, all safe to delete:

| Section | Written by | Files |
| --- | --- | ---: |
| `validation_tab` | Result Selection | 116 |
| `results_tab` | Result Selection | 116 |
| `audit_log_tab` | BF, CC, Bootstrap, B&S | 97 |
| `chart_tab` | Bornhuetter Ferguson | 67 |
| `ultimates_tab` | Cape Cod | 16 |
| `ratios_tab` | Cape Cod | 16 |

`notes_tab` is **not** on that list. See [Traps and Prerequisites](#traps-and-prerequisites).

### Audit log: four policies, two of which lose history

| File | Cap | Enforced at | Behaviour |
| --- | --- | --- | --- |
| Project `audit_log.json` | 5000 | `config.py:379`, `audit_service.py:85-86` | Trimmed correctly |
| Dataset sidecar (app server) | 50 | `dataset_service.py:386,427,439` | Trimmed, **but discards non-`Insert`/`Update` actions** |
| Method output sidecar | none | `dfm_contract.py:1010-1013` and siblings | Appends forever |
| Engine-written sidecar | 1 | `engine_dataset_sidecar_contract.py:97-102` | Replaces the whole history |

`_normalize_dataset_audit_log` (`dataset_service.py:408-427`) hard-codes `action not in {"Insert", "Update"}` and drops everything else — which is exactly the `Auto Refresh` action that `sidecar_audit_contract.py:25` defines and that `dfm.py:655` writes. It runs on the write paths at `dataset_service.py:1782` (`_save_dataset_sidecar_impl`) and `:2017` (`_patch_dataset_impl`), neither of which excludes method outputs. **This is live today, not hypothetical.**

Growth characteristics:

- Automatic refreshes append only when the published output actually moved — `append_audit=not automatic or output_changed` at `dfm.py:654`.
- Interactive saves append **unconditionally**, so a no-op Save still writes a record. This is the dominant growth path.
- Observed in practice: across 2,079 sidecars the longest log holds 5 records, p90 is 3, and 577 files have none. The project log holds 118 records after roughly six months.

The project log also uses a different vocabulary for the same idea: `entries` rather than `audit_log`, `timestamp` rather than `event_date`, a free-text `action` rather than a known value, and no `change_info` at all.

### Revision fingerprints

A DFM method file carries five `sha256:` values, in two families.

Pointing **up** at precedents, not derivable from this file, keep as they are:

- `data tab.source revision` — the input triangle's fingerprint when last read
- `results tab.ratio basis source revision` — same for the ratio basis dataset

Fingerprinting **this file**, at three widening scopes:

- `owned revision` — the person's choices (details, exclusions, formula selections, cell notes)
- `derived revision` — the computed numbers
- `publication revision` — only what downstream methods can see

The three self-fingerprints are **never read as data**. `_revision_response` (`dfm_service.py:223`) recomputes them via `method_revisions()` on every use. Their sole persisted purpose is the validation at `dfm_contract.py:526-530`, which blanks them, recomputes from content, and **rejects the file if the stored value differs**.

The copy in the dataset sidecar *is* load-bearing: `dfm_service.py:923-924` compares it against a value computed from the method file to detect "method saved but output never republished". The same pattern exists in `bornhuetter_ferguson_service.py:645`, `cape_cod_service.py:684` and `bootstrap_service.py:830`.

Project-wide cost: 4,831 fingerprints across 2,637 files, 352,663 bytes (3.7% of all stored bytes). Truncating to 16 hex characters would save 0.22 MB per project, about 8.2 MB across 37 — roughly five times what deleting `owned revision` and `derived revision` would save, without losing the integrity check.

### Producer parity

- **Two writers disagree today.** `dfm_service._publish` writes the method file without `persisted_projection`, so files on disk are already not all in one shape, before any of this work.
- **Four JSON text writers exist**, in two languages: `arcrho_api/io.py:80` (canonical), `arcrho_bridge/bridge_utils.py:58`, `frontend/electron/host_support.js:18`, and `frontend/electron/arcbot_host.js:1823`.
- **Result Selection and Berquist Sherman have no contract module** in `python-api/src/arcrho_api/`. Their shape is defined inside app-server services and re-implemented in JS.
- Legacy dual-spelling reads are concentrated in `dataset_index_contract.py` (25 hits), `arcrho_api/dfm.py` (22), `result_selection_service.py` (12) and `dfm_service.py` (12). `bornhuetter_ferguson_contract.py:440-441` and `cape_cod_contract.py:613-614` carry a `_snapshot_field(snake, spaced)` helper that exists only to read DFM-style spaced snapshots — it disappears once DFM moves.

## Proposed Contract

1. `snake_case` for every key, at every depth. No spaces, no capitals, no camelCase.
2. Every file carries `json_format`, and every kind is stamped `-v4` together. Drop the meaningless `-by-tab` segment.
2a. Every fingerprint is stored as `sha256:` plus the first 16 hex characters. The truncation lives in the one function that produces fingerprints, so both sides of every comparison (`source revision` vs recomputed, sidecar `publication_revision` vs method, sidecar `config_hash` vs `get_processing_config_hash`) shorten together; a stored full-length value never compares equal to a truncated one, which is why this is part of the same breaking change and not a later tidy-up.
3. Every timestamp is ISO-8601 UTC with millisecond precision and a `Z` suffix. Today they are naive with no timezone.
4. `audit_log` is the last field in the file. Cap 200 for a dataset, 500 for a project. Every action is kept, including `Auto Refresh`; consecutive automatic entries collapse to the most recent. The project log adopts the same record shape as sidecars — `audit_log` / `event_date` / known `action` / `change_info` / `user` — so one reader serves both (Decision 4).
5. Delete always-empty placeholder sections. Migrate `notes_tab` content, never delete it.
6. Drop forced copies, paired code fields, `origin_count`, the duplicate `user`, `formula`, and `processing_by_csv`. **One deliberate exception:** the DFM `ratios tab` keeps its own origin and development labels, so the ratio triangle reads as a complete table on its own (Decision 6). `results tab.ratio basis origin labels` still goes.
7. Persist nothing location-dependent: no `path`, no `mtime`, no `mtime_ns` in dependency entries. The keys become `precedents` / `dependents` per rule 1. One entry shape: `{dataset_name}` plus `method_type` when there is one, with two reserved optional keys — `reserving_class` and `project` — written **only** when the linked dataset lives outside the containing file's own reserving class or project. Readers default a missing key from the file's own location, so same-RC entries (all of them today) stay small and the planned cross-RC / cross-project linking becomes additive — no v5 needed to introduce it. Sub-questions in Open Decision 7.
8. Method files carry no audit log. History for a method lives in the dataset sidecar its output writes, which is where the app already reads it.
9. Dataset sidecars and method-output sidecars are **one schema, not two**. A method opened in a Dataset Viewer window shows only its output triangle or vector, read from the sidecar and CSV like any other dataset, so both must carry the same core: labels, notes, number formatting, `precedents` / `dependents`, and `audit_log` last. A method-output sidecar adds only `method_name`, `method_type`, `source_kind`, `calculated` and `publication_revision` on top; nothing in the core may differ between the two kinds. `dfm_contract.py:1019-1052` already builds this superset today — v4 keeps the shape and makes the invariant explicit (see Open Decision 8 on enforcing it).

Worked before/after payloads for all eleven file kinds are generated by `tmp_data/json_contract_v4_samples/generate_samples.py`, with `check_samples.py` asserting rules 1–5 hold.

## Traps and Prerequisites

These are the findings most likely to cause damage if the next person does not know them.

### 1. `notes_tab` is not an empty placeholder — migrate it

Four BF files carry a `notes_tab`, and **three hold real actuarial commentary that exists nowhere else**: a methodology note on loss development patterns, a tail based on a competitor study, an authorship line. Each one's matching dataset sidecar has an empty `notes` field, so the method file holds the only copy.

Deleting it alongside the empty sections destroys authored work. Move the text into the sidecar's `notes` field first. `dataset_index_contract.py:887` (`migrate_legacy_notes_files`) is a proven precedent for exactly this shape of one-time fix.

The guard meant to prevent this fails twice over. `frontend/tests/notes_sidecar_contract.test.mjs:31` asserts `/\bnotes_tab\s*:/u` against a hardcoded list of eight files. The Python producers are not on the list, **and** the pattern requires the key followed directly by a colon, so it cannot match `"notes_tab": {}` in Python source at all. Adding the missing files would not have caught this — the pattern needs fixing too.

### 2. A naive rename bricks every method file

`normalize_dfm_method` recomputes the three self-fingerprints from content and raises `DfmContractError` when a stored value differs (`dfm_contract.py:526-530`). The hash is taken over a structure whose **keys are the field names** (`owned_projection` at `dfm_contract.py:801` emits `"details tab"`, `"excluded cells"` and so on, hashed via `json.dumps(sort_keys=True)`).

Renaming therefore changes every computed fingerprint, and every existing file fails the check and refuses to load. This is worse than "everything looks stale".

- A find-and-replace rename across the workspace **will not work**.
- A scripted conversion is fine, because the normalise-and-write pipeline recomputes and rewrites the fingerprints as a matter of course.
- Better still: make the hash vocabulary independent of the persisted spelling, so renames are fingerprint-neutral. This also removes any need to convert in dependency order, since a downstream method's stored `dfm_source_revision` keeps matching.

### 3. The browser writes Berquist Sherman JSON directly

`berquist_sherman_main.js:2330` calls `hostApi.saveJsonFile(...)` → `preload.js:53` → IPC `save-json-file` → `main.js:1655`, which does `fs.writeFileSync(filePath, formatJsonForSave(...))`. This bypasses the app server, the Python contracts and the canonical text writer entirely.

Changing the contract in Python alone leaves B&S still writing the old shape.

### 4. Frozen and mirrored copies revert the format

- `data-engine/src/arcrho_engine/bundled_sources.py` bundles `python-api/src` and `frontend/app_server` wholesale into the Engine executable. An unrebuilt Engine writes the old shape back into a converted workspace.
- All four JSON text writers must move together or the bytes stop matching.
- Active macros must be republished to the shared library per `AGENT_GUIDELINES.md`; a stale macro writes the old shape.

### 5. A conversion walk will silently skip hidden folders

`runtime_cache_provenance_service.py:14` builds the path and `:119-134` writes one JSON file per cached CSV into `<reserving class>/.arcrho-cache-provenance/` (`config.py:390`). It stamps itself with a key named `format`, not `json_format` (`config.py:391`, checked at `runtime_cache_provenance_service.py:87`) — a third spelling of the version key. The directory name starts with a dot and does not exist in every project, so an ordinary walk skips it and leaves old-shape files behind with no error. A second dotted directory, `<project>/data/.arcrho-resq-import-staging/`, sits beside the reserving classes in at least one production project; decide whether the converter rewrites its contents or deletes the staging root, but it must not be silently skipped either.

### 6. Roughly a fifth of the test suite pins these names as literals

47 of 248 test files contain literal `"json format"`, `"details tab"`, `"ratios tab"`, `"method metadata"`, `dataset_type_name` or `"audit_log"` — 334 occurrences across 20+ files. `python-api/tests/test_persisted_json_text.py` pins the on-disk text layout itself. Budget for this; it is the single largest mechanical cost of the change.

### 7. Two producers already disagree

Reconcile `dfm_service._publish` with `persisted_projection` **before** converting, or the conversion normalises two different starting shapes and a conversion bug becomes indistinguishable from pre-existing drift.

## Migration

**Convert in place. Do not delete datasets and re-import from ResQ.**

Feasibility is proven: loading a real DFM method file, running `normalize_dfm_method` → `persisted_projection` → `persisted_json_text` and writing it back reproduces the on-disk file **byte for byte**, verified on three real files. Adding a key-rename step in front of that pipeline is a small, checkable change, and the output is by construction identical to what a fresh save writes.

Re-importing is rejected because any method authored in ArcRho since the last sync has no counterpart in ResQ, and because Bootstrap has no ResQ write-back path at all.

Script shape, following the proven pattern in `tools/migrate_eex_formulas.py`:

- Lives in `tools/`, with `--dry-run` and `--apply`, per-file backups and rollback.
- Walks `E:\ArcRho Server\projects\*\data\*\{methods,sidecars}`, the project root files, **and dotted directories**.
- Rewrites via the canonical contract modules rather than hand-editing keys.
- Verifies by re-normalising each converted file and asserting it is unchanged.
- **Run it on the Server PC, not across the mapped drive.** Roughly 13,000 method files and 77,000 dataset sidecars across 37 projects, and the share charges per file touched.

## Sequencing

1. Make the fingerprint hash independent of field spelling. On its own, first, so nothing cascades.
2. Reconcile the two disagreeing method writers.
3. Fix `_normalize_dataset_audit_log` to stop discarding `Auto Refresh`, move the cap to one shared constant, and introduce the shared sidecar-core validator that every sidecar writer calls (Decision 8).
4. Rename, drop dead fields, truncate fingerprints, redirect the one `processing_by_csv` reader (Decision 5), delete every legacy reader — one commit, since nothing may be left that reads the old shape.
5. Update tests, `frontend/docs/ui/dfm_json_format.md`, and generated docs under `frontend/docs/generated/`.
6. Convert the server, rehearsal run first.
7. Release app, Engine, Bridge, Gateway and macro library together.

Note `AGENT_GUIDELINES.md` requires any `index.json` contract change to be coordinated across five components; this plan does not change `index.json`, which keeps step 4 smaller.

## Measured Impact

Project `NJ_Annual_Prod_202605_Fake`, 2,637 files:

| File kind | Files | Now | Proposed | Change |
| --- | ---: | ---: | ---: | ---: |
| Dataset sidecars | 2,079 | 4,225,720 | 2,686,260 | −36.4% |
| DFM methods | 345 | 4,014,932 | 3,640,825 | −9.3% |
| Other methods | 213 | 1,293,482 | 1,284,070 | −0.7% |
| **Total** | **2,637** | **9,534,134** | **7,611,155** | **−20.2%** |

The project `audit_log.json` **grows** about 22%, because each record gains a field when the free-text action splits into a known action plus a description. The 500-record cap bounds it.

Dataset sidecars dominate the gain and are also the files read most often — on every folder scan, index rebuild and staleness check — while method files are read only when someone opens that method.

## Decisions

All eight questions were settled on 2026-08-22. Nothing in this section is still open; the remaining pre-implementation work is the scope call in [Not Covered](#not-covered) and the prerequisites in [Traps and Prerequisites](#traps-and-prerequisites).

1. **Project audit cap of 500 — agreed.** Down from 5000; roughly two years of settings history at the observed rate.
2. **Fingerprints truncate to 16 hex characters — agreed.** Contract rule 2a. Saves ~8.2 MB across 37 projects; the truncation must sit in the producing function so every comparison shortens both sides at once.
3. **`owned_revision` and `derived_revision` stay on disk — agreed,** shortened per Decision 2. They remain the only integrity check a method file has against a partial or hand-edited write.
4. **Project audit log adopts the sidecar record shape — agreed.** Contract rule 4. The file grows ~22%, bounded by the 500 cap, and one reader serves both files.
5. **The second fingerprint in sidecars is explained — no new field to remove.** Measured on one reserving class (122 sidecars): 67 carry `config_hash` twice, 29 carry one `publication_revision` (method outputs), 26 carry none. The doubled value is the data-processing-rules hash the Engine writes once under `processing` and again under `processing_by_csv[<csv_file>]` (`engine_dataset_sidecar_contract.py:88-93`) — the per-CSV map the plan already drops under rule 6. Dropping it removes the duplicate fingerprint for free, **with one reader to redirect**: the stale-sidecar count at `data_processing_rules_service.py:1324-1336` prefers the map and must fall through to the flat `processing` copy instead, and `test_resq_data_migration_engine.py:207` pins the map. The hash itself stays; it is what tells the app a cached CSV was built under the current processing rules.
6. **DFM ratio labels stay — redundancy rule bypassed on purpose.** Contract rule 6 carries the exception. Rationale: a method is also a thing a person or ArcBot reads as a raw file — ArcBot edit sessions hand the file text straight to the model (`arcbot_host.js:2218`, `:2143`) — and a ratio triangle without its own headings is not a complete table. The three label arrays cost well under 1 KB per file; the validation at `dfm_contract.py:561-564` keeps enforcing that they agree with the data tab, so they can never drift into carrying different information. The sample payloads in `tmp_data/json_contract_v4_samples/` were generated with the labels removed and must be regenerated. The measured DFM saving of 9.3% was computed without them and is now a slight overstatement.
7. **Cross-RC / cross-project links are by name, with rename handled by a propagation-style job.** Rule 7 stands (sparse entries; `reserving_class` / `project` present only on a real cross-link). Renaming a linked project or class is accepted as rare, so no stable ID is introduced; instead a rename must rewrite every downstream `precedents` entry so ordinary propagation keeps flowing afterwards. **This is straightforward to build on what exists**, and none of it is v4 work — it ships with the linking feature:
   - **There is nothing to rename yet.** Today the only rename is `project_settings_service.rename_project_folder` (`:277-307`), which renames the project *settings* folder under `config.PROJECT_SETTINGS_DIR`, not the workspace project; no reserving-class rename exists at all. A workspace rename is a new operation either way.
   - **The model is the dataset-types change job, not the per-class walk.** `data-engine/src/arcrho_engine/dataset_types_change.py` already does the hard part: it takes the *project-scope* propagation lease (`arcrho_dependent_propagation_contract.py:650-725`), which makes every class of the project report the 423 hold clients already understand, then calls the canonical `calculated_dataset_service.refresh_sidecar_graphs_and_recalculate` (`dataset_types_change.py:286`) to rewrite every sidecar's `precedents` / `dependents` and walk each affected class's dependents. A rename job is the same shape with a different rewrite in the middle.
   - **The sparse link format makes the far side self-indexing.** Because a `dependents` entry carries `project` / `reserving_class` only when the dependent lives elsewhere, the renamed project's own sidecars list exactly the far-side files that must change — no reverse index and no scan of the other 36 projects. The job collects those entries, groups them by target project, takes each target's project-scope lease, rewrites the matching `precedents` entries (and, for a class rename, the `reserving_class` values) in place, and releases. The renamed side needs no rewrite: its `dependents` entries point outward and are unaffected. Values and publication revisions do not change, so **no recalculation follows** — the job is a pure rewrite, cheaper than any propagation.
   - **Ordinary cross-project propagation needs one request-shape addition.** The per-class job identifies changed roots by name inside one class (`_CHANGED_ROOT_FIELDS`, `arcrho_dependent_propagation_contract.py:96`). A save whose dependents include cross-links must enqueue a second request for the far-side class, carrying the source's project and class so the Engine can resolve the precedent. That is the "who writes the far side" question answered: the far side is always written under its *own* class lease by its own job, never reached across from the source's lease.
   - **An unreachable linked project** leaves the dependent at status `Review Needed`, exactly as the public-API walk already does for a dependent it cannot refresh (`dfm_propagation.py:148-156`).
8. **Sidecar core parity is enforced by one shared validator — agreed.** Every sidecar writer (the engine contract plus the four method-output contracts) calls it before writing; it asserts the common core of rule 9 and that `audit_log` is last. A cross-writer test exercises all five producers against it. Sequencing step 3 carries this.

## Not Covered

Families a full review flagged beyond the eleven kinds above. Checked 2026-08-22: every one is already `snake_case`, so none needs a key rename — the only question each raises is its version stamp. Dispositions below are defaults, not open decisions.

**In scope — restamp only (rule 2 says every kind moves to `-v4` together, and each reader rejects an unknown stamp outright, so these cannot be left behind):**

- Runtime cache provenance files (one per cached CSV, dotted directory, `arcrho-runtime-cache-provenance-v1` at `config.py:391`). Rename the key `format` → `json_format` and restamp. The converter rewrites them rather than deleting them: a missing or mismatched file just marks the cache stale (`runtime_cache_provenance_service.py:87`), but deleting them all would force every cached CSV in 37 projects to rebuild on first open. The `csv_fingerprint.mtime_ns` inside is legitimate — it describes the cached file beside it and is *meant* to invalidate on copy, unlike the sidecar paths rule 7 removes.
- `dataset_number_formats.json` — restamp `arcrho.dataset-number-formats.v1` (`dataset_number_format_service.py:18`) to the hyphenated `-v4` form. One file per project; the strict reader refuses any other stamp (`:70-74`).
- `source_import.json` — replace `"version": 1` (`source_table_contract.py:34`, `:213`) with `json_format` and restamp. `last_import.csv_path` stays: it is the identity of an *external* source file used to decide whether a re-copy is due (`:221-249`), so it is location-dependent on purpose and unusable from another machine either way.

**Out of scope — not shared workspace data:**

- Shared macro library pointer and manifest (`publish_macro_library.py:166-188`): release artifacts regenerated on every publish, already `snake_case`, versioned by `release_id`. Nothing reads them as workspace data.
- Client-side JSON outside `E:` — `workspace_paths.json` and the AppData tier — machine-local by definition.
- Browser-persisted state: ~20 independently versioned keys, including `arcrho_ui_shell_state_v3` and `_v4` live simultaneously. Not files; a separate cleanup if ever.

**Not a format item:** release fragments under `frontend/changes/`. The migration needs its own fragment; `unreleased/` currently holds several.

Workflow files use `WORKFLOW_EXT = ".arcwf"` (`frontend/app_server/config.py:297`), not `.json`, and are out of scope.

## Artifacts

- **Sample payloads**: `tmp_data/json_contract_v4_samples/` — eleven before/after pairs built from real files, plus `generate_samples.py` to rebuild and `check_samples.py` to verify. `tmp_data/` is gitignored. **Stale since Decisions 2 and 6**: the DFM sample must keep the ratio labels and every sample must carry truncated fingerprints; regenerate before using them as the reference.
- **Visual spec**: published Artifact "ArcRho JSON Contract v4", showing each file kind side by side with removals and additions marked.
- **Current format reference**: `frontend/docs/ui/dfm_json_format.md` documents the v2 shape in spaced names throughout, and must be rewritten rather than edited.

## Recommendation

Proceed with in-place conversion. Do the fingerprint decoupling and the producer reconciliation first, as separate changes, because they are what turn a risky rename into a mechanical one. Treat the `notes_tab` migration as a correctness requirement, not a cleanup detail.
