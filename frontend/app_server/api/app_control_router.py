from __future__ import annotations

import os
import time
import threading
from typing import Any, Dict

from fastapi import APIRouter

from app_server import config
from app_server.services import arcbot_prompt_service, workspace_read_client

router = APIRouter()


@router.post("/app/restart")
def app_restart() -> Dict[str, Any]:
    try:
        config.RESTART_FLAG.write_text(str(time.time()), encoding="utf-8")
    except Exception:
        pass

    def _shutdown() -> None:
        time.sleep(0.25)
        os._exit(0)

    threading.Thread(target=_shutdown, daemon=True).start()
    return {"ok": True}


@router.post("/app/restart_electron")
def app_restart_electron() -> Dict[str, Any]:
    try:
        config.ELECTRON_RESTART_FLAG.write_text(str(time.time()), encoding="utf-8")
    except Exception:
        pass
    return {"ok": True}


@router.post("/app/shutdown_electron")
def app_shutdown_electron() -> Dict[str, Any]:
    try:
        config.ELECTRON_SHUTDOWN_FLAG.write_text(str(time.time()), encoding="utf-8")
    except Exception:
        pass
    return {"ok": True}


@router.post("/app/shutdown")
def app_shutdown() -> Dict[str, Any]:
    try:
        config.SHUTDOWN_FLAG.write_text(str(time.time()), encoding="utf-8")
    except Exception:
        pass

    def _shutdown() -> None:
        time.sleep(0.25)
        os._exit(0)

    threading.Thread(target=_shutdown, daemon=True).start()
    return {"ok": True}


@router.get("/arcbot/prompt-files")
def arcbot_prompt_files() -> Dict[str, Any]:
    """ArcBot's shared prompt files, read on the server host through the Gateway."""

    return workspace_read_client.run_workspace_read(
        "arcbot_prompt_files",
        {},
        local=arcbot_prompt_service.read_arcbot_prompt_files,
    )
