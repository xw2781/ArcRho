"""Slim Arcode FastAPI application.

This app is used by the standalone Arcode product build. It exposes the
general scripting API and the Arcode UI assets without ArcRho project/DFM
routes.
"""
from __future__ import annotations

import os

from fastapi import FastAPI
from fastapi.responses import RedirectResponse
from fastapi.staticfiles import StaticFiles

from app_server import config
from app_server.api.app_control_router import router as app_control_router
from app_server.api.arcode_scripting_router import router as arcode_scripting_router
from app_server.api.snowflake_router import router as snowflake_router

app = FastAPI(title="Arcode API", version="0.1")

app.include_router(app_control_router)
app.include_router(arcode_scripting_router)
app.include_router(snowflake_router)

ui_root = config.PROJECT_ROOT / "ui"
arcode_ui = ui_root / "arcode"
assistant_ui = ui_root / "ai-assistant"
libs_ui = ui_root / "libs"
shared_ui = ui_root / "shared"
icons_root = config.PROJECT_ROOT / "icons"

app.mount("/ui/arcode", StaticFiles(directory=str(arcode_ui), html=True), name="arcode-ui")
if assistant_ui.exists():
    app.mount("/ui/ai-assistant", StaticFiles(directory=str(assistant_ui)), name="ai-assistant-ui")
if libs_ui.exists():
    app.mount("/ui/libs", StaticFiles(directory=str(libs_ui)), name="ui-libs")
if shared_ui.exists():
    app.mount("/ui/shared", StaticFiles(directory=str(shared_ui)), name="ui-shared")
if icons_root.exists():
    app.mount("/icons", StaticFiles(directory=str(icons_root)), name="icons")


@app.get("/")
def home():
    return RedirectResponse(url="/ui/arcode/main.html")


@app.get("/ui/")
def ui_home():
    return RedirectResponse(url="/ui/arcode/main.html")


@app.get("/app/health")
def app_health():
    return {
        "ok": True,
        "app": "arcode",
        "token": os.environ.get("ARCODE_BACKEND_TOKEN") or os.environ.get("ARCRHO_BACKEND_TOKEN", ""),
        "backend_artifact_id": (
            os.environ.get("ARCODE_BACKEND_ARTIFACT_ID")
            or os.environ.get("ARCRHO_BACKEND_ARTIFACT_ID", "")
        ),
        "project_root": str(config.PROJECT_ROOT),
    }
