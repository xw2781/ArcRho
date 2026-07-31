"""Routes for the project-owned imported source table."""
from __future__ import annotations

from typing import Any, Dict

from fastapi import APIRouter, HTTPException

from app_server.schemas.source_table import (
    MssqlConnectionForgetRequest,
    MssqlConnectionTestRequest,
    MssqlTableListRequest,
    SourceProfileSaveRequest,
    SourceTableImportRequest,
    SourceTableRefreshRequest,
)
from app_server.services import source_table_service

router = APIRouter()


@router.get("/source_table")
def get_source_table(project_name: str) -> Dict[str, Any]:
    try:
        return {"ok": True, **source_table_service.get_source_table_state(project_name)}
    except HTTPException:
        raise
    except Exception as error:
        raise HTTPException(500, f"Failed to read source table settings: {str(error)}")


@router.post("/source_table/profile")
def save_source_table_profile(req: SourceProfileSaveRequest) -> Dict[str, Any]:
    mssql = req.mssql.model_dump() if req.mssql is not None else None
    try:
        source_table_service.save_source_profile(
            project_name=req.project_name,
            source_type=req.source_type,
            mssql=mssql,
        )
        return {"ok": True, **source_table_service.get_source_table_state(req.project_name)}
    except HTTPException:
        raise
    except Exception as error:
        raise HTTPException(500, f"Failed to save source table settings: {str(error)}")


@router.post("/source_table/test_connection")
def test_source_table_connection(req: MssqlConnectionTestRequest) -> Dict[str, Any]:
    try:
        return source_table_service.test_mssql_connection(
            server=req.server,
            database=req.database,
            table=req.table,
            authentication=req.authentication or "",
        )
    except HTTPException:
        raise
    except Exception as error:
        raise HTTPException(500, f"Failed to test the SQL Server connection: {str(error)}")


@router.get("/source_table/connections")
def get_source_table_connections() -> Dict[str, Any]:
    """Server-shared list of previously used SQL Server server/database pairs."""
    try:
        return source_table_service.load_mssql_connections()
    except HTTPException:
        raise
    except Exception as error:
        raise HTTPException(500, f"Failed to read saved SQL Server connections: {str(error)}")


@router.post("/source_table/connections/forget")
def forget_source_table_connection(req: MssqlConnectionForgetRequest) -> Dict[str, Any]:
    try:
        return source_table_service.forget_mssql_connection(
            server=req.server,
            database=req.database,
        )
    except HTTPException:
        raise
    except Exception as error:
        raise HTTPException(500, f"Failed to remove the saved SQL Server connection: {str(error)}")


@router.post("/source_table/tables")
def list_source_table_candidates(req: MssqlTableListRequest) -> Dict[str, Any]:
    """Tables and views available in the target database."""
    try:
        return source_table_service.list_mssql_tables(
            server=req.server,
            database=req.database,
            authentication=req.authentication or "",
        )
    except HTTPException:
        raise
    except Exception as error:
        raise HTTPException(500, f"Failed to list SQL Server tables: {str(error)}")


@router.post("/source_table/import")
def import_source_table(req: SourceTableImportRequest) -> Dict[str, Any]:
    try:
        return {"ok": True, **source_table_service.import_from_mssql(req.project_name)}
    except HTTPException:
        raise
    except Exception as error:
        raise HTTPException(500, f"Failed to import the source table: {str(error)}")


@router.post("/source_table/refresh")
def refresh_source_table(req: SourceTableRefreshRequest) -> Dict[str, Any]:
    """Re-copy the configured external CSV into the project master table."""
    try:
        return {
            "ok": True,
            **source_table_service.ensure_master_table(req.project_name, force=bool(req.force)),
        }
    except source_table_service.SourceTableNotConfiguredError as error:
        raise HTTPException(400, str(error))
    except source_table_service.SourceTableMissingError as error:
        raise HTTPException(409, str(error))
    except FileNotFoundError as error:
        raise HTTPException(404, str(error))
    except HTTPException:
        raise
    except Exception as error:
        raise HTTPException(500, f"Failed to refresh the imported source table: {str(error)}")
