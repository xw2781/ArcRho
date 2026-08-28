"""DFM method object and production migration helpers."""

from __future__ import annotations

import csv
import getpass
import os
import re
import threading
import uuid
from collections.abc import Iterable as IterableABC, Sequence
from copy import deepcopy
from datetime import datetime, timezone
from pathlib import Path
from typing import TYPE_CHECKING, Any, Iterable

from .sidecar_core_contract import dependency_entries
from .dfm_contract import (
    build_dfm_output_sidecar,
    default_average_formulas,
    dependency_entries,
    dfm_output_variants,
    dfm_precedent_names,
    normalize_dfm_method,
    persisted_projection,
    recalculate_dfm_method,
)
from .exceptions import DfmDataError, InvalidDfmJsonError, ReadOnlyError
from .io import persisted_json_text, read_json
from .paths import DFM_JSON_FORMAT, clean_text, sanitize_file_name_part
from .sidecar_audit_contract import AUDIT_ACTION_AUTO_REFRESH
from .sidecar_core_contract import with_audit_log_last
from .timestamps import utc_now_text

if TYPE_CHECKING:
    from .reserving_class import ReservingClass


_DFM_PUBLISH_LOCKS_GUARD = threading.Lock()
_DFM_PUBLISH_LOCKS: dict[str, threading.RLock] = {}


def _dfm_publish_lock(path: Path) -> threading.RLock:
    key = str(path.resolve()).casefold()
    with _DFM_PUBLISH_LOCKS_GUARD:
        return _DFM_PUBLISH_LOCKS.setdefault(key, threading.RLock())


def _tab(payload: dict[str, Any], key: str) -> dict[str, Any]:
    value = payload.get(key)
    if isinstance(value, dict):
        return value
    value = {}
    payload[key] = value
    return value


def _get_tab(payload: dict[str, Any], key: str) -> dict[str, Any]:
    value = payload.get(key)
    return value if isinstance(value, dict) else {}


def _matrix(value: Any) -> list[list[Any]]:
    return value if isinstance(value, list) else []


def _coerce_matrix(value: Any) -> list[list[Any]]:
    if not isinstance(value, list):
        return []
    return [row if isinstance(row, list) else [] for row in value]


def _trim_trailing(row: list[Any], trim_values: tuple[Any, ...]) -> list[Any]:
    out = list(row)
    while out and out[-1] in trim_values:
        out.pop()
    return out


def _trim_trailing_nulls_in_matrix(value: Any) -> list[list[Any]]:
    return [_trim_trailing(row, (None,)) for row in _coerce_matrix(value)]


def _trim_trailing_empty_text_in_matrix(value: Any) -> list[list[Any]]:
    return [_trim_trailing(row, ("", None)) for row in _coerce_matrix(value)]


def _parse_csv_cell(value: str) -> Any:
    text = str(value if value is not None else "").strip()
    if text == "":
        return None
    try:
        number = float(text.replace(",", ""))
    except ValueError:
        return text
    return number


def _read_csv_matrix(path: Path) -> list[list[Any]]:
    try:
        with path.open("r", encoding="utf-8-sig", newline="") as fh:
            return [[_parse_csv_cell(cell) for cell in row] for row in csv.reader(fh)]
    except OSError as err:
        raise DfmDataError(f"Failed to read CSV file {path}: {err}") from err


def _matrix_shape(reference: list[list[Any]]) -> tuple[int, int]:
    rows = len(reference)
    cols = max((len(row) for row in reference if isinstance(row, list)), default=0)
    return rows, cols


def _ensure_matrix(container: dict[str, Any], key: str, rows: int, cols: int, fill: Any = 0) -> list[list[Any]]:
    existing = _coerce_matrix(container.get(key))
    while len(existing) < rows:
        existing.append([])
    for row in existing:
        while len(row) < cols:
            row.append(fill)
    if rows >= 0:
        existing = existing[:rows]
    for index, row in enumerate(existing):
        existing[index] = row[:cols]
    container[key] = existing
    return existing


def _normalize_label(value: Any) -> str:
    return " ".join(str(value if value is not None else "").split()).strip()


def _split_agent_values(value: Iterable[Any] | Any | None) -> list[Any]:
    if value is None:
        return []
    if isinstance(value, str):
        return [item.strip() for item in value.split(",") if item.strip()]
    if isinstance(value, IterableABC):
        out: list[Any] = []
        for item in value:
            out.extend(_split_agent_values(item))
        return out
    return [value]


def _normalize_agent_inspect_include(include: Iterable[str] | str | None) -> list[str]:
    aliases = {
        "summary": "summary",
        "info": "summary",
        "data": "data-triangle",
        "data-triangle": "data-triangle",
        "input-data-triangle": "data-triangle",
        "input": "data-triangle",
        "ratio": "ratio-triangle",
        "ratio-triangle": "ratio-triangle",
        "ratio-values": "ratio-triangle",
        "ratios": "ratio-triangle",
        "average": "average-formulas",
        "average-formulas": "average-formulas",
        "avg": "average-formulas",
        "ultimate": "ultimate-vector",
        "ultimate-vector": "ultimate-vector",
        "results": "ultimate-vector",
    }
    default = ["summary", "average-formulas"]
    raw_items = _split_agent_values(include)
    if not raw_items:
        raw_items = default
    out: list[str] = []
    for item in raw_items:
        key = str(item).strip().lower().replace("_", "-")
        normalized = aliases.get(key)
        if normalized and normalized not in out:
            out.append(normalized)
    return out or default


def _normalize_agent_inspect_origins(origins: Iterable[int | str] | int | str | None) -> list[int | str]:
    out: list[int | str] = []
    for item in _split_agent_values(origins):
        text = str(item).strip()
        if not text:
            continue
        out.append(int(text) if text.isdigit() else text)
    return out


def _label_key(value: Any) -> str:
    label = _normalize_label(value)
    if ":" in label:
        prefix, rest = label.split(":", 1)
        if prefix.strip().isdigit():
            label = rest.strip()
    return label.lower()


def _display_average_label(value: Any) -> str:
    label = _normalize_label(value)
    if ":" in label:
        _prefix, rest = label.split(":", 1)
        if rest.strip():
            return rest.strip()
    return label


def _cell_note_table_name(table: str) -> str:
    key = clean_text(table).lower().replace("_", " ").replace("-", " ")
    aliases = {
        "main": "ratio_main_table",
        "ratio": "ratio_main_table",
        "ratio main": "ratio_main_table",
        "ratio_main_table": "ratio_main_table",
        "summary": "ratio_summary_table",
        "average": "ratio_summary_table",
        "average_formulas": "ratio_summary_table",
        "ratio summary": "ratio_summary_table",
        "ratio_summary_table": "ratio_summary_table",
    }
    if key in aliases:
        return aliases[key]
    raise DfmDataError(f"Unknown DFM cell-note table: {table!r}")


def _as_col_index(dev_period: int) -> int:
    try:
        col = int(dev_period) - 1
    except (TypeError, ValueError) as err:
        raise DfmDataError(f"Development period must be an integer: {dev_period!r}") from err
    if col < 0:
        raise DfmDataError(f"Development period must be 1-based and positive: {dev_period!r}")
    return col


def _dev_periods_to_cols(dev_periods: int | Iterable[int] | str, col_count: int) -> list[int]:
    if isinstance(dev_periods, str):
        text = dev_periods.strip().lower()
        if text in {"", "all", "*"}:
            return list(range(col_count))
        return [_as_col_index(int(text))]
    if isinstance(dev_periods, int):
        return [_as_col_index(dev_periods)]
    return [_as_col_index(value) for value in dev_periods]


def _is_number(value: Any) -> bool:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return False
    return number == number and number not in (float("inf"), float("-inf"))


def _number(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if number != number or number in (float("inf"), float("-inf")):
        return None
    return number


def _as_legacy_index(index: int) -> int:
    """Resolve the public 1-based DFM index while tolerating 0 for first item."""
    idx = int(index)
    return idx - 1 if idx > 0 else idx


def _now_iso() -> str:
    return utc_now_text()


def _json_bytes(payload: dict[str, Any]) -> bytes:
    return persisted_json_text(payload).encode("utf-8")


def _method_json_bytes(payload: dict[str, Any]) -> bytes:
    """The on-disk bytes of a DFM method.

    Every DFM method writer -- this public API, the bundled app server, and the
    ResQ migration -- serializes through ``persisted_projection`` so the same
    logical method lands on disk as the same bytes whichever component saved it.
    """

    return _json_bytes(persisted_projection(payload))


def _commit_bytes_atomic(files: dict[Path, bytes], *, last_paths: Iterable[Path] = ()) -> None:
    """Replace a small related file set transactionally, with sidecar-last ordering."""

    last_keys = {str(path.resolve()).casefold() for path in last_paths}
    ordered = sorted(files, key=lambda path: (str(path.resolve()).casefold() in last_keys, str(path).casefold()))
    staged: dict[Path, Path] = {}
    backups: dict[Path, bytes | None] = {}
    replaced: list[Path] = []
    try:
        for path in ordered:
            path.parent.mkdir(parents=True, exist_ok=True)
            current = path.read_bytes() if path.is_file() else None
            if current == files[path]:
                continue
            backups[path] = current
            temporary = path.with_name(f"{path.name}.{uuid.uuid4().hex}.tmp")
            temporary.write_bytes(files[path])
            staged[path] = temporary
        for path in ordered:
            temporary = staged.pop(path, None)
            if temporary is None:
                continue
            os.replace(temporary, path)
            replaced.append(path)
    except OSError as err:
        rollback_errors: list[str] = []
        for path in reversed(replaced):
            try:
                original = backups.get(path)
                if original is None:
                    path.unlink(missing_ok=True)
                else:
                    temporary = path.with_name(f"{path.name}.{uuid.uuid4().hex}.rollback")
                    temporary.write_bytes(original)
                    os.replace(temporary, path)
            except OSError as rollback_err:
                rollback_errors.append(f"{path.name}: {rollback_err}")
        detail = f"; rollback failed: {'; '.join(rollback_errors)}" if rollback_errors else ""
        raise DfmDataError(f"Failed to publish DFM files: {err}{detail}") from err
    finally:
        for temporary in staged.values():
            try:
                temporary.unlink(missing_ok=True)
            except OSError:
                pass


class DfmMethod:
    """One ArcRho DFM method JSON file."""

    def __init__(self, reserving_class: "ReservingClass", name: str, payload: dict[str, Any], file_path: Path) -> None:
        self.reserving_class_obj = reserving_class
        self.project = reserving_class.project
        self.project_name = reserving_class.project.name
        self.reserving_class = reserving_class.path
        self.name = clean_text(name)
        self.file_path = file_path
        self.payload = payload
        self._pending_notes: str | None = None
        self._last_ratio_adjustment: dict[str, Any] | None = None
        self._last_refreshed_dfm_outputs: tuple[str, ...] = ()
        self._propagation_warnings: tuple[str, ...] = ()
        self._ensure_grouped_payload()

    def __len__(self) -> int:
        labels = self._origin_labels()
        if labels:
            return len(labels)
        rows, _cols = self._ratio_shape()
        return rows

    @classmethod
    def load_existing(cls, reserving_class: "ReservingClass", name: str) -> "DfmMethod":
        file_path = reserving_class.project.dfm_path(reserving_class.path, name)
        if not file_path.exists():
            raise InvalidDfmJsonError(f"DFM method JSON not found: {file_path}")
        payload = read_json(file_path)
        return cls(reserving_class, name, payload, file_path)

    @classmethod
    def load_file(cls, file_path: str | Path, *, read_only: bool = False) -> "DfmMethod":
        path = Path(file_path).expanduser().resolve()
        if not path.exists():
            raise InvalidDfmJsonError(f"DFM method JSON not found: {path}")
        payload = read_json(path)
        details = _get_tab(payload, "details_tab")
        name = clean_text(details.get("name")) or path.stem

        class _StandaloneProject:
            def __init__(self, method_path: Path, read_only_value: bool) -> None:
                self.name = clean_text(_get_tab(payload, "method_metadata").get("project")) or ""
                if method_path.parent.name.lower() == "methods" and method_path.parent.parent.parent.name.lower() == "data":
                    self.path = method_path.parent.parent.parent.parent
                    self.data_dir = method_path.parent.parent.parent
                elif method_path.parent.parent.name.lower() == "data":
                    self.path = method_path.parent.parent.parent
                    self.data_dir = method_path.parent.parent
                else:
                    self.path = method_path.parent
                    self.data_dir = method_path.parent
                self.read_only = bool(read_only_value)

            def dfm_path(self, _reserving_class: str, _name: str) -> Path:
                return path

            def reserving_class_data_dir(self, _reserving_class: str) -> Path:
                if path.parent.name.lower() == "methods":
                    return path.parent.parent
                return path.parent

            def rebuild_dfm_index(self) -> list[Any]:
                return []

        class _StandaloneReservingClass:
            def __init__(self, project: _StandaloneProject) -> None:
                self.project = project
                self.path = clean_text(details.get("reserving class")) or ""

            @property
            def read_only(self) -> bool:
                return self.project.read_only

        project = _StandaloneProject(path, read_only)
        reserving_class = _StandaloneReservingClass(project)
        return cls(reserving_class, name, payload, path)

    @classmethod
    def new(
        cls,
        reserving_class: "ReservingClass",
        name: str,
        *,
        output_vector: str,
        input_triangle: str,
        origin_length: int,
        development_length: int,
        decimal_places: int = 4,
        notes: str = "",
        **extra: Any,
    ) -> "DfmMethod":
        method_name = clean_text(name)
        payload: dict[str, Any] = {
            "json_format": DFM_JSON_FORMAT,
            "details_tab": {
                "name": method_name,
                "output_type": clean_text(output_vector),
                "output_dataset": method_name,
                "output_category": "",
                "input_triangle": clean_text(input_triangle),
                "origin_length": int(origin_length),
                "development_length": int(development_length),
                "decimal_places": int(decimal_places),
            },
            "data_tab": {
                "origin_labels": [],
                "development_labels": [],
                "input_data_triangle_values": [],
                "input_data_triangle_mask": [],
                "number_format": "#,##0",
                "decimal_places": 0,
                "source_revision": "",
            },
            "ratios_tab": {
                "ratio_triangle": {
                    "origin_labels": [],
                    "development_labels": [],
                    "ratio_values": [],
                    "excluded": [],
                },
                "average_formulas": default_average_formulas(),
            },
            "results_tab": {
                "ratio_basis_dataset": "",
                "ratio_basis_origin_labels": [],
                "ratio_basis_values": [],
                "ratio_basis_number_format": "#,##0",
                "ratio_basis_decimal_places": 0,
                "ratio_basis_source_revision": "",
                "ultimate_ratio_decimal_places": 2,
                "ultimate_vector": [],
            },
            "method_metadata": {
                "last_modified": _now_iso(),
                "data_refreshed": _now_iso(),
            },
        }
        if extra:
            payload["api metadata"] = {"new_dfm extra": extra}
        method = cls(
            reserving_class,
            method_name,
            payload,
            reserving_class.project.dfm_path(reserving_class.path, method_name),
        )
        if notes:
            method.update_notes(notes)
        return method

    def load(self) -> "DfmMethod":
        self.payload = read_json(self.file_path)
        self._ensure_grouped_payload()
        return self

    def to_dict(self) -> dict[str, Any]:
        return deepcopy(self.payload)

    def set_input_snapshot(self, snapshot: dict[str, Any]) -> "DfmMethod":
        try:
            self.payload = recalculate_dfm_method(self.payload, input_snapshot=snapshot)
        except ValueError as err:
            raise DfmDataError(str(err)) from err
        return self

    def set_ratio_basis_snapshot(self, snapshot: dict[str, Any]) -> "DfmMethod":
        try:
            self.payload = recalculate_dfm_method(self.payload, ratio_basis_snapshot=snapshot)
        except ValueError as err:
            raise DfmDataError(str(err)) from err
        return self

    def _source_sidecar(self, dataset_name: str) -> dict[str, Any]:
        data_dir = self.project.reserving_class_data_dir(self.reserving_class)
        path = data_dir / "sidecars" / f"{sanitize_file_name_part(dataset_name, 'Dataset')}.json"
        return read_json(path) if path.is_file() else {}

    def _source_csv_path(
        self,
        dataset_name: str,
        sidecar: dict[str, Any],
        *,
        legacy_path: Any = None,
    ) -> Path:
        data_dir = self.project.reserving_class_data_dir(self.reserving_class)
        datasets_dir = data_dir / "datasets"
        csv_file = clean_text(sidecar.get("csv_file"))
        if csv_file:
            candidate = datasets_dir / Path(csv_file).name
            if candidate.is_file():
                return candidate
        if clean_text(legacy_path):
            resolved = self._resolve_data_path(legacy_path)
            if resolved and resolved.is_file():
                return resolved
        prefix = f"{sanitize_file_name_part(dataset_name, 'Dataset')}@".casefold()
        candidates = sorted(
            (
                path
                for path in datasets_dir.glob("*.csv")
                if path.name.casefold().startswith(prefix)
                or path.stem.casefold() == sanitize_file_name_part(dataset_name, "Dataset").casefold()
            ),
            key=lambda path: path.name.casefold(),
        )
        if len(candidates) == 1:
            return candidates[0]
        if not candidates:
            raise DfmDataError(f"DFM source dataset CSV not found: {dataset_name}")
        raise DfmDataError(f"DFM source dataset CSV is ambiguous: {dataset_name}")

    def _source_snapshot(
        self,
        dataset_name: str,
        *,
        vector: bool,
        legacy_path: Any = None,
    ) -> dict[str, Any]:
        sidecar = self._source_sidecar(dataset_name)
        path = self._source_csv_path(dataset_name, sidecar, legacy_path=legacy_path)
        matrix = _read_csv_matrix(path)
        fallback_origins = (
            self.results_tab.get("ratio_basis_origin_labels")
            if vector
            else self.data_tab.get("origin_labels")
        )
        origin_labels = sidecar.get("origin_labels")
        if not isinstance(origin_labels, list) or len(origin_labels) != len(matrix):
            origin_labels = fallback_origins if isinstance(fallback_origins, list) and len(fallback_origins) == len(matrix) else []
        if not origin_labels:
            origin_labels = [str(index + 1) for index in range(len(matrix))]
        data_format = clean_text(sidecar.get("data_format")) or ("Vector" if vector else "Triangle")
        values: Any = matrix
        development_labels: list[str] = []
        if vector:
            if data_format.lower() == "triangle":
                values = [
                    next((value for value in reversed(row) if _number(value) is not None), None)
                    for row in matrix
                ]
            else:
                values = [row[0] if row else None for row in matrix]
        else:
            development_labels = sidecar.get("development_labels") if isinstance(sidecar.get("development_labels"), list) else []
            if not development_labels:
                existing = self.data_tab.get("development_labels")
                if isinstance(existing, list) and len(existing) == max((len(row) for row in matrix), default=0):
                    development_labels = [str(item) for item in existing]
            if not development_labels:
                development_length = int(self.details.get("development_length") or 12)
                development_labels = [
                    f"{development_length * (index + 1)}m"
                    for index in range(max((len(row) for row in matrix), default=0))
                ]
        snapshot: dict[str, Any] = {
            "name": dataset_name,
            "origin_labels": [str(item) for item in origin_labels],
            "values": values,
            "data_format": data_format,
            "number_format": clean_text(sidecar.get("number_format")) or "#,##0",
            "decimal_places": int(sidecar.get("decimal_places") or 0),
            "revision": clean_text(
                sidecar.get("publication_revision")
                or sidecar.get("updated_at")
                or sidecar.get("modified")
            ),
        }
        if not vector:
            snapshot["development_labels"] = development_labels
            snapshot["mask"] = [[_number(value) is not None for value in row] for row in matrix]
        return snapshot

    def _upgrade_or_hydrate_v2(self) -> None:
        input_name = clean_text(self.details.get("input_triangle"))
        if not input_name:
            raise DfmDataError("DFM input triangle is required before save.")
        input_values = self.data_tab.get("input_data_triangle_values")
        if not isinstance(input_values, list) or not input_values:
            self.payload = recalculate_dfm_method(
                self.payload,
                input_snapshot=self._source_snapshot(input_name, vector=False),
            )
        basis_name = clean_text(self.results_tab.get("ratio_basis_dataset"))
        basis_values = self.results_tab.get("ratio_basis_values")
        if basis_name and (not isinstance(basis_values, list) or not basis_values):
            self.payload = recalculate_dfm_method(
                self.payload,
                ratio_basis_snapshot=self._source_snapshot(basis_name, vector=True),
            )

    def _output_csv_files(self) -> tuple[Path, dict[Path, bytes]]:
        output_dataset = clean_text(self.details.get("output_dataset")) or self.name
        origin_length = int(self.details.get("origin_length") or 12)
        data_dir = self.project.reserving_class_data_dir(self.reserving_class) / "datasets"
        files: dict[Path, bytes] = {}
        for period_length, values in dfm_output_variants(self.payload).items():
            filename = f"{sanitize_file_name_part(output_dataset, 'Dataset')}@{period_length}.csv"
            text = "".join(f"{'' if value is None else value}\n" for value in values)
            files[data_dir / filename] = text.encode("utf-8")
        primary = data_dir / f"{sanitize_file_name_part(output_dataset, 'Dataset')}@{origin_length}.csv"
        return primary, files

    def _output_sidecar_payload(
        self,
        csv_path: Path,
        existing: dict[str, Any],
        *,
        modified_at: str,
        automatic: bool,
        changed: bool,
    ) -> dict[str, Any]:
        try:
            return build_dfm_output_sidecar(
                self.payload,
                project_name=self.project_name,
                reserving_class=self.reserving_class,
                csv_file=csv_path.name,
                existing=existing,
                notes=self._pending_notes,
                timestamp=modified_at,
                user=getpass.getuser(),
                output_changed=changed,
                append_audit=not automatic or changed,
                audit_action=AUDIT_ACTION_AUTO_REFRESH if automatic and changed else None,
            )
        except ValueError as err:
            raise DfmDataError(str(err)) from err

    def _precedent_graph_files(
        self,
        existing_output_sidecar: dict[str, Any],
        *,
        output_dataset: str,
    ) -> dict[Path, bytes]:
        sidecar_dir = self.project.reserving_class_data_dir(self.reserving_class) / "sidecars"
        old_precedents = [
            item["dataset_name"]
            for item in dependency_entries(existing_output_sidecar.get("precedents"))
        ]
        new_precedents = dfm_precedent_names(self.payload)
        old_by_key = {clean_text(name).casefold(): clean_text(name) for name in old_precedents if clean_text(name)}
        new_by_key = {clean_text(name).casefold(): clean_text(name) for name in new_precedents if clean_text(name)}
        graph_changed = set(old_by_key) != set(new_by_key)
        if graph_changed:
            targets = set(new_by_key)
            queue = [
                item["dataset_name"]
                for item in dependency_entries(existing_output_sidecar.get("dependents"))
            ]
            visited: set[str] = set()
            while queue:
                dependent = clean_text(queue.pop(0))
                dependent_key = dependent.casefold()
                if not dependent_key or dependent_key in visited:
                    continue
                if dependent_key in targets:
                    raise DfmDataError(
                        f"DFM precedent '{new_by_key[dependent_key]}' would create a dependency cycle."
                    )
                visited.add(dependent_key)
                dependent_path = sidecar_dir / f"{sanitize_file_name_part(dependent, 'Dataset')}.json"
                if not dependent_path.is_file():
                    continue
                dependent_sidecar = read_json(dependent_path)
                queue.extend(
                    item["dataset_name"]
                    for item in dependency_entries(dependent_sidecar.get("dependents"))
                )
        files: dict[Path, bytes] = {}
        for key in sorted(set(old_by_key) | set(new_by_key)):
            name = new_by_key.get(key) or old_by_key[key]
            path = sidecar_dir / f"{sanitize_file_name_part(name, 'Dataset')}.json"
            if path == self._sidecar_path():
                raise DfmDataError("A DFM output dataset cannot also be its own precedent.")
            if not path.is_file():
                if graph_changed and key in new_by_key:
                    raise DfmDataError(f"DFM precedent sidecar is missing: {name}")
                continue
            source = read_json(path)
            dependents = [
                item["dataset_name"]
                for item in dependency_entries(source.get("dependents"))
            ]
            next_dependents = [
                item for item in dependents if clean_text(item).casefold() != output_dataset.casefold()
            ]
            if key in new_by_key:
                next_dependents.append(output_dataset)
            normalized = dependency_entries(next_dependents)
            if normalized == dependency_entries(source.get("dependents")):
                continue
            source["dependents"] = normalized
            files[path] = _json_bytes(with_audit_log_last(source))
        return files

    def save(
        self,
        *,
        automatic: bool = False,
        output_changed: bool | None = None,
        changed: bool | None = None,
    ) -> Path:
        # ``changed`` lets an automatic refresh that rewrote the method's derived
        # values without moving its publication stamp the output sidecar and
        # record the refresh, exactly as the app server does.
        if self.project.read_only:
            raise ReadOnlyError(f"Cannot write {self.file_path}; client is read-only.")
        self._sync_details_identity()
        self._upgrade_or_hydrate_v2()
        modified_at = _now_iso()
        if not automatic:
            _tab(self.payload, "method_metadata")["last_modified"] = modified_at
        try:
            self.payload = recalculate_dfm_method(
                self.payload,
                timestamp=modified_at,
                update_refresh_timestamp=False,
            )
        except ValueError as err:
            raise DfmDataError(str(err)) from err
        csv_path, output_files = self._output_csv_files()
        sidecar_path = self._sidecar_path()
        output_dataset = clean_text(self.details.get("output_dataset")) or self.name
        rc_data_dir = self.project.reserving_class_data_dir(self.reserving_class)
        published_output_changed = True
        with _dfm_publish_lock(rc_data_dir):
            existing_sidecar = read_json(sidecar_path) if sidecar_path.is_file() else {}
            if existing_sidecar:
                existing_owner = clean_text(existing_sidecar.get("method_name"))
                if existing_owner.casefold() != self.name.casefold():
                    owner_text = existing_owner or "a non-DFM dataset"
                    raise DfmDataError(
                        f"DFM output dataset '{output_dataset}' is already owned by {owner_text!r}."
                    )
            published_output_changed = (
                bool(output_changed)
                if output_changed is not None
                else clean_text(existing_sidecar.get("publication_revision"))
                != clean_text(self.metadata.get("publication_revision"))
            )
            sidecar = self._output_sidecar_payload(
                csv_path,
                existing_sidecar,
                modified_at=modified_at,
                automatic=automatic,
                changed=bool(changed) or published_output_changed,
            )
            files = self._precedent_graph_files(
                existing_sidecar,
                output_dataset=output_dataset,
            )
            if not automatic or published_output_changed:
                files.update(output_files)
            files.update({
                self.file_path: _method_json_bytes(self.payload),
                sidecar_path: _json_bytes(sidecar),
            })
            _commit_bytes_atomic(files, last_paths=(sidecar_path,))
        self._pending_notes = None
        rebuild_one = getattr(self.project, "rebuild_reserving_class_index", None)
        if callable(rebuild_one):
            rebuild_one(self.reserving_class_obj.path)
        else:
            self.project.rebuild_dfm_index()
        self._last_refreshed_dfm_outputs = ()
        self._propagation_warnings = ()
        if not automatic and published_output_changed:
            try:
                from .dfm_propagation import refresh_dfm_dependents

                propagation = refresh_dfm_dependents(self.reserving_class_obj, output_dataset)
                self._last_refreshed_dfm_outputs = propagation.refreshed_outputs
                self._propagation_warnings = propagation.warnings
            except Exception as err:
                self._propagation_warnings = (f"DFM propagation could not start: {err}",)
        return self.file_path

    @property
    def refreshed_dfm_outputs(self) -> tuple[str, ...]:
        return self._last_refreshed_dfm_outputs

    @property
    def propagation_warnings(self) -> tuple[str, ...]:
        return self._propagation_warnings

    @property
    def output_vector(self) -> str:
        return clean_text(self.details.get("output_type"))

    def output_vector_dataset_type(self) -> Any | None:
        lookup = getattr(self.project, "dataset_type", None)
        if not callable(lookup):
            return None
        return lookup(self.output_vector)

    def output_vector_category(self) -> str:
        info = self.output_vector_dataset_type()
        return clean_text(getattr(info, "category", ""))

    @property
    def input_triangle(self) -> str:
        return clean_text(self.details.get("input_triangle"))

    @property
    def origin_length(self) -> int | None:
        return _int_or_none(self.details.get("origin_length"))

    @property
    def development_length(self) -> int | None:
        return _int_or_none(self.details.get("development_length"))

    @property
    def decimal_places(self) -> int | None:
        return _int_or_none(self.details.get("decimal_places"))

    @property
    def notes(self) -> str:
        if self._pending_notes is not None:
            return self._pending_notes
        path = self._sidecar_path()
        if not path.exists():
            return ""
        return str(read_json(path).get("notes") or "")

    @property
    def last_modified(self) -> str:
        return clean_text(self.metadata.get("last_modified"))

    @property
    def details(self) -> dict[str, Any]:
        return _tab(self.payload, "details_tab")

    @property
    def data_tab(self) -> dict[str, Any]:
        return _tab(self.payload, "data_tab")

    @property
    def ratios_tab(self) -> dict[str, Any]:
        return _tab(self.payload, "ratios_tab")

    @property
    def ratio_triangle(self) -> dict[str, Any]:
        return _tab(self.ratios_tab, "ratio_triangle")

    @property
    def average_formulas(self) -> dict[str, Any]:
        return _tab(self.ratios_tab, "average_formulas")

    @property
    def cell_notes(self) -> dict[str, Any]:
        return _tab(self.ratios_tab, "cell_notes")

    @property
    def results_tab(self) -> dict[str, Any]:
        return _tab(self.payload, "results_tab")

    @property
    def metadata(self) -> dict[str, Any]:
        return _tab(self.payload, "method_metadata")

    def update_details(self, **fields: Any) -> "DfmMethod":
        mapping = {
            "name": "name",
            "output_vector": "output_type",
            "output_type": "output_type",
            "input_triangle": "input_triangle",
            "origin_length": "origin_length",
            "development_length": "development_length",
            "decimal_places": "decimal_places",
        }
        for key, value in fields.items():
            target = mapping.get(key, key.replace("_", " "))
            self.details[target] = value
            if target == "name":
                self.name = clean_text(value)
                self.file_path = self.project.dfm_path(self.reserving_class, self.name)
        return self

    def update_notes(self, text: str) -> "DfmMethod":
        self._pending_notes = str(text or "")
        return self

    def add_notes(self, text: str, *, append: bool = True, add_space: bool | None = None) -> "DfmMethod":
        new_text = str(text or "")
        if not append:
            return self.update_notes(new_text)
        existing = self.notes
        if not existing:
            return self.update_notes(new_text)
        separator = "\n\n" if add_space is not False else "\n"
        return self.update_notes(f"{existing}{separator}{new_text}")

    def clear_notes(self) -> "DfmMethod":
        return self.update_notes("")

    def selected_average_formulas(self) -> dict[str, Any]:
        return deepcopy(self.average_formulas)

    def agent_summary(self) -> dict[str, Any]:
        ratio_values = self.ratio_values()
        labels = self._average_labels()
        selected = _coerce_matrix(self.average_formulas.get("selected"))
        selected_by_dev: list[dict[str, Any]] = []
        col_count = self._average_col_count()
        dev_labels = self.ratio_triangle.get("development_labels") or []
        for col in range(col_count):
            row_index = None
            for row, selected_row in enumerate(selected):
                if col < len(selected_row) and bool(selected_row[col]):
                    row_index = row
                    break
            selected_by_dev.append({
                "development index": col + 1,
                "development label": dev_labels[col] if col < len(dev_labels) else str(col + 1),
                "formula": labels[row_index] if row_index is not None and row_index < len(labels) else "",
            })
        return {
            "api method": "DfmMethod.agent_summary",
            "project": self.project_name,
            "reserving class": self.reserving_class,
            "name": self.name,
            "file path": str(self.file_path),
            "details": self.info(),
            "data_tab": {
                "origin_labels": self.data_tab.get("origin_labels") or [],
                "development_labels": self.data_tab.get("development_labels") or [],
                "source_revision": self.data_tab.get("source_revision") or "",
            },
            "ratios_tab": {
                "origin_labels": self.ratio_triangle.get("origin_labels") or [],
                "development_labels": self.ratio_triangle.get("development_labels") or [],
                "ratio shape": list(_matrix_shape(ratio_values)),
                "average_formulas": labels,
                "selected by development": selected_by_dev,
            },
            "results_tab": {
                "ratio_basis_dataset": self.results_tab.get("ratio_basis_dataset") or "",
                "ratio_basis_source_revision": self.results_tab.get("ratio_basis_source_revision") or "",
                "publication_revision": self.metadata.get("publication_revision") or "",
            },
            "notes preview": self.notes[:500],
        }

    def input_data_triangle(self) -> list[list[Any]]:
        embedded = self.data_tab.get("input_data_triangle_values")
        if isinstance(embedded, list):
            return deepcopy(_coerce_matrix(embedded))
        return []

    def ratio_values(self) -> list[list[Any]]:
        return _coerce_matrix(self.ratio_triangle.get("ratio_values"))

    def ratio_row(self, row: int | str) -> dict[str, Any]:
        row_index = self._resolve_row(row)
        values = self.ratio_values()
        excluded = _coerce_matrix(self.ratio_triangle.get("excluded"))
        origin_labels = self._origin_labels()
        dev_labels = self.ratio_triangle.get("development_labels") or []
        row_values = values[row_index] if row_index < len(values) else []
        row_excluded = excluded[row_index] if row_index < len(excluded) else []
        return {
            "api method": "DfmMethod.ratio_row",
            "origin index": row_index + 1,
            "origin label": origin_labels[row_index] if row_index < len(origin_labels) else str(row_index + 1),
            "development_labels": dev_labels,
            "values": row_values,
            "excluded": row_excluded,
        }

    def agent_inspect(
        self,
        include: Iterable[str] | str | None = None,
        origins: Iterable[int | str] | int | str | None = None,
    ) -> dict[str, Any]:
        include_items = _normalize_agent_inspect_include(include)
        origin_items = _normalize_agent_inspect_origins(origins)
        components: dict[str, Any] = {}
        if "summary" in include_items:
            components["summary"] = self.agent_summary()
        if "data-triangle" in include_items:
            components["data triangle"] = {
                "api method": "DfmMethod.input_data_triangle",
                "values": self.input_data_triangle(),
            }
        if "ratio-triangle" in include_items:
            components["ratio_triangle"] = {
                "api method": "DfmMethod.ratio_values",
                "origin_labels": self.ratio_triangle.get("origin_labels") or [],
                "development_labels": self.ratio_triangle.get("development_labels") or [],
                "values": self.ratio_values(),
                "excluded": self.ratio_triangle.get("excluded") or [],
            }
        if "average-formulas" in include_items:
            components["average_formulas"] = self.average_formula_summary()
        if "ultimate-vector" in include_items:
            components["ultimate_vector"] = {
                "api method": "DfmMethod.ultimate_vector",
                "values": self.ultimate_vector(),
            }
        ratio_rows = [self.ratio_row(origin) for origin in origin_items]
        return {
            "api method": "DfmMethod.agent_inspect",
            "file path": str(self.file_path),
            "included": include_items,
            "components": components,
            "ratio rows": ratio_rows,
        }

    def average_formula_summary(self) -> dict[str, Any]:
        return {
            "api method": "DfmMethod.average_formula_summary",
            "label": self.average_formulas.get("label") or [],
            "custom_average_formula_settings": self.average_formulas.get("custom_average_formula_settings") or {},
            "selected": self.average_formulas.get("selected") or [],
            "values": self.average_formulas.get("values") or [],
            "inputs": self.average_formulas.get("inputs") or [],
        }

    def set_cell_note(
        self,
        row_label: str,
        development: int | str,
        note: str,
        *,
        table: str = "ratio_summary_table",
    ) -> "DfmMethod":
        table_name = _cell_note_table_name(table)
        column_label = self._cell_note_development_label(development)
        row_key = self._cell_note_row_label(row_label, table_name)
        notes_by_row = self._cell_note_table(table_name)
        row_notes = notes_by_row.setdefault(row_key, {})
        if not isinstance(row_notes, dict):
            row_notes = {}
            notes_by_row[row_key] = row_notes
        note_text = str(note or "")
        if note_text:
            row_notes[column_label] = note_text
        else:
            row_notes.pop(column_label, None)
            if not row_notes:
                notes_by_row.pop(row_key, None)
        return self

    def clear_cell_notes_for_development(
        self,
        development: int | str,
        *,
        table: str = "ratio_summary_table",
    ) -> "DfmMethod":
        table_name = _cell_note_table_name(table)
        column_label = self._cell_note_development_label(development)
        notes_by_row = self._cell_note_table(table_name)
        # Remove legacy column-keyed notes written by older API helpers.
        notes_by_row.pop(column_label, None)
        for row_key, row_notes in list(notes_by_row.items()):
            if not isinstance(row_notes, dict):
                continue
            row_notes.pop(column_label, None)
            if not row_notes:
                notes_by_row.pop(row_key, None)
        return self

    def set_selected_average_cell_note(
        self,
        development: int | str,
        note: str,
        *,
        clear_column: bool = False,
    ) -> "DfmMethod":
        col = self._resolve_development_col(development)
        if clear_column:
            self.clear_cell_notes_for_development(col + 1)
        labels = self._average_labels()
        selected = _coerce_matrix(self.average_formulas.get("selected"))
        for row, selected_row in enumerate(selected):
            if col < len(selected_row) and bool(selected_row[col]):
                if row >= len(labels):
                    break
                return self.set_cell_note(labels[row], col + 1, note)
        raise DfmDataError(f"No selected average found for development period {self.dev_period(col + 1)}.")

    def set_ratio_exclusions(self, matrix: list[list[bool | int]]) -> "DfmMethod":
        self.ratio_triangle["excluded"] = [[1 if cell else 0 for cell in row] for row in matrix]
        return self

    def set_ratio_exclusion(self, row: int | str, development: int | str, excluded: bool = True) -> "DfmMethod":
        row_index = self._resolve_row(row)
        col = self._resolve_development_col(development)
        matrix = self._excluded_matrix()
        self._set_excluded_cell(matrix, row_index, col, 1 if excluded else 0)
        return self

    def include_ratio(self, row: int | str, development: int | str) -> "DfmMethod":
        return self.set_ratio_exclusion(row, development, False)

    def exclude_ratio(self, row: int | str, development: int | str) -> "DfmMethod":
        return self.set_ratio_exclusion(row, development, True)

    def clear(self) -> "DfmMethod":
        self.clear_notes()
        rows, cols = self._ratio_shape()
        if rows and cols:
            self.ratio_triangle["excluded"] = [[0 for _ in range(cols)] for _ in range(rows)]
        selected = _coerce_matrix(self.average_formulas.get("selected"))
        if selected:
            self.average_formulas["selected"] = [[0 for _ in row] for row in selected]
        self._last_ratio_adjustment = None
        return self

    def include_all_ratios(self) -> "DfmMethod":
        rows, cols = self._ratio_shape()
        self.ratio_triangle["excluded"] = [[0 for _ in range(cols)] for _ in range(rows)]
        return self

    def exclude_high(
        self,
        dev_period: int,
        count: int = 1,
        reason: str = "",
        add_notes: bool = True,
    ) -> "DfmMethod":
        return self._exclude_extreme(dev_period, count, high=True, reason=reason, add_notes=add_notes)

    def exclude_low(
        self,
        dev_period: int,
        count: int = 1,
        reason: str = "",
        add_notes: bool = True,
    ) -> "DfmMethod":
        return self._exclude_extreme(dev_period, count, high=False, reason=reason, add_notes=add_notes)

    def select_high(
        self,
        dev_period: int = 1,
        count: int = 1,
        reason: str = "",
        add_notes: bool = True,
    ) -> "DfmMethod":
        return self._select_extreme(dev_period, count, high=True, reason=reason, add_notes=add_notes)

    def select_low(
        self,
        dev_period: int = 1,
        count: int = 1,
        reason: str = "",
        add_notes: bool = True,
    ) -> "DfmMethod":
        return self._select_extreme(dev_period, count, high=False, reason=reason, add_notes=add_notes)

    def exclude_l_df(self, dev_period: int, row: int | str, reason: str = "", add_notes: bool = True) -> "DfmMethod":
        col = _as_col_index(dev_period)
        row_index = self._resolve_row(row)
        excluded = self._excluded_matrix()
        self._set_excluded_cell(excluded, row_index, col, 1)
        if reason and add_notes:
            self.add_notes(reason)
        return self

    def exclude_row(self, row: int | str, add_notes: bool = False) -> "DfmMethod":
        row_index = self._resolve_row(row)
        excluded = self._excluded_matrix()
        for col in range(len(excluded[row_index])):
            excluded[row_index][col] = 1
        if add_notes:
            self.add_notes(f"Excluded row {row}.")
        return self

    def exclude_origin_year(self, origin_year: int | str, reason: str = "") -> "DfmMethod":
        row_index = self._resolve_origin_year(origin_year)
        self.exclude_row(row_index + 1)
        if reason:
            self.add_notes(reason)
        return self

    def exclude_covid_years(self, years: Iterable[int] | None = None, add_notes: bool = True) -> "DfmMethod":
        target_years = list(years if years is not None else (2020, 2021))
        labels = self._origin_labels()
        for year in target_years:
            for index, label in enumerate(labels):
                if str(year) in str(label):
                    self.exclude_row(index + 1)
        if add_notes and target_years:
            self.add_notes(f"Excluded COVID accident years: {', '.join(str(year) for year in target_years)}.")
        return self

    def exclude_diagonal(
        self,
        dev_index: int,
        start_row: int | None = None,
        end_row: int | None = None,
        reason: str = "",
        add_notes: bool = True,
    ) -> "DfmMethod":
        rows, cols = self._ratio_shape()
        if not rows or not cols:
            raise DfmDataError("DFM has no ratio triangle values.")
        start = 0 if start_row is None else max(0, int(start_row) - 1)
        end = rows - 1 if end_row is None else min(rows - 1, int(end_row) - 1)
        excluded = self._excluded_matrix()
        diag = max(0, int(dev_index))
        for row in range(start, end + 1):
            col = cols - 1 - (row - start) - diag
            if 0 <= col < cols:
                excluded[row][col] = 1
        if reason and add_notes:
            self.add_notes(reason)
        return self

    def set_selected_average(self, label: str, dev_periods: int | Iterable[int] | str = "all") -> "DfmMethod":
        label_text = _normalize_label(label)
        if label_text.lower() in {"high", "low"}:
            return self._set_selected_extreme_average(label_text.lower() == "high", dev_periods)
        labels = self._average_labels()
        row_index = self._ensure_average_label(label)
        col_count = self._average_col_count()
        selected = _ensure_matrix(self.average_formulas, "selected", len(self._average_labels()), col_count, 0)
        for col in _dev_periods_to_cols(dev_periods, col_count):
            self._require_col(col, col_count)
            for row in selected:
                row[col] = 0
            selected[row_index][col] = 1
        # Keep labels variable referenced after possible row creation.
        _ = labels
        return self

    def set_selected_average_by_label(self, label: str, development: int | str = "all") -> "DfmMethod":
        if isinstance(development, str) and development.strip().lower() in {"", "all", "*"}:
            return self.set_selected_average(label, "all")
        return self.set_selected_average(label, self._resolve_development_col(development) + 1)

    def set_user_ratio(
        self,
        value: float,
        dev_period: int,
        row_index: int | None = None,
        *,
        formula: str | None = None,
    ) -> "DfmMethod":
        target_row = self._ensure_average_label("User Entry")
        if row_index is not None:
            target_row = max(0, int(row_index) - 1)
            self._ensure_average_row_count(target_row + 1)
        col_count = self._average_col_count()
        values = _ensure_matrix(self.average_formulas, "values", len(self._average_labels()), col_count, None)
        col = _as_col_index(dev_period)
        self._require_col(col, col_count)
        self._set_average_row_user_entry(target_row)
        values[target_row][col] = float(value)
        if formula is not None:
            inputs = _ensure_matrix(self.average_formulas, "inputs", len(self._average_labels()), col_count, "")
            inputs[target_row][col] = str(formula or "").strip() or str(float(value))
        return self.set_selected_average(self._average_labels()[target_row], dev_period)

    def set_user_formula(
        self,
        formula: str,
        value: float,
        dev_period: int,
        row_index: int | None = None,
    ) -> "DfmMethod":
        return self.set_user_ratio(value, dev_period, row_index, formula=formula)

    def copy_average_formula_patterns(
        self,
        source: "DfmMethod" | str | None = None,
        col_index: int | Iterable[int] | str = "all",
        skip_user_entry_values: bool = True,
        *,
        copy_values: bool = False,
    ) -> "DfmMethod":
        reference = self._resolve_source_dfm(source)
        if copy_values:
            self.ratios_tab["average_formulas"] = deepcopy(reference.average_formulas)
            return self
        self._copy_average_selection(reference, col_index, skip_user_entry_values=skip_user_entry_values)
        return self

    def copy_ratio_patterns(
        self,
        source: "DfmMethod" | str | None = None,
        row_index: int | Iterable[int] | str = "all",
        col_index: int | Iterable[int] | str = "all",
        row_offset: int | str = "automatic",
        col_offset: int = 0,
    ) -> "DfmMethod":
        reference = self._resolve_source_dfm(source)
        source_excluded = _coerce_matrix(reference.ratio_triangle.get("excluded"))
        if row_index == "all" and col_index == "all" and row_offset == "automatic" and int(col_offset or 0) == 0:
            self.ratio_triangle["excluded"] = deepcopy(source_excluded)
            return self
        target = self._excluded_matrix()
        rows = self._resolve_index_selection(row_index, len(target))
        cols = self._resolve_index_selection(col_index, max((len(row) for row in target), default=0))
        resolved_row_offset = reference._infer_row_offset(self) if row_offset == "automatic" else int(row_offset or 0)
        resolved_col_offset = int(col_offset or 0)
        for row in rows:
            source_row = row - resolved_row_offset
            if source_row < 0 or source_row >= len(source_excluded):
                continue
            for col in cols:
                source_col = col - resolved_col_offset
                if source_col < 0 or source_col >= len(source_excluded[source_row]):
                    continue
                target[row][col] = source_excluded[source_row][source_col]
        return self

    def set_tail_value(
        self,
        dev_period: int,
        values: Iterable[float] | None = None,
        *,
        n_year: int | None = None,
        years: int | None = None,
        exclude: str | None = None,
        value_list: Iterable[float] | None = None,
        historical_ratio_data: Any = None,
    ) -> "DfmMethod":
        source_values = list(values if values is not None else (value_list if value_list is not None else []))
        if not source_values:
            raise DfmDataError("set_tail_value requires values or value_list.")
        numeric_values = [float(value) for value in source_values if _number(value) is not None]
        lookback = years if years is not None else n_year
        if isinstance(lookback, int):
            numeric_values = numeric_values[: max(0, lookback)]
        if not numeric_values:
            raise DfmDataError("set_tail_value did not receive any numeric values.")
        selected_values = list(numeric_values)
        excluded_label = ""
        exclude_key = clean_text(exclude).lower()
        if exclude_key == "low" and len(selected_values) > 1:
            selected_values.remove(min(selected_values))
            excluded_label = "ex low "
        elif exclude_key == "high" and len(selected_values) > 1:
            selected_values.remove(max(selected_values))
            excluded_label = "ex high "
        average = sum(selected_values) / len(selected_values)
        self.set_user_ratio(round(average, 4), dev_period)
        note_bits = [f"For development period {self.dev_period(dev_period, 1)}, selected a {len(numeric_values)}-year {excluded_label}average"]
        lookback = years if years is not None else n_year
        if lookback is not None:
            note_bits.append(f"years={lookback}")
        note_bits.append(f"values={', '.join(str(round(value, 4)) for value in selected_values)}")
        note_bits.append(f"average={round(average, 4)}")
        if historical_ratio_data is not None:
            note_bits.append("historical ratio data supplied")
        self.add_notes("; ".join(note_bits))
        return self

    def set_custom_averages(
        self,
        avg_index: int | None = None,
        avg_name: str | None = None,
        periods_included: int | str = "all",
        weight_type: str = "simple",
        ex_hi_lo: int = 0,
    ) -> "DfmMethod":
        label = avg_name or f"{str(weight_type).title()} - {periods_included}"
        row = self._ensure_average_label(label)
        settings = self._average_settings()
        self._ensure_settings_len(settings, len(self._average_labels()))
        settings["average_type"][row] = "custom"
        settings["base"][row] = str(weight_type).lower()
        settings["periods"][row] = periods_included
        settings["exclude"][row] = int(ex_hi_lo or 0)
        return self

    def selected_cumulative_factor(self, dev_index: int) -> float | None:
        values = self._selected_ratio_values()
        idx = _as_legacy_index(dev_index)
        if idx < 0 or idx >= len(values):
            return None
        running = 1.0
        for value in values[idx:]:
            if value is None:
                return None
            running *= value
        return running

    def dev_period(self, index: int | Sequence[int], format: int | str = 0) -> str:
        labels = self.ratio_triangle.get("development_labels") or self.data_tab.get("development_labels") or []
        if not isinstance(index, (str, bytes)) and isinstance(index, Sequence):
            items = list(index)
            if not items:
                return ""
            start = self._dev_period_part(int(items[0]), "start")
            end = self._dev_period_part(int(items[-1]), "end")
            return f"{start}-{end}" if start and end else f"{items[0]}-{items[-1]}"
        idx = _as_legacy_index(int(index))
        if 0 <= idx < len(labels):
            return self._format_development_label(str(labels[idx]), format)
        return str(idx + 1 if idx >= 0 else idx)

    def dev_month(self, index: int) -> float | None:
        label = self.dev_period(index)
        digits = "".join(ch if ch.isdigit() or ch == "." else " " for ch in label).split()
        if not digits:
            return None
        return _number(digits[-1])

    def ratio(self, row: int, column: int) -> Any:
        values = _coerce_matrix(self.ratio_triangle.get("ratio_values"))
        row_index = self._resolve_row(row)
        col_index = _as_col_index(column)
        try:
            return values[row_index][col_index]
        except IndexError as err:
            raise DfmDataError(f"Ratio cell not found at row={row}, column={column}.") from err

    def ultimate(self, row: int) -> Any:
        vector = self.ultimate_vector()
        row_index = self._resolve_row(row)
        try:
            return vector[row_index]
        except IndexError as err:
            raise DfmDataError(f"Ultimate value not found at row={row}.") from err

    def ultimate_vector(self) -> list[Any]:
        embedded = self.results_tab.get("ultimate_vector")
        if isinstance(embedded, list):
            return deepcopy(embedded)
        return []

    def ultimates(self, row: int | str | None = None) -> Any:
        if row is None:
            return self.ultimate_vector()
        return self.ultimate(row)

    def selected_ratio(self, dev_period: int) -> float | None:
        values = self._selected_ratio_values()
        col = _as_col_index(dev_period)
        return values[col] if 0 <= col < len(values) else None

    def results_dataframe(self):
        try:
            import pandas as pd
        except ImportError as err:
            raise DfmDataError("Install the pandas extra to use results_dataframe(): pip install arcrho-api[pandas]") from err
        origin_labels = self._origin_labels()
        ultimate = self.ultimate_vector()
        row_count = max(len(origin_labels), len(ultimate))
        return pd.DataFrame(
            {
                "origin": [origin_labels[i] if i < len(origin_labels) else i + 1 for i in range(row_count)],
                "ultimate": [ultimate[i] if i < len(ultimate) else None for i in range(row_count)],
            }
        )

    # Legacy aliases used by production notebooks.
    ex_hi = exclude_high
    ex_lo = exclude_low
    ex_LDF = exclude_l_df
    ex_row = exclude_row
    ex_AY = exclude_origin_year
    ex_COVID_AY = exclude_covid_years
    ex_diagonal = exclude_diagonal
    set_selected_estimate = set_selected_average
    set_user_value = set_user_ratio
    set_average_formula_patterns = copy_average_formula_patterns
    set_ratio_patterns = copy_ratio_patterns

    def get_average_factors(self) -> list[str]:
        return self._average_labels()

    def selected_average_label(self, dev_period: int) -> str:
        labels = self._average_labels()
        selected = _coerce_matrix(self.average_formulas.get("selected"))
        col = _as_col_index(dev_period)
        for row, selected_row in enumerate(selected):
            if col < len(selected_row) and bool(selected_row[col]):
                return labels[row] if row < len(labels) else ""
        return ""

    def offset(self) -> "DfmMethod":
        state = self._last_ratio_adjustment
        if not state:
            self.add_notes("No prior ratio adjustment is available for offset().")
            return self
        dev_period = int(state["dev_period"]) - 1
        if dev_period < 1:
            self.add_notes("Offset skipped because the adjusted development period has no prior period.")
            return self
        old_value = _number(state.get("old_selected"))
        new_value = _number(state.get("new_selected"))
        current_value = self.selected_ratio(dev_period)
        if old_value is None or new_value in (None, 0) or current_value is None:
            self.add_notes("Offset skipped because selected ratio values are unavailable.")
            return self
        adjusted = current_value * old_value / new_value
        self.add_notes(
            f"Adjusted the selected LDF for {self.dev_period(dev_period, 1)} to offset the selection for "
            f"{self.dev_period(dev_period + 1, 1)}: {round(current_value, 4)} * "
            f"{round(old_value, 4)} / {round(new_value, 4)} = {round(adjusted, 4)}."
        )
        self.set_user_ratio(round(adjusted, 4), dev_period)
        self._last_ratio_adjustment = None
        return self

    def set_summary_ratio_basis(self, basis_object: Any, data_type: str = "Vector") -> "DfmMethod":
        name = getattr(basis_object, "name", None) or getattr(basis_object, "Name", None) or str(basis_object)
        self.results_tab["ratio_basis_dataset"] = clean_text(name)
        self.results_tab["ratio_basis_data_format"] = clean_text(data_type) or "Vector"
        self.results_tab["ratio_basis_origin_labels"] = []
        self.results_tab["ratio_basis_values"] = []
        self.results_tab["ratio_basis_source_revision"] = ""
        return self

    def reset_ratio_basis(self, source: "DfmMethod" | str | None = None) -> "DfmMethod":
        reference = self._resolve_source_dfm(source)
        for key in (
            "ratio_basis_dataset",
            "ratio_basis_origin_labels",
            "ratio_basis_values",
            "ratio_basis_data_format",
            "ratio_basis_number_format",
            "ratio_basis_decimal_places",
            "ratio_basis_source_revision",
        ):
            self.results_tab[key] = deepcopy(reference.results_tab.get(key))
        return self

    def extended_ratio_data(self) -> dict[str, Any]:
        return {
            "api method": "DfmMethod.extended_ratio_data",
            "values": self.ratio_values(),
            "excluded": deepcopy(self.ratio_triangle.get("excluded") or []),
            "origin_labels": self._origin_labels(),
            "development_labels": self.ratio_triangle.get("development_labels") or [],
        }

    def view(self, *args: Any, **kwargs: Any) -> dict[str, Any]:
        return self.to_dict()

    def plot_diagnostics(self, *args: Any, **kwargs: Any) -> dict[str, Any]:
        return self.to_dict()

    def plot_ultimates(self, *args: Any, **kwargs: Any) -> dict[str, Any]:
        return self.to_dict()

    def quick_preview(self) -> dict[str, Any]:
        return self.to_dict()

    def prior(self, index: int = -1, project_name: str | None = None) -> "DfmMethod":
        target_project_name = clean_text(project_name)
        if not target_project_name:
            projects = self.project.client.list_projects()
            current = self.project.name
            try:
                current_index = next(i for i, name in enumerate(projects) if name.lower() == current.lower())
            except StopIteration as err:
                raise DfmDataError(f"Current project is not listed by the client: {current!r}") from err
            target_index = current_index + int(index)
            if target_index < 0 or target_index >= len(projects):
                raise DfmDataError(
                    f"Cannot resolve prior project with index {index}; current project {current!r} is "
                    f"at position {current_index + 1} of {len(projects)}."
                )
            target_project_name = projects[target_index]
        return self.project.client.project(target_project_name).reserving_class(self.reserving_class).dfm(self.name)

    def view_prior(self, index: int = -1) -> "DfmMethod":
        return self.prior(index)

    def view_prior_notes(self, index: int = -1) -> str:
        return self.prior(index).notes

    def info(self) -> dict[str, Any]:
        return {
            "project": self.project_name,
            "reserving_class": self.reserving_class,
            "name": self.name,
            "path": str(self.file_path),
            "output_vector": self.output_vector,
            "input_triangle": self.input_triangle,
            "origin_length": self.origin_length,
            "development_length": self.development_length,
        }

    def _ensure_grouped_payload(self) -> None:
        if not isinstance(self.payload, dict):
            raise InvalidDfmJsonError("DFM payload must be a JSON object.")
        self.payload.setdefault("json_format", DFM_JSON_FORMAT)
        json_format = self.payload.get("json_format")
        if json_format != DFM_JSON_FORMAT:
            raise InvalidDfmJsonError(
                f"Unsupported DFM JSON format: {self.payload.get('json_format')!r}. "
                f"Expected {DFM_JSON_FORMAT!r}."
            )
        try:
            self.payload = normalize_dfm_method(
                self.payload,
                require_complete=self.file_path.is_file(),
            )
        except ValueError as err:
            raise InvalidDfmJsonError(str(err)) from err
        _tab(self.payload, "details_tab")
        _tab(self.payload, "data_tab")
        ratios = _tab(self.payload, "ratios_tab")
        _tab(ratios, "ratio_triangle")
        _tab(ratios, "average_formulas")
        _tab(self.payload, "results_tab")
        _tab(self.payload, "method_metadata")
        self._sync_details_identity()

    def _sidecar_path(self) -> Path:
        data_dir = self.project.reserving_class_data_dir(self.reserving_class)
        output_dataset = clean_text(self.details.get("output_dataset")) or self.name
        return data_dir / "sidecars" / f"{sanitize_file_name_part(output_dataset, 'Dataset')}.json"

    def _trim_saved_triangle_arrays(self) -> None:
        input_values = self.data_tab.get("input_data_triangle_values")
        if isinstance(input_values, list):
            self.data_tab["input_data_triangle_values"] = _trim_trailing_nulls_in_matrix(input_values)

        ratio_values_source = self.ratio_triangle.get("ratio_values")
        ratio_values: list[list[Any]] = []
        if isinstance(ratio_values_source, list):
            ratio_values = _trim_trailing_nulls_in_matrix(ratio_values_source)
            self.ratio_triangle["ratio_values"] = ratio_values

        excluded_source = self.ratio_triangle.get("excluded")
        if isinstance(excluded_source, list):
            excluded = _coerce_matrix(excluded_source)
            trimmed_excluded: list[list[Any]] = []
            for index, row in enumerate(excluded):
                if ratio_values and index < len(ratio_values):
                    trimmed_excluded.append(list(row[: len(ratio_values[index])]))
                else:
                    trimmed_excluded.append(_trim_trailing(row, (2, None)))
            self.ratio_triangle["excluded"] = trimmed_excluded

        average_values = self.average_formulas.get("values")
        if isinstance(average_values, list):
            self.average_formulas["values"] = _trim_trailing_nulls_in_matrix(average_values)
        average_inputs = self.average_formulas.get("inputs")
        if isinstance(average_inputs, list):
            self.average_formulas["inputs"] = _trim_trailing_empty_text_in_matrix(average_inputs)

    def _sync_details_identity(self) -> None:
        self.details.setdefault("name", self.name)
        self.details["name"] = clean_text(self.details.get("name")) or self.name
        self.name = clean_text(self.details.get("name"))
        self.details["output_dataset"] = clean_text(self.details.get("output_dataset")) or self.name

    def _ratio_values(self) -> list[list[Any]]:
        return self.ratio_values()

    def _ratio_shape(self) -> tuple[int, int]:
        return _matrix_shape(self._ratio_values() or _coerce_matrix(self.ratio_triangle.get("excluded")))

    def _excluded_matrix(self) -> list[list[Any]]:
        rows, cols = self._ratio_shape()
        if not rows or not cols:
            raise DfmDataError("DFM has no ratio triangle values or exclusion matrix.")
        return _ensure_matrix(self.ratio_triangle, "excluded", rows, cols, 0)

    def _set_excluded_cell(self, excluded: list[list[Any]], row: int, col: int, value: int) -> None:
        if row < 0 or row >= len(excluded):
            raise DfmDataError(f"Ratio row out of range: {row + 1}")
        if col < 0 or col >= len(excluded[row]):
            raise DfmDataError(f"Ratio development period out of range: {col + 1}")
        excluded[row][col] = value

    def _exclude_extreme(
        self,
        dev_period: int,
        count: int,
        *,
        high: bool,
        reason: str = "",
        add_notes: bool = True,
    ) -> "DfmMethod":
        old_selected = self.selected_ratio(dev_period)
        col = _as_col_index(dev_period)
        candidates = self._ratio_candidates(col)
        if not candidates:
            raise DfmDataError(f"No numeric ratio values found for development period {dev_period}.")
        ordered = sorted(candidates, key=lambda item: item[1], reverse=high)
        excluded = self._excluded_matrix()
        for row, _value in ordered[: max(0, int(count))]:
            excluded[row][col] = 1
        self._last_ratio_adjustment = {
            "dev_period": dev_period,
            "old_selected": old_selected,
            "new_selected": self.selected_ratio(dev_period),
        }
        if reason and add_notes:
            self.add_notes(reason)
        return self

    def _select_extreme(
        self,
        dev_period: int,
        count: int,
        *,
        high: bool,
        reason: str = "",
        add_notes: bool = True,
    ) -> "DfmMethod":
        old_selected = self.selected_ratio(dev_period)
        col = _as_col_index(dev_period)
        candidates = self._ratio_candidates(col)
        if not candidates:
            raise DfmDataError(f"No numeric ratio values found for development period {dev_period}.")
        keep = {row for row, _value in sorted(candidates, key=lambda item: item[1], reverse=high)[: max(0, int(count))]}
        excluded = self._excluded_matrix()
        for row, _value in candidates:
            excluded[row][col] = 0 if row in keep else 1
        self._last_ratio_adjustment = {
            "dev_period": dev_period,
            "old_selected": old_selected,
            "new_selected": self.selected_ratio(dev_period),
        }
        if reason and add_notes:
            self.add_notes(reason)
        return self

    def _ratio_candidates(self, col: int) -> list[tuple[int, float]]:
        values = self._ratio_values()
        rows, cols = _matrix_shape(values)
        self._require_col(col, cols)
        out: list[tuple[int, float]] = []
        for row_index in range(rows):
            row = values[row_index] if row_index < len(values) else []
            if col >= len(row):
                continue
            number = _number(row[col])
            if number is not None:
                out.append((row_index, number))
        return out

    def _set_selected_extreme_average(self, high: bool, dev_periods: int | Iterable[int] | str) -> "DfmMethod":
        labels = self._average_labels()
        col_count = self._average_col_count()
        values = _ensure_matrix(self.average_formulas, "values", len(labels), col_count, None)
        selected = _ensure_matrix(self.average_formulas, "selected", len(labels), col_count, 0)
        for col in _dev_periods_to_cols(dev_periods, col_count):
            self._require_col(col, col_count)
            candidates: list[tuple[int, float]] = []
            for row, row_values in enumerate(values):
                if row >= len(labels) or "user entry" in labels[row].lower():
                    continue
                if col < len(row_values):
                    value = _number(row_values[col])
                    if value is not None:
                        candidates.append((row, value))
            if not candidates:
                raise DfmDataError(f"No average formula values found for development period {col + 1}.")
            row_index = sorted(candidates, key=lambda item: item[1], reverse=high)[0][0]
            for row in selected:
                row[col] = 0
            selected[row_index][col] = 1
        return self

    def _copy_average_selection(
        self,
        source: "DfmMethod",
        col_index: int | Iterable[int] | str,
        *,
        skip_user_entry_values: bool,
    ) -> None:
        source_labels = source._average_labels()
        source_selected = _coerce_matrix(source.average_formulas.get("selected"))
        target_col_count = self._average_col_count()
        cols = self._resolve_index_selection(col_index, target_col_count)
        for col in cols:
            selected_row = None
            for row, selected in enumerate(source_selected):
                if col < len(selected) and bool(selected[col]):
                    selected_row = row
                    break
            if selected_row is None or selected_row >= len(source_labels):
                continue
            label = source_labels[selected_row]
            if skip_user_entry_values and "user entry" in label.lower():
                continue
            target_row = self._ensure_average_label(label)
            target_labels = self._average_labels()
            target_selected = _ensure_matrix(self.average_formulas, "selected", len(target_labels), target_col_count, 0)
            for row in target_selected:
                row[col] = 0
            target_selected[target_row][col] = 1

    def _resolve_source_dfm(self, source: "DfmMethod" | str | None) -> "DfmMethod":
        if source is None or (isinstance(source, str) and source.strip().lower() in {"", "prior dfm"}):
            return self.prior()
        if isinstance(source, DfmMethod):
            return source
        if isinstance(source, str):
            return self.reserving_class_obj.dfm(source)
        raise DfmDataError(f"Expected DfmMethod, method name, or None; got {type(source).__name__}.")

    def _resolve_index_selection(self, selection: int | Iterable[int] | str, length: int) -> list[int]:
        if isinstance(selection, str):
            if selection.strip().lower() in {"all", "*", ""}:
                return list(range(length))
            return [_as_col_index(int(selection))]
        if isinstance(selection, int):
            return [_as_col_index(selection)]
        return [_as_col_index(value) for value in selection]

    def _infer_row_offset(self, target: "DfmMethod") -> int:
        try:
            source_first_match = re.search(r"\d{4}", clean_text(self._origin_labels()[0]))
            target_first_match = re.search(r"\d{4}", clean_text(target._origin_labels()[0]))
            if source_first_match is None or target_first_match is None:
                return 0
            source_first = int(source_first_match.group(0))
            target_first = int(target_first_match.group(0))
        except (IndexError, ValueError):
            return 0
        multiplier = 4 if "q" in clean_text(target._origin_labels()[0]).lower() else 1
        return (source_first - target_first) * multiplier

    def _format_development_label(self, label: str, format: int | str) -> str:
        if format == 0:
            return label
        label_without_index = re.sub(r"^\(?\s*\d+\s*\)?\s*", "", label).strip()
        if format == 1:
            return label_without_index or label
        if format == "start":
            text = label_without_index or label
            return text.split("-", 1)[0].strip()
        if format == "end":
            text = label_without_index or label
            return text.split("-", 1)[-1].strip()
        return label_without_index or label

    def _dev_period_part(self, index: int, part: str) -> str:
        return self.dev_period(index, part)

    def _origin_labels(self) -> list[Any]:
        labels = self.data_tab.get("origin_labels")
        if not isinstance(labels, list):
            labels = self.ratio_triangle.get("origin_labels")
        return labels if isinstance(labels, list) else []

    def _resolve_row(self, row: int | str) -> int:
        if isinstance(row, int):
            index = row - 1 if row > 0 else row
            if index < 0:
                raise DfmDataError(f"Row must be 1-based and positive: {row}")
            return index
        text = clean_text(row)
        labels = self._origin_labels()
        for index, label in enumerate(labels):
            if clean_text(label) == text or text in clean_text(label):
                return index
        if text.isdigit():
            year = text
            for index, label in enumerate(labels):
                if year in clean_text(label):
                    return index
            return int(text) - 1
        raise DfmDataError(f"Could not resolve origin row: {row!r}")

    def _resolve_origin_year(self, origin_year: int | str) -> int:
        text = clean_text(origin_year)
        labels = self._origin_labels()
        for index, label in enumerate(labels):
            if text and text in clean_text(label):
                return index
        raise DfmDataError(f"Could not resolve origin year: {origin_year!r}")

    def _resolve_development_col(self, development: int | str) -> int:
        if isinstance(development, int):
            return _as_col_index(development)
        text = clean_text(development)
        if text.isdigit():
            return _as_col_index(int(text))
        wanted = _label_key(text)
        labels = self.ratio_triangle.get("development_labels") or self.data_tab.get("development_labels") or []
        for index, label in enumerate(labels if isinstance(labels, list) else []):
            label_text = clean_text(label)
            if _label_key(label_text) == wanted or wanted in _label_key(label_text):
                return index
        raise DfmDataError(f"Could not resolve development column: {development!r}")

    def _cell_note_development_label(self, development: int | str) -> str:
        col = self._resolve_development_col(development)
        col_count = self._average_col_count()
        self._require_col(col, col_count)
        return self.dev_period(col + 1, 0)

    def _cell_note_table(self, table_name: str) -> dict[str, Any]:
        value = self.cell_notes.get(table_name)
        if isinstance(value, dict):
            return value
        value = {}
        self.cell_notes[table_name] = value
        return value

    def _cell_note_row_label(self, row_label: Any, table_name: str) -> str:
        if table_name == "ratio_summary_table":
            text = _display_average_label(row_label)
        else:
            text = _normalize_label(row_label)
        if not text:
            raise DfmDataError("Cell note row label cannot be blank.")
        return text

    def _resolve_data_path(self, value: Any) -> Path | None:
        text = clean_text(value)
        if not text:
            return None
        candidate = Path(text)
        if candidate.is_absolute():
            return candidate
        project_data = getattr(self.project, "data_dir", None)
        rc_data_dir = None
        if hasattr(self.project, "reserving_class_data_dir"):
            try:
                rc_data_dir = self.project.reserving_class_data_dir(self.reserving_class)
            except Exception:
                rc_data_dir = None
        if rc_data_dir:
            rc_candidate = Path(rc_data_dir) / text
            if rc_candidate.exists():
                return rc_candidate
            dataset_candidate = Path(rc_data_dir) / "datasets" / text
            if dataset_candidate.exists():
                return dataset_candidate
            method_candidate = Path(rc_data_dir) / "methods" / text
            if method_candidate.exists():
                return method_candidate
        if project_data:
            data_candidate = Path(project_data) / text
            if data_candidate.exists():
                return data_candidate
        method_relative = self.file_path.parent / text
        if method_relative.exists():
            return method_relative
        return candidate

    def _average_labels(self) -> list[str]:
        labels = self.average_formulas.get("label")
        if not isinstance(labels, list):
            labels = []
            self.average_formulas["label"] = labels
        return [_normalize_label(label) for label in labels]

    def _average_settings(self) -> dict[str, list[Any]]:
        settings = self.average_formulas.get("custom_average_formula_settings")
        if not isinstance(settings, dict):
            settings = {}
            self.average_formulas["custom_average_formula_settings"] = settings
        for key in ("average_type", "base", "periods", "exclude"):
            if not isinstance(settings.get(key), list):
                settings[key] = []
        return settings  # type: ignore[return-value]

    def _ensure_settings_len(self, settings: dict[str, list[Any]], length: int) -> None:
        defaults = {
            "average_type": "custom",
            "base": "",
            "periods": "all",
            "exclude": 0,
        }
        for key, default in defaults.items():
            values = settings.setdefault(key, [])
            while len(values) < length:
                values.append(default)

    def _ensure_average_row_count(self, row_count: int) -> None:
        labels = self.average_formulas.setdefault("label", [])
        while len(labels) < row_count:
            labels.append(f"User Entry {len(labels) + 1}")
        settings = self._average_settings()
        self._ensure_settings_len(settings, row_count)
        col_count = self._average_col_count()
        _ensure_matrix(self.average_formulas, "selected", row_count, col_count, 0)
        _ensure_matrix(self.average_formulas, "values", row_count, col_count, None)

    def _set_average_row_user_entry(self, row_index: int) -> None:
        settings = self._average_settings()
        self._ensure_settings_len(settings, row_index + 1)
        settings["average_type"][row_index] = "user_entry"
        settings["base"][row_index] = "simple"
        settings["periods"][row_index] = "all"
        settings["exclude"][row_index] = 0

    def _ensure_average_label(self, label: str) -> int:
        wanted = _label_key(label)
        labels = self.average_formulas.setdefault("label", [])
        for index, existing in enumerate(labels):
            if _label_key(existing) == wanted:
                return index
        labels.append(_normalize_label(label))
        row = len(labels) - 1
        settings = self._average_settings()
        self._ensure_settings_len(settings, len(labels))
        inferred = _infer_average_settings(label)
        if inferred:
            settings["average_type"][row] = "custom"
            settings["base"][row] = inferred["base"]
            settings["periods"][row] = inferred["periods"]
            settings["exclude"][row] = inferred["exclude"]
        self._ensure_average_row_count(len(labels))
        return row

    def _average_col_count(self) -> int:
        selected = _coerce_matrix(self.average_formulas.get("selected"))
        values = _coerce_matrix(self.average_formulas.get("values"))
        inputs = _coerce_matrix(self.average_formulas.get("inputs"))
        ratio_rows, ratio_cols = self._ratio_shape()
        labels = self.ratio_triangle.get("development_labels")
        label_count = len(labels) if isinstance(labels, list) else 0
        return max(_matrix_shape(selected)[1], _matrix_shape(values)[1], _matrix_shape(inputs)[1], ratio_cols, label_count, 1)

    def _require_col(self, col: int, col_count: int) -> None:
        if col < 0 or col >= col_count:
            raise DfmDataError(f"Development period out of range: {col + 1}; available columns: {col_count}")

    def _selected_ratio_values(self) -> list[float | None]:
        labels = self._average_labels()
        selected = _coerce_matrix(self.average_formulas.get("selected"))
        values = _coerce_matrix(self.average_formulas.get("values"))
        col_count = self._average_col_count()
        out: list[float | None] = [None] * col_count
        for col in range(col_count):
            row_index = None
            for row, selected_row in enumerate(selected):
                if col < len(selected_row) and bool(selected_row[col]):
                    row_index = row
                    break
            if row_index is None:
                continue
            if row_index < len(values) and col < len(values[row_index]):
                out[col] = _number(values[row_index][col])
        _ = labels
        return out

def _infer_average_settings(label: str) -> dict[str, Any] | None:
    normalized = _normalize_label(label)
    match = re.match(r"^(volume|simple)\s*-\s*(all|[1-9]\d*)(?:\s+ex\s+hi/lo(?:\s*x\s*([1-9]\d*))?)?$", normalized, re.I)
    if not match:
        if normalized.lower().startswith("user"):
            return {"base": "", "periods": "all", "exclude": 0}
        return None
    periods: str | int = match.group(2).lower()
    if periods != "all":
        periods = int(periods)
    exclude = int(match.group(3) or 0)
    if "ex hi/lo" in normalized.lower() and exclude == 0:
        exclude = 1
    return {"base": match.group(1).lower(), "periods": periods, "exclude": exclude}


def _int_or_none(value: Any) -> int | None:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None
