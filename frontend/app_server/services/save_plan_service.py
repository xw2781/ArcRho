"""Step one of a two-step save: what would this save refresh?

An ArcRho save rewrites every dependent object it can reach, and until now the
user only learned which ones after the write had already landed. This module
answers the same question beforehand, reading only: it resolves the save's
propagation roots through the owning service, walks the two dependency graphs
a real walk follows, and returns the reachable objects plus a ``fingerprint``
of everything it read.

The fingerprint is the whole point of splitting the save. The reserving-class
lease cannot be held across a human pause — an open confirmation dialog would
block every other save in the class, and an abandoned one would keep blocking
until the lease went stale — so the plan takes no lease at all. Instead the
commit carries the reviewed fingerprint back, the Engine recomputes it under
the lease, and a class that moved in between is refused with 409 rather than
saved against a list the user never saw.

The list is deliberately a superset. Only the walk itself can tell whether an
intermediate method output actually changed (``_recalculate_dependents_impl``
prunes branches whose output did not move), so a plan names what the save can
reach, not what it will certainly rewrite.
"""

from __future__ import annotations

import hashlib
import importlib
import json
from typing import Any, Dict, List, Mapping, Sequence, Tuple

from fastapi import HTTPException

from arcrho_engine_save_contract import (
    SAVE_JOB_KINDS,
    SAVE_JOB_PLAN_ROOT_FUNCTION,
)

from app_server.helpers import _canon_dataset_name
from app_server.services import calculated_dataset_service
from app_server.services import dataset_sidecar_status_service

SAVE_PLAN_CONTRACT_VERSION = 1

CALCULATED_DATASET_KIND = "Calculated dataset"
DATASET_KIND = "Dataset"


def _clean(value: Any) -> str:
    return str(value if value is not None else "").strip()


def resolve_save_roots(
    save_kind: str,
    args: Sequence[Any],
    kwargs: Mapping[str, Any],
) -> List[Dict[str, str]]:
    """Ask the service that owns ``save_kind`` for the roots its save uses.

    The resolver always lives in the same module as the save function, so a
    plan cannot derive a root differently from the save it precedes.
    """

    kind = _clean(save_kind)
    if kind not in SAVE_JOB_KINDS:
        raise HTTPException(400, f"Unknown save kind: {kind}")
    module_name, _save_function = SAVE_JOB_KINDS[kind]
    module = importlib.import_module(f"app_server.services.{module_name}")
    resolver = getattr(module, SAVE_JOB_PLAN_ROOT_FUNCTION, None)
    if resolver is None:
        raise HTTPException(
            500, f"Save kind '{kind}' cannot report its dependent updates."
        )
    roots: List[Dict[str, str]] = []
    seen: set[str] = set()
    for pair in resolver(*args, **dict(kwargs or {})) or []:
        dataset_name, dataset_type = (list(pair) + ["", ""])[:2]
        key = _canon_dataset_name(dataset_name)
        if not key or key in seen:
            continue
        seen.add(key)
        roots.append(
            {"dataset_name": _clean(dataset_name), "dataset_type": _clean(dataset_type)}
        )
    return roots


def _root_names(roots: Sequence[Mapping[str, str]]) -> List[str]:
    # A walk seeds itself from both the instance name and the dataset type,
    # because either can be the name a formula or a sidecar edge refers to.
    names: List[str] = []
    seen: set[str] = set()
    for root in roots:
        for value in (root.get("dataset_name"), root.get("dataset_type")):
            name = _clean(value)
            key = _canon_dataset_name(name)
            if not key or key in seen:
                continue
            seen.add(key)
            names.append(name)
    return names


def _dependent_kind(entry: Mapping[str, Any]) -> str:
    method_type = _clean(entry.get("method_type"))
    if method_type and method_type != dataset_sidecar_status_service.METHOD_TYPE_NONE:
        return method_type
    if _clean(entry.get("source_kind")).casefold() == "calculated":
        return CALCULATED_DATASET_KIND
    return DATASET_KIND


def _fingerprint(payload: Mapping[str, Any]) -> str:
    # Hash the canonical projection, never the rendered text, so the digest
    # cannot shift with formatting.
    canonical = json.dumps(
        payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False, default=str
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def build_save_plan(
    save_kind: str,
    project_name: str,
    reserving_class: str,
    args: Sequence[Any],
    kwargs: Mapping[str, Any] | None = None,
) -> Dict[str, Any]:
    """Return the dependent objects one save can reach, and a graph fingerprint.

    Runs no save and takes no reserving-class lease. Two graphs contribute,
    and both are needed: the sidecar ``Dependents`` edges carry the methods,
    and the dataset-type formulas are the authority for calculated datasets —
    which is the graph the real walk consults, whether or not a sidecar edge
    happens to mirror it.
    """

    project = _clean(project_name)
    reserving = _clean(reserving_class)
    if not project or not reserving:
        raise HTTPException(
            400, "project_name and reserving_class are required to plan a save."
        )

    roots = resolve_save_roots(save_kind, args, kwargs or {})
    root_names = _root_names(roots)

    dependents: List[Dict[str, str]] = []
    listed: set[str] = {_canon_dataset_name(name) for name in root_names}

    for entry in dataset_sidecar_status_service.dependent_closure(
        project, reserving, root_names
    ):
        key = _canon_dataset_name(entry.get("dataset_name"))
        if not key or key in listed:
            continue
        listed.add(key)
        dependents.append(
            {"dataset_name": _clean(entry.get("dataset_name")), "kind": _dependent_kind(entry)}
        )

    for entry in calculated_dataset_service.existing_downstream_dataset_types(
        project, reserving, root_names
    ):
        key = _canon_dataset_name(entry.get("dataset_name"))
        if not key or key in listed:
            continue
        listed.add(key)
        dependents.append(
            {"dataset_name": _clean(entry.get("dataset_name")), "kind": CALCULATED_DATASET_KIND}
        )

    graph_state = {
        "dataset_types": calculated_dataset_service.dataset_type_graph_signature(project),
        "sidecars": dataset_sidecar_status_service.graph_signature(
            project,
            reserving,
            [*root_names, *(item["dataset_name"] for item in dependents)],
        ),
    }
    fingerprint = _fingerprint(
        {
            "contract_version": SAVE_PLAN_CONTRACT_VERSION,
            "save_kind": _clean(save_kind),
            "project_name": project,
            "reserving_class": reserving,
            "roots": sorted(_canon_dataset_name(name) for name in root_names),
            "dependents": sorted(
                _canon_dataset_name(item["dataset_name"]) for item in dependents
            ),
            "graph_state": graph_state,
        }
    )

    return {
        "ok": True,
        "contract_version": SAVE_PLAN_CONTRACT_VERSION,
        "save_kind": _clean(save_kind),
        "project_name": project,
        "reserving_class": reserving,
        "roots": roots,
        "dependents": dependents,
        "dependent_count": len(dependents),
        "fingerprint": fingerprint,
    }


def plan_fingerprint_matches(
    save_kind: str,
    project_name: str,
    reserving_class: str,
    args: Sequence[Any],
    kwargs: Mapping[str, Any] | None,
    expected_fingerprint: str,
) -> Tuple[bool, str]:
    """Recompute the plan and compare it with the fingerprint the user reviewed.

    The commit calls this while it holds the reserving-class lease, so a
    match means no other save can slip in between the check and the write.
    """

    expected = _clean(expected_fingerprint)
    if not expected:
        return True, ""
    current = build_save_plan(save_kind, project_name, reserving_class, args, kwargs)
    return current["fingerprint"] == expected, current["fingerprint"]
