"""The ordered closure one dependent walk refreshes.

This module answers two questions and writes nothing: *what* does a save
reach, and *in which order* must those objects be refreshed so each one is
built from final inputs. The pass that does the refreshing (and the domain
refreshers it calls) live elsewhere; keeping the traversal pure means it can
be replayed in a test without a project on disk.

Two edge sources are read, both of which the walk already reads today:

- each sidecar's persisted ``dependents`` list, through
  :func:`dataset_sidecar_status_service.entry_names`, and
- the dataset-type formula graph
  (:func:`calculated_dataset_service._dependency_map`) restricted to the
  instances that exist in this reserving class
  (:func:`calculated_dataset_service._existing_dataset_keys`, which is served
  from the walk-scoped snapshot while a walk is open).

The order is Kahn's algorithm over those edges: a node is ready once every
precedent of it *inside the closure* has been emitted, and ties are broken by
the order the node was first seen. Only links can make a cycle; a cycle is
broken by emitting its first-seen node once with whatever has been refreshed
by then, which is the same single visit the per-walk visited set gives today.
"""
from __future__ import annotations

import heapq
from dataclasses import dataclass, field
from typing import Any, Dict, Iterable, List, Mapping, Sequence, Set, Tuple

from app_server.helpers import _canon_dataset_name
from app_server.services import dataset_sidecar_status_service

KIND_DFM = "dfm"
KIND_RESULT_SELECTION = "result_selection"
KIND_BERQUIST_SHERMAN = "berquist_sherman"
KIND_BORNHUETTER_FERGUSON = "bornhuetter_ferguson"
KIND_CAPE_COD = "cape_cod"
KIND_BOOTSTRAP = "bootstrap"
KIND_CALCULATED = "calculated"
KIND_LINKED_INPUT = "linked_input"
KIND_INPUT = "input"

_KIND_BY_METHOD_TYPE = {
    dataset_sidecar_status_service.METHOD_TYPE_DFM: KIND_DFM,
    dataset_sidecar_status_service.METHOD_TYPE_RESULT_SELECTION: KIND_RESULT_SELECTION,
    dataset_sidecar_status_service.METHOD_TYPE_BORN_HUETTER_FERGUSON: KIND_BORNHUETTER_FERGUSON,
    dataset_sidecar_status_service.METHOD_TYPE_CAPE_COD: KIND_CAPE_COD,
    dataset_sidecar_status_service.METHOD_TYPE_BOOTSTRAP: KIND_BOOTSTRAP,
    dataset_sidecar_status_service.METHOD_TYPE_BERQUIST_SHERMAN_SR: KIND_BERQUIST_SHERMAN,
    dataset_sidecar_status_service.METHOD_TYPE_BERQUIST_SHERMAN_CRA: KIND_BERQUIST_SHERMAN,
}

# Worded as Result Selection's own cap is, because the pass takes that
# traversal over and a user must not see two names for one limit.
GRAPH_LIMIT_MESSAGE = "Dependency graph exceeds the safe refresh limit."


def _clean_text(value: Any) -> str:
    return str(value if value is not None else "").strip()


def _max_graph_nodes() -> int:
    """Result Selection owns the cap; read it late so nothing imports in a ring."""
    from app_server.services import result_selection_service

    return result_selection_service.MAX_REFRESH_GRAPH_NODES


@dataclass(frozen=True)
class WalkNode:
    """One object the walk crosses, with everything a refresher needs."""

    key: str
    name: str
    kind: str
    method_type: str
    precedents: Tuple[str, ...]
    is_root: bool


@dataclass(frozen=True)
class WalkClosure:
    """Every object a save reaches, in the order it must be refreshed."""

    nodes: Tuple[WalkNode, ...]
    names_by_key: Mapping[str, str] = field(default_factory=dict)

    @property
    def refresh_order(self) -> Tuple[WalkNode, ...]:
        """The nodes the pass refreshes: the closure without the saved roots."""
        return tuple(node for node in self.nodes if not node.is_root)

    def name_of(self, key: str) -> str:
        return self.names_by_key.get(key, key)


def _node_kind(sidecar: Mapping[str, Any], key: str, calculated_keys: Set[str]) -> Tuple[str, str]:
    method_type = dataset_sidecar_status_service.normalize_method_type(
        sidecar.get("method_type"),
        sidecar.get("source_kind"),
    )
    kind = _KIND_BY_METHOD_TYPE.get(method_type)
    if kind:
        return kind, method_type
    source_kind = _clean_text(sidecar.get("source_kind")).casefold()
    if source_kind == "input" and (sidecar.get("internal_links") or sidecar.get("formula_links")):
        return KIND_LINKED_INPUT, method_type
    if key in calculated_keys:
        return KIND_CALCULATED, method_type
    return KIND_INPUT, method_type


def _formula_graph_edges(
    project_name: str,
    reserving_class: str,
    dataset_type_rows: List[Dict[str, Any]] | None,
) -> Tuple[Dict[str, List[str]], Set[str]]:
    """Formula-graph dependents by key, restricted to instances that exist here."""
    from app_server.services import calculated_dataset_service

    rows = (
        dataset_type_rows
        if dataset_type_rows is not None
        else calculated_dataset_service._dataset_type_rows(project_name)
    )
    dependency_map = calculated_dataset_service._dependency_map(project_name, rows)
    calculated_keys = {
        _canon_dataset_name(row.get("name"))
        for row in calculated_dataset_service._app_calculated_rows(rows)
        if _canon_dataset_name(row.get("name"))
    }
    if not dependency_map:
        return {}, calculated_keys
    existing_keys = calculated_dataset_service._existing_dataset_keys(project_name, reserving_class)
    names_by_key = {
        _canon_dataset_name(row.get("name")): _clean_text(row.get("name"))
        for row in rows
        if _canon_dataset_name(row.get("name"))
    }
    edges: Dict[str, List[str]] = {}
    for source_key, target_keys in dependency_map.items():
        targets = [
            names_by_key.get(target_key, target_key)
            for target_key in sorted(target_keys)
            if target_key in existing_keys
        ]
        if targets:
            edges[source_key] = targets
    return edges, calculated_keys


def ordered_closure(
    project_name: str,
    reserving_class: str,
    root_names: Iterable[str],
    *,
    sidecar_snapshot: Dict[str, Dict[str, Any]] | None = None,
    dataset_type_rows: List[Dict[str, Any]] | None = None,
) -> WalkClosure:
    """Name every object the roots reach and order it after its precedents.

    ``sidecar_snapshot`` is a walk-scoped cache keyed by canonical dataset
    name; pass the same dict the pass uses so each sidecar is read once. A
    missing sidecar on anything but a root is an error, as it is today.
    """

    snapshot = sidecar_snapshot if sidecar_snapshot is not None else {}
    formula_edges, calculated_keys = _formula_graph_edges(
        project_name, reserving_class, dataset_type_rows
    )

    roots: List[str] = []
    root_keys: Set[str] = set()
    for raw in root_names or []:
        name = _clean_text(raw)
        key = _canon_dataset_name(name)
        if not key or key in root_keys:
            continue
        root_keys.add(key)
        roots.append(name)

    names_by_key: Dict[str, str] = {}
    kinds: Dict[str, Tuple[str, str]] = {}
    dependents: Dict[str, List[str]] = {}
    queue = list(roots)
    while queue:
        frontier: List[str] = []
        seen_frontier: Set[str] = set()
        for name in queue:
            key = _canon_dataset_name(name)
            if not key or key in dependents or key in seen_frontier:
                continue
            seen_frontier.add(key)
            frontier.append(name)
        queue = []
        if not frontier:
            break
        if len(dependents) + len(frontier) > _max_graph_nodes():
            raise RuntimeError(GRAPH_LIMIT_MESSAGE)
        sidecars = _read_sidecars_cached(project_name, reserving_class, frontier, snapshot)
        for name in frontier:
            key = _canon_dataset_name(name)
            names_by_key.setdefault(key, name)
            sidecar = sidecars.get(key) or {}
            if not sidecar and key not in root_keys:
                raise RuntimeError(f"Dependency graph sidecar is missing for '{name}'.")
            kinds[key] = _node_kind(sidecar, key, calculated_keys)
            edges: List[str] = []
            edge_keys: Set[str] = set()
            for dependent_name in [
                *dataset_sidecar_status_service.entry_names(sidecar.get("dependents")),
                *formula_edges.get(key, []),
            ]:
                dependent_key = _canon_dataset_name(dependent_name)
                if not dependent_key or dependent_key in edge_keys:
                    continue
                edge_keys.add(dependent_key)
                names_by_key.setdefault(dependent_key, _clean_text(dependent_name))
                edges.append(dependent_key)
                if dependent_key not in dependents:
                    queue.append(dependent_name)
            dependents[key] = edges

    return _ordered_nodes(dependents, names_by_key, kinds, root_keys)


def _read_sidecars_cached(
    project_name: str,
    reserving_class: str,
    names: Sequence[str],
    snapshot: Dict[str, Dict[str, Any]],
) -> Dict[str, Dict[str, Any]]:
    missing = [name for name in names if _canon_dataset_name(name) not in snapshot]
    if missing:
        loaded = dataset_sidecar_status_service.read_sidecars(project_name, reserving_class, missing)
        for name in missing:
            key = _canon_dataset_name(name)
            snapshot[key] = loaded.get(key) or {}
    return {_canon_dataset_name(name): snapshot.get(_canon_dataset_name(name), {}) for name in names}


def _ordered_nodes(
    dependents: Dict[str, List[str]],
    names_by_key: Dict[str, str],
    kinds: Dict[str, Tuple[str, str]],
    root_keys: Set[str],
) -> WalkClosure:
    keys_in_order = list(dependents)
    index_by_key = {key: index for index, key in enumerate(keys_in_order)}
    precedents: Dict[str, List[str]] = {key: [] for key in keys_in_order}
    waiting: Dict[str, Set[str]] = {key: set() for key in keys_in_order}
    for key in keys_in_order:
        for dependent_key in dependents[key]:
            precedents[dependent_key].append(key)
            waiting[dependent_key].add(key)

    ready = [index_by_key[key] for key in keys_in_order if not waiting[key]]
    heapq.heapify(ready)
    emitted: Set[str] = set()
    ordered: List[str] = []
    while len(ordered) < len(keys_in_order):
        key = ""
        while ready:
            candidate = keys_in_order[heapq.heappop(ready)]
            if candidate not in emitted:
                key = candidate
                break
        if not key:
            # Only a link can close a ring. Break it on its first-seen node,
            # which is refreshed once from what is final so far.
            key = next(item for item in keys_in_order if item not in emitted)
        emitted.add(key)
        ordered.append(key)
        for dependent_key in dependents[key]:
            waiting[dependent_key].discard(key)
            if not waiting[dependent_key] and dependent_key not in emitted:
                heapq.heappush(ready, index_by_key[dependent_key])

    nodes = tuple(
        WalkNode(
            key=key,
            name=names_by_key.get(key, key),
            kind=kinds.get(key, (KIND_INPUT, dataset_sidecar_status_service.METHOD_TYPE_NONE))[0],
            method_type=kinds.get(key, (KIND_INPUT, dataset_sidecar_status_service.METHOD_TYPE_NONE))[1],
            precedents=tuple(precedents[key]),
            is_root=key in root_keys,
        )
        for key in ordered
    )
    return WalkClosure(nodes=nodes, names_by_key=dict(names_by_key))
