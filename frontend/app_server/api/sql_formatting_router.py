from fastapi import APIRouter

from app_server.schemas.sql_formatting import (
    SqlFormattingPreviewRequest,
    SqlFormattingPreviewResponse,
)
from app_server.services import sql_formatting_service


router = APIRouter()


@router.post(
    "/arcode/sql/format-preview",
    response_model=SqlFormattingPreviewResponse,
)
def format_sql_preview(
    request: SqlFormattingPreviewRequest,
) -> SqlFormattingPreviewResponse:
    return sql_formatting_service.preview(request)
