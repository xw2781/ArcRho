from __future__ import annotations

from typing import Any, Dict, List

from pydantic import BaseModel, Field


class DfmMethodIdentityRequest(BaseModel):
    project_name: str = Field(..., min_length=1)
    reserving_class: str = Field(..., min_length=1)
    method_name: str = Field(..., min_length=1)
    output_dataset: str | None = None


class DfmMethodPreviewRequest(BaseModel):
    method: Dict[str, Any]


class DfmDatasetReference(BaseModel):
    dataset_name: str = Field(..., min_length=1, max_length=255)
    row_idx: str = Field(..., min_length=1, max_length=255)
    col_idx: str | None = Field(None, max_length=255)


class DfmDatasetReferencesResolveRequest(BaseModel):
    project_name: str = Field(..., min_length=1)
    reserving_class: str = Field(..., min_length=1)
    references: List[DfmDatasetReference] = Field(..., min_length=1, max_length=100)


class DfmMethodSaveRequest(BaseModel):
    project_name: str = Field(..., min_length=1)
    reserving_class: str = Field(..., min_length=1)
    method: Dict[str, Any]
    notes: str | None = None
    expected_owned_revision: str | None = None
    expected_derived_revision: str | None = None
