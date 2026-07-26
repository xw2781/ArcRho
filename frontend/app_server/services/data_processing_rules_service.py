"""Project-scoped custom data-processing rule persistence and validation."""
from __future__ import annotations

import getpass
import hashlib
import json
import os
import re
import threading
import uuid
from datetime import datetime
from typing import Any, Dict, Iterable, List, Optional, Tuple

import pandas as pd
from pydantic import ValidationError

from app_server import config
from app_server.schemas.data_processing_rules import DataProcessingRulesData
from app_server.services.audit_service import safe_append_project_audit_log
from app_server.services import data_processing_values_service


_RULE_LOCKS_GUARD = threading.Lock()
_RULE_LOCKS: Dict[str, threading.Lock] = {}
_RULE_LOCK_TIMEOUT_SECONDS = 5.0
_AUDIT_KEYS = {
    "created",
    "modified_by",
    "updated_at",
    "updated_by",
    "user",
}
_ROW_COMPARISON_OPERATORS = {
    "greater_than",
    "greater_than_or_equal",
    "less_than",
    "less_than_or_equal",
}


class StoredRulesContractError(ValueError):
    """Raised when the persisted rules file is malformed or unsupported."""


class RulesRevisionConflictError(RuntimeError):
    """Raised when optimistic revision checking detects a stale editor."""


class RulesWriteLockedError(RuntimeError):
    """Raised when another request owns the project rules write lock."""


class RulesValidationError(ValueError):
    """Raised when a candidate rules payload has semantic errors."""

    def __init__(self, errors: List[str]):
        self.errors = list(errors)
        super().__init__("Data processing rules are invalid.")


def _utc_now() -> str:
    return datetime.utcnow().isoformat(timespec="seconds") + "Z"


def _current_user() -> str:
    value = str(os.environ.get("USERNAME") or os.environ.get("USER") or "").strip()
    if value:
        return value
    try:
        return str(getpass.getuser() or "").strip() or "unknown"
    except Exception:
        return "unknown"


def _lock_for_path(path: str) -> threading.Lock:
    key = os.path.normcase(os.path.abspath(path))
    with _RULE_LOCKS_GUARD:
        lock = _RULE_LOCKS.get(key)
        if lock is None:
            lock = threading.Lock()
            _RULE_LOCKS[key] = lock
        return lock


def _empty_document() -> Dict[str, Any]:
    return {
        "json_format": config.DATA_PROCESSING_RULES_FORMAT,
        "revision": 0,
        "updated_at": "",
        "updated_by": "",
        "rules": [],
    }


def _dedupe_json_values(values: Iterable[Any]) -> List[Any]:
    out: List[Any] = []
    seen: set[str] = set()
    for value in values:
        try:
            key = json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
        except TypeError:
            key = repr(value)
        if key in seen:
            continue
        seen.add(key)
        out.append(value)
    return out


def _normalize_condition(raw: Dict[str, Any], *, request_condition: bool) -> Dict[str, Any]:
    operator = str(raw.get("operator") or "").strip().lower()
    out: Dict[str, Any] = {
        "field": str(raw.get("field") or "").strip(),
        "operator": operator,
    }
    if request_condition:
        try:
            out["level"] = int(raw.get("level"))
        except (TypeError, ValueError):
            out["level"] = raw.get("level")

    if operator not in {"is_blank", "is_not_blank"}:
        value = raw.get("value")
        if operator in {"in", "not_in"} and isinstance(value, list):
            value = _dedupe_json_values(value)
        out["value"] = value
    return out


def _normalize_rule(raw: Dict[str, Any]) -> Dict[str, Any]:
    target = raw.get("target") if isinstance(raw.get("target"), dict) else {}
    request_conditions = (
        raw.get("request_conditions")
        if isinstance(raw.get("request_conditions"), dict)
        else {}
    )
    row_conditions = (
        raw.get("row_conditions")
        if isinstance(raw.get("row_conditions"), dict)
        else {}
    )
    action = raw.get("action") if isinstance(raw.get("action"), dict) else {}

    request_all = request_conditions.get("all")
    row_all = row_conditions.get("all")
    members = [
        str(value if value is not None else "").strip()
        for value in action.get("members", [])
        if str(value if value is not None else "").strip()
    ]
    action_out: Dict[str, Any] = {
        "type": str(action.get("type") or "").strip().lower(),
        "field": str(action.get("field") or "").strip(),
        "members": _dedupe_json_values(members),
    }
    if action.get("level") is not None:
        try:
            action_out["level"] = int(action.get("level"))
        except (TypeError, ValueError):
            action_out["level"] = action.get("level")

    return {
        "id": str(raw.get("id") or "").strip(),
        "name": str(raw.get("name") or "").strip(),
        "enabled": bool(raw.get("enabled", True)),
        "target": {
            "source_measure": str(target.get("source_measure") or "").strip(),
        },
        "request_conditions": {
            "all": [
                _normalize_condition(item, request_condition=True)
                for item in (request_all if isinstance(request_all, list) else [])
                if isinstance(item, dict)
            ],
        },
        "row_conditions": {
            "all": [
                _normalize_condition(item, request_condition=False)
                for item in (row_all if isinstance(row_all, list) else [])
                if isinstance(item, dict)
            ],
        },
        "action": action_out,
    }


def _parse_rules_data(data: Any, *, stored: bool) -> Dict[str, Any]:
    try:
        input_data = data if isinstance(data, dict) else {}
        if hasattr(DataProcessingRulesData, "model_validate"):
            model = DataProcessingRulesData.model_validate(input_data)
        else:
            model = DataProcessingRulesData.parse_obj(input_data)
    except ValidationError as error:
        message = f"Invalid data processing rules contract: {str(error)}"
        if stored:
            raise StoredRulesContractError(message)
        raise ValueError(message)

    raw = (
        model.model_dump(exclude_none=True)
        if hasattr(model, "model_dump")
        else model.dict(exclude_none=True)
    )
    json_format = raw.get("json_format")
    if stored and json_format != config.DATA_PROCESSING_RULES_FORMAT:
        raise StoredRulesContractError(
            f"Unsupported data processing rules format: {json_format or '(missing)'}."
        )
    if json_format and json_format != config.DATA_PROCESSING_RULES_FORMAT:
        raise ValueError(f"Unsupported data processing rules format: {json_format}.")

    revision_raw = raw.get("revision", 0)
    try:
        revision = int(revision_raw)
    except (TypeError, ValueError):
        if stored:
            raise StoredRulesContractError("Data processing rules revision must be an integer.")
        raise ValueError("Data processing rules revision must be an integer.")
    if revision < 0:
        if stored:
            raise StoredRulesContractError("Data processing rules revision cannot be negative.")
        raise ValueError("Data processing rules revision cannot be negative.")

    rules = raw.get("rules", [])
    if not isinstance(rules, list):
        if stored:
            raise StoredRulesContractError("Data processing rules must be a list.")
        raise ValueError("Data processing rules must be a list.")

    return {
        "json_format": config.DATA_PROCESSING_RULES_FORMAT,
        "revision": revision,
        "updated_at": str(raw.get("updated_at") or "").strip(),
        "updated_by": str(raw.get("updated_by") or "").strip(),
        "rules": [_normalize_rule(item) for item in rules if isinstance(item, dict)],
    }


def _read_rules_document(path: str) -> Dict[str, Any]:
    if not os.path.exists(path):
        return _empty_document()
    try:
        with open(path, "r", encoding="utf-8") as handle:
            raw = json.load(handle)
    except json.JSONDecodeError as error:
        raise StoredRulesContractError(f"Invalid data processing rules JSON: {str(error)}")
    except OSError:
        raise
    if not isinstance(raw, dict):
        raise StoredRulesContractError("Data processing rules file must contain a JSON object.")
    return _parse_rules_data(raw, stored=True)


def _canonical_rules_for_hash(document: Dict[str, Any]) -> Dict[str, Any]:
    rules = json.loads(json.dumps(list(document.get("rules") or []), ensure_ascii=False))
    for rule in rules:
        if not isinstance(rule, dict):
            continue
        for section_name in ("request_conditions", "row_conditions"):
            section = rule.get(section_name)
            conditions = section.get("all") if isinstance(section, dict) else None
            if not isinstance(conditions, list):
                continue
            for condition in conditions:
                if (
                    isinstance(condition, dict)
                    and condition.get("operator") in {"in", "not_in"}
                    and isinstance(condition.get("value"), list)
                ):
                    condition["value"] = sorted(
                        condition["value"],
                        key=lambda value: json.dumps(
                            value,
                            sort_keys=True,
                            ensure_ascii=False,
                            separators=(",", ":"),
                        ),
                    )
            conditions.sort(
                key=lambda condition: json.dumps(
                    condition,
                    sort_keys=True,
                    ensure_ascii=False,
                    separators=(",", ":"),
                )
            )
        action = rule.get("action")
        if isinstance(action, dict) and isinstance(action.get("members"), list):
            action["members"] = sorted(
                action["members"],
                key=lambda value: json.dumps(
                    value,
                    sort_keys=True,
                    ensure_ascii=False,
                    separators=(",", ":"),
                ),
            )
    rules.sort(key=lambda item: str(item.get("id") or "").casefold())
    return {
        "json_format": config.DATA_PROCESSING_RULES_FORMAT,
        "rules": rules,
    }


def _hash_json(value: Any) -> str:
    encoded = json.dumps(
        value,
        sort_keys=True,
        ensure_ascii=False,
        separators=(",", ":"),
    ).encode("utf-8")
    return "sha256:" + hashlib.sha256(encoded).hexdigest()


def semantic_rules_hash(document: Dict[str, Any]) -> str:
    return _hash_json(_canonical_rules_for_hash(document))


def _rule_id_order(document: Dict[str, Any]) -> List[str]:
    return [
        str(rule.get("id") or "")
        for rule in document.get("rules", [])
        if isinstance(rule, dict)
    ]


def _safe_read_json(path: str) -> Dict[str, Any]:
    if not path or not os.path.exists(path):
        return {}
    try:
        with open(path, "r", encoding="utf-8") as handle:
            raw = json.load(handle)
    except Exception:
        return {}
    return raw if isinstance(raw, dict) else {}


def _read_processing_config_json(path: str) -> Dict[str, Any]:
    """Read hash inputs without turning an inaccessible share into empty config."""
    if not path:
        return {}
    try:
        with open(path, "r", encoding="utf-8") as handle:
            raw = json.load(handle)
    except FileNotFoundError as error:
        if os.path.isdir(os.path.dirname(path)):
            return {}
        raise OSError(
            f"Processing configuration folder is unavailable: {os.path.dirname(path)}"
        ) from error
    except json.JSONDecodeError as error:
        raise StoredRulesContractError(
            f"Invalid processing configuration JSON '{path}': {str(error)}"
        )
    if not isinstance(raw, dict):
        raise StoredRulesContractError(
            f"Processing configuration file must contain a JSON object: {path}"
        )
    return raw


def _column_index(columns: Any) -> Dict[str, int]:
    out: Dict[str, int] = {}
    if not isinstance(columns, list):
        return out
    for index, value in enumerate(columns):
        name = str(value if value is not None else "").strip()
        if name:
            out[name.casefold()] = index
    return out


def _row_cell(row: Any, index: int) -> Any:
    if not isinstance(row, list) or index < 0 or index >= len(row):
        return ""
    return row[index]


def _json_scalar(value: Any) -> Any:
    if value is None:
        return None
    try:
        if pd.isna(value):
            return None
    except Exception:
        pass
    if hasattr(value, "item"):
        try:
            value = value.item()
        except Exception:
            pass
    if hasattr(value, "isoformat") and not isinstance(value, (str, bytes)):
        try:
            return value.isoformat()
        except Exception:
            pass
    if isinstance(value, (str, int, float, bool)):
        return value
    return str(value)


def _friendly_series_type(series: Any) -> str:
    try:
        if pd.api.types.is_bool_dtype(series.dtype):
            return "boolean"
        if pd.api.types.is_numeric_dtype(series.dtype):
            return "number"
        if pd.api.types.is_datetime64_any_dtype(series.dtype):
            return "date"
    except Exception:
        pass
    return "string"


def _source_table_options(
    table_path: str,
    mapping_rows: List[Dict[str, Any]],
) -> Tuple[List[Dict[str, Any]], str]:
    significance_by_field = {
        str(row.get("field_name") or "").strip(): str(row.get("significance") or "").strip()
        for row in mapping_rows
        if isinstance(row, dict) and str(row.get("field_name") or "").strip()
    }
    fallback_fields = [
        {
            "field": field_name,
            "type": (
                "date"
                if significance in {"Origin Date", "Development Date"}
                else ""
            ),
        }
        for field_name, significance in significance_by_field.items()
    ]
    if not table_path:
        return fallback_fields, "Project Field Mapping does not specify a source table path."
    if not os.path.isfile(table_path):
        return fallback_fields, f"Source table file was not found: {table_path}"

    try:
        frame = pd.read_csv(table_path, nrows=1000)
    except Exception as error:
        return fallback_fields, f"Failed to read source table columns: {str(error)}"

    fields: List[Dict[str, Any]] = []
    for column in frame.columns:
        name = str(column)
        series = frame[column]
        field_type = _friendly_series_type(series)
        significance = significance_by_field.get(name, "")
        if significance in {"Origin Date", "Development Date"}:
            field_type = "date"
        option: Dict[str, Any] = {"field": name, "type": field_type}
        values = _dedupe_json_values(
            [
                normalized
                for normalized in (_json_scalar(value) for value in series.tolist())
                if normalized is not None and str(normalized).strip() != ""
            ]
        )
        if len(values) <= 100:
            option["values"] = values
        fields.append(option)
    return fields, ""


def _apply_dataset_vocabularies(
    source_fields: List[Dict[str, Any]],
    vocabulary: Dict[str, Any],
) -> None:
    key_fields = list(vocabulary.get("key_fields") or [])
    datasets = (
        vocabulary.get("datasets")
        if isinstance(vocabulary.get("datasets"), dict)
        else {}
    )
    key_index_by_name = {
        str(item.get("field") or "").strip().casefold(): index
        for index, item in enumerate(key_fields)
        if isinstance(item, dict) and str(item.get("field") or "").strip()
    }
    level_by_name = {
        str(item.get("field") or "").strip().casefold(): item.get("level")
        for item in key_fields
        if isinstance(item, dict) and str(item.get("field") or "").strip()
    }

    for source_field in source_fields:
        field_name = str(source_field.get("field") or "").strip()
        key_index = key_index_by_name.get(field_name.casefold())
        if key_index is None:
            continue
        values_by_measure: Dict[str, List[str]] = {}
        union_values: List[str] = []
        union_seen: set[str] = set()
        for source_measure, dataset in datasets.items():
            values: List[str] = []
            seen: set[str] = set()
            combinations = (
                dataset.get("combinations")
                if isinstance(dataset, dict) and isinstance(dataset.get("combinations"), list)
                else []
            )
            for combination in combinations:
                if not isinstance(combination, list) or key_index >= len(combination):
                    continue
                value = str(combination[key_index] or "").strip()
                if not value or value in seen:
                    continue
                seen.add(value)
                values.append(value)
                if value not in union_seen:
                    union_seen.add(value)
                    union_values.append(value)
            values_by_measure[str(source_measure)] = values
        source_field["values_by_measure"] = values_by_measure
        # This mapped-key cache is authoritative even when it is empty. Keeping
        # the first-1,000-row sample here would leak values from other measures
        # into older clients that only read the flat compatibility field.
        source_field["values"] = union_values
        source_field["level"] = level_by_name.get(field_name.casefold())
        source_field["significance"] = "Reserving Class"


def _load_validation_context(project_name: str) -> Dict[str, Any]:
    mapping_path = config.get_field_mapping_path(project_name)
    mapping = _safe_read_json(mapping_path)
    mapping_rows = [
        row for row in mapping.get("rows", [])
        if isinstance(row, dict)
    ] if isinstance(mapping.get("rows"), list) else []
    table_path = str(mapping.get("table_path") or "").strip()
    source_fields, source_error = _source_table_options(table_path, mapping_rows)
    vocabulary_cache = data_processing_values_service.get_data_processing_values(project_name)
    source_vocabulary = data_processing_values_service.source_vocabulary_options(
        vocabulary_cache
    )
    _apply_dataset_vocabularies(source_fields, source_vocabulary)
    source_field_names = [str(item.get("field") or "").strip() for item in source_fields]
    source_field_set = set(source_field_names)
    source_type_by_field = {
        str(item.get("field") or "").strip(): str(item.get("type") or "").strip()
        for item in source_fields
    }

    source_measures: List[str] = []
    seen_source_measures: set[str] = set()
    reserving_defs: List[Dict[str, Any]] = []
    for row in mapping_rows:
        field_name = str(row.get("field_name") or "").strip()
        significance = str(row.get("significance") or "").strip()
        if not field_name:
            continue
        if significance == "Dataset" and field_name not in seen_source_measures:
            seen_source_measures.add(field_name)
            source_measures.append(field_name)
        if significance == "Reserving Class":
            try:
                level = int(row.get("level"))
            except (TypeError, ValueError):
                level = None
            reserving_defs.append({"field": field_name, "level": level})
    reserving_configuration_errors: List[str] = []
    fields_by_level: Dict[int, List[str]] = {}
    for item in reserving_defs:
        level = item.get("level")
        field_name = str(item.get("field") or "").strip()
        if not isinstance(level, int):
            reserving_configuration_errors.append(
                f"Reserving Class field '{field_name}' does not have a valid mapped level."
            )
            continue
        fields_by_level.setdefault(level, []).append(field_name)
    for level, fields in sorted(fields_by_level.items()):
        unique_fields = list(dict.fromkeys(fields))
        if len(unique_fields) > 1:
            reserving_configuration_errors.append(
                f"Field Mapping assigns Reserving Class level {level} to multiple fields: "
                f"{', '.join(unique_fields)}."
            )

    values_payload = _safe_read_json(config.get_reserving_class_values_path(project_name))
    members_by_field: Dict[str, List[str]] = {}
    for item in values_payload.get("fields", []) if isinstance(values_payload.get("fields"), list) else []:
        if not isinstance(item, dict):
            continue
        field_name = str(item.get("field_name") or "").strip()
        members = [
            str(value if value is not None else "").strip()
            for value in item.get("distinct_values", [])
            if str(value if value is not None else "").strip()
        ] if isinstance(item.get("distinct_values"), list) else []
        if field_name:
            members_by_field[field_name] = _dedupe_json_values(members)

    types_payload = _safe_read_json(config.get_reserving_class_types_path(project_name))
    type_columns = _column_index(types_payload.get("columns"))
    name_index = type_columns.get("name", 0)
    level_index = type_columns.get("level", 1)
    source_index = type_columns.get(
        "source",
        4 if "eex formula" in type_columns else 3,
    )
    formula_index = type_columns.get("formula", 2)
    types_by_level: Dict[int, List[str]] = {}
    source_by_type: Dict[Tuple[int, str], str] = {}
    formula_by_type: Dict[Tuple[int, str], str] = {}
    for row in types_payload.get("rows", []) if isinstance(types_payload.get("rows"), list) else []:
        name = str(_row_cell(row, name_index) or "").strip()
        try:
            level = int(_row_cell(row, level_index))
        except (TypeError, ValueError):
            continue
        if not name:
            continue
        names = types_by_level.setdefault(level, [])
        if name not in names:
            names.append(name)
        source_by_type[(level, name.casefold())] = str(_row_cell(row, source_index) or "").strip()
        formula_by_type[(level, name.casefold())] = str(_row_cell(row, formula_index) or "").strip()

    reserving_fields: List[Dict[str, Any]] = []
    for item in sorted(
        reserving_defs,
        key=lambda value: (
            value.get("level") if isinstance(value.get("level"), int) else 10**9,
            str(value.get("field") or "").casefold(),
        ),
    ):
        field_name = str(item.get("field") or "").strip()
        level = item.get("level")
        reserving_fields.append({
            "field": field_name,
            "level": level,
            "types": list(types_by_level.get(level, [])) if isinstance(level, int) else [],
            "members": list(members_by_field.get(field_name, [])),
        })

    dataset_types_payload = _safe_read_json(config.get_dataset_types_path(project_name))
    dataset_columns = _column_index(dataset_types_payload.get("columns"))
    dataset_name_index = dataset_columns.get("name", 0)
    dataset_source_index = dataset_columns.get("source", 5)
    dataset_types: List[Dict[str, str]] = []
    for row in dataset_types_payload.get("rows", []) if isinstance(dataset_types_payload.get("rows"), list) else []:
        name = str(_row_cell(row, dataset_name_index) or "").strip()
        source = str(_row_cell(row, dataset_source_index) or "").strip()
        if name:
            dataset_types.append({"name": name, "source": source})
    reachable_source_measures = [
        measure
        for measure in source_measures
        if any(
            _source_mentions_measure(str(item.get("source") or ""), measure)
            for item in dataset_types
        )
    ]

    return {
        "table_path": table_path,
        "source_error": source_error,
        "source_field_names": source_field_names,
        "source_field_set": source_field_set,
        "source_type_by_field": source_type_by_field,
        "source_measures": source_measures,
        "source_measure_set": set(source_measures),
        "reachable_source_measure_set": set(reachable_source_measures),
        "reserving_fields": reserving_fields,
        "reserving_by_field": {
            str(item.get("field") or ""): item for item in reserving_fields
        },
        "source_by_type": source_by_type,
        "formula_by_type": formula_by_type,
        "dataset_types": dataset_types,
        "source_vocabulary": source_vocabulary,
        "configuration_errors": reserving_configuration_errors,
        "options": {
            "source_measures": reachable_source_measures,
            "source_fields": source_fields,
            "reserving_class_fields": reserving_fields,
            "source_vocabulary": source_vocabulary,
        },
    }


def _condition_values(condition: Dict[str, Any]) -> List[Any]:
    value = condition.get("value")
    if condition.get("operator") in {"in", "not_in"}:
        return list(value) if isinstance(value, list) else []
    return [value]


def _extract_source_members(source: str) -> set[str]:
    text = str(source or "").strip()
    if not text:
        return set()
    quoted: set[str] = set()
    for match in re.finditer(r'"((?:\\.|[^"])*)"', text):
        token = str(match.group(1) or "")
        try:
            token = json.loads(f'"{token}"')
        except Exception:
            token = token.replace('\\"', '"')
        token = token.strip()
        if token:
            quoted.add(token)
    if quoted:
        return quoted
    return {
        token.strip()
        for token in re.split(r"[+\-*/()]", text)
        if token.strip() and not re.fullmatch(r"\d+(\.\d+)?", token.strip())
    }


def _expression_member_names(expression: str) -> List[str]:
    """Return every member name referenced in a Formula/Source expression.

    Handles quoted names (which may contain operators, e.g. ``"PD+UMPD"``) and
    bare names, unlike :func:`_extract_source_members`, which drops bare tokens
    whenever any quoted token is present.
    """
    text = str(expression or "")
    names: List[str] = []
    index = 0
    length = len(text)
    while index < length:
        char = text[index]
        if char.isspace() or char in "+-*/()":
            index += 1
            continue
        if char == '"':
            index += 1
            buffer: List[str] = []
            while index < length:
                if text[index] == "\\" and index + 1 < length:
                    buffer.append(text[index + 1])
                    index += 2
                    continue
                if text[index] == '"':
                    index += 1
                    break
                buffer.append(text[index])
                index += 1
            name = "".join(buffer).strip()
            if name:
                names.append(name)
            continue
        start = index
        while index < length and text[index] not in '+-*/()"':
            index += 1
        name = text[start:index].strip()
        if name and not re.fullmatch(r"\d+(\.\d+)?", name):
            names.append(name)
    return names


def _membership_member_set(
    level: int,
    type_name: str,
    source_by_type: Dict[Tuple[int, str], str],
    formula_by_type: Dict[Tuple[int, str], str],
    stack: Tuple[Tuple[int, str], ...] = (),
) -> set[str]:
    """Every reserving-class label a selected type resolves to for row matching.

    Mirrors the data-engine membership walk: the type's own name plus every
    intermediate composite label (from the ``Formula`` tree, falling back to
    ``Source``) plus the atomic leaves. Source tables store some measures at an
    aggregate label (e.g. ``IBNRCAT = "PD+UMPD"``) rather than atomic members, so
    ``keep_members`` actions may legitimately reference those composite labels.
    """
    key = (level, type_name.casefold())
    members: set[str] = {type_name}
    if key in stack:
        return members
    formula = str(formula_by_type.get(key, "") or "").strip()
    source = str(source_by_type.get(key, "") or "").strip()
    expression = formula or source
    if not expression:
        return members
    names = _expression_member_names(expression)
    if (
        not formula
        and len(names) == 1
        and names[0].casefold() == type_name.casefold()
    ):
        return members
    next_stack = stack + (key,)
    for child in names:
        child_key = (level, child.casefold())
        if child_key in source_by_type and child.casefold() != type_name.casefold():
            members |= _membership_member_set(
                level, child, source_by_type, formula_by_type, next_stack
            )
        else:
            members.add(child)
    return members


def _dataset_vocabulary_warning(
    rule: Dict[str, Any],
    source_measure: str,
    context: Dict[str, Any],
    label: str,
) -> List[str]:
    vocabulary = context.get("source_vocabulary")
    datasets = (
        vocabulary.get("datasets")
        if isinstance(vocabulary, dict) and isinstance(vocabulary.get("datasets"), dict)
        else {}
    )
    dataset = datasets.get(source_measure)
    if not isinstance(dataset, dict):
        return []
    try:
        row_count = int(dataset.get("row_count", 0))
    except (TypeError, ValueError):
        row_count = 0
    if row_count <= 0:
        dataset_type = str(dataset.get("dataset_type") or source_measure).strip()
        return [
            f"{label}: dataset '{dataset_type}' has no current source rows; "
            "dataset-specific value checks were skipped."
        ]

    key_fields = list(vocabulary.get("key_fields") or [])
    key_index = {
        str(item.get("field") or "").strip(): index
        for index, item in enumerate(key_fields)
        if isinstance(item, dict) and str(item.get("field") or "").strip()
    }
    combinations = dataset.get("combinations")
    if not key_index or not isinstance(combinations, list) or not combinations:
        return []

    action = rule.get("action") if isinstance(rule.get("action"), dict) else {}
    action_field = str(action.get("field") or "").strip()
    action_members = {
        str(value if value is not None else "").strip()
        for value in action.get("members", [])
        if str(value if value is not None else "").strip()
    }
    predicates: List[Tuple[int, str, set[str]]] = []
    if action_field in key_index and action_members:
        predicates.append((key_index[action_field], "in", action_members))

    row_conditions = (
        rule.get("row_conditions", {}).get("all", [])
        if isinstance(rule.get("row_conditions"), dict)
        else []
    )
    for condition in row_conditions:
        field = str(condition.get("field") or "").strip()
        if field not in key_index:
            continue
        operator = str(condition.get("operator") or "").strip()
        if operator == "is_blank":
            # Incomplete key tuples are intentionally absent from the cache, so a
            # blank-key predicate cannot be disproved using cached combinations.
            return []
        if operator in {"equals", "not_equals"}:
            values = {str(condition.get("value") or "").strip()}
        elif operator in {"in", "not_in"} and isinstance(condition.get("value"), list):
            values = {
                str(value if value is not None else "").strip()
                for value in condition.get("value", [])
            }
        else:
            continue
        values.discard("")
        if values:
            predicates.append((key_index[field], operator, values))

    if not predicates:
        return []

    def matches(combination: Any) -> bool:
        if not isinstance(combination, list) or len(combination) < len(key_fields):
            return False
        for index, operator, values in predicates:
            value = str(combination[index] or "").strip()
            if operator in {"in", "equals"} and value not in values:
                return False
            if operator in {"not_in", "not_equals"} and value in values:
                return False
        return True

    if any(matches(combination) for combination in combinations):
        return []
    dataset_type = str(dataset.get("dataset_type") or source_measure).strip()
    return [
        f"{label}: the Then member/filter values match no current complete "
        f"source-key combination for dataset '{dataset_type}'."
    ]


def _validate_rules(
    document: Dict[str, Any],
    context: Dict[str, Any],
) -> Tuple[List[str], List[str]]:
    errors: List[str] = []
    warnings: List[str] = []
    rules = document.get("rules", [])
    seen_ids: set[str] = set()
    source_fields = context.get("source_field_set", set())
    source_measures = context.get("source_measure_set", set())
    reachable_source_measures = context.get("reachable_source_measure_set", set())
    reserving_by_field = context.get("reserving_by_field", {})
    source_by_type = context.get("source_by_type", {})
    formula_by_type = context.get("formula_by_type", {})
    source_type_by_field = context.get("source_type_by_field", {})

    for index, rule in enumerate(rules):
        prefix = f"Rule {index + 1}"
        rule_id = str(rule.get("id") or "").strip()
        rule_name = str(rule.get("name") or "").strip()
        if not rule_id:
            errors.append(f"{prefix}: id is required.")
        elif rule_id in seen_ids:
            errors.append(f"{prefix}: duplicate id '{rule_id}'.")
        else:
            seen_ids.add(rule_id)
        if not rule_name:
            errors.append(f"{prefix}: name is required.")
        label = f"{prefix} ({rule_name or rule_id or 'unnamed'})"

        target = rule.get("target") if isinstance(rule.get("target"), dict) else {}
        source_measure = str(target.get("source_measure") or "").strip()
        if not source_measure:
            errors.append(f"{label}: target.source_measure is required.")
        elif source_measure not in source_measures:
            errors.append(
                f"{label}: source measure '{source_measure}' is not a mapped Dataset source field."
            )
        else:
            if source_measure not in source_fields:
                warnings.append(
                    f"{label}: source measure '{source_measure}' is absent from the current source table."
                )
            if source_measure not in reachable_source_measures:
                errors.append(
                    f"{label}: source measure '{source_measure}' is not reachable from any Dataset Type Source."
                )

        request_conditions = (
            rule.get("request_conditions", {}).get("all", [])
            if isinstance(rule.get("request_conditions"), dict)
            else []
        )
        for condition in request_conditions:
            field = str(condition.get("field") or "").strip()
            operator = str(condition.get("operator") or "").strip()
            reserving = reserving_by_field.get(field)
            if reserving is None:
                errors.append(
                    f"{label}: request condition field '{field}' is not a mapped Reserving Class field."
                )
                continue
            try:
                level = int(condition.get("level"))
            except (TypeError, ValueError):
                errors.append(f"{label}: request condition '{field}' requires an integer level.")
                continue
            if level != reserving.get("level"):
                errors.append(
                    f"{label}: request condition '{field}' level {level} does not match Field Mapping level {reserving.get('level')}."
                )
            values = _condition_values(condition)
            if operator in {"equals", "not_equals"} and isinstance(condition.get("value"), list):
                errors.append(f"{label}: {operator} requires a scalar value for '{field}'.")
            if operator in {"in", "not_in"} and not values:
                errors.append(f"{label}: {operator} requires a non-empty value list for '{field}'.")
            valid_types = set(reserving.get("types") or [])
            for value in values:
                value_text = str(value if value is not None else "").strip()
                if not value_text or value_text not in valid_types:
                    errors.append(
                        f"{label}: reserving class type '{value_text}' does not exist for '{field}' at level {level}."
                    )

        row_conditions = (
            rule.get("row_conditions", {}).get("all", [])
            if isinstance(rule.get("row_conditions"), dict)
            else []
        )
        for condition in row_conditions:
            field = str(condition.get("field") or "").strip()
            operator = str(condition.get("operator") or "").strip()
            if field not in source_fields:
                errors.append(
                    f"{label}: row condition field '{field}' does not exist in the source table."
                )
                continue
            value = condition.get("value")
            if operator in {"in", "not_in"} and (
                not isinstance(value, list) or len(value) == 0
            ):
                errors.append(f"{label}: {operator} requires a non-empty value list for '{field}'.")
            if (
                operator not in {"in", "not_in", "is_blank", "is_not_blank"}
                and (value is None or (isinstance(value, str) and not value.strip()))
            ):
                errors.append(f"{label}: {operator} requires a scalar value for '{field}'.")
            if operator not in {"in", "not_in", "is_blank", "is_not_blank"} and isinstance(value, list):
                errors.append(f"{label}: {operator} requires a scalar value for '{field}'.")
            if operator in _ROW_COMPARISON_OPERATORS and source_type_by_field.get(field) not in {"number", "date"}:
                errors.append(
                    f"{label}: {operator} is not compatible with non-numeric/non-date field '{field}'."
                )

        action = rule.get("action") if isinstance(rule.get("action"), dict) else {}
        action_type = str(action.get("type") or "").strip()
        action_field = str(action.get("field") or "").strip()
        members = list(action.get("members") or [])
        if action_field not in source_fields:
            errors.append(
                f"{label}: action field '{action_field}' does not exist in the source table."
            )
        if not members:
            errors.append(f"{label}: action.members must contain at least one atomic value.")

        reserving = reserving_by_field.get(action_field)
        if reserving is not None:
            try:
                action_level = int(action.get("level"))
            except (TypeError, ValueError):
                errors.append(
                    f"{label}: action field '{action_field}' requires its mapped level."
                )
                action_level = None
            if action_level is not None and action_level != reserving.get("level"):
                errors.append(
                    f"{label}: action level {action_level} does not match Field Mapping level {reserving.get('level')} for '{action_field}'."
                )
            valid_members = set(reserving.get("members") or [])
            if not valid_members:
                errors.append(
                    f"{label}: no atomic source members are available for action field '{action_field}'. Refresh Source Data first."
                )
            for member in members:
                if str(member) not in valid_members:
                    errors.append(
                        f"{label}: action member '{member}' is not an atomic source value for '{action_field}'."
                    )

            action_scope_conditions = [
                condition
                for condition in request_conditions
                if str(condition.get("field") or "").strip() == action_field
            ]
            scoped_type_names = list(reserving.get("types") or [])
            for condition in action_scope_conditions:
                condition_values = {
                    str(value if value is not None else "").strip()
                    for value in _condition_values(condition)
                }
                operator = str(condition.get("operator") or "").strip()
                if operator in {"equals", "in"}:
                    scoped_type_names = [
                        type_name
                        for type_name in scoped_type_names
                        if type_name in condition_values
                    ]
                elif operator in {"not_equals", "not_in"}:
                    scoped_type_names = [
                        type_name
                        for type_name in scoped_type_names
                        if type_name not in condition_values
                    ]
            scoped_types = (
                [
                    (int(reserving.get("level")), type_name)
                    for type_name in scoped_type_names
                ]
                if action_scope_conditions and isinstance(reserving.get("level"), int)
                else []
            )

            if action_type == "keep_members" and not action_scope_conditions:
                errors.append(
                    f"{label}: keep_members requires a request condition for action field '{action_field}'."
                )
            elif action_type == "keep_members" and not scoped_types:
                errors.append(
                    f"{label}: request conditions exclude every reserving class type for action field '{action_field}'."
                )
            for level, type_name in scoped_types:
                membership_members = _membership_member_set(
                    level, type_name, source_by_type, formula_by_type
                )
                if membership_members == {type_name} and not source_by_type.get(
                    (level, type_name.casefold())
                ):
                    errors.append(
                        f"{label}: normal Reserving Class Source could not be resolved for '{type_name}' at level {level}."
                    )
                    continue
                outside = [member for member in members if member not in membership_members]
                if action_type == "keep_members" and outside:
                    errors.append(
                        f"{label}: keep_members cannot add base-excluded member(s) for '{type_name}': {', '.join(outside)}."
                    )
                elif action_type == "exclude_members" and outside:
                    warnings.append(
                        f"{label}: excluded member(s) have no effect for '{type_name}': {', '.join(outside)}."
                    )
        elif action.get("level") is not None:
            errors.append(
                f"{label}: action.level is only valid for a mapped Reserving Class field."
            )

        if source_measure in source_measures:
            warnings.extend(
                _dataset_vocabulary_warning(rule, source_measure, context, label)
            )

    if rules and context.get("source_error"):
        errors.append(str(context.get("source_error")))
    if rules:
        errors.extend(
            str(error)
            for error in context.get("configuration_errors", [])
            if str(error).strip()
        )
    return errors, warnings


def _response_for_document(
    project_name: str,
    path: str,
    document: Dict[str, Any],
    *,
    exists: bool,
    context: Optional[Dict[str, Any]] = None,
    changed: Optional[bool] = None,
    impact: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    validation_context = context if context is not None else _load_validation_context(project_name)
    errors, warnings = _validate_rules(document, validation_context)
    response: Dict[str, Any] = {
        "ok": True,
        "exists": exists,
        "path": path,
        "data": document,
        "options": validation_context.get("options", {}),
        "semantic_hash": semantic_rules_hash(document),
        "validation": {
            "valid": not errors,
            "errors": errors,
            "warnings": warnings,
        },
    }
    if changed is not None:
        response["changed"] = changed
    if impact is not None:
        response["impact"] = impact
    try:
        response["processing_config_hash"] = get_processing_config_hash(project_name)
    except Exception:
        response["processing_config_hash"] = ""
    return response


def get_data_processing_rules(project_name: str) -> Dict[str, Any]:
    path = config.get_data_processing_rules_path(project_name)
    exists = os.path.exists(path)
    document = _read_rules_document(path)
    return _response_for_document(
        project_name,
        path,
        document,
        exists=exists,
    )


def validate_data_processing_rules(
    project_name: str,
    data: Dict[str, Any],
) -> Dict[str, Any]:
    path = config.get_data_processing_rules_path(project_name)
    current = _read_rules_document(path)
    candidate = _parse_rules_data(data, stored=False)
    candidate["revision"] = current["revision"]
    candidate["updated_at"] = current["updated_at"]
    candidate["updated_by"] = current["updated_by"]
    context = _load_validation_context(project_name)
    errors, warnings = _validate_rules(candidate, context)
    return {
        "ok": True,
        "valid": not errors,
        "errors": errors,
        "warnings": warnings,
        "data": candidate,
        "options": context.get("options", {}),
        "semantic_hash": semantic_rules_hash(candidate),
    }


def _atomic_write_document(path: str, document: Dict[str, Any]) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    temporary_path = f"{path}.{uuid.uuid4().hex}.tmp"
    try:
        with open(temporary_path, "w", encoding="utf-8", newline="\n") as handle:
            json.dump(document, handle, indent=2, ensure_ascii=False)
            handle.write("\n")
        os.replace(temporary_path, path)
    finally:
        try:
            if os.path.exists(temporary_path):
                os.remove(temporary_path)
        except OSError:
            pass


def _rules_by_id(document: Dict[str, Any]) -> Dict[str, Dict[str, Any]]:
    return {
        str(rule.get("id") or ""): rule
        for rule in document.get("rules", [])
        if str(rule.get("id") or "")
    }


def _describe_rule_changes(
    previous: Dict[str, Any],
    current: Dict[str, Any],
) -> Tuple[str, List[str]]:
    old_by_id = _rules_by_id(previous)
    new_by_id = _rules_by_id(current)
    old_ids = set(old_by_id)
    new_ids = set(new_by_id)
    added = sorted(new_ids - old_ids)
    removed = sorted(old_ids - new_ids)
    edited: List[str] = []
    enabled: List[str] = []
    disabled: List[str] = []
    affected_measures: set[str] = set()

    for rule_id in sorted(old_ids | new_ids):
        old = old_by_id.get(rule_id)
        new = new_by_id.get(rule_id)
        for rule in (old, new):
            if isinstance(rule, dict):
                target = rule.get("target") if isinstance(rule.get("target"), dict) else {}
                measure = str(target.get("source_measure") or "").strip()
                if measure:
                    affected_measures.add(measure)
        if old is None or new is None or old == new:
            continue
        edited.append(rule_id)
        if bool(old.get("enabled", True)) != bool(new.get("enabled", True)):
            (enabled if bool(new.get("enabled", True)) else disabled).append(rule_id)

    pieces = []
    for label, values in (
        ("added", added),
        ("edited", edited),
        ("removed", removed),
        ("enabled", enabled),
        ("disabled", disabled),
    ):
        if values:
            pieces.append(f"{label} {len(values)}")
    return ", ".join(pieces) or "updated", sorted(affected_measures)


def _source_mentions_measure(source: str, measure: str) -> bool:
    if not source or not measure:
        return False
    if source.strip() == measure:
        return True
    if f'"{measure}"' in source:
        return True
    return bool(
        re.search(
            rf"(?<![A-Za-z0-9_]){re.escape(measure)}(?![A-Za-z0-9_])",
            source,
            flags=re.IGNORECASE,
        )
    )


def _affected_dataset_types(context: Dict[str, Any], measures: List[str]) -> List[str]:
    out: List[str] = []
    for item in context.get("dataset_types", []):
        name = str(item.get("name") or "").strip()
        source = str(item.get("source") or "").strip()
        if name and any(_source_mentions_measure(source, measure) for measure in measures):
            out.append(name)
    return out


def is_imported_snapshot_payload(payload: Dict[str, Any]) -> bool:
    source = str(payload.get("source") or "").strip().lower()
    provenance = payload.get("provenance")
    provenance_kind = (
        str(provenance.get("kind") or "").strip().lower()
        if isinstance(provenance, dict)
        else ""
    )
    return source.startswith("resq_") or provenance_kind in {"import", "imported", "resq"}


def _count_stale_generated_sidecars(project_name: str, expected_hash: str) -> int:
    try:
        project_data_dir = config.get_project_data_dir(project_name)
    except ValueError:
        return 0
    if not os.path.isdir(project_data_dir):
        return 0
    count = 0
    for root, _dirs, files in os.walk(project_data_dir):
        if os.path.basename(root).casefold() != config.DATASET_SIDECAR_DIR.casefold():
            continue
        for filename in files:
            if not filename.lower().endswith(".json"):
                continue
            payload = _safe_read_json(os.path.join(root, filename))
            if str(payload.get("source_kind") or "").strip().lower() != "engine":
                continue
            if is_imported_snapshot_payload(payload):
                continue
            processing_by_csv = payload.get("processing_by_csv")
            if isinstance(processing_by_csv, dict) and processing_by_csv:
                stale_entries = 0
                for entry in processing_by_csv.values():
                    entry_hash = (
                        str(entry.get("config_hash") or "").strip()
                        if isinstance(entry, dict)
                        else ""
                    )
                    if not entry_hash or entry_hash != expected_hash:
                        stale_entries += 1
                count += stale_entries
                continue
            processing = payload.get("processing")
            stored_hash = (
                str(processing.get("config_hash") or "").strip()
                if isinstance(processing, dict)
                else ""
            )
            if not stored_hash or stored_hash != expected_hash:
                count += 1
    return count


def _invalidate_temporary_view_caches(project_name: str) -> int:
    project_data_dir = config.get_project_data_dir(project_name)
    if not os.path.isdir(project_data_dir):
        return 0
    cleared = 0
    for root, dirs, files in os.walk(project_data_dir):
        if os.path.basename(root).casefold() != config.TEMPORARY_VIEW_DATASET_CACHE_DIR.casefold():
            continue
        if os.path.basename(os.path.dirname(root)).casefold() != config.DATASET_CACHE_DIR.casefold():
            continue
        dirs[:] = []
        for filename in files:
            path = os.path.join(root, filename)
            try:
                os.remove(path)
            except PermissionError as error:
                raise RulesWriteLockedError(
                    f"Temporary-view cache is locked and could not be invalidated: {path}"
                ) from error
            except OSError as error:
                raise RuntimeError(
                    f"Failed to invalidate temporary-view cache: {path}: {str(error)}"
                ) from error
            cleared += 1
    return cleared


def save_data_processing_rules(
    project_name: str,
    *,
    expected_revision: int,
    data: Dict[str, Any],
) -> Dict[str, Any]:
    path = config.get_data_processing_rules_path(project_name)
    lock = _lock_for_path(path)
    if not lock.acquire(timeout=_RULE_LOCK_TIMEOUT_SECONDS):
        raise RulesWriteLockedError(
            "Data processing rules are being saved by another request. Please retry."
        )
    try:
        current = _read_rules_document(path)
        if int(expected_revision) != int(current.get("revision", 0)):
            raise RulesRevisionConflictError(
                f"Data processing rules revision changed from {expected_revision} to {current.get('revision', 0)}. Refresh and try again."
            )

        candidate = _parse_rules_data(data, stored=False)
        candidate["revision"] = current["revision"]
        candidate["updated_at"] = current["updated_at"]
        candidate["updated_by"] = current["updated_by"]
        context = _load_validation_context(project_name)
        errors, _warnings = _validate_rules(candidate, context)
        if errors:
            raise RulesValidationError(errors)

        semantic_unchanged = semantic_rules_hash(candidate) == semantic_rules_hash(current)
        order_changed = _rule_id_order(candidate) != _rule_id_order(current)
        if semantic_unchanged and not order_changed:
            return _response_for_document(
                project_name,
                path,
                current,
                exists=os.path.exists(path),
                context=context,
                changed=False,
                impact={
                    "affected_source_measures": [],
                    "affected_dataset_types": [],
                    "generated_caches_rejected": 0,
                    "temporary_view_caches_cleared": 0,
                    "invalidated_count": 0,
                },
            )

        if semantic_unchanged:
            candidate["revision"] = int(current.get("revision", 0)) + 1
            candidate["updated_at"] = _utc_now()
            candidate["updated_by"] = _current_user()
            _atomic_write_document(path, candidate)
            impact = {
                "affected_source_measures": [],
                "affected_dataset_types": [],
                "generated_caches_rejected": 0,
                "temporary_view_caches_cleared": 0,
                "invalidated_count": 0,
            }
            safe_append_project_audit_log(
                project_name=project_name,
                action=(
                    f"Reordered Data Processing Rules (revision {candidate['revision']})"
                ),
                user_name=candidate["updated_by"],
            )
            return _response_for_document(
                project_name,
                path,
                candidate,
                exists=True,
                context=context,
                changed=True,
                impact=impact,
            )

        change_description, affected_measures = _describe_rule_changes(current, candidate)
        candidate["revision"] = int(current.get("revision", 0)) + 1
        candidate["updated_at"] = _utc_now()
        candidate["updated_by"] = _current_user()
        temporary_caches_cleared = _invalidate_temporary_view_caches(project_name)
        _atomic_write_document(path, candidate)

        expected_hash = get_processing_config_hash(project_name)
        affected_types = _affected_dataset_types(context, affected_measures)
        stale_cache_count = _count_stale_generated_sidecars(project_name, expected_hash)
        impact = {
            "affected_source_measures": affected_measures,
            "affected_dataset_types": affected_types,
            "generated_caches_rejected": stale_cache_count,
            "temporary_view_caches_cleared": temporary_caches_cleared,
            "invalidated_count": stale_cache_count + temporary_caches_cleared,
        }
        safe_append_project_audit_log(
            project_name=project_name,
            action=(
                f"Saved Data Processing Rules (revision {candidate['revision']}; "
                f"{change_description}; affected measures: "
                f"{', '.join(affected_measures) if affected_measures else 'none'})"
            ),
            user_name=candidate["updated_by"],
        )
        return _response_for_document(
            project_name,
            path,
            candidate,
            exists=True,
            context=context,
            changed=True,
            impact=impact,
        )
    finally:
        lock.release()


def _strip_audit_metadata(value: Any) -> Any:
    if isinstance(value, dict):
        return {
            str(key): _strip_audit_metadata(item)
            for key, item in value.items()
            if str(key).strip().lower() not in _AUDIT_KEYS
        }
    if isinstance(value, list):
        return [_strip_audit_metadata(item) for item in value]
    return value


def _normalized_source_table_signature(field_mapping: Dict[str, Any]) -> Dict[str, Any]:
    table_path = str(field_mapping.get("table_path") or "").strip()
    normalized_path = (
        os.path.normcase(os.path.normpath(os.path.abspath(table_path)))
        if table_path
        else ""
    )
    signature: Dict[str, Any] = {
        "path": normalized_path,
        "exists": False,
        "mtime_ns": None,
        "size": None,
    }
    if not table_path:
        return signature
    try:
        stat = os.stat(table_path)
    except FileNotFoundError as error:
        if os.path.isdir(os.path.dirname(table_path)):
            return signature
        raise OSError(
            f"Source table folder is unavailable: {os.path.dirname(table_path)}"
        ) from error
    signature["exists"] = True
    signature["mtime_ns"] = int(stat.st_mtime_ns)
    signature["size"] = int(stat.st_size)
    return signature


def processing_config_payload(project_name: str) -> Dict[str, Any]:
    rules_path = config.get_data_processing_rules_path(project_name)
    rules_raw = _read_processing_config_json(rules_path)
    document = _parse_rules_data(rules_raw, stored=True) if rules_raw else _empty_document()
    field_mapping = _read_processing_config_json(config.get_field_mapping_path(project_name))
    return {
        "algorithm_version": config.DATA_PROCESSING_ALGORITHM_VERSION,
        "field_mapping": _strip_audit_metadata(field_mapping),
        "dataset_types": _strip_audit_metadata(
            _read_processing_config_json(config.get_dataset_types_path(project_name))
        ),
        "reserving_class_types": _strip_audit_metadata(
            _read_processing_config_json(config.get_reserving_class_types_path(project_name))
        ),
        "general_settings": _strip_audit_metadata(
            _read_processing_config_json(config.get_general_settings_path(project_name))
        ),
        "data_processing_rules": _canonical_rules_for_hash(document),
        "source_table": _normalized_source_table_signature(field_mapping),
    }


def get_processing_config_hash(project_name: str) -> str:
    return _hash_json(processing_config_payload(project_name))


def get_processing_provenance(
    project_name: str,
    *,
    config_hash: str | None = None,
) -> Dict[str, Any]:
    document = _read_rules_document(config.get_data_processing_rules_path(project_name))
    return {
        "config_hash": config_hash or get_processing_config_hash(project_name),
        "algorithm_version": config.DATA_PROCESSING_ALGORITHM_VERSION,
        "rules_format": config.DATA_PROCESSING_RULES_FORMAT,
        "rules_revision": int(document.get("revision", 0)),
    }
