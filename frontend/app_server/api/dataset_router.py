from __future__ import annotations

from typing import Any, Dict, List

from fastapi import APIRouter, HTTPException

from app_server.schemas.dataset import (
    CachedDatasetDeleteRequest,
    DatasetCacheLoadRequest,
    DatasetCalculatedPreviewRequest,
    DatasetNotesSaveRequest,
    DatasetNumberFormatsSaveRequest,
    DatasetSidecarLoadRequest,
    DatasetSidecarSaveRequest,
    EmptyDatasetCacheCreateRequest,
    PatchRequest,
)
from app_server.services import dataset_service, engine_hosted_save_service
from app_server.services import calculated_dataset_service
from app_server.services import dataset_number_format_service

router = APIRouter()


@router.get("/dataset/number-format-defaults")
def get_dataset_number_format_defaults(
    dataset_type_name: str = "",
) -> Dict[str, Any]:
    return dataset_number_format_service.get_preferences(
        dataset_type_name=dataset_type_name,
    )


@router.put("/dataset/number-format-defaults")
def save_dataset_number_format_defaults(req: DatasetNumberFormatsSaveRequest) -> Dict[str, Any]:
    return dataset_number_format_service.save_preferences(
        expected_revision=req.expected_revision,
        default_number_format=req.default_number_format,
        overrides=[item.model_dump() for item in req.overrides],
    )


@router.get("/datasets")
def list_datasets() -> List[Dict[str, Any]]:
    return dataset_service.list_datasets()


@router.get("/datasets/cached")
def list_cached_dataset_names(project_name: str, reserving_class: str, refresh: bool = False) -> Dict[str, Any]:
    return dataset_service.list_cached_dataset_names(project_name, reserving_class, refresh=refresh)


@router.post("/datasets/cached/delete")
def delete_cached_datasets(req: CachedDatasetDeleteRequest) -> Dict[str, Any]:
    return dataset_service.delete_cached_datasets(
        req.project_name,
        req.reserving_class,
        req.dataset_names,
    )


@router.post("/datasets/cached/empty")
def create_empty_cached_dataset(req: EmptyDatasetCacheCreateRequest) -> Dict[str, Any]:
    return dataset_service.create_empty_cached_dataset(
        req.project_name,
        req.reserving_class,
        req.dataset_type,
        instance_name=req.instance_name,
        data_format=req.data_format,
        origin_length=req.origin_length,
        development_length=req.development_length,
        cumulative=req.cumulative,
        calendar=req.calendar,
    )


@router.get("/dataset/{ds_id}")
def get_dataset(ds_id: str, project_name: str, origin_length: int) -> Dict[str, Any]:
    result = dataset_service.get_dataset(ds_id, project_name=project_name, origin_length=origin_length)
    if result is None:
        raise HTTPException(404, f"Unknown dataset: {ds_id}")
    return result


@router.get("/dataset/{ds_id}/diagonal")
def get_diagonal(ds_id: str, project_name: str, origin_length: int, k: int = 0) -> Dict[str, Any]:
    result = dataset_service.get_diagonal(
        ds_id,
        project_name=project_name,
        origin_length=origin_length,
        k=k,
    )
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


@router.post("/dataset/sidecar/load")
def load_dataset_sidecar(req: DatasetSidecarLoadRequest) -> Dict[str, Any]:
    return dataset_service.load_dataset_sidecar(
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


@router.post("/dataset/cache/load")
def load_dataset_cache(req: DatasetCacheLoadRequest) -> Dict[str, Any]:
    return dataset_service.load_cached_dataset_values(
        req.project_name,
        req.reserving_class,
        req.dataset_name,
        csv_file=req.csv_file,
        origin_length=req.origin_length,
        development_length=req.development_length,
        cumulative=req.cumulative,
        calendar=req.calendar,
    )


@router.post("/dataset/calculated/preview")
def preview_calculated_dataset_dependents(req: DatasetCalculatedPreviewRequest) -> Dict[str, Any]:
    return calculated_dataset_service.preview_dependents(
        req.project_name,
        req.reserving_class,
        req.changed_dataset_name,
        changed_dataset_type_name=req.changed_dataset_type_name,
        values=req.values,
        mask=req.mask,
        origin_labels=req.origin_labels,
        development_labels=req.development_labels,
    )


@router.post("/dataset/sidecar/save")
def save_dataset_sidecar(req: DatasetSidecarSaveRequest) -> Dict[str, Any]:
    # The save runs on ArcRho Engine next to the data; this endpoint keeps
    # its exact response shape and error codes.
    return engine_hosted_save_service.run_hosted_save(
        "dataset_sidecar",
        req.project_name,
        req.reserving_class,
        args=[req.project_name, req.reserving_class, req.dataset_name],
        kwargs={
            "dataset_type": req.dataset_type,
            "instance_name": req.instance_name,
            "source_kind": req.source_kind,
            "data_format": req.data_format,
            "origin_length": req.origin_length,
            "development_length": req.development_length,
            "cumulative": req.cumulative,
            "transposed": req.transposed,
            "calendar": req.calendar,
            "show_subtotal": req.show_subtotal,
            "number_format": req.number_format,
            "decimal_places": req.decimal_places,
            "origin_labels": req.origin_labels,
            "csv_file": req.csv_file,
            "method_type": req.method_type,
            "status": req.status,
            "notes": req.notes,
            "precedents": req.precedents,
            "external_links": req.external_links,
            "values": req.values,
            "mask": req.mask,
        },
    )
