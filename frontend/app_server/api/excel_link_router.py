from __future__ import annotations

from typing import Any, Dict

from fastapi import APIRouter

from app_server.schemas.excel_link import (
    ExcelLinkBreakRequest,
    ExcelLinkListRequest,
    ExcelLinkRefreshRequest,
    ExcelLinkRetargetRequest,
)
from app_server.services import (
    engine_hosted_save_service,
    excel_link_service,
    workspace_read_client,
)

router = APIRouter()


def _hosted_class_read(read_kind: str, read, req: ExcelLinkListRequest) -> Dict[str, Any]:
    """Host one whole-class read, workbook access included.

    The scan opens every dataset sidecar and DFM method JSON in the class — the
    reads that dominate this load from a Client PC — and whatever the read
    asks of each linked workbook is answered by the same host, because that
    host is the one every retarget and refresh reads the workbook on. This
    process never stats or opens a workbook itself unless no gateway offers
    the read.
    """

    project_name, reserving_class = req.project_name, req.reserving_class
    if not str(project_name or "").strip() or not str(reserving_class or "").strip():
        # The canonical 400 belongs to the service; the read contract would
        # reject a blank identifier first with a less useful error.
        return read(project_name, reserving_class)
    return workspace_read_client.run_workspace_read(
        read_kind,
        {"project_name": project_name, "reserving_class": reserving_class},
        local=lambda: read(project_name, reserving_class),
    )


@router.post("/excel_links/list")
def excel_links_list(req: ExcelLinkListRequest) -> Dict[str, Any]:
    # Workbook existence and the file-time status, from the host's own stat.
    return _hosted_class_read(
        "excel_link_listing", excel_link_service.list_reserving_class_excel_links, req
    )


@router.post("/excel_links/check")
def excel_links_check(req: ExcelLinkListRequest) -> Dict[str, Any]:
    # The same listing with each status settled by reading the linked cells
    # and comparing them with the stored values; the workbooks open on the host.
    return _hosted_class_read(
        "excel_link_value_check", excel_link_service.check_reserving_class_excel_link_values, req
    )


def _refresh_call(req: ExcelLinkRefreshRequest) -> Dict[str, Any]:
    """The one argument projection the plan and the refresh both run against."""

    return {
        "args": [req.project_name, req.reserving_class],
        "kwargs": {"targets": [target.model_dump() for target in req.targets]},
    }


@router.post("/excel_links/refresh/plan")
def plan_excel_links_refresh(req: ExcelLinkRefreshRequest) -> Dict[str, Any]:
    return engine_hosted_save_service.run_hosted_save_plan(
        "excel_link_refresh", req.project_name, req.reserving_class, **_refresh_call(req)
    )


@router.post("/excel_links/refresh")
def excel_links_refresh(req: ExcelLinkRefreshRequest) -> Dict[str, Any]:
    # Re-reads the accepted objects' linked cells on Arco Engine and saves the
    # ones whose values moved, then walks the class once.
    return engine_hosted_save_service.run_hosted_save(
        "excel_link_refresh", req.project_name, req.reserving_class, **_refresh_call(req)
    )


def _break_call(req: ExcelLinkBreakRequest) -> Dict[str, Any]:
    """The one argument projection the plan and the break both run against."""

    return {
        "args": [req.project_name, req.reserving_class],
        "kwargs": {"targets": [target.model_dump() for target in req.targets]},
    }


@router.post("/excel_links/break/plan")
def plan_excel_links_break(req: ExcelLinkBreakRequest) -> Dict[str, Any]:
    return engine_hosted_save_service.run_hosted_save_plan(
        "excel_link_break", req.project_name, req.reserving_class, **_break_call(req)
    )


@router.post("/excel_links/break")
def excel_links_break(req: ExcelLinkBreakRequest) -> Dict[str, Any]:
    # Drops the named objects' references to the named workbooks on Arco
    # Engine and saves them; no workbook is opened and no value moves.
    return engine_hosted_save_service.run_hosted_save(
        "excel_link_break", req.project_name, req.reserving_class, **_break_call(req)
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
    # The retarget runs on Arco Engine next to the data and opens the new
    # workbook there; this endpoint keeps the service's response shape and
    # error codes, including the 400 for a workbook the server cannot read.
    return engine_hosted_save_service.run_hosted_save(
        "excel_link_retarget",
        req.project_name,
        req.reserving_class,
        **_retarget_call(req),
    )
