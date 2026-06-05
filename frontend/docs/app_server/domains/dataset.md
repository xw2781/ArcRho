# App Server Domain: dataset

## Purpose
<!-- MANUAL:BEGIN -->
Dataset retrieval/patch domain for in-memory dataset instances.
Also handles generated/manual dataset file discovery and dataset Notes persistence under each project `data` folder.
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
- Exposes generated dataset sidecar load/save endpoints. Dataset sidecar load reads `projects/<project>/data/generated/<ReservingClassFolder>/<DatasetName>.json`; save updates only the base sidecar metadata and refreshes the selected reserving-class `dataset_instance_index.json`.
- Exposes a project/path cached dataset lookup for Project Instance backed by the reserving-class `dataset_instance_index.json` cache. The index resolves `project_name` plus selected reserving-class path to both `projects/<project>/data/generated/<ReservingClassFolder>` and `projects/<project>/data/manual/<ReservingClassFolder>`, then returns logical dataset names inferred from `.csv` files and metadata `.json` sidecars plus a folder signature derived from physical cache-file names, sizes, modification times, and folder existence. Returned `files` entries are minimal Project Instance table records with base dataset name, latest modified time, earliest created time, user text from related metadata JSON, and method type when applicable. Length/mode-scoped cache filenames such as `<DatasetName>@12@12.csv`, `<DatasetName>@12@12@cum@dev.csv`, or older matching JSON sidecars are normalized to one base dataset instance entry.
- Exposes cached dataset deletion for Project Instance. The delete endpoint accepts project, reserving-class path, and logical dataset names, removes matching `.csv`/`.json` cache files only inside the selected generated/manual reserving-class cache folders, and rebuilds `dataset_instance_index.json` afterward.
<!-- MANUAL:END -->

## Data/State/Caches
<!-- MANUAL:BEGIN -->
- Uses in-memory dataset map and patch payloads.
- ArcRhoTri CSV request targets are `projects/<project>/data/generated/<ReservingClassFolder>/<DatasetName>@<OriginLength>@<DevelopmentLength>@<cum|inc>@<dev|cal>.csv`; the metadata sidecar is the base `<DatasetName>.json` file and records dataset type/instance labels, `data_format`, saved `origin_length`, `development_length`, `cumulative`, `calendar`, `created`, `updated_at`, and user fields. The reserving-class path is a single filename-escaped folder name using the reversible `_%XX_` rule and is not repeated in the CSV filename.
- ArcRhoTri precheck/execution treats a missing variant-specific CSV as a cache miss. Runtime cache creation writes the base sidecar only when it is missing; later sidecar setting changes come from the explicit Dataset sidecar save endpoint so ordinary dataset runs do not overwrite the user's saved period lengths.
- Persists dataset Notes as JSON files in `projects/<project>/data/manual/<ReservingClassFolder>/ArcRhoTriNotes@<DatasetName>.json`.
- Cached dataset lookup is read-only and scans both generated and manual folders for the selected reserving-class path, matching `.csv` and `.json` filenames/sidecars back to logical dataset-name candidates after applying the same server-side folder/file sanitizers used by runtime cache writes. The response keeps physical `size`, `mtime`, and `mtime_ns` details inside `folder_signature` for frontend stale-content detection, while the saved `files` list remains a compact logical instance list for Project Instance.
<!-- MANUAL:END -->

## Common Change Tasks
<!-- MANUAL:BEGIN -->
1. Change patch semantics: align schema, service patch rules, and frontend expectations.
<!-- MANUAL:END -->

## Known Risks
<!-- MANUAL:BEGIN -->
- Patch operations can introduce subtle data integrity issues.
<!-- MANUAL:END -->
