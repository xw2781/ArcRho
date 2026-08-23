"""Public-API propagation for canonical self-contained DFM dependents."""

from __future__ import annotations

import json
import os
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any, Iterable

from .dfm_contract import DFM_JSON_FORMAT, recalculate_dfm_method
from .sidecar_core_contract import dependency_entries
from .io import persisted_json_text
from .sidecar_core_contract import with_audit_log_last
from .paths import clean_text, sanitize_file_name_part

if TYPE_CHECKING:
    from .reserving_class import ReservingClass


@dataclass(frozen=True)
class DfmPropagationResult:
    refreshed_outputs: tuple[str, ...] = ()
    warnings: tuple[str, ...] = ()


def _key(value: Any) -> str:
    return clean_text(value).casefold()


def _read_json(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8") as handle:
        payload = json.load(handle)
    if not isinstance(payload, dict):
        raise ValueError(f"Sidecar must contain a JSON object: {path.name}")
    return payload


def _sidecar_path(sidecar_dir: Path, dataset_name: str) -> Path:
    return sidecar_dir / f"{sanitize_file_name_part(dataset_name, 'Dataset')}.json"


def _mark_review_needed(path: Path) -> None:
    payload = _read_json(path)
    if payload.get("status") == 2:
        return
    payload["status"] = 2
    encoded = persisted_json_text(with_audit_log_last(payload)).encode("utf-8")
    temporary = path.with_name(f"{path.name}.{uuid.uuid4().hex}.tmp")
    try:
        temporary.write_bytes(encoded)
        os.replace(temporary, path)
    finally:
        try:
            temporary.unlink(missing_ok=True)
        except OSError:
            pass


def _is_dfm_sidecar(payload: dict[str, Any]) -> bool:
    return _key(payload.get("method_type")) == "dfm" or _key(payload.get("source_kind")) == "dfm"


def refresh_dfm_dependents(
    reserving_class: "ReservingClass",
    updated_dataset: str,
) -> DfmPropagationResult:
    return refresh_dfm_dependents_for_sources(reserving_class, (updated_dataset,))


def refresh_dfm_dependents_for_sources(
    reserving_class: "ReservingClass",
    updated_datasets: Iterable[Any],
) -> DfmPropagationResult:
    """Refresh direct/transitive DFM branches; isolate failures and preserve publications.

    This in-process walk runs on the server host (migration, Bridge import,
    public API scripts), so it must hold the same reserving-class lease that
    Engine dependent-propagation jobs use; a walk and an Engine job never
    interleave on one class. Client processes enqueue an Engine job instead.
    """

    from arcrho_dependent_propagation_contract import held_reserving_class_lease

    with held_reserving_class_lease(
        reserving_class.project.client.server_root,
        reserving_class.project.name,
        reserving_class.path,
    ):
        return _refresh_dfm_dependents_for_sources_locked(
            reserving_class, updated_datasets
        )


def _refresh_dfm_dependents_for_sources_locked(
    reserving_class: "ReservingClass",
    updated_datasets: Iterable[Any],
) -> DfmPropagationResult:
    sidecar_dir = reserving_class.data_dir / "sidecars"
    frontier: list[tuple[str, bool, str]] = []
    queued_roots: set[str] = set()
    for raw_name in updated_datasets:
        name = clean_text(raw_name)
        key = _key(name)
        if name and key not in queued_roots:
            queued_roots.add(key)
            frontier.append((name, False, "root"))
    processed_edges: set[tuple[str, str, str, bool]] = set()
    refreshed_keys: set[str] = set()
    refreshed: list[str] = []
    warnings: list[str] = []
    while frontier:
        targets: dict[str, dict[str, Any]] = {}
        for source_name, blocked, event_token in frontier:
            source_path = _sidecar_path(sidecar_dir, source_name)
            try:
                source_sidecar = _read_json(source_path)
            except Exception as exc:
                warnings.append(f"Could not inspect dependents of '{source_name}': {exc}")
                continue
            dependent_names = [
                entry["dataset_name"]
                for entry in dependency_entries(source_sidecar.get("dependents"))
            ]
            for output_name in dependent_names:
                output_key = _key(output_name)
                edge = (_key(source_name), event_token, output_key, blocked)
                if not output_key or edge in processed_edges:
                    continue
                processed_edges.add(edge)
                target = targets.setdefault(
                    output_key,
                    {"output_name": output_name, "sources": [], "blocked": False},
                )
                target["sources"].append(source_name)
                target["blocked"] = bool(target["blocked"] or blocked)

        next_frontier: list[tuple[str, bool, str]] = []
        for target in targets.values():
            output_name = target["output_name"]
            output_key = _key(output_name)
            source_names = tuple(dict.fromkeys(target["sources"]))
            blocked = bool(target["blocked"])
            output_path = _sidecar_path(sidecar_dir, output_name)
            try:
                output_sidecar = _read_json(output_path)
            except Exception as exc:
                warnings.append(f"Could not inspect dependent '{output_name}': {exc}")
                continue
            if blocked:
                try:
                    _mark_review_needed(output_path)
                except Exception as exc:
                    warnings.append(f"Blocked dependent '{output_name}' could not be marked Review Needed: {exc}")
                else:
                    warnings.append(f"Blocked dependent '{output_name}' was marked Review Needed.")
                next_frontier.append((output_name, True, "blocked"))
                continue
            if not _is_dfm_sidecar(output_sidecar):
                try:
                    _mark_review_needed(output_path)
                except Exception as exc:
                    warnings.append(f"Non-DFM dependent '{output_name}' could not be marked Review Needed: {exc}")
                warnings.append(
                    f"Public API propagation stopped at non-DFM dependent '{output_name}'; "
                    "calculated-dataset and RS cascade requires the app server."
                )
                next_frontier.append((output_name, True, "blocked"))
                continue
            method_name = clean_text(output_sidecar.get("method_name"))
            try:
                if not method_name:
                    raise ValueError("DFM output sidecar does not identify its method")
                method = reserving_class.dfm(method_name)
                if method.payload.get("json_format") != DFM_JSON_FORMAT:
                    raise ValueError("automatic propagation requires a canonical DFM v2 method")
                input_name = clean_text(method.details.get("input_triangle"))
                basis_name = clean_text(method.results_tab.get("ratio_basis_dataset"))
                input_key = _key(input_name)
                basis_key = _key(basis_name)
                source_keys = {_key(source_name) for source_name in source_names}
                matches_input = input_key in source_keys
                matches_basis = bool(basis_key) and basis_key in source_keys
                if any(key not in {input_key, basis_key} for key in source_keys):
                    raise ValueError("dependency graph does not match the DFM precedent identities")
                old_publication = clean_text(method.metadata.get("publication_revision"))
                input_snapshot = method._source_snapshot(input_name, vector=False) if matches_input else None
                embedded_origins = [str(item) for item in method.data_tab.get("origin_labels", [])]
                refreshed_origins = [
                    str(item)
                    for item in (input_snapshot or {}).get("origin_labels", [])
                ]
                basis_needs_realign = bool(
                    matches_input and basis_name and refreshed_origins != embedded_origins
                )
                basis_snapshot = (
                    method._source_snapshot(basis_name, vector=True)
                    if basis_name and (matches_basis or basis_needs_realign)
                    else None
                )
                method.payload = recalculate_dfm_method(
                    method.payload,
                    input_snapshot=input_snapshot,
                    ratio_basis_snapshot=basis_snapshot,
                    changed_precedents=source_names,
                )
                output_changed = clean_text(method.metadata.get("publication_revision")) != old_publication
                method.save(automatic=True, output_changed=output_changed)
                if output_key not in refreshed_keys:
                    refreshed_keys.add(output_key)
                    refreshed.append(output_name)
                if output_changed:
                    publication_revision = clean_text(method.metadata.get("publication_revision"))
                    next_frontier.append(
                        (output_name, False, f"publication:{publication_revision}")
                    )
            except Exception as exc:
                try:
                    _mark_review_needed(output_path)
                except Exception as status_exc:
                    warnings.append(
                        f"DFM '{method_name or output_name}' refresh failed ({exc}); "
                        f"Review Needed status could not be written ({status_exc})."
                    )
                else:
                    warnings.append(
                        f"DFM '{method_name or output_name}' refresh failed and was marked Review Needed: {exc}"
                    )
                next_frontier.append((output_name, True, "blocked"))
        frontier = next_frontier
    return DfmPropagationResult(tuple(refreshed), tuple(warnings))


__all__ = [
    "DfmPropagationResult",
    "refresh_dfm_dependents",
    "refresh_dfm_dependents_for_sources",
]
