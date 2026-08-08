"""ArcRho Web UI — FastAPI application.

This module creates the FastAPI ``app`` instance, includes all API routers,
and mounts the static frontend.  All business logic lives in
``app_server.services.*`` and route handlers in ``app_server.api.*``.
"""
from __future__ import annotations

import os

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from fastapi.responses import RedirectResponse

from app_server import config
from app_server.api import (
    workflow_router,
    app_control_router,
    workspace_paths_router,
    audit_log_router,
    dataset_router,
    book_router,
    excel_router,
    arcrho_router,
    project_settings_router,
    table_summary_router,
    source_table_router,
    field_mapping_router,
    dataset_types_router,
    dependent_propagation_router,
    object_change_watch_router,
    reserving_class_router,
    scripting_router,
    dfm_rpc_bridge_router,
    dfm_method_router,
    result_selection_rpc_bridge_router,
    result_selection_router,
    bornhuetter_ferguson_router,
    cape_cod_router,
    bootstrap_router,
    dfm_method_index_router,
    project_user_preferences_router,
    ui_automation_router,
    snowflake_router,
    sql_formatting_router,
    data_processing_rules_router,
    user_identity_router,
)

# ---------------------------------------------------------------------------
# App
# ---------------------------------------------------------------------------

app = FastAPI(title="Triangle Demo API", version="0.1")

# --- Include routers (API routes BEFORE static mount) ---
app.include_router(workflow_router)
app.include_router(app_control_router)
app.include_router(workspace_paths_router)
app.include_router(audit_log_router)
app.include_router(dataset_router)
app.include_router(book_router)
app.include_router(excel_router)
app.include_router(arcrho_router)
app.include_router(project_settings_router)
app.include_router(table_summary_router)
app.include_router(source_table_router)
app.include_router(field_mapping_router)
app.include_router(dataset_types_router)
app.include_router(dependent_propagation_router)
app.include_router(object_change_watch_router)
app.include_router(reserving_class_router)
app.include_router(scripting_router)
app.include_router(dfm_rpc_bridge_router)
app.include_router(dfm_method_router)
app.include_router(result_selection_rpc_bridge_router)
app.include_router(result_selection_router)
app.include_router(bornhuetter_ferguson_router)
app.include_router(cape_cod_router)
app.include_router(bootstrap_router)
app.include_router(dfm_method_index_router)
app.include_router(project_user_preferences_router)
app.include_router(ui_automation_router)
app.include_router(snowflake_router)
app.include_router(sql_formatting_router)
app.include_router(data_processing_rules_router)
app.include_router(user_identity_router)

# --- Frontend assets (served from ./ui and ./icons, no /static) ---
# Mount AFTER API routes to avoid conflicts

app.mount("/ui", StaticFiles(directory=str(config.PROJECT_ROOT / "ui"), html=True), name="ui")
app.mount("/icons", StaticFiles(directory=str(config.PROJECT_ROOT / "icons")), name="icons")


@app.get("/")
def home():
    return RedirectResponse(url="/ui/")


@app.get("/app/health")
def app_health():
    return {
        "ok": True,
        "app": "arcrho",
        "token": os.environ.get("ARCRHO_BACKEND_TOKEN", ""),
        "backend_artifact_id": os.environ.get("ARCRHO_BACKEND_ARTIFACT_ID", ""),
        "project_root": str(config.PROJECT_ROOT),
    }
