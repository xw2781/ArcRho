from __future__ import annotations

from typing import Any, Dict, List

from fastapi import APIRouter, HTTPException

from app_server.schemas.dataset import (
    CachedDatasetDeleteRequest,
    DatasetNotesLoadRequest,
    DatasetNotesSaveRequest,
    DatasetSidecarLoadRequest,
    DatasetSidecarSaveRequest,
    PatchRequest,
)
from app_server.services import dataset_service

router = APIRouter()


@router.get("/datasets")
def list_datasets() -> List[Dict[str, Any]]:
    return dataset_service.list_datasets()


@router.get("/datasets/cached")
def list_cached_dataset_names(project_name: str, reserving_class: str) -> Dict[str, Any]:
    return dataset_service.list_cached_dataset_names(project_name, reserving_class)


@router.post("/datasets/cached/delete")
def delete_cached_datasets(req: CachedDatasetDeleteRequest) -> Dict[str, Any]:
    return dataset_service.delete_cached_datasets(
        req.project_name,
        req.reserving_class,
        req.dataset_names,
    )


@router.get("/dataset/{ds_id}")
def get_dataset(ds_id: str, start_year: int = 2016) -> Dict[str, Any]:
    result = dataset_service.get_dataset(ds_id, start_year=start_year)
    if result is None:
        raise HTTPException(404, f"Unknown dataset: {ds_id}")
    return result


@router.get("/dataset/{ds_id}/diagonal")
def get_diagonal(ds_id: str, k: int = 0, start_year: int = 2016) -> Dict[str, Any]:
    result = dataset_service.get_diagonal(ds_id, k=k, start_year=start_year)
    if result is None:
        raise HTTPException(404, f"Unknown dataset: {ds_id}")
    return result


@router.post("/dataset/{ds_id}/patch")
def patch_dataset(ds_id: str, req: PatchRequest) -> Dict[str, Any]:
    result = dataset_service.patch_dataset(ds_id, req.items, file_mtime=req.file_mtime)
    if result is None:
        raise HTTPException(404, f"Unknown dataset: {ds_id}")
    if result.get("conflict"):
        raise HTTPException(409, "File changed on disk. Reload and retry.")
    return result


@router.post("/dataset/notes/load")
def load_dataset_notes(req: DatasetNotesLoadRequest) -> Dict[str, Any]:
    return dataset_service.load_dataset_notes(
        req.project_name,
        req.reserving_class,
        req.dataset_name,
    )


@router.post("/dataset/notes/save")
def save_dataset_notes(req: DatasetNotesSaveRequest) -> Dict[str, Any]:
    return dataset_service.save_dataset_notes(
        req.project_name,
        req.reserving_class,
        req.dataset_name,
        req.notes,
    )


@router.post("/dataset/sidecar/load")
def load_dataset_sidecar(req: DatasetSidecarLoadRequest) -> Dict[str, Any]:
    return dataset_service.load_dataset_sidecar(
        req.project_name,
        req.reserving_class,
        req.dataset_name,
    )


@router.post("/dataset/sidecar/save")
def save_dataset_sidecar(req: DatasetSidecarSaveRequest) -> Dict[str, Any]:
    return dataset_service.save_dataset_sidecar(
        req.project_name,
        req.reserving_class,
        req.dataset_name,
        origin_length=req.origin_length,
        development_length=req.development_length,
        cumulative=req.cumulative,
        calendar=req.calendar,
        csv_file=req.csv_file,
    )
