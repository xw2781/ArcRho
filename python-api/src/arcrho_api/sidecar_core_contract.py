"""The one schema every dataset sidecar shares, and the check that enforces it.

A dataset sidecar and a method-output sidecar are one schema, not two. A
method opened in a Dataset Viewer window shows only its output triangle or
vector, read from the sidecar and CSV like any other dataset, so both must
carry the same core: identity, formatting, status, the dependency graph, and
the ``audit_log`` as the last field. A method-output sidecar adds only
``method_name``, ``method_type``, ``source_kind``, ``calculated`` and
``publication_revision`` on top; nothing in the core may differ between the
two kinds.

Every sidecar builder -- the engine contract and the four method-output
contracts -- runs its payload through :func:`validate_sidecar_core` before
returning it, and every app-server write funnel runs the payload it is about
to serialize through :func:`with_audit_log_last`, so the invariant is enforced
where the bytes are produced rather than remembered at each call site.

Axis labels and notes are not part of the required core on purpose: an engine
sidecar derives its labels from the project header when the CSV is loaded and
has no notes until someone writes them, so requiring either would make that
builder invent values. When present they are checked for shape.
"""

from __future__ import annotations

from typing import Any, Mapping

from .sidecar_audit_contract import normalize_audit_log


class SidecarContractError(ValueError):
    """Raised when a sidecar payload does not satisfy the shared core."""


SIDECAR_AUDIT_LOG_FIELD = "audit_log"
SIDECAR_PRECEDENTS_FIELD = "Precedents"
SIDECAR_DEPENDENTS_FIELD = "Dependents"

# Fields every sidecar carries, whatever produced it.
SIDECAR_CORE_FIELDS: tuple[str, ...] = (
    "dataset_name",
    "dataset_type",
    "reserving_class",
    "project_name",
    "source_kind",
    "calculated",
    "data_format",
    "method_type",
    "status",
    "number_format",
    "decimal_places",
    "show_subtotal",
    "csv_file",
    "created",
    "updated_at",
    "modified_by",
    SIDECAR_PRECEDENTS_FIELD,
    SIDECAR_DEPENDENTS_FIELD,
    SIDECAR_AUDIT_LOG_FIELD,
)

# Fields only a method-output sidecar adds on top of the core.
METHOD_OUTPUT_SIDECAR_FIELDS: tuple[str, ...] = (
    "method_name",
    "publication_revision",
)

# Optional core fields that, when present, must have this shape.
_LIST_FIELDS = ("origin_labels", "development_labels")


def with_audit_log_last(payload: Mapping[str, Any]) -> dict[str, Any]:
    """Return *payload* with a normalized ``audit_log`` as its last field.

    This is the projection every write funnel applies. Key order otherwise
    follows the payload, so a writer that already builds the canonical order
    is untouched and one that merged an older file gets the log moved to the
    end instead of wherever the old file kept it.
    """

    ordered = {key: value for key, value in payload.items() if key != SIDECAR_AUDIT_LOG_FIELD}
    ordered[SIDECAR_AUDIT_LOG_FIELD] = normalize_audit_log(payload.get(SIDECAR_AUDIT_LOG_FIELD))
    return ordered


def validate_sidecar_core(payload: Mapping[str, Any]) -> dict[str, Any]:
    """Assert the shared core of a complete sidecar payload and return it.

    Raises :class:`SidecarContractError` naming the first violation. The
    payload is returned unchanged so a builder can ``return
    validate_sidecar_core(payload)``.
    """

    if not isinstance(payload, Mapping):
        raise SidecarContractError("A sidecar payload must be a JSON object.")
    missing = [field for field in SIDECAR_CORE_FIELDS if field not in payload]
    if missing:
        raise SidecarContractError("Sidecar is missing core fields: " + ", ".join(missing))
    keys = list(payload.keys())
    if keys[-1] != SIDECAR_AUDIT_LOG_FIELD:
        raise SidecarContractError(
            f"Sidecar {SIDECAR_AUDIT_LOG_FIELD} must be the last field; found {keys[-1]!r}."
        )
    for field in (SIDECAR_PRECEDENTS_FIELD, SIDECAR_DEPENDENTS_FIELD, SIDECAR_AUDIT_LOG_FIELD, *_LIST_FIELDS):
        if field in payload and not isinstance(payload[field], list):
            raise SidecarContractError(f"Sidecar {field} must be a list.")
    audit_log = payload[SIDECAR_AUDIT_LOG_FIELD]
    if normalize_audit_log(audit_log) != audit_log:
        raise SidecarContractError("Sidecar audit_log is not in the canonical policy form.")
    if not isinstance(payload["calculated"], bool):
        raise SidecarContractError("Sidecar calculated must be a boolean.")
    present_method_fields = [field for field in METHOD_OUTPUT_SIDECAR_FIELDS if field in payload]
    if present_method_fields and len(present_method_fields) != len(METHOD_OUTPUT_SIDECAR_FIELDS):
        raise SidecarContractError(
            "A method-output sidecar carries all of: " + ", ".join(METHOD_OUTPUT_SIDECAR_FIELDS)
        )
    if present_method_fields and payload["calculated"] is not True:
        raise SidecarContractError("A method-output sidecar is always calculated.")
    return dict(payload)


__all__ = [
    "METHOD_OUTPUT_SIDECAR_FIELDS",
    "SIDECAR_AUDIT_LOG_FIELD",
    "SIDECAR_CORE_FIELDS",
    "SIDECAR_DEPENDENTS_FIELD",
    "SIDECAR_PRECEDENTS_FIELD",
    "SidecarContractError",
    "validate_sidecar_core",
    "with_audit_log_last",
]
