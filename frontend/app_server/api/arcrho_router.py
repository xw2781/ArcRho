from __future__ import annotations

import hashlib
from typing import Any, Dict

from fastapi import APIRouter

from app_server.schemas.arcrho import ArcRhoTriRequest, ArcRhoHeadersRequest, ArcRhoHeadersCacheClearRequest
from app_server.helpers import set_data_path_like_vba
from app_server.services import arcrho_runtime_service

router = APIRouter()


@router.post("/arcrho/headers")
def arcrho_headers(req: ArcRhoHeadersRequest) -> Dict[str, Any]:
    pairs = [
        ("Function", "ArcRhoHeaders"),
        ("periodType", str(req.periodType)),
        ("Transposed", str(req.Transposed)),
        ("Calendar", str(req.Calendar)),
        ("PeriodLength", str(req.PeriodLength)),
        ("ProjectName", req.ProjectName),
        ("StoredPeriodLength", str(req.StoredPeriodLength)),
    ]
    return arcrho_runtime_service.arcrho_headers(pairs, timeout_sec=max(0.1, float(req.timeout_sec)))


@router.post("/arcrho/headers/cache/clear")
def clear_arcrho_headers_cache(req: ArcRhoHeadersCacheClearRequest) -> Dict[str, Any]:
    return arcrho_runtime_service.clear_arcrho_headers_cache(
        req.ProjectName,
        origin_length=req.OriginLength,
        development_length=req.DevelopmentLength,
    )


@router.get("/arcrho/projects")
def arcrho_projects() -> Dict[str, Any]:
    return arcrho_runtime_service.arcrho_projects()


@router.post("/arcrho/tri/precheck")
def arcrho_tri_precheck(req: ArcRhoTriRequest) -> Dict[str, Any]:
    pairs = [
        ("Function", "ArcRhoTri"),
        ("Path", req.Path),
        ("DatasetName", req.TriangleName),
        ("Cumulative", str(req.Cumulative)),
        ("Transposed", str(False)),
        ("Calendar", str(req.Calendar)),
        ("ProjectName", req.ProjectName),
        ("OriginLength", str(req.OriginLength)),
        ("DevelopmentLength", str(req.DevelopmentLength)),
    ]
    data_path = set_data_path_like_vba(pairs)
    need_request = not arcrho_runtime_service.arcrho_tri_cache_matches(data_path, pairs)
    ds_id = "arcrhotri_" + hashlib.sha1(data_path.encode("utf-8")).hexdigest()[:16]
    return {
        "ok": True,
        "need_request": need_request,
        "cache_exists": (not need_request),
        "data_path": data_path,
        "ds_id": ds_id,
    }


@router.post("/arcrho/tri")
def arcrho_tri(req: ArcRhoTriRequest) -> Dict[str, Any]:
    pairs = [
        ("Function", "ArcRhoTri"),
        ("Path", req.Path),
        ("DatasetName", req.TriangleName),
        ("Cumulative", str(req.Cumulative)),
        ("Transposed", str(False)),
        ("Calendar", str(req.Calendar)),
        ("ProjectName", req.ProjectName),
        ("OriginLength", str(req.OriginLength)),
        ("DevelopmentLength", str(req.DevelopmentLength)),
    ]
    data_path = set_data_path_like_vba(pairs)
    return arcrho_runtime_service.run_arcrho_tri(pairs, data_path, timeout_sec=max(0.1, float(req.timeout_sec)), force_refresh=False)


@router.post("/arcrho/tri/refresh")
def arcrho_tri_refresh(req: ArcRhoTriRequest) -> Dict[str, Any]:
    pairs = [
        ("Function", "ArcRhoTri"),
        ("Path", req.Path),
        ("DatasetName", req.TriangleName),
        ("Cumulative", str(req.Cumulative)),
        ("Transposed", str(False)),
        ("Calendar", str(req.Calendar)),
        ("ProjectName", req.ProjectName),
        ("OriginLength", str(req.OriginLength)),
        ("DevelopmentLength", str(req.DevelopmentLength)),
    ]
    data_path = set_data_path_like_vba(pairs)
    return arcrho_runtime_service.run_arcrho_tri(pairs, data_path, timeout_sec=max(0.1, float(req.timeout_sec)), force_refresh=True)
