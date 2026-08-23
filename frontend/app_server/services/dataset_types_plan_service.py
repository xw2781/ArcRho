"""Plan one dataset-type change before anything on the server moves.

A change to the dataset-type table used to be applied by walking every sidecar
of every reserving class under a lock on the whole project, whether or not a
class held anything the change could touch. This module works out, without a
lock, which reserving classes a change actually reaches, so the user can see
that list before confirming and the job can hold only those classes.

The scan costs one ``index.json`` read per reserving class and opens no
sidecar: an index row already names each instance's dataset type and formula,
and the table alone says which types are neighbours of a changed one. The only
sidecars the planner opens are the few instances a rename would also rename,
to learn whether anything still reads them.

The same function runs twice on purpose. The app server (or the Gateway,
through the hosted read) runs it to build the plan the dialog shows, and the
Engine runs it again under the project lease and compares, so an edit made
while the dialog was open is caught rather than silently widening the lock.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Callable, Dict, List, NamedTuple, Set, Tuple

from fastapi import HTTPException

from app_server import config
from app_server.helpers import _canon_dataset_name, _parse_calculated_flag
from app_server.services import (
    dataset_instance_index_service,
    dataset_sidecar_status_service,
    dataset_types_service,
)

_INDEX_READ_EXECUTOR = ThreadPoolExecutor(
    max_workers=6,
    thread_name_prefix="arcrho-dataset-types-plan",
)

# The roles a dataset type can play in one change. An instance of a type in
# any of these roles has a sidecar the change rewrites: its own type name, its
# formula, or the precedents/dependents it derives from the table.
ROLE_RENAMED = "renamed"
ROLE_CHANGED = "changed"
ROLE_REMOVED = "removed"
ROLE_PRECEDENT = "precedent"
ROLE_DEPENDENT = "dependent"


class AffectedInstance(NamedTuple):
    """One index row the change reaches, with what the change does to it."""

    name: str
    dataset_type: str
    method_type: str
    new_dataset_type: str
    rename_to: str


class AffectedClass(NamedTuple):
    reserving_class: str
    instances: List[AffectedInstance]
    reason: str


class DatasetTypesChangePlan(NamedTuple):
    plan: Dict[str, Any]
    rows: List[List[Any]]
    renames: List[Dict[str, str]]
    rename_map: Dict[str, str]
    changed_types: List[str]
    removed_types: List[str]
    classes: List[AffectedClass]
    class_count: int


def _clean_text(value: Any) -> str:
    return str(value if value is not None else "").strip()


def _row_name(row: Any) -> str:
    return _clean_text(row[0]) if isinstance(row, (list, tuple)) and row else ""


def _row_formula(row: Any) -> str:
    return (
        _clean_text(row[4])
        if isinstance(row, (list, tuple)) and len(row) > 4
        else ""
    )


def _row_calculated(row: Any) -> bool:
    return (
        _parse_calculated_flag(row[3])
        if isinstance(row, (list, tuple)) and len(row) > 3
        else False
    )


def table_digest(rows: List[List[Any]]) -> str:
    """Identity of one table's graph-bearing content.

    Only the five submitted cells count: Source and Generated are derived from
    the field mapping at write time, so two tables that differ only there are
    the same table as far as a plan is concerned.
    """

    projected = [
        [
            _row_name(row),
            _clean_text(row[1]) if len(row) > 1 else "",
            _clean_text(row[2]) if len(row) > 2 else "",
            _row_calculated(row),
            _row_formula(row),
        ]
        for row in rows or []
        if isinstance(row, (list, tuple))
    ]
    text = json.dumps(projected, separators=(",", ":"), ensure_ascii=False)
    return "sha256:" + hashlib.sha256(text.encode("utf-8")).hexdigest()


# ---------------------------------------------------------------------------
# Renames
# ---------------------------------------------------------------------------


def rename_map(
    previous_rows: List[List[Any]],
    next_rows: List[List[Any]],
    renames: List[Dict[str, str]],
) -> Dict[str, str]:
    """``{old name key: new name}`` for the renames this change really makes.

    A rename is only a rename when the old name was in the table and is gone,
    and the new name was not and is there now. Anything else is refused: the
    grid that sent it disagrees with the file, and applying it would rewrite
    instances onto a type that does not exist.
    """

    previous_names = {
        _canon_dataset_name(name): name
        for name in (_row_name(row) for row in previous_rows or [])
        if _canon_dataset_name(name)
    }
    next_names = {
        _canon_dataset_name(name): name
        for name in (_row_name(row) for row in next_rows or [])
        if _canon_dataset_name(name)
    }
    mapping: Dict[str, str] = {}
    for entry in renames or []:
        source = _clean_text(entry.get("from"))
        target = _clean_text(entry.get("to"))
        source_key = _canon_dataset_name(source)
        target_key = _canon_dataset_name(target)
        if source_key not in previous_names or source_key in next_names:
            raise HTTPException(
                400,
                f"Cannot rename dataset type '{source}': it is not a type being "
                "replaced in this change.",
            )
        if target_key not in next_names or target_key in previous_names:
            raise HTTPException(
                400,
                f"Cannot rename dataset type '{source}' to '{target}': the new "
                "name is not a new type in this change.",
            )
        mapping[source_key] = next_names[target_key]
    return mapping


def _quoted_components(formula: str, known_names: List[str]) -> List[Tuple[int, int, str]]:
    """Every component occurrence in one formula as ``(start, end, name)``.

    Mirrors the tokenizer in ``dataset_types_service``: quoted names win when
    any quote is present, otherwise the longest known name at each position.
    """

    text = str(formula or "")
    quoted = [(m.start(), m.end(), m.group(1).strip()) for m in re.finditer(r'"([^"]+)"', text)]
    if quoted:
        return quoted
    unique_names = sorted(
        {n.strip() for n in known_names if n and n.strip()}, key=len, reverse=True
    )
    matches: List[Tuple[int, int, str]] = []
    for name in unique_names:
        pattern = re.compile(
            rf"(?<![A-Za-z0-9_]){re.escape(name)}(?![A-Za-z0-9_])", flags=re.IGNORECASE
        )
        matches.extend((m.start(), m.end(), name) for m in pattern.finditer(text))
    matches.sort(key=lambda item: (item[0], -(item[1] - item[0])))
    used: List[Tuple[int, int]] = []
    out: List[Tuple[int, int, str]] = []
    for start, end, name in matches:
        if any(start < ue and end > us for us, ue in used):
            continue
        used.append((start, end))
        out.append((start, end, name))
    out.sort(key=lambda item: item[0])
    return out


def rewrite_renamed_formulas(
    rows: List[List[Any]],
    mapping: Dict[str, str],
    known_names: List[str],
) -> List[List[Any]]:
    """Rewrite every formula component that names a renamed type.

    An unquoted formula is rewritten into the quoted form for all of its
    components, because the tokenizer reads a formula with any quote in it as
    entirely quoted; a half-quoted rewrite would lose the other components.
    """

    if not mapping:
        return [list(row) for row in rows or []]
    out: List[List[Any]] = []
    for row in rows or []:
        cells = list(row)
        formula = _row_formula(cells)
        if _row_calculated(cells) and formula:
            occurrences = _quoted_components(formula, known_names)
            if any(_canon_dataset_name(name) in mapping for _s, _e, name in occurrences):
                pieces: List[str] = []
                cursor = 0
                for start, end, name in occurrences:
                    pieces.append(formula[cursor:start])
                    pieces.append(f'"{mapping.get(_canon_dataset_name(name), name)}"')
                    cursor = end
                pieces.append(formula[cursor:])
                cells[4] = "".join(pieces)
        out.append(cells)
    return out


def previous_rows_as_renamed(
    previous_rows: List[List[Any]],
    mapping: Dict[str, str],
) -> List[List[Any]]:
    """The previous table with each renamed type already carrying its new name.

    Comparing the submitted table against this, rather than against the file,
    is what makes a pure rename read as "nothing changed" and a rename plus a
    new formula read as exactly that one formula change.
    """

    if not mapping:
        return [list(row) for row in previous_rows or []]
    old_names = [_row_name(row) for row in previous_rows or []]
    renamed_rows: List[List[Any]] = []
    for row in previous_rows or []:
        cells = list(row)
        key = _canon_dataset_name(_row_name(cells))
        if key in mapping:
            cells[0] = mapping[key]
        renamed_rows.append(cells)
    return rewrite_renamed_formulas(renamed_rows, mapping, old_names)


# ---------------------------------------------------------------------------
# Which types the change reaches
# ---------------------------------------------------------------------------


def _components_by_key(rows: List[List[Any]]) -> Dict[str, Set[str]]:
    known = [_row_name(row) for row in rows or []]
    out: Dict[str, Set[str]] = {}
    for row in rows or []:
        key = _canon_dataset_name(_row_name(row))
        if not key or not _row_calculated(row) or not _row_formula(row):
            continue
        out[key] = {
            component_key
            for component_key in (
                _canon_dataset_name(component)
                for component in dataset_types_service._extract_formula_components(
                    _row_formula(row), known
                )
            )
            if component_key
        }
    return out


def affected_type_roles(
    previous_renamed: List[List[Any]],
    next_rows: List[List[Any]],
    mapping: Dict[str, str],
) -> Dict[str, Set[str]]:
    """``{type name key: roles}`` for every type whose sidecars the change rewrites.

    Keys are the names instances carry *today*: a renamed type appears under
    its old name, since that is what its sidecars and index rows still say.
    """

    previous = dataset_types_service._graph_projection(previous_renamed)
    current = dataset_types_service._graph_projection(next_rows)
    previous_components = _components_by_key(previous_renamed)
    current_components = _components_by_key(next_rows)
    new_to_old = {_canon_dataset_name(new): old for old, new in mapping.items()}

    def today(key: str) -> str:
        return new_to_old.get(key, key)

    roles: Dict[str, Set[str]] = {}

    def add(key: str, role: str) -> None:
        if key:
            roles.setdefault(key, set()).add(role)

    touched: Set[str] = set()
    for key in set(previous) - set(current):
        add(today(key), ROLE_REMOVED)
        touched.add(key)
    for key in set(previous) & set(current):
        if previous[key] != current[key] or previous_components.get(key) != current_components.get(key):
            add(today(key), ROLE_CHANGED)
            touched.add(key)
    for old_key in mapping:
        add(old_key, ROLE_RENAMED)
        touched.add(_canon_dataset_name(mapping[old_key]))

    # Direct precedents, under both tables: their sidecars list the touched
    # type among their dependents, and that list is about to change.
    for key in list(touched):
        for component in previous_components.get(key, set()) | current_components.get(key, set()):
            add(today(component), ROLE_PRECEDENT)

    # Every type downstream of a touched one, under both tables, is rebuilt or
    # at least has its precedents re-derived.
    dependents_of: Dict[str, Set[str]] = {}
    for components in (previous_components, current_components):
        for key, sources in components.items():
            for source in sources:
                dependents_of.setdefault(source, set()).add(key)
    frontier = list(touched)
    seen: Set[str] = set()
    while frontier:
        key = frontier.pop()
        if key in seen:
            continue
        seen.add(key)
        for dependent in dependents_of.get(key, set()):
            if dependent not in touched:
                add(today(dependent), ROLE_DEPENDENT)
            if dependent not in seen:
                frontier.append(dependent)
    return roles


# ---------------------------------------------------------------------------
# Which reserving classes hold those types
# ---------------------------------------------------------------------------


def _list_reserving_classes(project_name: str) -> List[str]:
    try:
        data_dir = config.get_project_data_dir(project_name)
    except ValueError:
        return []
    if not os.path.isdir(data_dir):
        return []
    return sorted(
        (
            config.decode_filename_segment(entry.name)
            for entry in os.scandir(data_dir)
            if entry.is_dir()
        ),
        key=str.casefold,
    )


def _index_rows(project_name: str, reserving_class: str) -> List[Dict[str, Any]]:
    index = dataset_instance_index_service.get_index(project_name, reserving_class)
    return [row for row in (index.get("files") or []) if isinstance(row, dict)]


def _reads_nothing(project_name: str, reserving_class: str, dataset_name: str) -> bool:
    """Whether no dataset or method lists this instance among its inputs."""

    payload = dataset_sidecar_status_service.read_sidecar(
        dataset_sidecar_status_service.sidecar_path(project_name, reserving_class, dataset_name)
    )
    return not dataset_sidecar_status_service.entry_names(payload.get("dependents"))


def _affected_in_class(
    project_name: str,
    reserving_class: str,
    roles: Dict[str, Set[str]],
    mapping: Dict[str, str],
) -> AffectedClass | None:
    instances: List[AffectedInstance] = []
    role_counts: Dict[str, int] = {}
    for row in _index_rows(project_name, reserving_class):
        dataset_type = _clean_text(row.get("dataset_type"))
        type_key = _canon_dataset_name(dataset_type)
        if type_key not in roles:
            continue
        name = _clean_text(row.get("name"))
        method_type = dataset_sidecar_status_service.normalize_method_type(
            row.get("method_type"), row.get("source_kind")
        )
        new_type = mapping.get(type_key, dataset_type)
        rename_to = ""
        # An instance named after its type follows the type's new name, but
        # only a plain dataset nothing reads: a method output is named by its
        # method, and an input some object names would leave that object
        # pointing at a name that no longer exists.
        if (
            type_key in mapping
            and method_type == dataset_sidecar_status_service.METHOD_TYPE_NONE
            and _canon_dataset_name(name) == type_key
            and _reads_nothing(project_name, reserving_class, name)
        ):
            rename_to = new_type
        instances.append(AffectedInstance(name, dataset_type, method_type, new_type, rename_to))
        for role in roles[type_key]:
            role_counts[role] = role_counts.get(role, 0) + 1
    if not instances:
        return None
    return AffectedClass(reserving_class, instances, _describe_reason(role_counts))


def _describe_reason(role_counts: Dict[str, int]) -> str:
    labels = (
        (ROLE_RENAMED, "of a renamed type"),
        (ROLE_CHANGED, "of a changed type"),
        (ROLE_REMOVED, "of a removed type"),
        (ROLE_DEPENDENT, "downstream of the change"),
        (ROLE_PRECEDENT, "feeding a changed type"),
    )
    parts = [
        f"{role_counts[role]} {label}"
        for role, label in labels
        if role_counts.get(role)
    ]
    return "; ".join(parts)


def _plan_entry(project_name: str, affected: AffectedClass) -> Dict[str, Any]:
    return {
        "project": project_name,
        "reserving_class": affected.reserving_class,
        "instances": len(affected.instances),
        "adopting": sum(
            1 for item in affected.instances if item.new_dataset_type != item.dataset_type
        ),
        "renaming": sum(1 for item in affected.instances if item.rename_to),
        "reason": affected.reason,
    }


def plan_dataset_types_change(
    project_name: str,
    rows: Any,
    renames: Any,
    *,
    on_progress: Callable[[int, int, str], None] | None = None,
) -> DatasetTypesChangePlan:
    """Work out what one submitted table does to the project, without a lock.

    ``rows`` is the submitted table and ``renames`` the grid's ``[{from, to}]``
    list. The returned rows are the ones to write: formulas naming a renamed
    type already carry the new name.
    """

    project = _clean_text(project_name)
    previous_rows = dataset_types_service.read_persisted_rows(project)
    normalized = dataset_types_service.normalize_submitted_rows(rows)
    renames_list = [
        {"from": _clean_text(entry.get("from")), "to": _clean_text(entry.get("to"))}
        for entry in (renames or [])
        if isinstance(entry, dict)
    ]
    mapping = rename_map(previous_rows, normalized, renames_list)
    # The submitted formulas still spell the old names, so both name sets are
    # known while they are tokenized.
    next_rows = rewrite_renamed_formulas(
        normalized,
        mapping,
        [_row_name(row) for row in normalized] + [entry["from"] for entry in renames_list],
    )
    dataset_types_service.require_resolvable_formulas(next_rows)
    previous_renamed = previous_rows_as_renamed(previous_rows, mapping)
    resolved_next = dataset_types_service.resolve_persisted_rows(project, next_rows)
    roles = affected_type_roles(previous_renamed, resolved_next, mapping)

    from app_server.services import calculated_dataset_service

    changed_types = calculated_dataset_service.changed_formula_dataset_type_names(
        previous_renamed, resolved_next
    )
    removed_types = [
        _row_name(row)
        for row in previous_rows
        if ROLE_REMOVED in roles.get(_canon_dataset_name(_row_name(row)), set())
    ]

    reserving_classes = _list_reserving_classes(project)
    total = len(reserving_classes)
    classes: List[AffectedClass] = []
    if roles and reserving_classes:
        futures = [
            (
                reserving_class,
                _INDEX_READ_EXECUTOR.submit(
                    _affected_in_class, project, reserving_class, roles, mapping
                ),
            )
            for reserving_class in reserving_classes
        ]
        for scanned, (reserving_class, future) in enumerate(futures, start=1):
            affected = future.result()
            if affected is not None:
                classes.append(affected)
            if on_progress is not None:
                on_progress(scanned, total, reserving_class)

    return DatasetTypesChangePlan(
        plan={
            "table_digest": table_digest(previous_rows),
            "affected": [_plan_entry(project, affected) for affected in classes],
        },
        rows=next_rows,
        renames=renames_list,
        rename_map=mapping,
        changed_types=changed_types,
        removed_types=removed_types,
        classes=classes,
        class_count=total,
    )


def plan_dataset_types_change_read(
    project_name: str,
    rows: Any,
    renames: Any,
) -> Dict[str, Any]:
    """The hosted-read form of the planner: the plan plus the rows to submit."""

    planned = plan_dataset_types_change(project_name, rows, renames)
    return {
        "ok": True,
        "plan": planned.plan,
        "rows": planned.rows,
        "renames": planned.renames,
        "changed_types": planned.changed_types,
        "classes_total": planned.class_count,
    }
