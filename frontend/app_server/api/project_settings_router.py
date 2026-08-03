from __future__ import annotations

from typing import Any, Dict

from fastapi import APIRouter, status

from app_server.schemas.project_settings import (
    ProjectSettingsUpdateRequest,
    FolderStructureUpdateRequest,
    RenameProjectFolderRequest,
    DuplicateProjectFolderRequest,
    DuplicateProjectFolderJobResponse,
    ProjectDuplicationJobStatusResponse,
    CreateProjectFolderRequest,
    DeleteProjectFolderRequest,
    OpenProjectFolderRequest,
    GeneratedDatasetCacheClearRequest,
    GeneralSettingsUpdateRequest,
)
from app_server.services import project_settings_service

router = APIRouter()


@router.get("/project_settings/{source}/folders")
def get_project_folders(source: str) -> Dict[str, Any]:
    return project_settings_service.get_project_folders(source)


@router.post("/project_settings/{source}/folders")
def update_project_folders(source: str, req: FolderStructureUpdateRequest) -> Dict[str, Any]:
    return project_settings_service.update_project_folders(source, req.folders, req.project_paths)


@router.post("/project_settings/{source}/rename_project_folder")
def rename_project_folder(source: str, req: RenameProjectFolderRequest) -> Dict[str, Any]:
    return project_settings_service.rename_project_folder(source, req.old_name, req.new_name)


@router.post(
    "/project_settings/{source}/duplicate_project_folder",
    response_model=DuplicateProjectFolderJobResponse,
    status_code=status.HTTP_202_ACCEPTED,
)
def duplicate_project_folder(
    source: str,
    req: DuplicateProjectFolderRequest,
) -> DuplicateProjectFolderJobResponse:
    return project_settings_service.duplicate_project_folder(
        source,
        req.old_name,
        req.new_name,
        request_id=req.request_id,
    )


@router.get(
    "/project_settings/{source}/duplicate_project_folder/status/{request_id}",
    response_model=ProjectDuplicationJobStatusResponse,
    response_model_exclude_none=True,
)
def get_duplicate_project_folder_status(
    source: str,
    request_id: str,
) -> ProjectDuplicationJobStatusResponse:
    return project_settings_service.get_duplicate_project_folder_status(
        source,
        request_id,
    )


@router.post("/project_settings/{source}/create_project_folder")
def create_project_folder(source: str, req: CreateProjectFolderRequest) -> Dict[str, Any]:
    return project_settings_service.create_project_folder(source, req.name)


@router.post("/project_settings/{source}/delete_project_folder")
def delete_project_folder(source: str, req: DeleteProjectFolderRequest) -> Dict[str, Any]:
    return project_settings_service.delete_project_folder(source, req.name)


@router.post("/project_settings/{source}/open_project_folder")
def open_project_folder(source: str, req: OpenProjectFolderRequest) -> Dict[str, Any]:
    return project_settings_service.open_project_folder(source, req.project_name)


@router.post("/project_settings/{source}/generated_dataset_cache/clear")
def clear_generated_dataset_csv_caches(source: str, req: GeneratedDatasetCacheClearRequest) -> Dict[str, Any]:
    return project_settings_service.clear_generated_dataset_csv_caches(source, req.project_name)


@router.get("/project_settings/{source}")
def get_project_settings(source: str) -> Dict[str, Any]:
    return project_settings_service.get_project_settings(source)


@router.post("/project_settings/{source}")
def update_project_settings(source: str, req: ProjectSettingsUpdateRequest) -> Dict[str, Any]:
    return project_settings_service.update_project_settings(source, req.data, file_mtime=req.file_mtime)


@router.get("/general_settings")
def get_general_settings(project_name: str) -> Dict[str, Any]:
    return project_settings_service.get_general_settings(project_name)


@router.post("/general_settings")
def update_general_settings(req: GeneralSettingsUpdateRequest) -> Dict[str, Any]:
    return project_settings_service.update_general_settings(
        project_name=req.project_name,
        origin_start_date=req.origin_start_date,
        origin_end_date=req.origin_end_date,
        development_end_date=req.development_end_date,
        auto_generated=bool(req.auto_generated),
    )
