from typing import List, Literal, Optional

from pydantic import BaseModel, Field


class ProjectSettingsUpdateRequest(BaseModel):
    """Authoritative project registry write: virtual folders plus project paths."""

    folders: List[str] = Field(default_factory=list)
    project_paths: List[str] = Field(default_factory=list)
    file_mtime: Optional[float] = None


class RenameProjectFolderRequest(BaseModel):
    old_name: str
    new_name: str


class DuplicateProjectFolderRequest(BaseModel):
    old_name: str
    new_name: str
    request_id: Optional[str] = None


class DuplicateProjectFolderJobResponse(BaseModel):
    ok: Literal[True]
    job_id: str
    status: Literal["queued", "processing", "success", "error"]


class ProjectDuplicationProgress(BaseModel):
    stage: str
    completed: int = Field(ge=0)
    total: int = Field(ge=0)
    label: str


class ProjectDuplicationJobStatusResponse(BaseModel):
    ok: Literal[True]
    job_id: str
    contract_version: int
    status: Literal["queued", "processing", "success", "error"]
    updated_at: str
    request_id: str
    progress: ProjectDuplicationProgress
    message: Optional[str] = None


class CreateProjectFolderRequest(BaseModel):
    name: str


class DeleteProjectFolderRequest(BaseModel):
    name: str


class OpenProjectFolderRequest(BaseModel):
    project_name: str


class GeneratedDatasetCacheClearRequest(BaseModel):
    project_name: str


class GeneralSettingsUpdateRequest(BaseModel):
    project_name: str
    origin_start_date: Optional[str] = ""
    origin_end_date: Optional[str] = ""
    development_end_date: Optional[str] = ""
    auto_generated: Optional[bool] = False
