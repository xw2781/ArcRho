from __future__ import annotations

from fastapi import HTTPException, Request


def require_local_client(request: Request, feature: str = "This integration") -> None:
    """Reject integration calls that did not originate on this computer."""
    host = (request.client.host if request.client else "") or ""
    if host not in {"127.0.0.1", "::1", "localhost"}:
        raise HTTPException(403, f"{feature} is only available from the local machine.")
