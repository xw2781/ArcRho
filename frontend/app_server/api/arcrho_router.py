from __future__ import annotations

import hashlib
from typing import Any, Dict

from fastapi import APIRouter

from app_server.schemas.arcrho import (
    ArcRhoTriRequest,
    ArcRhoVecRequest,
    ArcRhoHeadersRequest,
    ArcRhoHeadersCacheClearRequest,
)
from app_server.helpers import set_data_path_like_vba
from app_server.services import arcrho_runtime_service

router = APIRouter()


def _arcrho_tri_pairs(req: ArcRhoTriRequest) -> list:
    dataset_type = str(req.DatasetTypeName or req.TriangleName or "").strip()
    instance_name = str(req.InstanceName or "").strip()
    pairs = [
        ("Function", "ArcRhoTri"),
        ("Path", req.Path),
        ("DatasetName", dataset_type),
    ]
    if instance_name:
        pairs.append(("InstanceName", instance_name))
    pairs.extend([
        ("Cumulative", str(req.Cumulative)),
        ("Transposed", str(False)),
        ("Calendar", str(req.Calendar)),
        ("ProjectName", req.ProjectName),
        ("OriginLength", str(req.OriginLength)),
        ("DevelopmentLength", str(req.DevelopmentLength)),
    ])
    return pairs


def _arcrho_vec_pairs(req: ArcRhoVecRequest) -> list:
    dataset_type = str(req.DatasetTypeName or req.VectorName or "").strip()
    instance_name = str(req.InstanceName or "").strip()
    pairs = [
        ("Function", "ArcRhoVec"),
        ("Path", req.Path),
        ("DatasetName", dataset_type),
    ]
    if instance_name:
        pairs.append(("InstanceName", instance_name))
    pairs.extend([
        ("Cumulative", str(req.Cumulative)),
        ("Transposed", str(False)),
        ("Calendar", str(req.Calendar)),
        ("ProjectName", req.ProjectName),
        ("OriginLength", str(req.PeriodLength)),
        ("DevelopmentLength", str(req.PeriodLength)),
    ])
    return pairs


def _arcrho_precheck_response(req: ArcRhoTriRequest | ArcRhoVecRequest, pairs: list, ds_id_prefix: str) -> Dict[str, Any]:
    data_path = set_data_path_like_vba(pairs)
    local_result = arcrho_runtime_service.resolve_local_triangle_cache(
        data_path,
        pairs,
        allow_derived=bool(req.AllowDerived),
        materialize=False,
        local_only=bool(req.LocalOnly),
    )
    local_available = bool(local_result.get("ok"))
    manual_source_found = bool(local_result.get("manual_source_found"))
    generated_source_found = bool(local_result.get("generated_source_found"))
    need_request = not local_available and not manual_source_found and (not req.LocalOnly or generated_source_found)
    ds_id = ds_id_prefix + hashlib.sha1(data_path.encode("utf-8")).hexdigest()[:16]
    result = {
        "ok": True,
        "need_request": need_request,
        "cache_exists": local_available,
        "data_path": data_path,
        "ds_id": ds_id,
        "local_cache_status": local_result.get("status"),
        "local_cache_message": local_result.get("message"),
        "manual_source_found": manual_source_found,
        "generated_source_found": generated_source_found,
    }
    return result


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
    pairs = _arcrho_tri_pairs(req)
    return _arcrho_precheck_response(req, pairs, "arcrhotri_")


@router.post("/arcrho/tri")
def arcrho_tri(req: ArcRhoTriRequest) -> Dict[str, Any]:
    pairs = _arcrho_tri_pairs(req)
    data_path = set_data_path_like_vba(pairs)
    return arcrho_runtime_service.run_arcrho_tri(
        pairs,
        data_path,
        timeout_sec=max(0.1, float(req.timeout_sec)),
        force_refresh=False,
        local_only=bool(req.LocalOnly),
        allow_derived=bool(req.AllowDerived),
        write_sidecar=bool(req.WriteSidecar),
    )


@router.post("/arcrho/tri/refresh")
def arcrho_tri_refresh(req: ArcRhoTriRequest) -> Dict[str, Any]:
    pairs = _arcrho_tri_pairs(req)
    data_path = set_data_path_like_vba(pairs)
    return arcrho_runtime_service.run_arcrho_tri(
        pairs,
        data_path,
        timeout_sec=max(0.1, float(req.timeout_sec)),
        force_refresh=True,
        local_only=bool(req.LocalOnly),
        allow_derived=bool(req.AllowDerived),
        write_sidecar=bool(req.WriteSidecar),
    )


@router.post("/arcrho/vec/precheck")
def arcrho_vec_precheck(req: ArcRhoVecRequest) -> Dict[str, Any]:
    pairs = _arcrho_vec_pairs(req)
    return _arcrho_precheck_response(req, pairs, "arcrhovec_")


@router.post("/arcrho/vec")
def arcrho_vec(req: ArcRhoVecRequest) -> Dict[str, Any]:
    pairs = _arcrho_vec_pairs(req)
    data_path = set_data_path_like_vba(pairs)
    return arcrho_runtime_service.run_arcrho_tri(
        pairs,
        data_path,
        timeout_sec=max(0.1, float(req.timeout_sec)),
        force_refresh=False,
        local_only=bool(req.LocalOnly),
        allow_derived=bool(req.AllowDerived),
        write_sidecar=bool(req.WriteSidecar),
    )


@router.post("/arcrho/vec/refresh")
def arcrho_vec_refresh(req: ArcRhoVecRequest) -> Dict[str, Any]:
    pairs = _arcrho_vec_pairs(req)
    data_path = set_data_path_like_vba(pairs)
    return arcrho_runtime_service.run_arcrho_tri(
        pairs,
        data_path,
        timeout_sec=max(0.1, float(req.timeout_sec)),
        force_refresh=True,
        local_only=bool(req.LocalOnly),
        allow_derived=bool(req.AllowDerived),
        write_sidecar=bool(req.WriteSidecar),
    )
