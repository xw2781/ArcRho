"""Arco Server client entry point."""

from __future__ import annotations

from pathlib import Path

from .config import get_server_root
from .exceptions import InvalidArcRhoServerError
from .paths import clean_text, project_dir_case_insensitive
from .project import Project


class ArcRhoClient:
    """Client bound to one Arco Server root folder."""

    def __init__(self, server_root: str | Path | None = None, *, read_only: bool = False, validate: bool = True) -> None:
        resolved_root = server_root if server_root is not None else get_server_root(required=True)
        self.server_root = Path(resolved_root).expanduser().resolve()
        self.read_only = bool(read_only)
        self.projects_dir = self.server_root / "projects"
        self.requests_dir = self.server_root / "requests"
        if validate:
            self.validate()

    def validate(self) -> None:
        if not self.server_root.exists() or not self.server_root.is_dir():
            raise InvalidArcRhoServerError(f"Arco Server root does not exist: {self.server_root}")
        if not self.projects_dir.exists() or not self.projects_dir.is_dir():
            raise InvalidArcRhoServerError(
                f"Arco Server root must contain a projects folder: {self.projects_dir}"
            )

    def list_projects(self) -> list[str]:
        if not self.projects_dir.exists():
            return []
        return sorted(item.name for item in self.projects_dir.iterdir() if item.is_dir())

    def project_exists(self, name: str) -> bool:
        return project_dir_case_insensitive(self.projects_dir, name) is not None

    def resolve_project_path(self, name: str) -> Path:
        project = self.project(name)
        return project.path

    def project(self, name: str) -> Project:
        project_name = clean_text(name)
        return Project(self, project_name)
