from __future__ import annotations

import os
from typing import Any, Dict, List

from fastapi import APIRouter, HTTPException

from app_server import config
from app_server.schemas.book import XlsmPatchRequest
from app_server.services import project_settings_service

router = APIRouter()


@router.get("/project_settings")
def list_project_settings_sources() -> Dict[str, Any]:
    return project_settings_service.list_project_settings_sources()


@router.get("/project_book/meta")
def project_book_meta() -> Dict[str, Any]:
    path = config.PROJECT_BOOK
    if not os.path.exists(path):
        raise HTTPException(404, f"Project index file not found: {path}")

    st = os.stat(path)
    return {
        "path": path,
        "mtime": st.st_mtime,
        "sheets": ["Virtual Projects"],
    }


@router.get("/project_book/sheet")
def project_book_sheet(sheet: str) -> Dict[str, Any]:
    path = config.PROJECT_BOOK
    if not os.path.exists(path):
        raise HTTPException(404, f"Project index file not found: {path}")

    st = os.stat(path)
    data = project_settings_service.project_index_to_sheet_data(project_settings_service._read_project_index())
    sheet_obj = data.get("Virtual Projects") or {}
    values = [list(sheet_obj.get("headers") or [])] + [list(row) for row in (sheet_obj.get("rows") or [])]
    return {"sheet": sheet, "values": values, "mtime": st.st_mtime}


@router.post("/project_book/patch")
def project_book_patch(req: XlsmPatchRequest) -> Dict[str, Any]:
    path = config.PROJECT_BOOK
    if not os.path.exists(path):
        raise HTTPException(404, f"Project index file not found: {path}")

    st = os.stat(path)
    if req.file_mtime is not None and abs(st.st_mtime - req.file_mtime) > 1e-6:
        raise HTTPException(409, "Project index file changed on disk. Reload and retry.")

    try:
        data = project_settings_service.project_index_to_sheet_data(project_settings_service._read_project_index())
        if req.sheet != "Virtual Projects":
            raise HTTPException(404, f"Sheet not found: {req.sheet}")

        sheet_obj = data.get(req.sheet) or {}
        headers = list(sheet_obj.get("headers") or [])
        rows = [list(r) if isinstance(r, list) else [] for r in (sheet_obj.get("rows") or [])]
        matrix: List[List[Any]] = [headers] + rows

        applied = 0
        rejected = []

        for it in req.items:
            rr = it.r
            cc = it.c
            if rr < 0 or cc < 0:
                rejected.append({"r": it.r, "c": it.c, "reason": "out_of_range"})
                continue

            while len(matrix) <= rr:
                matrix.append([])
            while len(matrix[rr]) <= cc:
                matrix[rr].append(None)

            matrix[rr][cc] = it.value
            applied += 1

        if matrix:
            sheet_obj["headers"] = list(matrix[0])
            sheet_obj["rows"] = [list(r) for r in matrix[1:]]
        else:
            sheet_obj["headers"] = []
            sheet_obj["rows"] = []
        data["Virtual Projects"] = sheet_obj
        index_data = project_settings_service.update_project_index_from_sheet_data(data)
        project_settings_service._write_project_index(index_data)

        st2 = os.stat(path)
        return {"ok": True, "applied": applied, "rejected": rejected, "mtime": st2.st_mtime}

    except PermissionError:
        raise HTTPException(423, "Project index file is locked. Close it and retry.")
