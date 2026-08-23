from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field


class DatasetTypesSaveRequest(BaseModel):
    project_name: str
    columns: List[str] = Field(default_factory=list)
    rows: List[List[Any]] = Field(default_factory=list)
    # ``[{"from": old, "to": new}]`` for every row whose Name the grid edited
    # since the table was last saved. Without it a rename is indistinguishable
    # from one type removed and another added.
    renames: List[Dict[str, str]] = Field(default_factory=list)
    # The plan the user confirmed, echoed back from the ``applied: "plan"``
    # answer. Absent on the first POST; present only on the confirming one.
    plan: Optional[Dict[str, Any]] = None
    # The client generates this before its first POST and reuses it on every
    # retry, so a response lost in flight can never apply one change twice.
    request_id: str = ""


class DatasetTypesImportLocalFileRequest(BaseModel):
    file_path: str
