from typing import Any, Dict

from pydantic import BaseModel


class ResultSelectionLoadRequest(BaseModel):
    project_name: str
    reserving_class: str
    method_name: str
    include_method: bool = True


class ResultSelectionSaveRequest(BaseModel):
    project_name: str
    reserving_class: str
    method: Dict[str, Any]
    notes: str = ""
    expected_revision: str | None = None
