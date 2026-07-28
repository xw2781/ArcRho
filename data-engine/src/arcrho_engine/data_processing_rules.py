from __future__ import annotations

import hashlib
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Dict, Iterable, List, Mapping, Optional, Sequence, Tuple

import pandas as pd


SUPPORTED_RULES_FORMAT = "arcrho-data-processing-rules-v1"


class DataProcessingConfigurationError(RuntimeError):
    """Raised when project processing configuration cannot be compiled safely."""


class ReservingClassConfigurationError(DataProcessingConfigurationError):
    """Raised when reserving-class fields or resolved Sources are invalid."""


class DataProcessingRulesError(DataProcessingConfigurationError):
    """Raised when data_processing_rules.json is invalid or cannot be applied."""


def build_configuration_file_signature(
    paths: Mapping[str, Path],
    *,
    required_keys: Iterable[str],
) -> Tuple[Tuple[str, bool, int, int, str], ...]:
    required = set(required_keys)
    missing = [
        str(path)
        for key, path in paths.items()
        if key in required and not path.exists()
    ]
    if missing:
        raise DataProcessingConfigurationError(
            f"Missing project JSON file(s): {', '.join(missing)}"
        )

    signature: List[Tuple[str, bool, int, int, str]] = []
    for key, path in sorted(paths.items()):
        if not path.exists():
            signature.append((key, False, 0, 0, ""))
            continue
        try:
            stat = path.stat()
            digest = hashlib.sha256(path.read_bytes()).hexdigest()
        except OSError as exc:
            raise DataProcessingConfigurationError(
                f"Cannot read project configuration file [{path}]: {exc}"
            ) from exc
        signature.append((key, True, stat.st_mtime_ns, stat.st_size, digest))
    return tuple(signature)


def _canonical_name(value: Any) -> str:
    return str(value if value is not None else "").strip().casefold()


def _required_text(value: Any, label: str, error_type=DataProcessingRulesError) -> str:
    if not isinstance(value, str) or not value.strip():
        raise error_type(f"{label} must be a non-empty string.")
    return value.strip()


def _integer_level(value: Any, label: str, error_type=DataProcessingRulesError) -> int:
    if isinstance(value, bool):
        raise error_type(f"{label} must be an integer.")
    try:
        level = int(str(value).strip())
    except (TypeError, ValueError) as exc:
        raise error_type(f"{label} must be an integer.") from exc
    if level <= 0:
        raise error_type(f"{label} must be greater than zero.")
    return level


def _json_table_records(payload: Any, label: str) -> List[Dict[str, Any]]:
    if not isinstance(payload, dict):
        raise ReservingClassConfigurationError(f"{label} must be a JSON object.")

    columns = payload.get("columns")
    rows = payload.get("rows")
    if not isinstance(columns, list) or not isinstance(rows, list):
        raise ReservingClassConfigurationError(
            f"{label} must contain list-valued columns and rows."
        )

    records: List[Dict[str, Any]] = []
    normalized_columns = [str(column if column is not None else "").strip() for column in columns]
    for row_index, raw_row in enumerate(rows):
        if not isinstance(raw_row, list):
            raise ReservingClassConfigurationError(
                f"{label} row {row_index + 1} must be a list."
            )
        values = list(raw_row) + [None] * max(0, len(normalized_columns) - len(raw_row))
        records.append(dict(zip(normalized_columns, values)))
    return records


@dataclass(frozen=True)
class ReservingClassField:
    field: str
    level: int


@dataclass(frozen=True)
class ReservingClassType:
    field: str
    level: int
    name: str
    formula: str
    source: str


@dataclass(frozen=True)
class CompiledCondition:
    field: str
    operator: str
    value: Any = None
    level: Optional[int] = None


@dataclass(frozen=True)
class CompiledAction:
    type: str
    field: str
    members: Tuple[Any, ...]
    level: Optional[int] = None
    reserving_class_field: bool = False


@dataclass(frozen=True)
class CompiledRule:
    id: str
    name: str
    enabled: bool
    source_measure: str
    request_conditions: Tuple[CompiledCondition, ...]
    row_conditions: Tuple[CompiledCondition, ...]
    action: CompiledAction


@dataclass(frozen=True)
class CompiledRules:
    json_format: str
    revision: int
    rules: Tuple[CompiledRule, ...]


@dataclass
class ReservingClassCatalog:
    fields: Tuple[ReservingClassField, ...]
    types: Dict[Tuple[str, int, str], ReservingClassType]
    _field_by_name: Dict[str, ReservingClassField] = field(default_factory=dict)
    _coefficients: Dict[Tuple[str, int, str], Dict[str, int]] = field(default_factory=dict)
    _membership: Dict[Tuple[str, int, str], Dict[str, int]] = field(default_factory=dict)

    def resolve_field(self, field_name: Any) -> Optional[ReservingClassField]:
        return self._field_by_name.get(_canonical_name(field_name))

    def resolve_type(
        self,
        field_name: Any,
        level: Any,
        type_name: Any,
    ) -> ReservingClassType:
        field_info = self.resolve_field(field_name)
        if field_info is None:
            raise ReservingClassConfigurationError(
                f"Unknown reserving-class field [{field_name}]."
            )
        normalized_level = _integer_level(
            level,
            f"Level for reserving-class field [{field_info.field}]",
            ReservingClassConfigurationError,
        )
        if normalized_level != field_info.level:
            raise ReservingClassConfigurationError(
                f"Reserving-class field [{field_info.field}] is level "
                f"{field_info.level}, not level {normalized_level}."
            )
        key = (field_info.field, field_info.level, _canonical_name(type_name))
        resolved = self.types.get(key)
        if resolved is None:
            raise ReservingClassConfigurationError(
                f"Unknown reserving-class type [{type_name}] for "
                f"{field_info.field} at level {field_info.level}."
            )
        return resolved

    def coefficients_for(
        self,
        field_name: Any,
        level: Any,
        type_name: Any,
    ) -> Dict[str, int]:
        resolved = self.resolve_type(field_name, level, type_name)
        key = (resolved.field, resolved.level, _canonical_name(resolved.name))
        return dict(self._resolve_coefficients(key, ()))

    def membership_coefficients_for(
        self,
        field_name: Any,
        level: Any,
        type_name: Any,
    ) -> Dict[str, int]:
        """Row-matching coefficients for a selected reserving-class type.

        Unlike :meth:`coefficients_for`, which resolves a selection down to its
        atomic raw members only, this returns a coefficient for every node in the
        resolution tree: the selected type's own name, each intermediate composite
        label (as spelled in the ``Formula`` column), and each atomic leaf. Source
        tables store some measures at atomic granularity (e.g. losses) and others
        at an aggregate reserving-class label (e.g. remaining-budget exposure keyed
        by ``IBNRCAT = "PD+UMPD"``); matching every tree node lets a request pick up
        whichever granularity the data uses, with the correct +/- sign.
        """
        resolved = self.resolve_type(field_name, level, type_name)
        key = (resolved.field, resolved.level, _canonical_name(resolved.name))
        return dict(self._resolve_membership(key, ()))

    def _resolve_membership(
        self,
        key: Tuple[str, int, str],
        stack: Tuple[Tuple[str, int, str], ...],
    ) -> Dict[str, int]:
        cached = self._membership.get(key)
        if cached is not None:
            return cached
        if key in stack:
            cycle_keys = stack[stack.index(key):] + (key,)
            cycle = " -> ".join(self.types[item].name for item in cycle_keys)
            raise ReservingClassConfigurationError(
                f"Cyclic reserving-class Source detected: {cycle}."
            )

        row = self.types[key]
        formula = str(row.formula or "").strip()
        source = str(row.source or "").strip()
        # Prefer the human-authored Formula so intermediate composite labels are
        # visited; fall back to Source when no Formula is defined.
        expression = formula or source

        membership: Dict[str, int] = {row.name: 1}
        source_tokens = _tokenize_member_expression(source) if source else []
        is_leaf = (
            not expression
            or (
                not formula
                and len(source_tokens) == 1
                and source_tokens[0][0] == "NAME"
                and _canonical_name(source_tokens[0][1]) == _canonical_name(row.name)
            )
        )
        if is_leaf:
            self._membership[key] = membership
            return membership

        next_stack = stack + (key,)

        def resolve_component(component_name: str) -> Dict[str, int]:
            component_key = (row.field, row.level, _canonical_name(component_name))
            if component_key in self.types:
                return self._resolve_membership(component_key, next_stack)
            # A Formula may reference a display-only label that is not itself a
            # defined type; treat it as an atomic stored label so rows keyed with
            # it are still matched (mirrors the pre-refactor inclusion behavior).
            return {component_name: 1}

        component_coefficients = _parse_member_expression(expression, resolve_component)
        membership = _combine_coefficients(membership, component_coefficients, 1)
        membership = {name: value for name, value in membership.items() if value != 0}
        self._membership[key] = membership
        return membership

    def _resolve_coefficients(
        self,
        key: Tuple[str, int, str],
        stack: Tuple[Tuple[str, int, str], ...],
    ) -> Dict[str, int]:
        cached = self._coefficients.get(key)
        if cached is not None:
            return cached
        if key in stack:
            cycle_keys = stack[stack.index(key):] + (key,)
            cycle = " -> ".join(self.types[item].name for item in cycle_keys)
            raise ReservingClassConfigurationError(
                f"Cyclic reserving-class Source detected: {cycle}."
            )

        row = self.types[key]
        source = str(row.source or "").strip()
        formula = str(row.formula or "").strip()
        if not source:
            if formula:
                raise ReservingClassConfigurationError(
                    f"Reserving-class type [{row.name}] at level {row.level} "
                    "has a Formula but no resolved Source."
                )
            coefficients = {row.name: 1}
            self._coefficients[key] = coefficients
            return coefficients

        source_tokens = _tokenize_member_expression(source)
        if (
            not formula
            and len(source_tokens) == 1
            and source_tokens[0][0] == "NAME"
            and _canonical_name(source_tokens[0][1]) == _canonical_name(row.name)
        ):
            coefficients = {row.name: 1}
            self._coefficients[key] = coefficients
            return coefficients

        next_stack = stack + (key,)

        def resolve_component(component_name: str) -> Dict[str, int]:
            component_key = (row.field, row.level, _canonical_name(component_name))
            if component_key not in self.types:
                raise ReservingClassConfigurationError(
                    f"Resolved Source for [{row.name}] references unknown member "
                    f"[{component_name}] for {row.field} at level {row.level}."
                )
            return self._resolve_coefficients(component_key, next_stack)

        coefficients = _parse_member_expression(source, resolve_component)
        coefficients = {name: value for name, value in coefficients.items() if value != 0}
        if not coefficients:
            raise ReservingClassConfigurationError(
                f"Resolved Source for [{row.name}] has no nonzero atomic members."
            )
        invalid = {name: value for name, value in coefficients.items() if value not in {-1, 1}}
        if invalid:
            details = ", ".join(f"{name}={value}" for name, value in sorted(invalid.items()))
            raise ReservingClassConfigurationError(
                f"Resolved Source for [{row.name}] produces unsupported member "
                f"coefficients ({details}); only -1 and 1 are supported."
            )
        self._coefficients[key] = coefficients
        return coefficients

def build_reserving_class_catalog(
    field_mapping_payload: Any,
    reserving_class_payload: Any,
) -> ReservingClassCatalog:
    if not isinstance(field_mapping_payload, dict):
        raise ReservingClassConfigurationError("field_mapping.json must be a JSON object.")
    mapping_rows = field_mapping_payload.get("rows")
    if not isinstance(mapping_rows, list):
        raise ReservingClassConfigurationError(
            "field_mapping.json must contain a list-valued rows field."
        )

    fields: List[ReservingClassField] = []
    seen_fields: set[str] = set()
    seen_levels: set[int] = set()
    for row_index, raw_row in enumerate(mapping_rows):
        if not isinstance(raw_row, dict):
            raise ReservingClassConfigurationError(
                f"field_mapping.json row {row_index + 1} must be an object."
            )
        if str(raw_row.get("significance", "") or "").strip() != "Reserving Class":
            continue
        field_name = _required_text(
            raw_row.get("field_name"),
            f"field_mapping.json row {row_index + 1} field_name",
            ReservingClassConfigurationError,
        )
        level = _integer_level(
            raw_row.get("level"),
            f"field_mapping.json reserving-class field [{field_name}] level",
            ReservingClassConfigurationError,
        )
        field_key = _canonical_name(field_name)
        if field_key in seen_fields:
            raise ReservingClassConfigurationError(
                f"Duplicate reserving-class field [{field_name}] in field_mapping.json."
            )
        if level in seen_levels:
            raise ReservingClassConfigurationError(
                f"Duplicate reserving-class level [{level}] in field_mapping.json."
            )
        seen_fields.add(field_key)
        seen_levels.add(level)
        fields.append(ReservingClassField(field=field_name, level=level))

    fields.sort(key=lambda item: item.level)
    field_by_level = {item.level: item for item in fields}
    field_by_name = {_canonical_name(item.field): item for item in fields}

    types: Dict[Tuple[str, int, str], ReservingClassType] = {}
    for row_index, record in enumerate(
        _json_table_records(reserving_class_payload, "reserving_class_types.json")
    ):
        name = str(record.get("Name", "") if record.get("Name") is not None else "").strip()
        level_text = str(
            record.get("Level", "") if record.get("Level") is not None else ""
        ).strip()
        formula = str(
            record.get("Formula", "") if record.get("Formula") is not None else ""
        ).strip()
        source = str(
            record.get("Source", "") if record.get("Source") is not None else ""
        ).strip()
        if not name and not level_text and not formula and not source:
            continue
        if not name:
            raise ReservingClassConfigurationError(
                f"reserving_class_types.json row {row_index + 1} has a blank Name."
            )
        level = _integer_level(
            level_text,
            f"reserving_class_types.json type [{name}] Level",
            ReservingClassConfigurationError,
        )
        field_info = field_by_level.get(level)
        if field_info is None:
            raise ReservingClassConfigurationError(
                f"Reserving-class type [{name}] uses unmapped level {level}."
            )
        key = (field_info.field, level, _canonical_name(name))
        if key in types:
            raise ReservingClassConfigurationError(
                f"Duplicate reserving-class type [{name}] for "
                f"{field_info.field} at level {level}."
            )
        types[key] = ReservingClassType(
            field=field_info.field,
            level=level,
            name=name,
            formula=formula,
            source=source,
        )

    catalog = ReservingClassCatalog(
        fields=tuple(fields),
        types=types,
        _field_by_name=field_by_name,
    )
    return catalog


def _tokenize_member_expression(expression: Any) -> List[Tuple[str, str, int]]:
    text = str(expression if expression is not None else "")
    tokens: List[Tuple[str, str, int]] = []
    index = 0
    while index < len(text):
        if text[index].isspace():
            index += 1
            continue
        start = index
        char = text[index]
        if char in "+-()*/":
            tokens.append((char, char, start))
            index += 1
            continue
        if char == '"':
            index += 1
            value_parts: List[str] = []
            while index < len(text):
                current = text[index]
                if (
                    current == "\\"
                    and index + 1 < len(text)
                    and text[index + 1] in {'"', "\\"}
                ):
                    value_parts.append(text[index + 1])
                    index += 2
                    continue
                if current == '"':
                    index += 1
                    break
                value_parts.append(current)
                index += 1
            else:
                raise ReservingClassConfigurationError(
                    f"Unterminated quoted member in Source expression at position {start + 1}."
                )
            value = "".join(value_parts).strip()
            if not value:
                raise ReservingClassConfigurationError(
                    f"Blank quoted member in Source expression at position {start + 1}."
                )
            tokens.append(("NAME", value, start))
            continue

        while index < len(text) and text[index] not in "+-()*/":
            index += 1
        value = text[start:index].strip()
        if not value:
            raise ReservingClassConfigurationError(
                f"Invalid Source expression token at position {start + 1}."
            )
        tokens.append(("NAME", value, start))
    return tokens


def _combine_coefficients(
    left: Mapping[str, int],
    right: Mapping[str, int],
    multiplier: int,
) -> Dict[str, int]:
    out = dict(left)
    for name, value in right.items():
        out[name] = out.get(name, 0) + multiplier * value
        if out[name] == 0:
            out.pop(name)
    return out


def _parse_member_expression(
    expression: Any,
    resolve_component: Callable[[str], Dict[str, int]],
) -> Dict[str, int]:
    tokens = _tokenize_member_expression(expression)
    if not tokens:
        raise ReservingClassConfigurationError("Resolved reserving-class Source is blank.")
    position = 0

    def current() -> Optional[Tuple[str, str, int]]:
        return tokens[position] if position < len(tokens) else None

    def parse_primary() -> Dict[str, int]:
        nonlocal position
        token = current()
        if token is None:
            raise ReservingClassConfigurationError(
                "Resolved reserving-class Source ends with an operator."
            )
        kind, value, offset = token
        if kind == "NAME":
            position += 1
            return resolve_component(value)
        if kind == "(":
            position += 1
            inner = parse_expression()
            closing = current()
            if closing is None or closing[0] != ")":
                raise ReservingClassConfigurationError(
                    f"Unbalanced parenthesis in Source expression at position {offset + 1}."
                )
            position += 1
            return inner
        if kind in {"*", "/"}:
            raise ReservingClassConfigurationError(
                f"Unsupported operator [{kind}] in reserving-class Source."
            )
        raise ReservingClassConfigurationError(
            f"Unexpected token [{value}] in Source expression at position {offset + 1}."
        )

    def parse_unary() -> Dict[str, int]:
        nonlocal position
        multiplier = 1
        while current() is not None and current()[0] in {"+", "-"}:
            if current()[0] == "-":
                multiplier *= -1
            position += 1
        value = parse_primary()
        if multiplier == 1:
            return value
        return {name: multiplier * coefficient for name, coefficient in value.items()}

    def parse_expression() -> Dict[str, int]:
        nonlocal position
        result = parse_unary()
        while current() is not None and current()[0] != ")":
            operator = current()
            if operator is None:
                break
            if operator[0] in {"*", "/"}:
                raise ReservingClassConfigurationError(
                    f"Unsupported operator [{operator[0]}] in reserving-class Source."
                )
            if operator[0] not in {"+", "-"}:
                raise ReservingClassConfigurationError(
                    f"Expected + or - at position {operator[2] + 1} in Source expression."
                )
            position += 1
            right = parse_unary()
            result = _combine_coefficients(
                result,
                right,
                1 if operator[0] == "+" else -1,
            )
        return result

    parsed = parse_expression()
    if position != len(tokens):
        token = tokens[position]
        raise ReservingClassConfigurationError(
            f"Unexpected token [{token[1]}] at position {token[2] + 1} "
            "in Source expression."
        )
    return parsed


def _mapped_source_fields(field_mapping_payload: Any) -> Tuple[set[str], set[str]]:
    if not isinstance(field_mapping_payload, dict):
        raise DataProcessingRulesError("field_mapping.json must be a JSON object.")
    rows = field_mapping_payload.get("rows")
    if not isinstance(rows, list):
        raise DataProcessingRulesError(
            "field_mapping.json must contain a list-valued rows field."
        )
    all_fields: set[str] = set()
    dataset_fields: set[str] = set()
    for raw_row in rows:
        if not isinstance(raw_row, dict):
            continue
        field_name = str(raw_row.get("field_name", "") or "").strip()
        if not field_name:
            continue
        all_fields.add(field_name)
        if str(raw_row.get("significance", "") or "").strip() == "Dataset":
            dataset_fields.add(field_name)
    return all_fields, dataset_fields


def _reachable_source_measures(
    dataset_types_payload: Any,
    dataset_fields: Iterable[str],
) -> set[str]:
    records = _json_table_records(dataset_types_payload, "dataset_types.json")
    sources = [
        str(record.get("Source", "") if record.get("Source") is not None else "")
        for record in records
    ]
    reachable: set[str] = set()
    for field_name in dataset_fields:
        for source in sources:
            start = 0
            while True:
                position = source.find(field_name, start)
                if position < 0:
                    break
                before = source[position - 1] if position > 0 else ""
                after_index = position + len(field_name)
                after = source[after_index] if after_index < len(source) else ""
                if (
                    (not before or not (before.isalnum() or before == "_"))
                    and (not after or not (after.isalnum() or after == "_"))
                ):
                    reachable.add(field_name)
                    break
                start = position + 1
            if field_name in reachable:
                break
    return reachable


def _condition_group(
    raw_group: Any,
    *,
    label: str,
    request_group: bool,
    catalog: ReservingClassCatalog,
) -> Tuple[CompiledCondition, ...]:
    if not isinstance(raw_group, dict) or set(raw_group) != {"all"}:
        raise DataProcessingRulesError(f"{label} must be an object containing only all.")
    raw_conditions = raw_group.get("all")
    if not isinstance(raw_conditions, list):
        raise DataProcessingRulesError(f"{label}.all must be a list.")

    request_operators = {"equals", "not_equals", "in", "not_in"}
    row_operators = {
        "equals",
        "not_equals",
        "in",
        "not_in",
        "is_blank",
        "is_not_blank",
        "greater_than",
        "greater_than_or_equal",
        "less_than",
        "less_than_or_equal",
    }
    conditions: List[CompiledCondition] = []
    for condition_index, raw_condition in enumerate(raw_conditions):
        condition_label = f"{label}.all[{condition_index}]"
        if not isinstance(raw_condition, dict):
            raise DataProcessingRulesError(f"{condition_label} must be an object.")
        allowed_keys = (
            {"field", "level", "operator", "value"}
            if request_group
            else {"field", "operator", "value"}
        )
        unknown_keys = sorted(set(raw_condition) - allowed_keys)
        if unknown_keys:
            raise DataProcessingRulesError(
                f"{condition_label} contains unsupported field(s): "
                + ", ".join(unknown_keys)
            )
        field_name = _required_text(
            raw_condition.get("field"),
            f"{condition_label}.field",
        )
        operator = _required_text(
            raw_condition.get("operator"),
            f"{condition_label}.operator",
        )
        allowed_operators = request_operators if request_group else row_operators
        if operator not in allowed_operators:
            raise DataProcessingRulesError(
                f"{condition_label}.operator [{operator}] is not supported."
            )

        level: Optional[int] = None
        if request_group:
            field_info = catalog.resolve_field(field_name)
            if field_info is None:
                raise DataProcessingRulesError(
                    f"{condition_label}.field [{field_name}] is not a mapped "
                    "reserving-class field."
                )
            level = _integer_level(
                raw_condition.get("level"),
                f"{condition_label}.level",
            )
            if level != field_info.level:
                raise DataProcessingRulesError(
                    f"{condition_label}.level must be {field_info.level} for "
                    f"field [{field_info.field}]."
                )
            field_name = field_info.field
        elif "level" in raw_condition and raw_condition.get("level") not in {None, ""}:
            raise DataProcessingRulesError(
                f"{condition_label}.level is only valid for request conditions."
            )

        value = raw_condition.get("value")
        if operator in {"is_blank", "is_not_blank"}:
            if "value" in raw_condition and value is not None:
                raise DataProcessingRulesError(
                    f"{condition_label}.value is not valid for operator [{operator}]."
                )
            value = None
        elif operator in {"in", "not_in"}:
            if not isinstance(value, list) or not value:
                raise DataProcessingRulesError(
                    f"{condition_label}.value must be a non-empty list for "
                    f"operator [{operator}]."
                )
            value = tuple(value)
        else:
            if "value" not in raw_condition or isinstance(value, (list, dict)):
                raise DataProcessingRulesError(
                    f"{condition_label}.value must be a scalar for operator [{operator}]."
                )

        if request_group:
            raw_values = value if isinstance(value, tuple) else (value,)
            resolved_values: List[str] = []
            for raw_value in raw_values:
                try:
                    resolved = catalog.resolve_type(field_name, level, raw_value)
                except ReservingClassConfigurationError as exc:
                    raise DataProcessingRulesError(
                        f"{condition_label} references an invalid reserving-class type: {exc}"
                    ) from exc
                resolved_values.append(resolved.name)
            value = tuple(resolved_values) if isinstance(value, tuple) else resolved_values[0]

        conditions.append(
            CompiledCondition(
                field=field_name,
                level=level,
                operator=operator,
                value=value,
            )
        )
    return tuple(conditions)


def _compile_action(
    raw_action: Any,
    *,
    label: str,
    catalog: ReservingClassCatalog,
) -> CompiledAction:
    if not isinstance(raw_action, dict):
        raise DataProcessingRulesError(f"{label} must be an object.")
    unknown_keys = sorted(set(raw_action) - {"type", "field", "level", "members"})
    if unknown_keys:
        raise DataProcessingRulesError(
            f"{label} contains unsupported field(s): " + ", ".join(unknown_keys)
        )
    action_type = _required_text(raw_action.get("type"), f"{label}.type")
    if action_type not in {"keep_members", "exclude_members"}:
        raise DataProcessingRulesError(
            f"{label}.type [{action_type}] is not supported."
        )
    field_name = _required_text(raw_action.get("field"), f"{label}.field")
    raw_members = raw_action.get("members")
    if not isinstance(raw_members, list) or not raw_members:
        raise DataProcessingRulesError(f"{label}.members must be a non-empty list.")

    members: List[Any] = []
    seen_members: set[Tuple[type, Any]] = set()
    for member in raw_members:
        if isinstance(member, (list, dict)) or member is None:
            raise DataProcessingRulesError(
                f"{label}.members values must be non-null JSON scalars."
            )
        try:
            member_key = (type(member), member)
            if member_key in seen_members:
                continue
            seen_members.add(member_key)
        except TypeError as exc:
            raise DataProcessingRulesError(
                f"{label}.members values must be JSON scalars."
            ) from exc
        members.append(member)

    field_info = catalog.resolve_field(field_name)
    if field_info is None:
        if "level" in raw_action and raw_action.get("level") not in {None, ""}:
            raise DataProcessingRulesError(
                f"{label}.level is only valid for mapped reserving-class fields."
            )
        return CompiledAction(
            type=action_type,
            field=field_name,
            members=tuple(members),
        )

    level = _integer_level(raw_action.get("level"), f"{label}.level")
    if level != field_info.level:
        raise DataProcessingRulesError(
            f"{label}.level must be {field_info.level} for field [{field_info.field}]."
        )

    resolved_members: List[str] = []
    for member in members:
        try:
            resolved = catalog.resolve_type(field_info.field, level, member)
        except ReservingClassConfigurationError as exc:
            raise DataProcessingRulesError(
                f"{label}.members contains an invalid reserving-class member: {exc}"
            ) from exc
        # Actions match the member's stored label literally, so both atomic raw
        # members and composite/intermediate labels (e.g. "PD+UMPD") are allowed:
        # some source measures are stored at an aggregate reserving-class label
        # rather than decomposed to atomic members.
        resolved_members.append(resolved.name)

    return CompiledAction(
        type=action_type,
        field=field_info.field,
        level=level,
        members=tuple(resolved_members),
        reserving_class_field=True,
    )


def compile_data_processing_rules(
    payload: Any,
    *,
    catalog: ReservingClassCatalog,
    field_mapping_payload: Any,
    dataset_types_payload: Any,
    source_columns: Optional[Iterable[str]] = None,
) -> CompiledRules:
    if payload is None:
        return CompiledRules(
            json_format=SUPPORTED_RULES_FORMAT,
            revision=0,
            rules=(),
        )
    if not isinstance(payload, dict):
        raise DataProcessingRulesError(
            "data_processing_rules.json must contain a JSON object."
        )
    unknown_top_level = sorted(
        set(payload)
        - {"json_format", "revision", "updated_at", "updated_by", "rules"}
    )
    if unknown_top_level:
        raise DataProcessingRulesError(
            "data_processing_rules.json contains unsupported field(s): "
            + ", ".join(unknown_top_level)
        )
    json_format = payload.get("json_format")
    if json_format != SUPPORTED_RULES_FORMAT:
        raise DataProcessingRulesError(
            f"data_processing_rules.json json_format must be "
            f"[{SUPPORTED_RULES_FORMAT}]."
        )
    revision = payload.get("revision")
    if isinstance(revision, bool) or not isinstance(revision, int) or revision < 0:
        raise DataProcessingRulesError(
            "data_processing_rules.json revision must be a non-negative integer."
        )
    for audit_field in ("updated_at", "updated_by"):
        if audit_field in payload and payload[audit_field] is not None and not isinstance(
            payload[audit_field],
            str,
        ):
            raise DataProcessingRulesError(
                f"data_processing_rules.json {audit_field} must be a string."
            )
    raw_rules = payload.get("rules")
    if not isinstance(raw_rules, list):
        raise DataProcessingRulesError(
            "data_processing_rules.json rules must be a list."
        )

    _all_fields, dataset_fields = _mapped_source_fields(field_mapping_payload)
    reachable_measures = _reachable_source_measures(
        dataset_types_payload,
        dataset_fields,
    )
    source_column_set = (
        {str(column) for column in source_columns}
        if source_columns is not None
        else None
    )

    rules: List[CompiledRule] = []
    seen_ids: set[str] = set()
    for rule_index, raw_rule in enumerate(raw_rules):
        label = f"data_processing_rules.json rules[{rule_index}]"
        if not isinstance(raw_rule, dict):
            raise DataProcessingRulesError(f"{label} must be an object.")
        unknown_rule_fields = sorted(
            set(raw_rule)
            - {
                "id",
                "name",
                "enabled",
                "target",
                "request_conditions",
                "row_conditions",
                "action",
            }
        )
        if unknown_rule_fields:
            raise DataProcessingRulesError(
                f"{label} contains unsupported field(s): "
                + ", ".join(unknown_rule_fields)
            )
        rule_id = _required_text(raw_rule.get("id"), f"{label}.id")
        rule_id_key = _canonical_name(rule_id)
        if rule_id_key in seen_ids:
            raise DataProcessingRulesError(f"Duplicate rule id [{rule_id}].")
        seen_ids.add(rule_id_key)
        name = _required_text(raw_rule.get("name"), f"{label}.name")
        enabled = raw_rule.get("enabled")
        if not isinstance(enabled, bool):
            raise DataProcessingRulesError(f"{label}.enabled must be a boolean.")

        target = raw_rule.get("target")
        if not isinstance(target, dict) or set(target) != {"source_measure"}:
            raise DataProcessingRulesError(
                f"{label}.target must contain only source_measure."
            )
        source_measure = _required_text(
            target.get("source_measure"),
            f"{label}.target.source_measure",
        )
        if source_measure not in dataset_fields:
            raise DataProcessingRulesError(
                f"{label}.target.source_measure [{source_measure}] is not a mapped "
                "Dataset source field."
            )
        if source_measure not in reachable_measures:
            raise DataProcessingRulesError(
                f"{label}.target.source_measure [{source_measure}] is not reachable "
                "from any Dataset Type Source."
            )
        if source_column_set is not None and source_measure not in source_column_set:
            raise DataProcessingRulesError(
                f"{label}.target.source_measure [{source_measure}] does not exist "
                "in the source table."
            )

        request_conditions = _condition_group(
            raw_rule.get("request_conditions"),
            label=f"{label}.request_conditions",
            request_group=True,
            catalog=catalog,
        )
        row_conditions = _condition_group(
            raw_rule.get("row_conditions"),
            label=f"{label}.row_conditions",
            request_group=False,
            catalog=catalog,
        )
        action = _compile_action(
            raw_rule.get("action"),
            label=f"{label}.action",
            catalog=catalog,
        )
        if source_column_set is not None:
            for condition in row_conditions:
                if condition.field not in source_column_set:
                    raise DataProcessingRulesError(
                        f"{label}.row_conditions field [{condition.field}] does not "
                        "exist in the source table."
                    )
            if action.field not in source_column_set:
                raise DataProcessingRulesError(
                    f"{label}.action.field [{action.field}] does not exist in the "
                    "source table."
                )
        rules.append(
            CompiledRule(
                id=rule_id,
                name=name,
                enabled=enabled,
                source_measure=source_measure,
                request_conditions=request_conditions,
                row_conditions=row_conditions,
                action=action,
            )
        )

    return CompiledRules(
        json_format=json_format,
        revision=revision,
        rules=tuple(rules),
    )


def resolve_request_path(
    catalog: ReservingClassCatalog,
    path: str | Sequence[str],
) -> Tuple[
    Dict[Tuple[str, int], str],
    Dict[str, Dict[str, int]],
]:
    if isinstance(path, str):
        path_parts = path.split("\\")
    else:
        path_parts = [str(item if item is not None else "") for item in path]
    if len(path_parts) > len(catalog.fields):
        extras = [part for part in path_parts[len(catalog.fields):] if str(part).strip()]
        if extras:
            raise ReservingClassConfigurationError(
                "Requested reserving-class path contains more levels than "
                "field_mapping.json."
            )
        path_parts = path_parts[:len(catalog.fields)]

    request_context: Dict[Tuple[str, int], str] = {}
    selected_coefficients: Dict[str, Dict[str, int]] = {}
    for field_info, raw_name in zip(catalog.fields, path_parts):
        selected_name = str(raw_name if raw_name is not None else "").strip()
        if not selected_name:
            continue
        resolved = catalog.resolve_type(
            field_info.field,
            field_info.level,
            selected_name,
        )
        request_context[(field_info.field, field_info.level)] = resolved.name
        selected_coefficients[field_info.field] = catalog.membership_coefficients_for(
            field_info.field,
            field_info.level,
            resolved.name,
        )
    return request_context, selected_coefficients


def request_conditions_match(
    conditions: Sequence[CompiledCondition],
    request_context: Mapping[Tuple[str, int], str],
) -> bool:
    for condition in conditions:
        selected = request_context.get((condition.field, int(condition.level or 0)))
        if selected is None:
            return False
        selected_key = _canonical_name(selected)
        if condition.operator == "equals":
            if selected_key != _canonical_name(condition.value):
                return False
        elif condition.operator == "not_equals":
            if selected_key == _canonical_name(condition.value):
                return False
        elif condition.operator == "in":
            allowed = {_canonical_name(value) for value in condition.value}
            if selected_key not in allowed:
                return False
        elif condition.operator == "not_in":
            excluded = {_canonical_name(value) for value in condition.value}
            if selected_key in excluded:
                return False
        else:
            raise DataProcessingRulesError(
                f"Unsupported request-condition operator [{condition.operator}]."
            )
    return True


def build_base_row_weights(
    source_rows: pd.DataFrame,
    selected_coefficients: Mapping[str, Mapping[str, int]],
) -> pd.Series:
    weights = pd.Series(1, index=source_rows.index, dtype="int64")
    for field_name, coefficients in selected_coefficients.items():
        if field_name not in source_rows.columns:
            raise DataProcessingRulesError(
                f"Source table does not contain selected reserving-class field "
                f"[{field_name}]."
            )
        series = source_rows[field_name]
        if pd.api.types.is_numeric_dtype(series.dtype):
            coefficient_names = list(coefficients)
            numeric_names = pd.to_numeric(
                pd.Series(coefficient_names, dtype="object"),
                errors="coerce",
            )
            if numeric_names.isna().any():
                raise DataProcessingRulesError(
                    f"Reserving-class Source members for numeric field "
                    f"[{field_name}] must be numeric."
                )
            numeric_coefficients = {
                numeric_name: coefficients[name]
                for name, numeric_name in zip(coefficient_names, numeric_names.tolist())
            }
            if len(numeric_coefficients) != len(coefficient_names):
                raise DataProcessingRulesError(
                    f"Reserving-class Source members for numeric field "
                    f"[{field_name}] are ambiguous after numeric conversion."
                )
            field_weights = series.map(numeric_coefficients).fillna(0)
        else:
            text_coefficients = {
                str(name): coefficient
                for name, coefficient in coefficients.items()
            }
            field_weights = series.astype("string").map(text_coefficients).fillna(0)
        weights = weights * field_weights.astype("int64")
    return weights


def _blank_mask(series: pd.Series) -> pd.Series:
    blank = series.isna()
    if pd.api.types.is_object_dtype(series.dtype) or pd.api.types.is_string_dtype(series.dtype):
        blank = blank | series.astype("string").str.strip().eq("").fillna(False)
    return blank.astype(bool)


def _membership_mask(series: pd.Series, values: Sequence[Any]) -> pd.Series:
    valid = ~_blank_mask(series)
    if pd.api.types.is_numeric_dtype(series.dtype):
        converted = pd.to_numeric(pd.Series(list(values)), errors="coerce")
        if converted.isna().any():
            raise DataProcessingRulesError(
                f"Condition values for numeric field [{series.name}] must be numeric."
            )
        return (valid & series.isin(converted.tolist())).astype(bool)
    if pd.api.types.is_datetime64_any_dtype(series.dtype):
        converted = pd.to_datetime(pd.Series(list(values)), errors="coerce")
        if converted.isna().any():
            raise DataProcessingRulesError(
                f"Condition values for date field [{series.name}] must be valid dates."
            )
        return (valid & series.isin(converted.tolist())).astype(bool)
    text_values = [str(value) for value in values]
    return (
        valid
        & series.astype("string").isin(text_values).fillna(False)
    ).astype(bool)


def _ordered_comparison_mask(
    series: pd.Series,
    operator: str,
    value: Any,
) -> pd.Series:
    valid = ~_blank_mask(series)
    comparable: pd.Series
    comparison_value: Any
    if pd.api.types.is_numeric_dtype(series.dtype):
        try:
            comparison_value = float(value)
        except (TypeError, ValueError) as exc:
            raise DataProcessingRulesError(
                f"Condition value for numeric field [{series.name}] must be numeric."
            ) from exc
        comparable = pd.to_numeric(series, errors="coerce")
    elif pd.api.types.is_datetime64_any_dtype(series.dtype):
        comparison_value = pd.to_datetime(value, errors="coerce")
        if pd.isna(comparison_value):
            raise DataProcessingRulesError(
                f"Condition value for date field [{series.name}] must be a valid date."
            )
        comparable = pd.to_datetime(series, errors="coerce")
    else:
        numeric_series = pd.to_numeric(series.where(valid), errors="coerce")
        if valid.any() and numeric_series[valid].notna().all():
            try:
                comparison_value = float(value)
            except (TypeError, ValueError) as exc:
                raise DataProcessingRulesError(
                    f"Condition value for numeric field [{series.name}] must be numeric."
                ) from exc
            comparable = numeric_series
        else:
            date_series = pd.to_datetime(series.where(valid), errors="coerce")
            comparison_value = pd.to_datetime(value, errors="coerce")
            if (
                pd.isna(comparison_value)
                or (valid.any() and not date_series[valid].notna().all())
            ):
                raise DataProcessingRulesError(
                    f"Ordered comparison [{operator}] is not compatible with "
                    f"source field [{series.name}]."
                )
            comparable = date_series

    if operator == "greater_than":
        result = comparable > comparison_value
    elif operator == "greater_than_or_equal":
        result = comparable >= comparison_value
    elif operator == "less_than":
        result = comparable < comparison_value
    elif operator == "less_than_or_equal":
        result = comparable <= comparison_value
    else:
        raise DataProcessingRulesError(
            f"Unsupported ordered-comparison operator [{operator}]."
        )
    return (valid & result.fillna(False)).astype(bool)


def evaluate_row_conditions(
    source_rows: pd.DataFrame,
    conditions: Sequence[CompiledCondition],
) -> pd.Series:
    result = pd.Series(True, index=source_rows.index, dtype=bool)
    for condition in conditions:
        if condition.field not in source_rows.columns:
            raise DataProcessingRulesError(
                f"Source table does not contain rule-condition field "
                f"[{condition.field}]."
            )
        series = source_rows[condition.field]
        if condition.operator == "is_blank":
            condition_result = _blank_mask(series)
        elif condition.operator == "is_not_blank":
            condition_result = ~_blank_mask(series)
        elif condition.operator == "equals":
            condition_result = _membership_mask(series, (condition.value,))
        elif condition.operator == "not_equals":
            valid = ~_blank_mask(series)
            condition_result = valid & ~_membership_mask(series, (condition.value,))
        elif condition.operator == "in":
            condition_result = _membership_mask(series, condition.value)
        elif condition.operator == "not_in":
            valid = ~_blank_mask(series)
            condition_result = valid & ~_membership_mask(series, condition.value)
        else:
            condition_result = _ordered_comparison_mask(
                series,
                condition.operator,
                condition.value,
            )
        result &= condition_result.astype(bool)
    return result


def build_weighted_source_frame(
    source_rows: pd.DataFrame,
    *,
    passthrough_columns: Sequence[str],
    source_measures: Sequence[str],
    selected_coefficients: Mapping[str, Mapping[str, int]],
    request_context: Mapping[Tuple[str, int], str],
    rules: Sequence[CompiledRule],
) -> pd.DataFrame:
    missing_columns = [
        column
        for column in list(passthrough_columns) + list(source_measures)
        if column and column not in source_rows.columns
    ]
    if missing_columns:
        raise DataProcessingRulesError(
            "Source table is missing required calculation column(s): "
            + ", ".join(dict.fromkeys(missing_columns))
        )

    base_weights = build_base_row_weights(source_rows, selected_coefficients)
    active = base_weights.ne(0)
    output_columns = list(
        dict.fromkeys(
            [column for column in passthrough_columns if column]
            + [column for column in source_measures if column]
        )
    )
    working = source_rows.loc[active, output_columns].copy()
    active_rows = source_rows.loc[active]
    active_weights = base_weights.loc[active]

    applicable_by_measure: Dict[str, List[CompiledRule]] = {}
    for rule in rules:
        if not rule.enabled or not request_conditions_match(
            rule.request_conditions,
            request_context,
        ):
            continue
        applicable_by_measure.setdefault(rule.source_measure, []).append(rule)

    for source_measure in source_measures:
        values = pd.to_numeric(active_rows[source_measure], errors="coerce")
        invalid_numeric = values.isna() & ~_blank_mask(active_rows[source_measure])
        if invalid_numeric.any():
            raise DataProcessingRulesError(
                f"Source measure [{source_measure}] contains non-numeric values."
            )
        values = values.fillna(0)
        custom_mask = pd.Series(True, index=active_rows.index, dtype=bool)
        for rule in applicable_by_measure.get(source_measure, []):
            if rule.action.field not in active_rows.columns:
                raise DataProcessingRulesError(
                    f"Rule [{rule.id}] action field [{rule.action.field}] is not "
                    "present in the source table."
                )
            if (
                rule.action.type == "keep_members"
                and rule.action.reserving_class_field
                and rule.action.field in selected_coefficients
            ):
                eligible_members = {
                    member
                    for member, coefficient in selected_coefficients[
                        rule.action.field
                    ].items()
                    if coefficient != 0
                }
                invalid_members = [
                    member
                    for member in rule.action.members
                    if member not in eligible_members
                ]
                if invalid_members:
                    raise DataProcessingRulesError(
                        f"Rule [{rule.id}] keep_members cannot add members excluded "
                        "by the selected normal reserving-class Source: "
                        + ", ".join(str(member) for member in invalid_members)
                    )

            condition_mask = evaluate_row_conditions(active_rows, rule.row_conditions)
            member_mask = _membership_mask(
                active_rows[rule.action.field],
                rule.action.members,
            )
            if rule.action.type == "keep_members":
                action_mask = member_mask
            elif rule.action.type == "exclude_members":
                action_mask = ~member_mask
            else:
                raise DataProcessingRulesError(
                    f"Rule [{rule.id}] has unsupported action [{rule.action.type}]."
                )
            custom_mask &= (~condition_mask) | action_mask

        working[source_measure] = (
            values
            * active_weights
            * custom_mask.astype("int8")
        )

    return working
