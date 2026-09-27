from __future__ import annotations

from typing import Any, Dict

from fastapi import APIRouter, HTTPException

from app_server import config
from app_server.schemas.workspace_paths import (
    ServerProfileActivateRequest,
    ServerProfileSaveRequest,
    WorkspacePathsUpdateRequest,
)
from app_server.services import hosted_save_enrollment_service, server_profile_service

router = APIRouter()


def _with_path_overrides(cfg: Dict[str, Any], req: WorkspacePathsUpdateRequest) -> Dict[str, Any]:
    workspace_root = req.workspace_root.strip()
    if not workspace_root:
        raise HTTPException(400, "workspace_root is required.")

    paths = dict(cfg.get("paths") or {})
    if req.paths:
        paths.update(req.paths.dict(exclude_none=True))
    return {"workspace_root": workspace_root, "paths": paths}


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


@router.get("/server_profiles")
def get_server_profiles() -> Dict[str, Any]:
    return server_profile_service.list_server_profiles()


@router.get("/server_profiles/health")
def get_server_health(id: str = "") -> Dict[str, Any]:
    return server_profile_service.server_health(id)


@router.get("/server/status")
def get_server_component_status() -> Dict[str, Any]:
    return server_profile_service.server_component_status()


@router.post("/server/start")
def start_server() -> Dict[str, Any]:
    return server_profile_service.start_active_server()


@router.post("/server/stop")
def stop_server() -> Dict[str, Any]:
    return server_profile_service.stop_active_server()


@router.get("/server_profiles/inspect")
def inspect_server_folder(root: str) -> Dict[str, Any]:
    return server_profile_service.inspect_server_folder(root)


@router.post("/server_profiles")
def save_server_profile(req: ServerProfileSaveRequest) -> Dict[str, Any]:
    return server_profile_service.save_server_profile(
        name=req.name,
        root=req.root,
        profile_id=req.id or "",
        gateway_config=req.gateway_config or "",
    )


@router.post("/server_profiles/activate")
def activate_server_profile(req: ServerProfileActivateRequest) -> Dict[str, Any]:
    return server_profile_service.activate_server_profile(req.id)
