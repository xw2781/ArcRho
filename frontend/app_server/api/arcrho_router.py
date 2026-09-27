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
from app_server.services import (
    arcrho_runtime_service,
    engine_calculation_service,
    workspace_mutation_client,
    workspace_read_client,
)

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
    options = {
        "local_only": bool(req.LocalOnly),
        "allow_derived": bool(req.AllowDerived),
        "temporary_session_id": str(req.TemporarySessionId) if req.TemporarySessionId else None,
        "allow_runtime_cache_provenance": not bool(req.WriteSidecar),
    }
    # The precheck and the run below are Server-hosted engine-calculation
    # operations: the whole route runs on the Arco Server host when the
    # Gateway advertises it, otherwise the same service function runs here.
    # The CSV location is resolved only for a local run: resolving it looks
    # the project folder up on the workspace drive.
    return engine_calculation_service.run_hosted_dataset_operation(
        OPERATION_DATASET_PRECHECK,
        pairs,
        options,
        timeout_sec=float(req.timeout_sec),
        local=lambda: arcrho_runtime_service.arcrho_precheck(
            set_data_path_like_vba(pairs), pairs, **options
        ),
    )


def _arcrho_run_response(
    req: ArcRhoTriRequest | ArcRhoVecRequest, pairs: list, *, force_refresh: bool
) -> Dict[str, Any]:
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
        options,
        timeout_sec=timeout_sec,
        local=lambda: arcrho_runtime_service.run_arcrho_tri(
            pairs, set_data_path_like_vba(pairs), timeout_sec=timeout_sec, **options
        ),
    )


@router.post("/arcrho/headers")
def arcrho_headers(req: ArcRhoHeadersRequest) -> Dict[str, Any]:
    # The period headings, resolved on the server host: its settings check,
    # cache lookup and any Engine run are local disk there.
    kwargs = {
        "project_name": req.ProjectName,
        "period_length": req.PeriodLength,
        "timeout_sec": max(0.1, float(req.timeout_sec)),
        "period_type": req.periodType,
        "transposed": req.Transposed,
        "calendar": req.Calendar,
        "stored_period_length": req.StoredPeriodLength,
    }
    return workspace_read_client.run_workspace_read(
        "arcrho_headers",
        kwargs,
        local=lambda: arcrho_runtime_service.get_project_headers(**kwargs),
    )


@router.post("/arcrho/headers/cache/clear")
def clear_arcrho_headers_cache(req: ArcRhoHeadersCacheClearRequest) -> Dict[str, Any]:
    kwargs = {
        "project_name": req.ProjectName,
        "origin_length": req.OriginLength,
        "development_length": req.DevelopmentLength,
    }
    return workspace_mutation_client.run_workspace_mutation(
        "arcrho_headers_cache_clear",
        kwargs,
        local=lambda: arcrho_runtime_service.clear_arcrho_headers_cache(**kwargs),
    )


@router.get("/arcrho/projects")
def arcrho_projects() -> Dict[str, Any]:
    # The project registry, read on the server host through the Gateway.
    return workspace_read_client.run_workspace_read(
        "project_names",
        {},
        local=arcrho_runtime_service.arcrho_projects,
    )


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
