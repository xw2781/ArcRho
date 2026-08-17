"""Contract for ArcRho Server-hosted workspace mutations.

``arcrho_workspace_read_contract`` hosts reads, whose defining property is that
they are pure functions of the workspace: an uncertain answer may simply be
asked again, or answered locally instead. A mutation cannot borrow that
reasoning, so it gets its own registry and its own route rather than being
smuggled into the read table.

Only allowlisted kinds may execute remotely, and every registered kind must be
**idempotent**: running it twice against the same workspace must leave the same
end state as running it once. That is what lets this transport, like the read
one, keep no durable receipt — an answer the client never saw is either already
applied or safe to ask for again. A mutation that cannot make that promise
belongs on the hosted-save path (``arcrho_hosted_save_http_contract``), which
buys durability with a request file, an Engine claim, and a receipt.

What the client may *not* do is fall back to its own mapped drive after the
server may already have acted. Reads fall back freely; a mutation whose outcome
is unknown must be reported, not repeated somewhere else, because the second
run would answer about a workspace the first one already changed.

Mutations run under the submitting user's identity so the audit trail, sidecar
stamps, and log lines name the person who asked rather than the Gateway's
service profile.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Mapping

from arcrho_dependent_propagation_contract import (
    DependentPropagationContractError,
    validate_project_name,
    validate_request_id,
    validate_reserving_class_path,
)


WORKSPACE_MUTATION_FUNCTION = "ArcRhoWorkspaceMutation"
WORKSPACE_MUTATION_CONTRACT_VERSION = 1
WORKSPACE_MUTATION_PATH = "/api/workspace-mutations"
WORKSPACE_MUTATION_CAPABILITY_FIELD = "workspace_mutation_kinds"
# A mutation removes or rewrites files in one reserving class and rebuilds that
# class's index; it never waits on the Engine, so it needs no save-sized budget.
WORKSPACE_MUTATION_TIMEOUT_SECONDS = 180.0
MAX_WORKSPACE_MUTATION_REQUEST_BYTES = 256 * 1024


class WorkspaceMutationContractError(ValueError):
    """Raised when a workspace-mutation payload violates this contract."""


@dataclass(frozen=True)
class WorkspaceMutationKind:
    """One remotely executable, idempotent ``app_server.services`` mutation."""

    module: str
    function: str
    required: tuple[str, ...]
    optional: tuple[str, ...] = ()
    # Arguments whose value is a list of names rather than a single string.
    # Named here so validation checks the right shape instead of coercing a
    # list to ``str`` and silently accepting "['a', 'b']" as one dataset.
    list_args: tuple[str, ...] = field(default_factory=tuple)

    @property
    def allowed(self) -> frozenset[str]:
        return frozenset(self.required + self.optional)


# kind -> canonical service mutation. The Gateway resolves mutations only
# through this table; a request naming anything else, or passing an argument
# not listed here, is rejected before any import happens.
WORKSPACE_MUTATION_KINDS: dict[str, WorkspaceMutationKind] = {
    # Deleting a cached dataset removes its files and rebuilds the reserving
    # class index. It is idempotent because a file that is already gone is
    # skipped rather than failed, and the rebuild derives the index from
    # whatever survives; a repeat therefore reports "nothing matched" against
    # an end state identical to the first run's.
    "cached_dataset_delete": WorkspaceMutationKind(
        "dataset_service",
        "delete_cached_datasets",
        ("project_name", "reserving_class", "dataset_names"),
        list_args=("dataset_names",),
    ),
}

HTTP_WORKSPACE_MUTATION_KINDS: tuple[str, ...] = tuple(sorted(WORKSPACE_MUTATION_KINDS))


def build_workspace_mutation_request(
    *,
    request_id: str,
    mutation_kind: str,
    kwargs: Mapping[str, Any],
    user_name: str,
    user_display_name: str = "",
) -> dict[str, Any]:
    return validate_workspace_mutation_request(
        {
            "Function": WORKSPACE_MUTATION_FUNCTION,
            "ContractVersion": WORKSPACE_MUTATION_CONTRACT_VERSION,
            "RequestId": request_id,
            "MutationKind": mutation_kind,
            "Kwargs": dict(kwargs),
            "UserName": user_name,
            "UserDisplayName": user_display_name,
        }
    )


def _validate_list_arg(kind: str, name: str, value: Any) -> list[str]:
    if not isinstance(value, (list, tuple)):
        raise WorkspaceMutationContractError(
            f"Workspace mutation {kind!r} expects {name!r} to be a list of names."
        )
    names = [str(item or "").strip() for item in value]
    names = [item for item in names if item]
    if not names:
        raise WorkspaceMutationContractError(
            f"Workspace mutation {kind!r} requires at least one {name!r} entry."
        )
    return names


def validate_workspace_mutation_request(payload: Mapping[str, Any]) -> dict[str, Any]:
    if not isinstance(payload, Mapping):
        raise WorkspaceMutationContractError("A workspace-mutation request must be a JSON object.")
    if str(payload.get("Function") or "") != WORKSPACE_MUTATION_FUNCTION:
        raise WorkspaceMutationContractError("Not a workspace-mutation request.")
    version = payload.get("ContractVersion")
    if version != WORKSPACE_MUTATION_CONTRACT_VERSION:
        raise WorkspaceMutationContractError(
            f"Unsupported workspace-mutation contract version: {version!r}"
        )
    kind = str(payload.get("MutationKind") or "").strip()
    spec = WORKSPACE_MUTATION_KINDS.get(kind)
    if spec is None:
        raise WorkspaceMutationContractError(f"Unknown workspace-mutation kind: {kind!r}")
    kwargs = payload.get("Kwargs")
    if not isinstance(kwargs, Mapping):
        raise WorkspaceMutationContractError("Workspace-mutation Kwargs must be an object.")
    unexpected = sorted(set(kwargs) - spec.allowed)
    if unexpected:
        raise WorkspaceMutationContractError(
            f"Workspace mutation {kind!r} does not accept: {', '.join(unexpected)}."
        )

    normalized_kwargs = dict(kwargs)
    missing = [
        name
        for name in spec.required
        if name not in spec.list_args and not str(kwargs.get(name) or "").strip()
    ]
    if missing:
        raise WorkspaceMutationContractError(
            f"Workspace mutation {kind!r} requires: {', '.join(missing)}."
        )
    for name in spec.list_args:
        if name in spec.required or name in kwargs:
            normalized_kwargs[name] = _validate_list_arg(kind, name, kwargs.get(name))

    try:
        request_id = validate_request_id(payload.get("RequestId"))
        # Only logical identifiers travel; a machine-local project folder or a
        # drive-letter reserving-class path is refused before any lookup.
        validate_project_name(normalized_kwargs["project_name"], "project_name")
        if "reserving_class" in spec.allowed and normalized_kwargs.get("reserving_class"):
            validate_reserving_class_path(normalized_kwargs["reserving_class"])
    except DependentPropagationContractError as exc:
        raise WorkspaceMutationContractError(str(exc)) from exc
    return {
        "Function": WORKSPACE_MUTATION_FUNCTION,
        "ContractVersion": WORKSPACE_MUTATION_CONTRACT_VERSION,
        "RequestId": request_id,
        "MutationKind": kind,
        "Kwargs": normalized_kwargs,
        "UserName": str(payload.get("UserName") or "").strip(),
        "UserDisplayName": str(payload.get("UserDisplayName") or "").strip(),
    }
