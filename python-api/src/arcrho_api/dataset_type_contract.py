"""Which rows of a project's dataset-types table ArcRho computes itself.

``dataset_types.json`` flags a type ``Calculated`` and gives it a ``Formula``
over other types, each quoted by name: ``"Net Loss--Paid" / "Claim
Counts--CWP"``. ArcRho rebuilds an instance of such a type from the instances
its formula names, so the instance is read-only in the app, is refreshed by
the dependent-propagation walk, and is hidden from the ResQ transfer review.

That is only possible when every type the formula names is in the table. A
formula naming a type the table lacks -- one ResQ holds and ArcRho never
imported, carried along when the type's formula was copied from ResQ -- can
never be evaluated, and a dataset it left read-only could neither be rebuilt
nor edited. Such a type is therefore not calculated at all: an instance of it
is a plain input holding whatever values it was given, with no formula, no
precedents, and no place in the dependent walk as a target. Only a quoted
name can be unresolved, because an unquoted reference is recognised only
when it matches a type already in the table.

The app server, the ResQ import, and the transfer review decide "calculated"
through :func:`is_app_calculated_dataset_type` and nowhere else.

Which types a formula *reads* is a separate question with a separate answer.
A generated type is calculated by the Engine rather than by ArcRho, but its
formula still names other types, and those names are the links a user sees, the
chain a source refresh follows, and the arrows the dependency graph draws. So
:func:`formula_references`, :func:`dataset_type_formula_graph` and
:func:`formula_closure` read every calculated row's formula, generated or not,
and every reader of a formula in the app goes through them.
"""

from __future__ import annotations

import re
from typing import Any, Iterable, Mapping, NamedTuple, Sequence

_QUOTED_NAME_RE = re.compile(r'"([^"]+)"')
_WHITESPACE_RE = re.compile(r"\s+")


def dataset_type_key(name: Any) -> str:
    """One comparison key for a type name: quotes and outer space dropped, inner runs of space collapsed, case ignored."""
    text = str(name if name is not None else "").strip().strip('"').strip("'").strip()
    return _WHITESPACE_RE.sub(" ", text).casefold()


def dataset_type_keys(rows: Iterable[Mapping[str, Any]]) -> frozenset[str]:
    """The keys of every named row, for :func:`is_app_calculated_dataset_type`."""
    return frozenset(key for key in (dataset_type_key(row.get("name")) for row in rows) if key)


def quoted_formula_names(formula: Any) -> list[str]:
    """The double-quoted type names a formula spells out, in order, once each."""
    out: list[str] = []
    seen: set[str] = set()
    for match in _QUOTED_NAME_RE.finditer(str(formula if formula is not None else "")):
        name = match.group(1).strip()
        key = dataset_type_key(name)
        if key and key not in seen:
            seen.add(key)
            out.append(name)
    return out


def formula_references(formula: Any, known_names: Iterable[Any]) -> list[str]:
    """The type names one formula reads, in the order the formula spells them.

    Every double-quoted name first, then every unquoted name the table already
    holds, longest first and each match taken off the text, so the type
    ``Premium`` is not also read out of the words ``Earned Premium``. Matching
    ignores case and outer space, a name is returned once however often it
    appears, and an unquoted word the table does not know is not a reference at
    all. A formula that mixes the two styles -- only a hand-edited one does,
    since ResQ quotes every name -- counts both.

    ``known_names`` are the table's names as it spells them; the returned names
    keep their spelling from the formula (quoted) or from the table (unquoted).
    """

    text = str(formula if formula is not None else "").strip()
    if not text:
        return []

    out: list[str] = []
    seen: set[str] = set()

    unquoted_parts: list[str] = []
    last = 0
    for match in _QUOTED_NAME_RE.finditer(text):
        name = match.group(1).strip()
        key = dataset_type_key(name)
        if key and key not in seen:
            seen.add(key)
            out.append(name)
        unquoted_parts.append(text[last:match.start()])
        unquoted_parts.append(" ")
        last = match.end()
    unquoted_parts.append(text[last:])
    unquoted_text = "".join(unquoted_parts)

    candidates = {str(name if name is not None else "").strip() for name in known_names}
    for name in sorted(candidates, key=lambda item: (-len(item), item)):
        key = dataset_type_key(name)
        if not key or key in seen:
            continue
        pattern = re.compile(rf"(?<![A-Za-z0-9_]){re.escape(name)}(?![A-Za-z0-9_])", flags=re.IGNORECASE)
        matched_text, hits = pattern.subn(lambda match: " " * (match.end() - match.start()), unquoted_text)
        if hits:
            unquoted_text = matched_text
            seen.add(key)
            out.append(name)
    return out


class DatasetTypeFormulaGraph(NamedTuple):
    """One project's logical formula graph, keyed by :func:`dataset_type_key`.

    ``names`` gives each key the spelling to show a user. ``precedents`` maps a
    calculated type to the types its formula reads, in formula order;
    ``dependents`` is the exact reverse, in table order. A type whose formula
    reads nothing is in neither map.
    """

    names: dict[str, str]
    precedents: dict[str, tuple[str, ...]]
    dependents: dict[str, tuple[str, ...]]


def dataset_type_formula_graph(rows: Iterable[Mapping[str, Any]]) -> DatasetTypeFormulaGraph:
    """The formula graph of a parsed dataset-types table, generated types included.

    Every row flagged calculated with a formula contributes its edges, whoever
    computes it: ArcRho evaluates an app-calculated type and the Engine builds a
    generated one, but both read the types their formula names.
    """

    table = [row for row in rows if dataset_type_key(row.get("name"))]
    names: dict[str, str] = {}
    for row in table:
        names.setdefault(dataset_type_key(row.get("name")), str(row.get("name")).strip())
    known_names = list(names.values())

    precedents: dict[str, tuple[str, ...]] = {}
    dependents: dict[str, list[str]] = {}
    for row in table:
        key = dataset_type_key(row.get("name"))
        formula = str(row.get("formula") if row.get("formula") is not None else "").strip()
        if not row.get("calculated") or not formula:
            continue
        edges: list[str] = []
        for name in formula_references(formula, known_names):
            component = dataset_type_key(name)
            if not component or component == key or component in edges:
                continue
            edges.append(component)
            names.setdefault(component, str(name).strip())
        if edges:
            precedents[key] = tuple(edges)
            for component in edges:
                dependents.setdefault(component, []).append(key)

    return DatasetTypeFormulaGraph(
        names=names,
        precedents=precedents,
        dependents={key: tuple(value) for key, value in dependents.items()},
    )


def formula_closure(
    rows: Iterable[Mapping[str, Any]],
    names: Sequence[Any],
    direction: str = "dependents",
) -> list[str]:
    """Every type reachable from ``names`` through formulas, breadth first.

    ``direction`` is ``"dependents"`` for the types a change to ``names`` feeds,
    or ``"precedents"`` for the types they read. The starting names are not in
    the result, and a formula cycle ends the walk rather than repeating it.
    """

    if direction not in ("precedents", "dependents"):
        raise ValueError(f"unknown direction: {direction}")
    graph = dataset_type_formula_graph(rows)
    edges = graph.precedents if direction == "precedents" else graph.dependents

    seen: set[str] = set()
    queue: list[str] = []
    for name in names:
        key = dataset_type_key(name)
        if key and key not in seen:
            seen.add(key)
            queue.append(key)

    out: list[str] = []
    while queue:
        for key in edges.get(queue.pop(0), ()):
            if key in seen:
                continue
            seen.add(key)
            out.append(key)
            queue.append(key)
    return out


def is_generated_formula_dataset_type(row: Mapping[str, Any]) -> bool:
    """True when the Engine builds this type from a formula over other types.

    Such a type is not the formula evaluator's -- the Engine rebuilds it from
    the source table -- but its formula still names other types, so it is both
    a reader of them and, for a refresh, something to rebuild when one of them
    changes.
    """
    formula = str(row.get("formula") if row.get("formula") is not None else "").strip()
    return bool(row.get("generated") and row.get("calculated") and formula)


def generated_formula_refresh_names(
    rows: Iterable[Mapping[str, Any]],
    names: Sequence[Any],
) -> list[str]:
    """``names`` plus every Engine-built formula type that reads them.

    This is the set a source refresh scoped to ``names`` has to rebuild. The
    walk is on types rather than instances and crosses every calculated type,
    so a type with no instance anywhere cannot hide a later generated formula
    whose source still uses one of ``names``; only the generated types it
    reaches are added, because those are the ones the Engine rebuilds. The
    given names keep their order and their spelling and come first. An empty
    request stays empty, since no scope already means every type.
    """

    table = list(rows)
    out: list[str] = []
    seen: set[str] = set()
    for name in names:
        text = str(name if name is not None else "").strip()
        key = dataset_type_key(text)
        if key and key not in seen:
            seen.add(key)
            out.append(text)
    if not out:
        return []

    graph = dataset_type_formula_graph(table)
    generated = {
        dataset_type_key(row.get("name"))
        for row in table
        if is_generated_formula_dataset_type(row)
    }
    for key in formula_closure(table, list(out), "dependents"):
        if key in generated and key not in seen:
            seen.add(key)
            out.append(graph.names.get(key, key))
    return out


def is_app_calculated_dataset_type(row: Mapping[str, Any], known_keys: Iterable[str]) -> bool:
    """True when ArcRho rebuilds instances of this type from its formula.

    ``row`` is one parsed table row (``name``, ``calculated``, ``generated``,
    ``formula``); ``known_keys`` is :func:`dataset_type_keys` of the whole
    table. Generated types are the Engine's, not the formula evaluator's.
    """
    formula = str(row.get("formula") if row.get("formula") is not None else "").strip()
    if not row.get("calculated") or row.get("generated") or not formula:
        return False
    keys = known_keys if isinstance(known_keys, (set, frozenset)) else frozenset(known_keys)
    return all(dataset_type_key(name) in keys for name in quoted_formula_names(formula))
