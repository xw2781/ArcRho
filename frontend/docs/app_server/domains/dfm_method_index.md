# App Server Domain: Dataset Instance Index

## Purpose
<!-- MANUAL:BEGIN -->
Dataset instance index routes maintain a reserving-class-scoped `dataset_instance_index.json` cache of logical dataset instances, minimal Project Instance table metadata, folder signatures, and method-backed dataset associations. Project Instance uses the index for its cached dataset table, and the DFM Details `Name` selector uses the same index's `methods` list for DFM-backed dataset names.
<!-- MANUAL:END -->

## Entry Points
<!-- MANUAL:BEGIN -->
Routes:

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/dfm/method-index?project_name=<name>&reserving_class=<path>&refresh=false` | Return the cached dataset instance index for a project/reserving-class path, rebuilding it if the cache file is missing or `refresh=true`. |
| `GET` | `/dfm/percent-developed-curve?project_name=<name>&reserving_class=<path>&method_name=<name>` | Read the matching local DFM method JSON from a project and return computed `% Developed` curve points for prior-project comparison overlays. |
| `POST` | `/dfm/method-index/refresh` | Rebuild the reserving-class dataset instance index after a DFM method save, generated dataset cache write, or explicit chooser refresh. |
<!-- MANUAL:END -->

## Key Files
<!-- MANUAL:BEGIN -->
- `app_server/api/dfm_method_index_router.py` - Thin API routes.
- `app_server/schemas/dfm_method_index.py` - Refresh request schema.
- `app_server/services/dataset_instance_index_service.py` - Project/reserving-class path resolution, generated/manual cached file scan, DFM method-file output extraction, metadata collection, folder signature generation, and cache write.
- `ui/dfm/dfm_details.js` - Details `Name` selector UI that consumes the index.
- `ui/dfm/dfm_startup_state.js` - Last-opened DFM object project-user preference state and index refresh helper.
<!-- MANUAL:END -->

## Data/State/Caches
<!-- MANUAL:BEGIN -->
- Cache file path: `projects/<project>/data/manual/<ReservingClassFolder>/dataset_instance_index.json`.
- Indexed method files must match local DFM method storage: `projects/<project>/data/manual/<ReservingClassFolder>/DFM@<Name>.json`.
- The index stores `dataset_names`, `files`, `methods`, `folder_paths`, and `folder_signature`. The `files` list is a logical dataset-instance list for Project Instance, not a physical file inventory: length/mode-scoped CSV variants such as `<DatasetName>@12@12@cum@dev.csv` collapse into the base `<DatasetName>` entry. Each logical entry includes only the dataset name plus table metadata such as latest modified time, earliest created time, user, and `method_type` when the instance is backed by a DFM method. For DFM entries, `dataset_name` comes from `details tab`.`output type` in the `DFM@<Name>.json` method file and `method_type` is `DFM`.
- Normal DFM saves and app-server generated dataset cache writes request an index refresh for the current project/reserving-class path after files are written, so Project Instance and the Details `Name` selector use the shared durable cache instead of scanning folders during every page load.
- `method_index.json` is no longer read as a fallback cache file. Existing folders without `dataset_instance_index.json` rebuild the new file from current cached files when the endpoint is called.
- `% Developed` curve lookup is read-only. It uses the same local DFM filename convention, reads `data tab`.`development labels` for x-axis month indexes, reads `ratios tab`.`ratio triangle`.`development labels` for displayed ratio period labels, reads `ratios tab`.`average formulas`.`selected` and `values`, derives selected/cumulative/% developed values, and returns only plot points and request metadata. Missing or incomplete DFM methods return explicit API errors so the frontend does not add a comparison line.
<!-- MANUAL:END -->

## Known Risks
<!-- MANUAL:BEGIN -->
- Filename parsing assumes the local DFM method filename convention. If method filenames are renamed, update the parser and chooser together.
- The cache lives in each durable reserving-class `data/manual` folder and is duplicated with the project; locked or inaccessible folders surface as API errors in the chooser or Project Instance status areas. External file edits that do not refresh `dataset_instance_index.json` are not reflected until the endpoint rebuilds the index.
<!-- MANUAL:END -->
