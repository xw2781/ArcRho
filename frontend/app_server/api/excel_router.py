from __future__ import annotations

from typing import Any, Dict

from fastapi import APIRouter

from app_server.schemas.excel import ExcelCellReadRequest, ExcelBatchReadRequest, ExcelOpenRequest
from app_server.services import excel_service

router = APIRouter()


@router.post("/excel/read_cell")
def excel_read_cell(req: ExcelCellReadRequest) -> Dict[str, Any]:
    return excel_service.excel_read_cell(req.book_path, req.sheet, req.cell)


@router.post("/excel/read_cells_batch")
def excel_read_cells_batch(req: ExcelBatchReadRequest) -> Dict[str, Any]:
    return excel_service.excel_read_cells_batch(req.items)


@router.post("/excel/open_workbook")
def excel_open_workbook(req: ExcelOpenRequest) -> Dict[str, Any]:
    return excel_service.excel_open_workbook(req.book_path, req.sheet, req.cell)
