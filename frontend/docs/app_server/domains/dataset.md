# App Server Domain: dataset

## Purpose
<!-- MANUAL:BEGIN -->
Dataset retrieval/patch domain for in-memory dataset instances.
Also handles reserving-class dataset file discovery, sidecar metadata, and dataset Notes persistence under each project `data` folder.
See [`data-engine/docs/dataset-scenarios.md`](../../../../data-engine/docs/dataset-scenarios.md) for the source-kind scenario matrix, editability rules, and cache rebuild behavior.
<!-- MANUAL:END -->

## Entry Points
<!-- AUTO-GEN:BEGIN app_server.dataset.entry_points -->
| Method | Path | Handler | Request Model | Schema | Service Calls |
| --- | --- | --- | --- | --- | --- |
| `POST` | `/dataset/notes/load` | `load_dataset_notes` | `DatasetNotesLoadRequest` | [`app_server/schemas/dataset.py`](../../../app_server/schemas/dataset.py) | `dataset_service.load_dataset_notes` |
| `POST` | `/dataset/notes/save` | `save_dataset_notes` | `DatasetNotesSaveRequest` | [`app_server/schemas/dataset.py`](../../../app_server/schemas/dataset.py) | `dataset_service.save_dataset_notes` |
| `POST` | `/dataset/sidecar/load` | `load_dataset_sidecar` | `DatasetSidecarLoadRequest` | [`app_server/schemas/dataset.py`](../../../app_server/schemas/dataset.py) | `dataset_service.load_dataset_sidecar` |
| `POST` | `/dataset/sidecar/save` | `save_dataset_sidecar` | `DatasetSidecarSaveRequest` | [`app_server/schemas/dataset.py`](../../../app_server/schemas/dataset.py) | `dataset_service.save_dataset_sidecar` |
| `GET` | `/dataset/{ds_id}` | `get_dataset` | `str` | - | `dataset_service.get_dataset` |
| `GET` | `/dataset/{ds_id}/diagonal` | `get_diagonal` | `str` | - | `dataset_service.get_diagonal` |
| `POST` | `/dataset/{ds_id}/patch` | `patch_dataset` | `PatchRequest` | [`app_server/schemas/dataset.py`](../../../app_server/schemas/dataset.py) | `dataset_service.patch_dataset` |
| `GET` | `/datasets` | `list_datasets` | - | - | `dataset_service.list_datasets` |
| `GET` | `/datasets/cached` | `list_cached_dataset_names` | `str` | - | `dataset_service.list_cached_dataset_names` |
| `POST` | `/datasets/cached/delete` | `delete_cached_datasets` | `CachedDatasetDeleteRequest` | [`app_server/schemas/dataset.py`](../../../app_server/schemas/dataset.py) | `dataset_service.delete_cached_datasets` |
| `POST` | `/datasets/cached/empty` | `create_empty_cached_dataset` | `EmptyDatasetCacheCreateRequest` | [`app_server/schemas/dataset.py`](../../../app_server/schemas/dataset.py) | `dataset_service.create_empty_cached_dataset` |
<!-- AUTO-GEN:END -->

## Key Files
<!-- AUTO-GEN:BEGIN app_server.dataset.key_files -->
- [`app_server/api/dataset_router.py`](../../../app_server/api/dataset_router.py) - Dataset query/patch routes.
- [`app_server/services/dataset_service.py`](../../../app_server/services/dataset_service.py) - Dataset in-memory operations.
- [`app_server/schemas/dataset.py`](../../../app_server/schemas/dataset.py) - Dataset patch request model.
- [`ui/shared/api.js`](../../../ui/shared/api.js) - Frontend client wrapper for dataset API.
<!-- AUTO-GEN:END -->

## External Interfaces
<!-- MANUAL:BEGIN -->
- Called by dataset/DFM frontend flows via `shared/api.js`.
- Exposes Notes load/save endpoints for project-scoped dataset notes persistence.
- Exposes dataset sidecar load/save endpoints. Dataset sidecars live in `projects/<project>/data/<ReservingClassFolder>/sidecars/<DatasetName>.json`; save updates only the base sidecar metadata and refreshes the selected reserving-class `index.json`.
- Exposes a project/path cached dataset lookup for Project Instance backed by the reserving-class `index.json` cache. The index resolves `project_name` plus selected reserving-class path to `projects/<project>/data/<ReservingClassFolder>`, then returns logical dataset names inferred from `datasets/*.csv`, `methods/*.json`, and `sidecars/*.json` metadata plus a folder signature derived from physical cache-file names, sizes, modification times, and folder existence. Returned `files` entries are minimal Project Instance table records with base dataset name, latest modified time, earliest created time, user text from related metadata JSON, source kind, editability flags, and method type when applicable. Mode-qualified cache filenames such as `<DatasetName>@12@12@cum@dev.csv` are normalized to one base dataset instance entry; older length-only filenames are treated as literal stems instead of compatibility aliases.
- Exposes cached empty dataset creation for Project Instance non-generated dataset types. The endpoint writes a zero-filled CSV under `datasets/` and base metadata sidecar under `sidecars/`, using the existing length/mode-scoped filename convention and deriving the actual triangle/vector shape from the project's `general_settings.json` date boundaries. For triangles, cells are included only when the origin period plus development period falls on or before `development_end_date`, so older origin periods have wider editable rows and newer periods narrow toward the latest diagonal. Dataset patch validation reuses that date-derived mask when sidecar metadata is available.
- Treats `dataset_types.json` rows with `Calculated=true` and `Generated=false` as app-calculated outputs. Adding one through Project Instance or changing one of its component CSV caches recalculates the output under the selected reserving-class folder, marks the sidecar `source_kind: "calculated"`, `calculated: true`, and `editable: false`, and refreshes the selected reserving-class dataset index.
- Exposes cached dataset deletion for Project Instance. The delete endpoint accepts project, reserving-class path, and logical dataset names, removes matching `datasets/`, `methods/`, and related `sidecars/` files only inside the selected reserving-class data folder, and rebuilds `index.json` afterward.
<!-- MANUAL:END -->

## Data/State/Caches
<!-- MANUAL:BEGIN -->
- Uses in-memory dataset map and patch payloads.
- ArcRhoTri CSV request targets are `projects/<project>/data/<ReservingClassFolder>/datasets/<InstanceName>@<OriginLength>@<DevelopmentLength>@<cum|inc>@<dev|cal>.csv` when `InstanceName` is supplied, otherwise the Dataset Name is used. The metadata sidecar is `sidecars/<InstanceName>.json` and records the generated instance name separately from `dataset_type`, plus `source_kind: "engine"`, `generated: true`, `editable: false`, `data_format`, saved `origin_length`, `development_length`, `cumulative`, `calendar`, `created`, `updated_at`, and user fields. The reserving-class path is a single filename-escaped folder name using the reversible `_%XX_` rule and is not repeated in the CSV filename.
- Project Instance non-generated placeholders are stored under `projects/<project>/data/<ReservingClassFolder>/datasets` with sidecars using `source_kind: "input"`, `generated: false`, and `editable: true`.
- App-calculated outputs also stay under `projects/<project>/data/<ReservingClassFolder>/datasets` but use `source_kind: "calculated"`, `calculated: true`, `editable: false`, `generated: false`, store their formula/dependency metadata in the sidecar, and are recomputed eagerly after editable component patch saves or ArcRhoTri cache writes for component datasets. Formula evaluation supports dataset references, parentheses, and `+`, `-`, `*`, `/`; missing or ambiguous component caches skip the dependent update without failing the source dataset save.
- ArcRhoTri precheck/execution treats a missing variant-specific CSV as a cache miss. When `InstanceName` is supplied, cache validation keys on the sidecar's decoded instance/dataset name plus project and reserving-class path, so manually imported datasets whose `dataset_type` is a broader label such as `Net Loss - ad hoc` can still satisfy DFM/Dataset loads by their visible instance name. Manual `source_kind: "input"` caches are never cleared or regenerated by ArcRhoTri execution; the runtime uses the exact cache when present, can derive coarser period requests from finer cumulative caches (for example monthly to quarterly or annual), and returns an explicit local-cache error when only a coarser fixed-size cache exists or no input sidecar is found. Runtime engine cache creation writes the base sidecar only when it is missing; later sidecar setting changes come from the explicit Dataset sidecar save endpoint so ordinary dataset runs do not overwrite the user's saved period lengths.
- Persists dataset Notes as JSON files in `projects/<project>/data/<ReservingClassFolder>/sidecars/ArcRhoTriNotes@<DatasetName>.json`.
- Cached dataset lookup is read-only and scans the selected reserving-class folder's `datasets/`, `methods/`, and `sidecars/` children, matching CSV caches, DFM method JSON, and sidecar metadata back to logical instance-name candidates after applying the same server-side folder/file sanitizers used by runtime cache writes. Filename-derived fallback names and metadata payload names are decoded from the reversible `_%XX_` form before they are returned for display, so encoded sidecar/method payloads and decoded file-derived names collapse to one logical Project Instance row. The response keeps a short `sha256:` `folder_signature` derived from physical file names, sizes, modification times, and folder existence for frontend stale-content detection, while the saved `files` list remains a compact logical instance list for Project Instance. Each cached instance row stores `dataset_name` as the user-visible instance Name and `dataset_type_name` as the Dataset Type used to open/decorate that instance.
<!-- MANUAL:END -->

## Common Change Tasks
<!-- MANUAL:BEGIN -->
1. Change patch semantics: align schema, service patch rules, and frontend expectations.
<!-- MANUAL:END -->

## Known Risks
<!-- MANUAL:BEGIN -->
- Patch operations can introduce subtle data integrity issues.
<!-- MANUAL:END -->
