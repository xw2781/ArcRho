from __future__ import annotations

from typing import Any, Dict

from fastapi import APIRouter

from app_server.schemas.excel_link import ExcelLinkListRequest, ExcelLinkRetargetRequest
from app_server.services import excel_link_service, workspace_read_client

router = APIRouter()


@router.post("/excel_links/list")
def excel_links_list(req: ExcelLinkListRequest) -> Dict[str, Any]:
    """Host the reserving-class scan; resolve the workbooks on this machine.

    The scan opens every dataset sidecar and DFM method JSON in the class — the
    reads that dominate this load from a Client PC — so it runs on the ArcRho
    Server host when the gateway offers it. The workbooks those references
    point at are a different matter: they sit on other file servers reached
    through drive letters this PC maps and the server host may not, so their
    existence is resolved here for either transport.
    """

    project_name, reserving_class = req.project_name, req.reserving_class
    if not str(project_name or "").strip() or not str(reserving_class or "").strip():
        # The canonical 400 belongs to the service; the read contract would
        # reject a blank identifier first with a less useful error.
        return excel_link_service.list_reserving_class_excel_links(
            project_name, reserving_class
        )
    return excel_link_service.resolve_workbook_stats(
        workspace_read_client.run_workspace_read(
            "excel_link_scan",
            {"project_name": project_name, "reserving_class": reserving_class},
            local=lambda: excel_link_service.scan_reserving_class_excel_links(
                project_name, reserving_class
            ),
        )
    )


def _load_listing(project_name: str, reserving_class: str) -> Dict[str, Any]:
    """The list route's own answer, for the inventory a retarget returns with."""

    return excel_links_list(
        ExcelLinkListRequest(project_name=project_name, reserving_class=reserving_class)
    )


@router.post("/excel_links/retarget")
def excel_links_retarget(req: ExcelLinkRetargetRequest) -> Dict[str, Any]:
    return excel_link_service.retarget_reserving_class_workbook(
        req.project_name,
        req.reserving_class,
        req.old_workbook_path,
        req.new_workbook_path,
        refresh_values=req.refresh_values,
        listing=_load_listing,
    )
