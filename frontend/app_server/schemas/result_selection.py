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
    # Fingerprint of the dependent-update plan the user confirmed. The Engine
    # rechecks it under the reserving-class lease and refuses with 409 if the
    # class changed while the plan was on screen.
    plan_fingerprint: str = ""
