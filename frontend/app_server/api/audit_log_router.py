"""Project audit log routes.

Both routes run on the server host through the Gateway (see
``audit_service``); a Client PC refuses rather than touching the file over
the share.
"""

from __future__ import annotations

from typing import Any, Dict

from fastapi import APIRouter, HTTPException

from app_server.schemas.audit_log import AuditLogWriteRequest
from app_server.services import audit_service, workspace_read_client

router = APIRouter()


@router.get("/audit_log")
def get_audit_log(project_name: str, limit: int = 500) -> Dict[str, Any]:
    project_name_clean = str(project_name or "").strip()
    if not project_name_clean:
        raise HTTPException(400, "Missing project_name parameter")

    try:
        out = workspace_read_client.run_workspace_read(
            audit_service.AUDIT_LOG_READ_KIND,
            {"project_name": project_name_clean, "limit": limit},
            local=lambda: audit_service.read_audit_log(project_name_clean, limit=limit),
            gateway_required=True,
        )
        return {"ok": True, **out}
    except ValueError as e:
        raise HTTPException(404, str(e))


@router.post("/audit_log")
def write_audit_log(req: AuditLogWriteRequest) -> Dict[str, Any]:
    project_name = str(req.project_name or "").strip()
    action = str(req.action or "").strip()
    if not project_name:
        raise HTTPException(400, "project_name is required")
    if not action:
        raise HTTPException(400, "action is required")
    if len(action) > 2000:
        raise HTTPException(400, "action is too long")
    try:
        out = audit_service.submit_project_audit_log_append(
            project_name=project_name,
            action=action,
            user_name=req.user_name,
        )
        return {"ok": True, **out}
    except HTTPException:
        raise
    except ValueError as e:
        raise HTTPException(404, str(e))
    except PermissionError:
        raise HTTPException(423, "Audit log file is locked. Another user may have it open.")
    except Exception as e:
        raise HTTPException(500, f"Failed to write audit log: {str(e)}")
