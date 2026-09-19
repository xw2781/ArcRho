from __future__ import annotations

from typing import Any, Dict

from fastapi import APIRouter

from app_server.schemas.excel import (
    ExcelBatchReadRequest,
    ExcelCellReadRequest,
    ExcelOpenRequest,
)
from app_server.services import excel_service, workspace_read_client

router = APIRouter()


@router.post("/excel/read_cell")
def excel_read_cell(req: ExcelCellReadRequest) -> Dict[str, Any]:
    return excel_service.excel_read_cell(req.book_path, req.sheet, req.cell)


@router.post("/excel/read_cells_batch")
def excel_read_cells_batch(req: ExcelBatchReadRequest) -> Dict[str, Any]:
    """Read linked workbook cells on the host that has to be able to open them.

    Every workbook read a window performs - the freshness check an opening
    Dataset or DFM window runs, a Links-tab refresh, a formula committed in
    the formula bar - goes through here, and through the gateway whenever one
    offers the read, because ArcRho Server is the machine a retarget and a
    refresh open the workbook on and linked workbooks live on shares. A Client
    PC reads them over its mapped drive only when no gateway answers.
    """

    items = [item.model_dump() for item in req.items]
    if not items:
        return excel_service.excel_read_cells_batch(items)
    return workspace_read_client.run_workspace_read(
        "excel_cell_values",
        {"items": items},
        local=lambda: excel_service.excel_read_cells_batch(items),
    )


@router.post("/excel/open_workbook")
def excel_open_workbook(req: ExcelOpenRequest) -> Dict[str, Any]:
    return excel_service.excel_open_workbook(req.book_path, req.sheet, req.cell)
