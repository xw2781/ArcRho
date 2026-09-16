"""Gateway-only transport for client-side dependent-propagation operations."""
from __future__ import annotations

from typing import Any, Mapping

from fastapi import HTTPException

from app_server.services import workspace_mutation_client, workspace_read_client


def is_server_process() -> bool:
    return workspace_read_client._is_server_process()


def _refuse_local() -> dict:
    raise HTTPException(503, "Dependent propagation requires ArcRho Gateway.")


def read(kind: str, kwargs: Mapping[str, Any]) -> dict:
    return workspace_read_client.run_workspace_read(
        kind, kwargs, local=_refuse_local, gateway_required=True,
    )


def submit(kwargs: Mapping[str, Any]) -> dict:
    return workspace_mutation_client.run_workspace_mutation(
        "propagation_submit", kwargs, local=_refuse_local, gateway_required=True,
    )
