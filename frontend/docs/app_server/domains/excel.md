# App Server Domain: excel

## Purpose
<!-- MANUAL:BEGIN -->
Excel integration domain (workbook value reads, lightweight file metadata checks, and workbook operations).
<!-- MANUAL:END -->

## Entry Points
<!-- AUTO-GEN:BEGIN app_server.excel.entry_points -->
| Method | Path | Handler | Request Model | Schema | Service Calls |
| --- | --- | --- | --- | --- | --- |
| `POST` | `/excel/file_mtimes_batch` | `excel_file_mtimes_batch` | `ExcelFileMtimeBatchRequest` | [`app_server/schemas/excel.py`](../../../app_server/schemas/excel.py) | `excel_service.excel_file_mtimes_batch` |
| `POST` | `/excel/open_workbook` | `excel_open_workbook` | `ExcelOpenRequest` | [`app_server/schemas/excel.py`](../../../app_server/schemas/excel.py) | `excel_service.excel_open_workbook` |
| `POST` | `/excel/read_cell` | `excel_read_cell` | `ExcelCellReadRequest` | [`app_server/schemas/excel.py`](../../../app_server/schemas/excel.py) | `excel_service.excel_read_cell` |
| `POST` | `/excel/read_cells_batch` | `excel_read_cells_batch` | `ExcelBatchReadRequest` | [`app_server/schemas/excel.py`](../../../app_server/schemas/excel.py) | `excel_service.excel_read_cells_batch` |
<!-- AUTO-GEN:END -->

## Key Files
<!-- AUTO-GEN:BEGIN app_server.excel.key_files -->
- [`app_server/api/excel_router.py`](../../../app_server/api/excel_router.py) - Excel COM automation routes.
- [`app_server/services/excel_service.py`](../../../app_server/services/excel_service.py) - Excel process interaction logic.
- [`app_server/schemas/excel.py`](../../../app_server/schemas/excel.py) - Excel request payload schemas.
<!-- AUTO-GEN:END -->

## External Interfaces
<!-- MANUAL:BEGIN -->
- Called by interactive Excel-based workflows.
- `/excel/file_mtimes_batch` resolves and deduplicates workbook paths, then reads file metadata with bounded concurrency while preserving request order. It does not open Excel or load workbook contents.
<!-- MANUAL:END -->

## Data/State/Caches
<!-- MANUAL:BEGIN -->
- Workbook value/open operations depend on local Excel automation availability; timestamp checks use filesystem metadata only.
<!-- MANUAL:END -->

## Common Change Tasks
<!-- MANUAL:BEGIN -->
1. Add automation method: schema + router + service must stay aligned.
<!-- MANUAL:END -->

## Known Risks
<!-- MANUAL:BEGIN -->
- Excel COM timing and environment dependencies are fragile.
<!-- MANUAL:END -->
