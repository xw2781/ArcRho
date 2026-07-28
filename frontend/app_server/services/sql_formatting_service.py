from __future__ import annotations

import threading

from app_server.schemas.sql_formatting import (
    SqlFormattingPreviewRequest,
    SqlFormattingPreviewResponse,
)


_FORMATTER = None
_FORMATTER_LOCK = threading.Lock()


def _get_formatter():
    global _FORMATTER
    if _FORMATTER is not None:
        return _FORMATTER
    with _FORMATTER_LOCK:
        if _FORMATTER is None:
            from app_server.services.sql_formatting.engine import SqlFormatter

            _FORMATTER = SqlFormatter()
    return _FORMATTER


def preview(request: SqlFormattingPreviewRequest) -> SqlFormattingPreviewResponse:
    """Build a deterministic, safe-to-apply SQL formatting preview."""

    return _get_formatter().format(
        request.sql,
        dialect=request.dialect,
        openquery_mode=request.openquery_mode,
    )
