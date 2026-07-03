from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field


class ProjectSettingsUpdateRequest(BaseModel):
    data: Dict[str, Any]
    file_mtime: Optional[float] = None


class FolderStructureUpdateRequest(BaseModel):
    folders: List[str] = Field(default_factory=list)
    project_paths: List[str] = Field(default_factory=list)


class RenameProjectFolderRequest(BaseModel):
    old_name: str
    new_name: str


class DuplicateProjectFolderRequest(BaseModel):
    old_name: str
    new_name: str


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
