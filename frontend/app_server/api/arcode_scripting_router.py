from __future__ import annotations

from typing import Any, Dict, List

from fastapi import APIRouter, Request
from fastapi.responses import StreamingResponse

from app_server.api.local_client import require_local_client
from app_server.schemas.scripting import (
    ScriptDeleteVarRequest,
    ScriptInspectRequest,
    ScriptNotebookLoadRequest,
    ScriptNotebookSaveRequest,
    ScriptMacroSourceRunRequest,
    ScriptRunRequest,
)
from app_server.services import (
    scripting_macro_service,
    scripting_notebook_service,
    scripting_preferences_service,
    scripting_service,
)

router = APIRouter()
_SESSION_HEADER = "X-Scripting-Session-Id"


def _session_id_from_request(request: Request) -> str | None:
    raw = request.headers.get(_SESSION_HEADER)
    if raw is None:
        return None
    sid = raw.strip()
    return sid or None


@router.post("/scripting/run")
def scripting_run(req: ScriptRunRequest, request: Request) -> Dict[str, Any]:
    return scripting_service.run_script(req.code, _session_id_from_request(request))


@router.post("/scripting/run-stream")
def scripting_run_stream(req: ScriptRunRequest, request: Request) -> StreamingResponse:
    stream = scripting_service.run_script_stream(req.code, _session_id_from_request(request))
    return StreamingResponse(stream, media_type="application/x-ndjson")


@router.post("/scripting/interrupt")
def scripting_interrupt(request: Request) -> Dict[str, Any]:
    return scripting_service.interrupt_execution(_session_id_from_request(request))


@router.get("/scripting/variables")
def scripting_variables(request: Request) -> List[Dict[str, Any]]:
    return scripting_service.get_variables(_session_id_from_request(request))


@router.post("/scripting/del-variable")
def scripting_del_variable(req: ScriptDeleteVarRequest, request: Request) -> Dict[str, Any]:
    return scripting_service.del_variable(req.name, _session_id_from_request(request))


@router.post("/scripting/reset")
def scripting_reset(request: Request) -> Dict[str, Any]:
    return scripting_service.reset_session(_session_id_from_request(request))


@router.post("/scripting/save-notebook")
def scripting_save_notebook(req: ScriptNotebookSaveRequest) -> Dict[str, Any]:
    return scripting_notebook_service.save_notebook(req.filename, req.cells)


@router.post("/scripting/load-notebook")
def scripting_load_notebook(req: ScriptNotebookLoadRequest) -> Dict[str, Any]:
    return scripting_notebook_service.load_notebook(req.filename)


@router.get("/scripting/notebooks")
def scripting_list_notebooks() -> List[Dict[str, str]]:
    return scripting_notebook_service.list_notebooks()


@router.post("/scripting/run-in-arcrho")
def scripting_run_in_arcrho(req: ScriptMacroSourceRunRequest, request: Request) -> Dict[str, Any]:
    require_local_client(request, "Run in ArcRho")
    return scripting_macro_service.run_arcrho_macro_source(req.source, req.filename, req.source_path)


@router.post("/scripting/inspect")
def scripting_inspect(req: ScriptInspectRequest, request: Request) -> Dict[str, Any]:
    return scripting_service.inspect_object(req.code, req.cursor_pos, _session_id_from_request(request))


@router.get("/scripting/preferences")
def scripting_get_preferences() -> Dict[str, Any]:
    return scripting_preferences_service.get_preferences()


@router.post("/scripting/preferences")
def scripting_save_preferences(prefs: Dict[str, Any]) -> Dict[str, Any]:
    return scripting_preferences_service.save_preferences(prefs)


@router.get("/scripting/api-help")
def scripting_api_help() -> List[Dict[str, str]]:
    return scripting_service.get_api_help()
