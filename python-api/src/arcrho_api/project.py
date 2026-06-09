"""Project object implementation."""

from __future__ import annotations

from pathlib import Path
from typing import TYPE_CHECKING, Any

from .exceptions import ProjectNotFoundError
from .io import read_json, write_json_atomic
from .models import DatasetTypeInfo, DfmMethodRef, ProjectSettings
from .paths import (
    RESERVING_CLASS_INDEX_FILE_NAME,
    clean_text,
    dfm_filename,
    parse_dfm_filename,
    project_dir_case_insensitive,
    sanitize_reserving_class_folder,
)

if TYPE_CHECKING:
    from .client import ArcRhoClient
    from .dfm import DfmMethod
    from .reserving_class import ReservingClass


class Project:
    """ArcRho project folder under an ArcRho Server root."""

    def __init__(self, client: "ArcRhoClient", name: str) -> None:
        self.client = client
        self.name = clean_text(name)
        self.path = self._require_path()
        self.data_dir = self.path / "data"
        self.users_dir = self.path / "users"

    def _require_path(self) -> Path:
        project_path = project_dir_case_insensitive(self.client.projects_dir, self.name)
        if project_path is None:
            raise ProjectNotFoundError(f"Project folder not found under projects: {self.name}")
        return project_path

    @property
    def read_only(self) -> bool:
        return self.client.read_only

    def settings(self) -> ProjectSettings:
        general_path = self.path / "general_settings.json"
        general: dict[str, Any] = {}
        if general_path.exists():
            general = read_json(general_path)
        return ProjectSettings(project_name=self.name, project_path=self.path, general_settings=general)

    def reload_settings(self) -> ProjectSettings:
        return self.settings()

    @property
    def dataset_types_path(self) -> Path:
        return self.path / "dataset_types.json"

    def dataset_types(self) -> list[DatasetTypeInfo]:
        """Load project dataset types from dataset_types.json."""
        if not self.dataset_types_path.exists():
            return []
        raw = read_json(self.dataset_types_path, required_object=False)
        return _normalize_dataset_types(raw)

    def dataset_type(self, name: str) -> DatasetTypeInfo | None:
        wanted = clean_text(name).lower()
        if not wanted:
            return None
        for item in self.dataset_types():
            if item.name.lower() == wanted:
                return item
        return None

    def dataset_type_category(self, name: str) -> str:
        info = self.dataset_type(name)
        return info.category if info is not None else ""

    def reserving_class(self, path: str) -> "ReservingClass":
        from .reserving_class import ReservingClass

        return ReservingClass(self, path)

    def dfm(self, reserving_class: str, name: str) -> "DfmMethod":
        return self.reserving_class(reserving_class).dfm(name)

    def new_dfm(self, reserving_class: str, name: str, **details: Any) -> "DfmMethod":
        return self.reserving_class(reserving_class).new_dfm(name, **details)

    def dfm_exists(self, reserving_class: str, name: str) -> bool:
        return self.dfm_path(reserving_class, name).exists()

    def dfm_path(self, reserving_class: str, name: str) -> Path:
        return self.reserving_class_methods_dir(reserving_class) / dfm_filename(name)

    def reserving_class_data_dir(self, reserving_class: str) -> Path:
        return self.data_dir / sanitize_reserving_class_folder(reserving_class)

    def reserving_class_datasets_dir(self, reserving_class: str) -> Path:
        return self.reserving_class_data_dir(reserving_class) / "datasets"

    def reserving_class_methods_dir(self, reserving_class: str) -> Path:
        return self.reserving_class_data_dir(reserving_class) / "methods"

    def list_dfm_methods(self, refresh: bool = False) -> list[DfmMethodRef]:
        if refresh:
            return self.rebuild_dfm_index()
        if not self.data_dir.exists():
            return []
        refs: list[DfmMethodRef] = []
        for folder in self.data_dir.iterdir():
            if not folder.is_dir() or folder.name.lower() == "tmp":
                continue
            method_dir = folder / "methods"
            if not method_dir.is_dir():
                continue
            for path in method_dir.iterdir():
                if not path.is_file():
                    continue
                method_name = parse_dfm_filename(path.name)
                if method_name is None:
                    continue
                refs.append(DfmMethodRef(path=folder.name, name=method_name, file_path=path))
        refs.sort(key=lambda item: (item.path.lower(), item.name.lower()))
        return refs

    def rebuild_dfm_index(self) -> list[DfmMethodRef]:
        refs = self.list_dfm_methods(refresh=False)
        refs_by_path: dict[str, list[DfmMethodRef]] = {}
        for item in refs:
            refs_by_path.setdefault(item.path, []).append(item)
        folder_names = set(refs_by_path)
        if self.data_dir.exists():
            folder_names.update(
                item.name
                for item in self.data_dir.iterdir()
                if item.is_dir() and item.name.lower() != "tmp"
            )
        for folder_name in sorted(folder_names, key=str.lower):
            folder_refs = refs_by_path.get(folder_name, [])
            methods: list[dict[str, str]] = []
            for item in folder_refs:
                payload = read_json(item.file_path)
                details = payload.get("details tab") if isinstance(payload.get("details tab"), dict) else {}
                dataset_name = clean_text(details.get("output type"))
                if not dataset_name:
                    continue
                methods.append({
                    "dataset_name": dataset_name,
                    "method_type": "DFM",
                })
            methods.sort(key=lambda item: (item["dataset_name"].lower(), item["method_type"].lower()))
            write_json_atomic(
                self.data_dir / folder_name / RESERVING_CLASS_INDEX_FILE_NAME,
                {
                    "ok": True,
                    "version": 6,
                    "project_name": self.name,
                    "reserving_class": folder_name,
                    "folder_paths": {
                        "data": str(self.data_dir / folder_name),
                        "datasets": str(self.data_dir / folder_name / "datasets"),
                        "methods": str(self.data_dir / folder_name / "methods"),
                        "sidecars": str(self.data_dir / folder_name / "sidecars"),
                    },
                    "files": [
                        {
                            "dataset_name": item["dataset_name"],
                            "dataset_type_name": item["dataset_name"],
                            "method_type": item["method_type"],
                        }
                        for item in methods
                    ],
                },
                read_only=self.read_only,
            )
        return refs


def _bool_cell(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return bool(value)
    text = clean_text(value).lower()
    return text in {"1", "true", "yes", "y"}


def _normalize_dataset_types(raw: Any) -> list[DatasetTypeInfo]:
    rows: list[DatasetTypeInfo] = []
    if isinstance(raw, list):
        for item in raw:
            if not isinstance(item, dict):
                continue
            name = clean_text(item.get("Name", item.get("name", "")))
            if not name:
                continue
            rows.append(DatasetTypeInfo(
                name=name,
                data_format=clean_text(item.get("Data Format", item.get("data_format", ""))),
                category=clean_text(item.get("Category", item.get("category", ""))),
                calculated=_bool_cell(item.get("Calculated", item.get("calculated", False))),
                formula=clean_text(item.get("Formula", item.get("formula", ""))),
                source=clean_text(item.get("Source", item.get("source", ""))),
            ))
        return rows

    if not isinstance(raw, dict):
        return rows
    columns = raw.get("columns")
    raw_rows = raw.get("rows")
    if not isinstance(columns, list) or not isinstance(raw_rows, list):
        return rows
    col_idx: dict[str, int] = {}
    for index, column in enumerate(columns):
        label = clean_text(column)
        if label:
            col_idx[label] = index
            col_idx[label.lower()] = index

    def cell(row: list[Any], label: str, default: Any = "") -> Any:
        index = col_idx.get(label, col_idx.get(label.lower(), -1))
        return row[index] if index >= 0 and index < len(row) else default

    for raw_row in raw_rows:
        if not isinstance(raw_row, list):
            continue
        name = clean_text(cell(raw_row, "Name"))
        if not name:
            continue
        rows.append(DatasetTypeInfo(
            name=name,
            data_format=clean_text(cell(raw_row, "Data Format")),
            category=clean_text(cell(raw_row, "Category")),
            calculated=_bool_cell(cell(raw_row, "Calculated", False)),
            formula=clean_text(cell(raw_row, "Formula")),
            source=clean_text(cell(raw_row, "Source", raw_row[5] if len(raw_row) > 5 else "")),
        ))
    return rows
