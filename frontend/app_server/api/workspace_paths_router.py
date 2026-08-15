from __future__ import annotations

from typing import Any, Dict

from fastapi import APIRouter, HTTPException

from app_server import config
from app_server.schemas.workspace_paths import WorkspacePathsUpdateRequest
from app_server.services import hosted_save_enrollment_service

router = APIRouter()


def _with_path_overrides(cfg: Dict[str, Any], req: WorkspacePathsUpdateRequest) -> Dict[str, Any]:
    workspace_root = req.workspace_root.strip()
    if not workspace_root:
        raise HTTPException(400, "workspace_root is required.")

    paths = dict(cfg.get("paths") or {})
    if req.paths:
        updates = req.paths.dict(exclude_none=True)
        paths.update(updates)
    return {
        "workspace_root": workspace_root,
        "paths": {
            "projects_dir": config._clean_path_segment(
                paths.get("projects_dir"),
                config.DEFAULT_WORKSPACE_PATHS["projects_dir"],
            ),
            "requests_dir": config._clean_path_segment(
                paths.get("requests_dir"),
                config.DEFAULT_WORKSPACE_PATHS["requests_dir"],
            ),
        },
    }


def _persist_workspace_paths(cfg: Dict[str, Any]) -> Dict[str, Any]:
    try:
        config.save_workspace_paths(cfg)
        config.refresh_runtime_paths()
        config.clear_runtime_path_caches()
        return {
            "ok": True,
            "config": config.load_workspace_paths(),
            "config_exists": config.workspace_paths_file_exists(),
        }
    except Exception as e:
        raise HTTPException(500, f"Failed to save workspace paths: {str(e)}")


@router.get("/workspace_paths")
def get_workspace_paths() -> Dict[str, Any]:
    return {
        "ok": True,
        "config": config.load_workspace_paths(),
        "config_exists": config.workspace_paths_file_exists(),
    }


@router.post("/workspace_paths")
def update_workspace_paths(req: WorkspacePathsUpdateRequest) -> Dict[str, Any]:
    cfg = _with_path_overrides(config.load_workspace_paths(), req)
    response = _persist_workspace_paths(cfg)
    hosted_save_enrollment_service.auto_enroll_current_user()
    return response
