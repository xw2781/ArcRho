# App Server Index

## Purpose
<!-- MANUAL:BEGIN -->
App-server domain map for FastAPI routers, schemas, and services.
<!-- MANUAL:END -->

## Entry Points
<!-- AUTO-GEN:BEGIN app_server.index.entry_points -->
| Domain | Router | Route Count | Domain Index |
| --- | --- | --- | --- |
| `app_control` | [`app_server/api/app_control_router.py`](../../app_server/api/app_control_router.py) | 4 | [`app_control.md`](domains/app_control.md) |
| `arcrho` | [`app_server/api/arcrho_router.py`](../../app_server/api/arcrho_router.py) | 6 | [`arcrho.md`](domains/arcrho.md) |
| `audit_log` | [`app_server/api/audit_log_router.py`](../../app_server/api/audit_log_router.py) | 2 | [`audit_log.md`](domains/audit_log.md) |
| `book` | [`app_server/api/book_router.py`](../../app_server/api/book_router.py) | 3 | [`book.md`](domains/book.md) |
| `dataset` | [`app_server/api/dataset_router.py`](../../app_server/api/dataset_router.py) | 10 | [`dataset.md`](domains/dataset.md) |
| `dataset_types` | [`app_server/api/dataset_types_router.py`](../../app_server/api/dataset_types_router.py) | 3 | [`dataset_types.md`](domains/dataset_types.md) |
| `excel` | [`app_server/api/excel_router.py`](../../app_server/api/excel_router.py) | 5 | [`excel.md`](domains/excel.md) |
| `field_mapping` | [`app_server/api/field_mapping_router.py`](../../app_server/api/field_mapping_router.py) | 2 | [`field_mapping.md`](domains/field_mapping.md) |
| `project_book` | [`app_server/api/project_book_router.py`](../../app_server/api/project_book_router.py) | 4 | [`project_book.md`](domains/project_book.md) |
| `project_settings` | [`app_server/api/project_settings_router.py`](../../app_server/api/project_settings_router.py) | 11 | [`project_settings.md`](domains/project_settings.md) |
| `reserving_class` | [`app_server/api/reserving_class_router.py`](../../app_server/api/reserving_class_router.py) | 11 | [`reserving_class.md`](domains/reserving_class.md) |
| `table_summary` | [`app_server/api/table_summary_router.py`](../../app_server/api/table_summary_router.py) | 2 | [`table_summary.md`](domains/table_summary.md) |
| `workflow` | [`app_server/api/workflow_router.py`](../../app_server/api/workflow_router.py) | 5 | [`workflow.md`](domains/workflow.md) |
| `workspace_paths` | [`app_server/api/workspace_paths_router.py`](../../app_server/api/workspace_paths_router.py) | 2 | [`workspace_paths.md`](domains/workspace_paths.md) |
<!-- AUTO-GEN:END -->

## Key Files
<!-- AUTO-GEN:BEGIN app_server.index.key_files -->
- [`app_server/main.py`](../../app_server/main.py) - FastAPI app creation, router registration, static mount.
- [`app_server/api/__init__.py`](../../app_server/api/__init__.py) - Router exports consumed by app startup.
- [`app_server/config.py`](../../app_server/config.py) - Runtime path/config constants and helpers.
- [`app_server/helpers.py`](../../app_server/helpers.py) - Cross-domain utility helpers.
<!-- AUTO-GEN:END -->

## Non-Negotiable Contracts
<!-- MANUAL:BEGIN -->
Mandatory before app-server logic/API/architecture changes:
1. [`../contracts/business_logic_contract.md`](../contracts/business_logic_contract.md)
2. [`../architecture/architecture_guardrails.md`](../architecture/architecture_guardrails.md)
3. [`../contracts/frontend_behavior_contract.md`](../contracts/frontend_behavior_contract.md) for cross-frame/API behavior coupling

High-risk files that must follow contracts:
- `app_server/api/*.py`
- `app_server/services/*.py`
- `app_server/config.py`
<!-- MANUAL:END -->

## External Interfaces
<!-- MANUAL:BEGIN -->
- Public interface is HTTP routes mounted by `app_server/main.py`; the frontend shell is served under `/ui` and shared icon assets under `/icons`.
- Internal interface is router -> service -> filesystem/state helpers.
- Packaged builds include the `arcrho_api` Python package in the frozen app server for scripting-console imports, and ship a pip-installable wheel under app resources `python_packages/` for external notebook environments.
<!-- MANUAL:END -->

## Data/State/Caches
<!-- MANUAL:BEGIN -->
- Path and cache constants are centralized in `app_server/config.py`.
- Several domains persist JSON caches under project folders or AppData.
- Scripting notebook persistence is file-based under `~/Documents/ArcRho/scripts`; save writes `.ipynb` with code-cell outputs/execution counts and load accepts `.ipynb`, legacy `.arcnb`, and `.py` scripting files from that directory.
- Scripting execution interrupt uses per-session cancellation with trace checks and an interruptible `time.sleep(...)` import hook so `/scripting/interrupt` can stop active cells promptly; `/scripting/run-stream` emits NDJSON stdout/stderr events for live output during long-running cells.
<!-- MANUAL:END -->

## Common Change Tasks
<!-- MANUAL:BEGIN -->
1. Add route: update one router file under `app_server/api`, schema under `app_server/schemas`, and service under `app_server/services`.
2. Change payload contract: update schema first, then router/service.
3. Change project path behavior: sync with [`../runtime/config_paths.md`](../runtime/config_paths.md).
<!-- MANUAL:END -->

## Known Risks
<!-- MANUAL:BEGIN -->
- File-based persistence and path assumptions are sensitive to environment setup.
- Domain cross-calls (for example, table summary -> reserving class refresh) can add side effects.
<!-- MANUAL:END -->
