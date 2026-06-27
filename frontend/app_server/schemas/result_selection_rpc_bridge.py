from __future__ import annotations

from pydantic import BaseModel, Field


class ResultSelectionRpcBridgeRequest(BaseModel):
    project_name: str = Field(..., min_length=1)
    reserving_class: str = Field(..., min_length=1)
    method_name: str = Field(..., min_length=1)
    output_type: str = ""
    origin_length: int = Field(..., ge=1)
    timeout_sec: float = Field(8.0, gt=0)


class ResultSelectionRpcBridgeApplyRequest(ResultSelectionRpcBridgeRequest):
    pass


class ResultSelectionRpcBridgeKeepLocalRequest(ResultSelectionRpcBridgeRequest):
    pass


class ResultSelectionRpcBridgeUpdateRemoteRequest(ResultSelectionRpcBridgeRequest):
    rpc_server_write_confirmed: bool = False
