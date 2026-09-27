from __future__ import annotations

from typing import Optional

from pydantic import BaseModel


class WorkspacePaths(BaseModel):
    projects_dir: Optional[str] = None
    requests_dir: Optional[str] = None


class WorkspacePathsUpdateRequest(BaseModel):
    workspace_root: str
    paths: Optional[WorkspacePaths] = None


class ServerProfileSaveRequest(BaseModel):
    name: str
    root: str
    id: Optional[str] = None
    gateway_config: Optional[str] = None


class ServerProfileActivateRequest(BaseModel):
    id: str

