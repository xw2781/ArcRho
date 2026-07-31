from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field


class ReservingClassTypesSaveRequest(BaseModel):
    project_name: str
    columns: List[str] = Field(default_factory=list)
    rows: List[List[Any]] = Field(default_factory=list)


class ReservingClassTypesImportLocalFileRequest(BaseModel):
    file_path: str


class RefreshReservingClassValuesRequest(BaseModel):
    # Values always come from the project-owned imported master table.
    project_name: str
    force: bool = False


class ReservingClassHiddenPathsSaveRequest(BaseModel):
    project_name: str
    hidden_paths: List[str] = Field(default_factory=list)


class ReservingClassFilterSpecSaveRequest(BaseModel):
    project_name: str
    filter_spec: Dict[str, List[str]] = Field(default_factory=dict)
    preferences: Optional[Dict[str, Any]] = None
