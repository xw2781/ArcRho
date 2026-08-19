from __future__ import annotations

from typing import Any, Dict, List

from pydantic import BaseModel, Field


class ScriptRunRequest(BaseModel):
    code: str


class ScriptDeleteVarRequest(BaseModel):
    name: str


class ScriptNotebookSaveRequest(BaseModel):
    filename: str
    cells: List[Dict[str, Any]]


class ScriptNotebookLoadRequest(BaseModel):
    filename: str


class ScriptInspectRequest(BaseModel):
    code: str
    cursor_pos: int


class SnowflakeConnectionProfile(BaseModel):
    name: str = ""
    account: str = ""
    user: str = ""
    authenticator: str = "externalbrowser"
    role: str = ""
    warehouse: str = ""
    database: str = ""
    schema_name: str = ""


class SnowflakeQueryRequest(BaseModel):
    sql: str
    connection: str = "my_example_connection"
    limit: int = 1000


class SnowflakeConnectionSaveRequest(BaseModel):
    # The profile being edited. Empty adds one; a different `profile.name`
    # renames the existing profile instead of leaving a copy behind.
    connection: str = ""
    profile: SnowflakeConnectionProfile


class SnowflakeConnectionDeleteRequest(BaseModel):
    connection: str


class SnowflakeConnectionResetRequest(BaseModel):
    # Empty resets the stored default connection.
    connection: str = ""


class ScriptMacroRunRequest(BaseModel):
    macro_id: str
    active_context: Dict[str, Any] = Field(default_factory=dict)
    task_window_id: str = ""
    task_session_id: str = ""
    task_mode: str = ""


class ScriptMacroSourceRunRequest(BaseModel):
    source: str
    filename: str = "untitled_macro.py"
    source_path: str = ""


class ScriptMacroDeleteRequest(BaseModel):
    macro_id: str


class ScriptMacroLibraryInstallRequest(BaseModel):
    macro_id: str
    overwrite: bool = False


class ScriptMacroRenameRequest(BaseModel):
    macro_id: str
    new_name: str


class ScriptTaskWrapperSaveRequest(BaseModel):
    title: str
    description: str = ""
    filename: str = ""
    tasks: List[Dict[str, Any]] = Field(default_factory=list)
