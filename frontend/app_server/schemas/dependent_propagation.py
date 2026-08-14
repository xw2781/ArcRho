from typing import List, Literal, Optional

from pydantic import BaseModel, Field


class ChangedRoot(BaseModel):
    dataset_name: str
    dataset_type: str = ""


class RefreshDependentsJobRequest(BaseModel):
    project_name: str
    reserving_class: str
    changed_roots: List[ChangedRoot] = Field(default_factory=list)
    request_id: Optional[str] = None


class RefreshDependentsJobResponse(BaseModel):
    ok: Literal[True]
    job_id: str
    status: Literal["queued", "processing", "success", "error"]


class DependentPropagationProgress(BaseModel):
    stage: str
    completed: int = Field(ge=0)
    total: int = Field(ge=0)
    label: str


class DependentPropagationJobStatusResponse(BaseModel):
    ok: Literal[True]
    job_id: str
    contract_version: int
    status: Literal["queued", "processing", "success", "error"]
    updated_at: str
    request_id: str
    progress: DependentPropagationProgress
    message: Optional[str] = None
    merged_into: Optional[str] = None


class ReservingClassBusyResponse(BaseModel):
    ok: Literal[True]
    busy: bool
    reason: Optional[Literal["processing", "queued"]] = None
