"""Reserving-class scoped API object."""

from __future__ import annotations

import csv
import getpass
import json
import os
import time
import uuid
from datetime import datetime
from pathlib import Path
from typing import TYPE_CHECKING, Any

from .dataset_display_contract import normalize_show_subtotal
from .exceptions import DfmDataError, ReadOnlyError
from .io import persisted_json_text
from .models import DfmMethodRef, TriangleCacheResult
from .paths import clean_text, dataset_filename, sanitize_file_name_part, sanitize_reserving_class_folder
from .timestamps import utc_now_text

if TYPE_CHECKING:
    from .dfm import DfmMethod
    from .project import Project


class ReservingClass:
    """Project-scoped reserving class path."""

    def __init__(self, project: "Project", path: str) -> None:
        self.project = project
        self.path = clean_text(path)

    @property
    def name(self) -> str:
        return self.path

    @property
    def read_only(self) -> bool:
        return self.project.read_only

    def dfm(self, name: str) -> "DfmMethod":
        from .dfm import DfmMethod

        return DfmMethod.load_existing(self, name)

    def new_dfm(self, name: str, **details: Any) -> "DfmMethod":
        from .dfm import DfmMethod

        return DfmMethod.new(self, name, **details)

    def dfm_exists(self, name: str) -> bool:
        return self.project.dfm_exists(self.path, name)

    def list_dfm_methods(self, refresh: bool = False) -> list[DfmMethodRef]:
        refs = self.project.list_dfm_methods(refresh=refresh)
        expected = sanitize_reserving_class_folder(self.path).lower()
        return [item for item in refs if item.path.lower() == expected]

    @property
    def data_dir(self) -> Path:
        return self.project.reserving_class_data_dir(self.path)

    @property
    def datasets_dir(self) -> Path:
        if hasattr(self.project, "reserving_class_datasets_dir"):
            return self.project.reserving_class_datasets_dir(self.path)
        return self.data_dir / "datasets"

    def dataset_path(self, name: str) -> Path:
        wanted = dataset_filename(name)
        direct = self.datasets_dir / wanted
        if direct.exists():
            return direct
        wanted_lower = wanted.lower()
        if self.datasets_dir.exists():
            for item in self.datasets_dir.iterdir():
                if item.is_file() and item.name.lower() == wanted_lower:
                    return item
        return direct

    def dataset_exists(self, name: str) -> bool:
        return self.dataset_path(name).is_file()

    def list_datasets(self) -> list[str]:
        if not self.datasets_dir.exists():
            return []
        names = [item.stem for item in self.datasets_dir.iterdir() if item.is_file() and item.suffix.lower() == ".csv"]
        return sorted(names, key=str.lower)

    def read_dataset(self, name: str) -> list[list[Any]]:
        return _read_csv_matrix(self.dataset_path(name))

    def read_triangle(self, name: str) -> list[list[Any]]:
        return self.read_dataset(name)

    def triangle_cache_path(
        self,
        name: str,
        *,
        cumulative: bool = True,
        origin_length: int = 12,
        development_length: int = 12,
    ) -> Path:
        """Return the ArcRhoTri CSV cache path for this reserving class."""

        filename = _length_scoped_dataset_filename(
            name,
            origin_length,
            development_length,
            cumulative=cumulative,
        )
        return self.project.path / "data" / sanitize_reserving_class_folder(self.path) / "datasets" / filename

    def add_triangle(
        self,
        name: str,
        *,
        cumulative: bool = True,
        origin_length: int = 12,
        development_length: int = 12,
        timeout_sec: float = 6.0,
        force_refresh: bool = False,
    ) -> TriangleCacheResult:
        """Ensure an ArcRhoTri CSV cache exists, requesting it if needed.

        If the cache file is already present, it is reused. Otherwise this writes an
        ArcRhoTri request JSON to the server requests folder and waits for the engine
        to produce the CSV.
        """

        dataset_name = clean_text(name)
        if not dataset_name:
            raise DfmDataError("Triangle dataset name cannot be blank.")

        data_path = self.triangle_cache_path(
            dataset_name,
            cumulative=cumulative,
            origin_length=origin_length,
            development_length=development_length,
        )
        if data_path.is_file() and not force_refresh:
            self._write_triangle_sidecar_if_allowed(
                data_path,
                dataset_name,
                origin_length=origin_length,
                development_length=development_length,
            )
            return TriangleCacheResult(dataset_name=dataset_name, file_path=data_path, from_cache=True)

        if self.read_only:
            raise ReadOnlyError(f"Cannot request missing ArcRhoTri cache through a read-only client: {data_path}")

        if force_refresh and data_path.exists():
            try:
                data_path.unlink()
            except OSError as err:
                raise DfmDataError(f"Failed to clear ArcRhoTri cache {data_path}: {err}") from err

        data_path.parent.mkdir(parents=True, exist_ok=True)
        request_path = self._write_triangle_request(
            dataset_name,
            data_path,
            cumulative=cumulative,
            origin_length=origin_length,
            development_length=development_length,
        )
        if not _wait_for_file(data_path, timeout_sec=max(0.1, float(timeout_sec))):
            raise DfmDataError(
                "Timed out waiting for ArcRhoTri CSV cache. "
                f"Request file: {request_path}; expected CSV: {data_path}"
            )
        self._write_triangle_sidecar(
            data_path,
            dataset_name,
            origin_length=origin_length,
            development_length=development_length,
        )
        refreshed_outputs: tuple[str, ...] = ()
        propagation_warnings: tuple[str, ...] = ()
        try:
            from .dfm_propagation import refresh_dfm_dependents

            propagation = refresh_dfm_dependents(self, dataset_name)
            refreshed_outputs = propagation.refreshed_outputs
            propagation_warnings = propagation.warnings
        except Exception as err:
            propagation_warnings = (f"DFM propagation could not start: {err}",)
        return TriangleCacheResult(
            dataset_name=dataset_name,
            file_path=data_path,
            from_cache=False,
            request_path=request_path,
            refreshed_dfm_outputs=refreshed_outputs,
            propagation_warnings=propagation_warnings,
        )

    def _write_triangle_request(
        self,
        dataset_name: str,
        data_path: Path,
        *,
        cumulative: bool,
        origin_length: int,
        development_length: int,
    ) -> Path:
        self.project.client.requests_dir.mkdir(parents=True, exist_ok=True)
        payload = {
            "Function": "ArcRhoTri",
            "Path": self.path,
            "DatasetName": dataset_name,
            "Cumulative": bool(cumulative),
            "Transposed": False,
            "Calendar": False,
            "ProjectName": self.project.name,
            "OriginLength": int(origin_length),
            "DevelopmentLength": int(development_length),
            "DataPath": str(data_path),
            "UserName": getpass.getuser(),
        }
        timestamp = datetime.now().strftime("%Y-%m-%d_%H-%M-%S.%f")[:-3]
        stem = f"request-{timestamp}"
        temp_path = self.project.client.requests_dir / f"{stem}.{uuid.uuid4()}.tmp"
        final_path = self.project.client.requests_dir / f"{stem}.json"
        if final_path.exists():
            final_path = self.project.client.requests_dir / f"{stem}-{uuid.uuid4().hex[:8]}.json"
        try:
            temp_path.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
            os.replace(temp_path, final_path)
        except OSError as err:
            try:
                temp_path.unlink(missing_ok=True)
            except OSError:
                pass
            raise DfmDataError(f"Failed to write ArcRhoTri request file: {err}") from err
        return final_path

    def _write_triangle_sidecar_if_allowed(
        self,
        data_path: Path,
        dataset_name: str,
        *,
        origin_length: int,
        development_length: int,
    ) -> None:
        if self.read_only:
            return
        self._write_triangle_sidecar(
            data_path,
            dataset_name,
            origin_length=origin_length,
            development_length=development_length,
        )

    def _write_triangle_sidecar(
        self,
        data_path: Path,
        dataset_name: str,
        *,
        origin_length: int,
        development_length: int,
    ) -> Path:
        sidecar_dir = data_path.parent.parent / "sidecars" if data_path.parent.name == "datasets" else data_path.parent / "sidecars"
        sidecar_dir.mkdir(parents=True, exist_ok=True)
        sidecar_path = sidecar_dir / f"{sanitize_file_name_part(dataset_name, 'Dataset')}.json"
        existing: dict[str, Any] = {}
        if sidecar_path.is_file():
            try:
                parsed = json.loads(sidecar_path.read_text(encoding="utf-8"))
                existing = parsed if isinstance(parsed, dict) else {}
            except (OSError, json.JSONDecodeError):
                existing = {}
        payload = {
            **existing,
            "dataset_name": dataset_name,
            "dataset_type": dataset_name,
            "instance_name": dataset_name,
            "reserving_class": self.path,
            "project_name": self.project.name,
            "source_kind": "engine",
            "calculated": False,
            "method_type": "None",
            "status": 0,
            "data_format": "Triangle",
            "data_format_code": 0,
            "origin_length": int(origin_length),
            "development_length": int(development_length),
            "show_subtotal": normalize_show_subtotal(existing.get("show_subtotal")),
            "csv_file": data_path.name,
            "updated_at": utc_now_text(),
            "precedents": existing.get("precedents") if isinstance(existing.get("precedents"), list) else [],
            "dependents": existing.get("dependents") if isinstance(existing.get("dependents"), list) else [],
        }
        temp_path = sidecar_path.with_name(f"{sidecar_path.name}.{uuid.uuid4()}.tmp")
        try:
            temp_path.write_text(persisted_json_text(payload), encoding="utf-8")
            os.replace(temp_path, sidecar_path)
        except OSError as err:
            try:
                temp_path.unlink(missing_ok=True)
            except OSError:
                pass
            raise DfmDataError(f"Failed to write ArcRhoTri cache metadata {sidecar_path}: {err}") from err
        return sidecar_path


def _parse_csv_cell(value: str) -> Any:
    text = str(value if value is not None else "").strip()
    if text == "":
        return None
    try:
        return float(text.replace(",", ""))
    except ValueError:
        return text


def _read_csv_matrix(path: Path) -> list[list[Any]]:
    try:
        with path.open("r", encoding="utf-8-sig", newline="") as fh:
            return [[_parse_csv_cell(cell) for cell in row] for row in csv.reader(fh)]
    except OSError as err:
        raise DfmDataError(f"Failed to read CSV file {path}: {err}") from err


def _length_scoped_dataset_filename(
    dataset_name: Any,
    origin_length: Any,
    development_length: Any,
    *,
    cumulative: bool = True,
) -> str:
    dataset_file = sanitize_file_name_part(dataset_name, "Dataset")
    origin = clean_text(origin_length)
    development = clean_text(development_length)
    if origin and development:
        cum_suffix = "cum" if cumulative else "inc"
        dataset_file = f"{dataset_file}@{origin}@{development}@{cum_suffix}@dev"
    return f"{dataset_file}.csv"


def _wait_for_file(path: Path, timeout_sec: float, settle_ms: float = 50.0) -> bool:
    deadline = time.time() + max(0.0, float(timeout_sec))
    while time.time() <= deadline:
        if path.exists():
            if settle_ms > 0:
                time.sleep(settle_ms / 1000.0)
            return True
        time.sleep(0.1)
    return path.exists()
