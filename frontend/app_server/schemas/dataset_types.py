from typing import Any, List

from pydantic import BaseModel, Field


class DatasetTypesSaveRequest(BaseModel):
    project_name: str
    columns: List[str] = Field(default_factory=list)
    rows: List[List[Any]] = Field(default_factory=list)
    # The client generates this before its first POST and reuses it on every
    # retry, so a response lost in flight can never apply one change twice.
    request_id: str = ""


class DatasetTypesImportLocalFileRequest(BaseModel):
    file_path: str
