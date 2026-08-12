from __future__ import annotations

from typing import Any, Dict

from fastapi import APIRouter

from app_server.schemas.excel_link import ExcelLinkListRequest, ExcelLinkRetargetRequest
from app_server.services import excel_link_service

router = APIRouter()


@router.post("/excel_links/list")
def excel_links_list(req: ExcelLinkListRequest) -> Dict[str, Any]:
    return excel_link_service.list_reserving_class_excel_links(
        req.project_name, req.reserving_class
    )


@router.post("/excel_links/retarget")
def excel_links_retarget(req: ExcelLinkRetargetRequest) -> Dict[str, Any]:
    return excel_link_service.retarget_reserving_class_workbook(
        req.project_name,
        req.reserving_class,
        req.old_workbook_path,
        req.new_workbook_path,
        refresh_values=req.refresh_values,
    )
