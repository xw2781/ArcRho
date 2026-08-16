from __future__ import annotations

from typing import Any, Dict

from fastapi import APIRouter

from app_server.schemas.arcrho import (
    ArcRhoTriRequest,
    ArcRhoVecRequest,
    ArcRhoHeadersRequest,
    ArcRhoHeadersCacheClearRequest,
)
from arcrho_engine_calculation_contract import OPERATION_DATASET_PRECHECK, OPERATION_DATASET_RUN

from app_server.helpers import set_data_path_like_vba
from app_server.services import arcrho_runtime_service, engine_calculation_service

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


def _arcrho_precheck_response(req: ArcRhoTriRequest | ArcRhoVecRequest, pairs: list) -> Dict[str, Any]:
    data_path = set_data_path_like_vba(pairs)
    options = {
        "local_only": bool(req.LocalOnly),
        "allow_derived": bool(req.AllowDerived),
        "temporary_session_id": str(req.TemporarySessionId) if req.TemporarySessionId else None,
        "allow_runtime_cache_provenance": not bool(req.WriteSidecar),
    }
    # The precheck and the run below are Server-hosted engine-calculation
    # operations: the whole route runs on the ArcRho Server host when the
    # Gateway advertises it, otherwise the same service function runs here.
    return engine_calculation_service.run_hosted_dataset_operation(
        OPERATION_DATASET_PRECHECK,
        pairs,
        data_path,
        options,
        timeout_sec=float(req.timeout_sec),
        local=lambda: arcrho_runtime_service.arcrho_precheck(data_path, pairs, **options),
    )


def _arcrho_run_response(
    req: ArcRhoTriRequest | ArcRhoVecRequest, pairs: list, *, force_refresh: bool
) -> Dict[str, Any]:
    data_path = set_data_path_like_vba(pairs)
    timeout_sec = max(0.1, float(req.timeout_sec))
    options = {
        "force_refresh": bool(force_refresh),
        "local_only": bool(req.LocalOnly),
        "allow_derived": bool(req.AllowDerived),
        "write_sidecar": bool(req.WriteSidecar),
        "temporary_session_id": str(req.TemporarySessionId) if req.TemporarySessionId else None,
    }
    return engine_calculation_service.run_hosted_dataset_operation(
        OPERATION_DATASET_RUN,
        pairs,
        data_path,
        options,
        timeout_sec=timeout_sec,
        local=lambda: arcrho_runtime_service.run_arcrho_tri(
            pairs, data_path, timeout_sec=timeout_sec, **options
        ),
    )


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
    return _arcrho_precheck_response(req, pairs)


@router.post("/arcrho/tri")
def arcrho_tri(req: ArcRhoTriRequest) -> Dict[str, Any]:
    return _arcrho_run_response(req, _arcrho_tri_pairs(req), force_refresh=False)


@router.post("/arcrho/tri/refresh")
def arcrho_tri_refresh(req: ArcRhoTriRequest) -> Dict[str, Any]:
    return _arcrho_run_response(req, _arcrho_tri_pairs(req), force_refresh=True)


@router.post("/arcrho/vec/precheck")
def arcrho_vec_precheck(req: ArcRhoVecRequest) -> Dict[str, Any]:
    pairs = _arcrho_vec_pairs(req)
    return _arcrho_precheck_response(req, pairs)


@router.post("/arcrho/vec")
def arcrho_vec(req: ArcRhoVecRequest) -> Dict[str, Any]:
    return _arcrho_run_response(req, _arcrho_vec_pairs(req), force_refresh=False)


@router.post("/arcrho/vec/refresh")
def arcrho_vec_refresh(req: ArcRhoVecRequest) -> Dict[str, Any]:
    return _arcrho_run_response(req, _arcrho_vec_pairs(req), force_refresh=True)
