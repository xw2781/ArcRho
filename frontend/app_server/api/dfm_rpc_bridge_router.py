from __future__ import annotations

from typing import Any, Dict

from fastapi import APIRouter

from app_server.schemas.dfm_rpc_bridge import (
    DfmRpcBridgeApplyRequest,
    DfmRpcBridgeKeepLocalRequest,
    DfmRpcBridgeRequest,
    DfmRpcBridgeUpdateRemoteRequest,
)
from app_server.services import (
    dfm_rpc_bridge_service,
    workspace_mutation_client,
    workspace_read_client,
)

router = APIRouter()


# The ArcRho Bridge that serves these requests runs on the server host, where
# the request folder and the method files are local disk; only the Client PC
# half of the exchange crosses SMB. Each route therefore runs on the Gateway
# when it advertises the kind, and locally over the mapped drive otherwise.
# The request/response shapes are identical either way.


@router.post("/dfm/rpc-bridge/sync")
def sync_dfm_rpc_bridge(req: DfmRpcBridgeRequest) -> Dict[str, Any]:
    return workspace_mutation_client.run_workspace_mutation(
        "dfm_rpc_bridge_sync",
        req.model_dump(),
        local=lambda: dfm_rpc_bridge_service.send_sync_request(req),
    )


@router.post("/dfm/rpc-bridge/compare")
def compare_dfm_rpc_bridge(req: DfmRpcBridgeRequest) -> Dict[str, Any]:
    return workspace_read_client.run_workspace_read(
        "dfm_rpc_bridge_compare",
        req.model_dump(),
        local=lambda: dfm_rpc_bridge_service.compare(req),
    )


@router.post("/dfm/rpc-bridge/apply")
def apply_dfm_rpc_bridge(req: DfmRpcBridgeApplyRequest) -> Dict[str, Any]:
    return dfm_rpc_bridge_service.apply_remote_to_local(req)


@router.post("/dfm/rpc-bridge/keep-local")
def keep_local_dfm_rpc_bridge(req: DfmRpcBridgeKeepLocalRequest) -> Dict[str, Any]:
    return workspace_mutation_client.run_workspace_mutation(
        "dfm_rpc_bridge_keep_local",
        req.model_dump(),
        local=lambda: dfm_rpc_bridge_service.keep_local(req),
    )


@router.post("/dfm/rpc-bridge/cleanup")
def cleanup_dfm_rpc_bridge(req: DfmRpcBridgeRequest) -> Dict[str, Any]:
    return workspace_mutation_client.run_workspace_mutation(
        "dfm_rpc_bridge_cleanup",
        req.model_dump(),
        local=lambda: dfm_rpc_bridge_service.cleanup_tmp(req),
    )


@router.post("/dfm/rpc-bridge/update-remote")
def update_remote_dfm_rpc_bridge(req: DfmRpcBridgeUpdateRemoteRequest) -> Dict[str, Any]:
    return workspace_mutation_client.run_workspace_mutation(
        "dfm_rpc_bridge_update_remote",
        req.model_dump(),
        local=lambda: dfm_rpc_bridge_service.update_remote(req),
    )
