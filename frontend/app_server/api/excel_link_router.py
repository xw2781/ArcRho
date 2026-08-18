from __future__ import annotations

from typing import Any, Dict

from fastapi import APIRouter

from app_server.schemas.excel_link import ExcelLinkListRequest, ExcelLinkRetargetRequest
from app_server.services import (
    engine_hosted_save_service,
    excel_link_service,
    workspace_read_client,
)

router = APIRouter()


@router.post("/excel_links/list")
def excel_links_list(req: ExcelLinkListRequest) -> Dict[str, Any]:
    """Host the whole listing, workbook existence included.

    The scan opens every dataset sidecar and DFM method JSON in the class — the
    reads that dominate this load from a Client PC — and whether each linked
    workbook can be opened is answered by the same host, because that host is
    the one every retarget and refresh reads the workbook on. This process
    never stats or opens a workbook itself unless no gateway offers the read.
    """

    project_name, reserving_class = req.project_name, req.reserving_class
    if not str(project_name or "").strip() or not str(reserving_class or "").strip():
        # The canonical 400 belongs to the service; the read contract would
        # reject a blank identifier first with a less useful error.
        return excel_link_service.list_reserving_class_excel_links(
            project_name, reserving_class
        )
    return workspace_read_client.run_workspace_read(
        "excel_link_listing",
        {"project_name": project_name, "reserving_class": reserving_class},
        local=lambda: excel_link_service.list_reserving_class_excel_links(
            project_name, reserving_class
        ),
    )


def _retarget_call(req: ExcelLinkRetargetRequest) -> Dict[str, Any]:
    """The one argument projection the plan and the retarget both run against."""

    return {
        "args": [
            req.project_name,
            req.reserving_class,
            req.old_workbook_path,
            req.new_workbook_path,
        ],
        "kwargs": {},
    }


@router.post("/excel_links/retarget/plan")
def plan_excel_links_retarget(req: ExcelLinkRetargetRequest) -> Dict[str, Any]:
    # Which datasets and method outputs the retarget's walk would reach;
    # nothing is written and no lease is taken.
    return engine_hosted_save_service.run_hosted_save_plan(
        "excel_link_retarget",
        req.project_name,
        req.reserving_class,
        **_retarget_call(req),
    )


@router.post("/excel_links/retarget")
def excel_links_retarget(req: ExcelLinkRetargetRequest) -> Dict[str, Any]:
    # The retarget runs on ArcRho Engine next to the data and opens the new
    # workbook there; this endpoint keeps the service's response shape and
    # error codes, including the 400 for a workbook the server cannot read.
    return engine_hosted_save_service.run_hosted_save(
        "excel_link_retarget",
        req.project_name,
        req.reserving_class,
        **_retarget_call(req),
    )
