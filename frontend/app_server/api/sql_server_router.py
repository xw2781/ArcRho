from typing import Any, Dict

from fastapi import APIRouter

from app_server.schemas.sql_server import (
    SqlServerConnectionDeleteRequest,
    SqlServerConnectionSaveRequest,
    SqlServerQueryRequest,
)
from app_server.services import sql_server_service

router = APIRouter()


@router.get("/sqlserver/connections")
def sql_server_connections() -> Dict[str, Any]:
    return sql_server_service.load_connections()


@router.post("/sqlserver/connections")
def sql_server_save_connection(req: SqlServerConnectionSaveRequest) -> Dict[str, Any]:
    return sql_server_service.save_connection(
        req.connection,
        req.profile.model_dump(),
        req.make_default,
    )


@router.post("/sqlserver/connections/delete")
def sql_server_delete_connection(req: SqlServerConnectionDeleteRequest) -> Dict[str, Any]:
    return sql_server_service.delete_connection(req.connection)


@router.post("/sqlserver/query")
def sql_server_query(req: SqlServerQueryRequest) -> Dict[str, Any]:
    return sql_server_service.run_query(req.sql, req.connection, req.limit)


@router.post("/sqlserver/test-connection")
def sql_server_test_connection(req: SqlServerQueryRequest) -> Dict[str, Any]:
    return sql_server_service.test_connection(req.connection)
