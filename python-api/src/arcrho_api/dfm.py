"""DFM method object and production migration helpers."""

from __future__ import annotations

import csv
import re
from collections.abc import Iterable as IterableABC, Sequence
from copy import deepcopy
from datetime import datetime, timezone
from pathlib import Path
from typing import TYPE_CHECKING, Any, Iterable

from .exceptions import DfmDataError, InvalidDfmJsonError
from .io import read_json, write_json_atomic
from .paths import DFM_JSON_FORMAT, clean_text, sanitize_file_name_part

if TYPE_CHECKING:
    from .reserving_class import ReservingClass


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
        "main": "ratio main table",
        "ratio": "ratio main table",
        "ratio main": "ratio main table",
        "ratio main table": "ratio main table",
        "summary": "ratio summary table",
        "average": "ratio summary table",
        "average formulas": "ratio summary table",
        "ratio summary": "ratio summary table",
        "ratio summary table": "ratio summary table",
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
    return datetime.now(timezone.utc).astimezone().isoformat()


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
        details = _get_tab(payload, "details tab")
        name = clean_text(details.get("name")) or path.stem

        class _StandaloneProject:
            def __init__(self, method_path: Path, read_only_value: bool) -> None:
                self.name = clean_text(_get_tab(payload, "method metadata").get("project")) or ""
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
            "json format": DFM_JSON_FORMAT,
            "details tab": {
                "name": method_name,
                "output type": clean_text(output_vector),
                "input triangle": clean_text(input_triangle),
                "origin length": int(origin_length),
                "development length": int(development_length),
                "decimal places": int(decimal_places),
            },
            "data tab": {
                "origin labels": [],
                "development labels": [],
                "input data triangle csv path": "",
            },
            "ratios tab": {
                "ratio triangle": {
                    "origin labels": [],
                    "development labels": [],
                    "ratio values": [],
                    "excluded": [],
                },
                "average formulas": _default_average_formulas(),
            },
            "results tab": {
                "ratio basis dataset": "",
                "ultimate ratio decimal places": 2,
                "ultimate vector csv path": "",
            },
            "method metadata": {
                "last modified": _now_iso(),
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

    def save(self) -> Path:
        if self._pending_notes is not None and not self._sidecar_path().exists():
            raise DfmDataError(
                f"DFM output sidecar not found: {self._sidecar_path()}. "
                "Materialize the output dataset before saving DFM notes."
            )
        self._sync_details_identity()
        self._trim_saved_triangle_arrays()
        _tab(self.payload, "method metadata")["last modified"] = _now_iso()
        path = write_json_atomic(self.file_path, self.payload, read_only=self.project.read_only)
        if self._pending_notes is not None:
            sidecar = read_json(self._sidecar_path())
            sidecar["notes"] = self._pending_notes
            write_json_atomic(self._sidecar_path(), sidecar, read_only=self.project.read_only)
            self._pending_notes = None
        rebuild_one = getattr(self.project, "rebuild_reserving_class_index", None)
        if callable(rebuild_one):
            rebuild_one(self.reserving_class_obj.path)
        else:
            self.project.rebuild_dfm_index()
        return path

    @property
    def output_vector(self) -> str:
        return clean_text(self.details.get("output type"))

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
        return clean_text(self.details.get("input triangle"))

    @property
    def origin_length(self) -> int | None:
        return _int_or_none(self.details.get("origin length"))

    @property
    def development_length(self) -> int | None:
        return _int_or_none(self.details.get("development length"))

    @property
    def decimal_places(self) -> int | None:
        return _int_or_none(self.details.get("decimal places"))

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
        return clean_text(self.metadata.get("last modified"))

    @property
    def details(self) -> dict[str, Any]:
        return _tab(self.payload, "details tab")

    @property
    def data_tab(self) -> dict[str, Any]:
        return _tab(self.payload, "data tab")

    @property
    def ratios_tab(self) -> dict[str, Any]:
        return _tab(self.payload, "ratios tab")

    @property
    def ratio_triangle(self) -> dict[str, Any]:
        return _tab(self.ratios_tab, "ratio triangle")

    @property
    def average_formulas(self) -> dict[str, Any]:
        return _tab(self.ratios_tab, "average formulas")

    @property
    def cell_notes(self) -> dict[str, Any]:
        return _tab(self.ratios_tab, "cell notes")

    @property
    def results_tab(self) -> dict[str, Any]:
        return _tab(self.payload, "results tab")

    @property
    def metadata(self) -> dict[str, Any]:
        return _tab(self.payload, "method metadata")

    def update_details(self, **fields: Any) -> "DfmMethod":
        mapping = {
            "name": "name",
            "output_vector": "output type",
            "output_type": "output type",
            "input_triangle": "input triangle",
            "origin_length": "origin length",
            "development_length": "development length",
            "decimal_places": "decimal places",
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
        input_data_path = clean_text(self.data_tab.get("input data triangle csv path"))
        ultimate_path = clean_text(self.results_tab.get("ultimate vector csv path"))
        labels = self._average_labels()
        selected = _coerce_matrix(self.average_formulas.get("selected"))
        selected_by_dev: list[dict[str, Any]] = []
        col_count = self._average_col_count()
        dev_labels = self.ratio_triangle.get("development labels") or []
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
            "data tab": {
                "origin labels": self.data_tab.get("origin labels") or [],
                "development labels": self.data_tab.get("development labels") or [],
                "input data triangle csv path": input_data_path,
            },
            "ratios tab": {
                "origin labels": self.ratio_triangle.get("origin labels") or [],
                "development labels": self.ratio_triangle.get("development labels") or [],
                "ratio shape": list(_matrix_shape(ratio_values)),
                "average formulas": labels,
                "selected by development": selected_by_dev,
            },
            "results tab": {
                "ratio basis dataset": self.results_tab.get("ratio basis dataset") or "",
                "ultimate vector csv path": ultimate_path,
            },
            "notes preview": self.notes[:500],
        }

    def input_data_triangle(self) -> list[list[Any]]:
        path = self._resolve_data_path(self.data_tab.get("input data triangle csv path"))
        if not path:
            return []
        return _read_csv_matrix(path)

    def ratio_values(self) -> list[list[Any]]:
        return _coerce_matrix(self.ratio_triangle.get("ratio values"))

    def ratio_row(self, row: int | str) -> dict[str, Any]:
        row_index = self._resolve_row(row)
        values = self.ratio_values()
        excluded = _coerce_matrix(self.ratio_triangle.get("excluded"))
        origin_labels = self._origin_labels()
        dev_labels = self.ratio_triangle.get("development labels") or []
        row_values = values[row_index] if row_index < len(values) else []
        row_excluded = excluded[row_index] if row_index < len(excluded) else []
        return {
            "api method": "DfmMethod.ratio_row",
            "origin index": row_index + 1,
            "origin label": origin_labels[row_index] if row_index < len(origin_labels) else str(row_index + 1),
            "development labels": dev_labels,
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
            components["ratio triangle"] = {
                "api method": "DfmMethod.ratio_values",
                "origin labels": self.ratio_triangle.get("origin labels") or [],
                "development labels": self.ratio_triangle.get("development labels") or [],
                "values": self.ratio_values(),
                "excluded": self.ratio_triangle.get("excluded") or [],
            }
        if "average-formulas" in include_items:
            components["average formulas"] = self.average_formula_summary()
        if "ultimate-vector" in include_items:
            components["ultimate vector"] = {
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
            "custom average formula settings": self.average_formulas.get("custom average formula settings") or {},
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
        table: str = "ratio summary table",
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
        table: str = "ratio summary table",
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
            self.ratios_tab["average formulas"] = deepcopy(reference.average_formulas)
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
        settings["averageType"][row] = "custom"
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
        labels = self.ratio_triangle.get("development labels") or self.data_tab.get("development labels") or []
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
        values = _coerce_matrix(self.ratio_triangle.get("ratio values"))
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
        path = self._resolve_data_path(self.results_tab.get("ultimate vector csv path"))
        if not path:
            return []
        matrix = _read_csv_matrix(path)
        return [row[0] if row else None for row in matrix]

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
        self.results_tab["ratio basis dataset"] = clean_text(name)
        self.results_tab["ratio basis dataset type"] = clean_text(data_type) or "Vector"
        return self

    def reset_ratio_basis(self, source: "DfmMethod" | str | None = None) -> "DfmMethod":
        reference = self._resolve_source_dfm(source)
        self.results_tab["ratio basis dataset"] = reference.results_tab.get("ratio basis dataset", "")
        if "ratio basis dataset type" in reference.results_tab:
            self.results_tab["ratio basis dataset type"] = reference.results_tab.get("ratio basis dataset type", "")
        return self

    def extended_ratio_data(self) -> dict[str, Any]:
        return {
            "api method": "DfmMethod.extended_ratio_data",
            "values": self.ratio_values(),
            "excluded": deepcopy(self.ratio_triangle.get("excluded") or []),
            "origin labels": self._origin_labels(),
            "development labels": self.ratio_triangle.get("development labels") or [],
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
        self.payload.setdefault("json format", DFM_JSON_FORMAT)
        if self.payload.get("json format") != DFM_JSON_FORMAT:
            raise InvalidDfmJsonError(
                f"Unsupported DFM JSON format: {self.payload.get('json format')!r}. "
                f"Expected {DFM_JSON_FORMAT!r}."
            )
        _tab(self.payload, "details tab")
        _tab(self.payload, "data tab")
        ratios = _tab(self.payload, "ratios tab")
        _tab(ratios, "ratio triangle")
        _tab(ratios, "average formulas")
        ratios.pop("percent developed curve", None)
        _tab(self.payload, "results tab")
        self.payload.pop("notes tab", None)
        _tab(self.payload, "method metadata")
        self.data_tab.pop("input data triangle values", None)
        self.results_tab.pop("ultimate vector", None)
        self._sync_details_identity()

    def _sidecar_path(self) -> Path:
        data_dir = self.project.reserving_class_data_dir(self.reserving_class)
        return data_dir / "sidecars" / f"{sanitize_file_name_part(self.name, 'Dataset')}.json"

    def _trim_saved_triangle_arrays(self) -> None:
        input_values = self.data_tab.get("input data triangle values")
        if isinstance(input_values, list):
            self.data_tab["input data triangle values"] = _trim_trailing_nulls_in_matrix(input_values)

        ratio_values_source = self.ratio_triangle.get("ratio values")
        ratio_values: list[list[Any]] = []
        if isinstance(ratio_values_source, list):
            ratio_values = _trim_trailing_nulls_in_matrix(ratio_values_source)
            self.ratio_triangle["ratio values"] = ratio_values

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
        labels = self.data_tab.get("origin labels")
        if not isinstance(labels, list):
            labels = self.ratio_triangle.get("origin labels")
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
        labels = self.ratio_triangle.get("development labels") or self.data_tab.get("development labels") or []
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
        if table_name == "ratio summary table":
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
        settings = self.average_formulas.get("custom average formula settings")
        if not isinstance(settings, dict):
            settings = {}
            self.average_formulas["custom average formula settings"] = settings
        for key in ("averageType", "base", "periods", "exclude"):
            if not isinstance(settings.get(key), list):
                settings[key] = []
        return settings  # type: ignore[return-value]

    def _ensure_settings_len(self, settings: dict[str, list[Any]], length: int) -> None:
        defaults = {
            "averageType": "custom",
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
        settings["averageType"][row_index] = "user_entry"
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
            settings["averageType"][row] = "custom"
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
        labels = self.ratio_triangle.get("development labels")
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

def _default_average_formulas() -> dict[str, Any]:
    return {
        "label": ["Volume - all", "Simple - all", "User Entry"],
        "custom average formula settings": {
            "averageType": ["custom", "custom", "user_entry"],
            "base": ["volume", "simple", ""],
            "periods": ["all", "all", "all"],
            "exclude": [0, 0, 0],
        },
        "selected": [],
        "values": [],
    }


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
