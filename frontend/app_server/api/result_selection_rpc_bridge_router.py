from __future__ import annotations

from typing import Any, Dict

from fastapi import APIRouter

from app_server.schemas.result_selection_rpc_bridge import (
    ResultSelectionRpcBridgeApplyRequest,
    ResultSelectionRpcBridgeKeepLocalRequest,
    ResultSelectionRpcBridgeRequest,
    ResultSelectionRpcBridgeUpdateRemoteRequest,
)
from app_server.services import (
    result_selection_rpc_bridge_service,
    workspace_mutation_client,
    workspace_read_client,
)

router = APIRouter()


# Hosted on the Gateway when it advertises the kind, local over the mapped
# drive otherwise, exactly as the DFM RPC bridge routes are.


@router.post("/result-selection/rpc-bridge/sync")
def sync_result_selection_rpc_bridge(req: ResultSelectionRpcBridgeRequest) -> Dict[str, Any]:
    return workspace_mutation_client.run_workspace_mutation(
        "result_selection_rpc_bridge_sync",
        req.model_dump(),
        local=lambda: result_selection_rpc_bridge_service.send_sync_request(req),
    )


@router.post("/result-selection/rpc-bridge/compare")
def compare_result_selection_rpc_bridge(req: ResultSelectionRpcBridgeRequest) -> Dict[str, Any]:
    return workspace_read_client.run_workspace_read(
        "result_selection_rpc_bridge_compare",
        req.model_dump(),
        local=lambda: result_selection_rpc_bridge_service.compare(req),
    )


@router.post("/result-selection/rpc-bridge/apply")
def apply_result_selection_rpc_bridge(req: ResultSelectionRpcBridgeApplyRequest) -> Dict[str, Any]:
    return result_selection_rpc_bridge_service.apply_remote_to_local(req)


@router.post("/result-selection/rpc-bridge/keep-local")
def keep_local_result_selection_rpc_bridge(req: ResultSelectionRpcBridgeKeepLocalRequest) -> Dict[str, Any]:
    return workspace_mutation_client.run_workspace_mutation(
        "result_selection_rpc_bridge_keep_local",
        req.model_dump(),
        local=lambda: result_selection_rpc_bridge_service.keep_local(req),
    )


@router.post("/result-selection/rpc-bridge/cleanup")
def cleanup_result_selection_rpc_bridge(req: ResultSelectionRpcBridgeRequest) -> Dict[str, Any]:
    return workspace_mutation_client.run_workspace_mutation(
        "result_selection_rpc_bridge_cleanup",
        req.model_dump(),
        local=lambda: result_selection_rpc_bridge_service.cleanup_tmp(req),
    )


@router.post("/result-selection/rpc-bridge/update-remote")
def update_remote_result_selection_rpc_bridge(req: ResultSelectionRpcBridgeUpdateRemoteRequest) -> Dict[str, Any]:
    return workspace_mutation_client.run_workspace_mutation(
        "result_selection_rpc_bridge_update_remote",
        req.model_dump(),
        local=lambda: result_selection_rpc_bridge_service.update_remote(req),
    )
