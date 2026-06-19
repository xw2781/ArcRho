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
    connection: str = "my_example_connection"
    profile: SnowflakeConnectionProfile


class ScriptMacroRunRequest(BaseModel):
    macro_id: str
    active_context: Dict[str, Any] = Field(default_factory=dict)


class ScriptMacroDeleteRequest(BaseModel):
    macro_id: str
