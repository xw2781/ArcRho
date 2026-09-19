# App Server Domain: excel

## Purpose
<!-- MANUAL:BEGIN -->
Excel integration domain (workbook value reads, lightweight file metadata checks, and workbook operations).
<!-- MANUAL:END -->

## Entry Points
<!-- AUTO-GEN:BEGIN app_server.excel.entry_points -->
| Method | Path | Handler | Request Model | Schema | Service Calls |
| --- | --- | --- | --- | --- | --- |
| `POST` | `/excel/open_workbook` | `excel_open_workbook` | `ExcelOpenRequest` | [`app_server/schemas/excel.py`](../../../app_server/schemas/excel.py) | `excel_service.excel_open_workbook` |
| `POST` | `/excel/read_cell` | `excel_read_cell` | `ExcelCellReadRequest` | [`app_server/schemas/excel.py`](../../../app_server/schemas/excel.py) | `excel_service.excel_read_cell` |
| `POST` | `/excel/read_cells_batch` | `excel_read_cells_batch` | `ExcelBatchReadRequest` | [`app_server/schemas/excel.py`](../../../app_server/schemas/excel.py) | `excel_service.excel_read_cells_batch`, `workspace_read_client.run_workspace_read` |
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
- `/excel/read_cells_batch` is the one workbook cell read every window shares: the freshness check an opening Dataset or DFM method runs against its saved links, the Links-tab refresh, a formula committed in the formula bar, and the B&S CRA link check. Every cell is answered on its own: a missing sheet, an address the sheet cannot resolve, or a non-numeric value (a `#REF!` left by a deleted row) is that cell's error and leaves the other cells of the same workbook with their real values, so a caller can tell a broken reference from a value that merely moved. `workbook_cell_value` is the single rule for what one workbook cell means and is shared by `excel_read_cell` and the batch read: a cell that reads as empty — never filled, outside the used range, or a formula whose cached result is an empty or whitespace-only string — is the blank ArcRho stores as `null`, not an error.
- It is the registered `excel_cell_values` [workspace read](workspace_reads.md), so the workbook is opened on the ArcRho Server host whenever a gateway offers the read, for the same reason the Excel Link Manager's check opens it there: that host is the one a refresh and a retarget have to be able to read the workbook on, and reading workbooks over SMB from a Client PC is the transport being retired. A Client PC opens them over its mapped drive only when no gateway answers. The kind names no project — each item carries the workbook path it asks about and the read touches no workspace file — and a request with no item is served locally without a round trip, because the read contract refuses a request whose only argument is empty.
- No route reports a workbook's modification time. Freshness is a value comparison everywhere: the caller reads the linked cells and compares them with the numbers it stores, which is what the Excel Link Manager's `/excel_links/check` does for a whole reserving class. A workbook saved with no change to a linked cell is not a change.
<!-- MANUAL:END -->

## Data/State/Caches
<!-- MANUAL:BEGIN -->
- A batch read groups its cells by workbook and then by sheet, and answers each sheet from one walk of the rectangle its requested cells span. A read-only worksheet re-reads the sheet from its first row every time it is asked for a single address, so reading a linked range address by address costs one pass per cell — a 120x120 range took roughly a quarter of an hour and now takes well under a second. Every walk is run to its end rather than abandoned once the last requested cell is answered, because a worksheet only releases the sheet's XML stream when its walk finishes, and a stream left open keeps the workbook file locked against the person editing it in Excel. `excel_read_cell` is the same reader asked for one cell, so a single read and a batch read can never disagree.
- Cell reads and the readability probe (`excel_workbook_readable`) are plain openpyxl file reads that need no Excel installation, so they run wherever the workbook is reachable — on ArcRho Server for every hosted read; only opening a workbook in Excel needs local automation. `excel_workbook_properties_batch` stats each path and reads its `docProps/core.xml` in one worker, and is the Excel Link Manager listing's alone.
<!-- MANUAL:END -->

## Common Change Tasks
<!-- MANUAL:BEGIN -->
1. Add automation method: schema + router + service must stay aligned.
<!-- MANUAL:END -->

## Known Risks
<!-- MANUAL:BEGIN -->
- Excel COM timing and environment dependencies are fragile.
<!-- MANUAL:END -->
