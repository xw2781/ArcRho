from __future__ import annotations

from typing import Any, Dict

from pydantic import BaseModel, Field


class DfmMethodIdentityRequest(BaseModel):
    project_name: str = Field(..., min_length=1)
    reserving_class: str = Field(..., min_length=1)
    method_name: str = Field(..., min_length=1)
    output_dataset: str | None = None


class DfmMethodPreviewRequest(BaseModel):
    method: Dict[str, Any]


class DfmMethodSaveRequest(BaseModel):
    project_name: str = Field(..., min_length=1)
    reserving_class: str = Field(..., min_length=1)
    method: Dict[str, Any]
    notes: str | None = None
    expected_owned_revision: str | None = None
    expected_derived_revision: str | None = None

