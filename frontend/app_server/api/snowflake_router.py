from typing import Any, Dict

from fastapi import APIRouter

from app_server.schemas.scripting import (
    SnowflakeConnectionSaveRequest,
    SnowflakeQueryRequest,
)
from app_server.services import snowflake_service

router = APIRouter()


def _model_to_dict(value: Any) -> Dict[str, Any]:
    if hasattr(value, "model_dump"):
        return value.model_dump()
    if hasattr(value, "dict"):
        return value.dict()
    return dict(value or {})


@router.get("/snowflake/connections")
def snowflake_connections() -> Dict[str, Any]:
    return snowflake_service.load_connections()


@router.post("/snowflake/connections")
def snowflake_save_connection(req: SnowflakeConnectionSaveRequest) -> Dict[str, Any]:
    return snowflake_service.save_connection(req.connection, _model_to_dict(req.profile))


@router.post("/snowflake/query")
def snowflake_query(req: SnowflakeQueryRequest) -> Dict[str, Any]:
    return snowflake_service.run_query(req.sql, req.connection, req.limit)


@router.post("/snowflake/test-connection")
def snowflake_test_connection(req: SnowflakeQueryRequest) -> Dict[str, Any]:
    return snowflake_service.test_connection(req.connection)
