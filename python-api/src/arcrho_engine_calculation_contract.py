"""Contract for Gateway-hosted ArcRho Engine calculation requests.

The legacy ``ArcRhoTri`` / ``ArcRhoVec`` / ``ArcRhoHeaders`` exchange writes
one ``request-*.json`` into the workspace ``requests`` folder and waits for the
Engine's CSV to appear beside the project data. From a Client PC both halves
cross the mapped drive: the request write is three SMB round trips, and every
wait tick writes and deletes a probe file so the Windows redirector's cached
"file not found" answer cannot hide a result the Engine has already written.
A dataset run can chain several such exchanges (headers, calculated-dataset
inputs, the dataset itself), which is where a multi-second wait comes from.

A Client PC may instead POST the same logical request to the machine-wide
ArcRho Gateway. The Gateway runs the very same ``app_server`` publish-and-wait
helpers on the server host — the request lands in the local ``requests`` root
the Engine already watches, and the CSV wait is a local file-system event —
then answers with the completion. Nothing about the Engine changes: it still
claims the same request file and writes the same CSV to the same location, and
Excel, ``arcrho_api``, and the migration keep publishing over SMB.

The request carries only the legacy request-file keys as ordered pairs. The
server derives the output ``DataPath`` itself with the canonical
``set_data_path_like_vba`` and stamps the requesting user, so a client can
neither point the Engine at an arbitrary file nor act as another user. A
calculation is a deterministic function of the workspace: a repeated request
recomputes the same CSV, so this transport keeps no idempotency receipt.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Mapping, Sequence

from arcrho_dependent_propagation_contract import (
    DependentPropagationContractError,
    validate_project_name,
    validate_request_id,
    validate_reserving_class_path,
)


ENGINE_CALCULATION_FUNCTION = "ArcRhoEngineCalculation"
ENGINE_CALCULATION_CONTRACT_VERSION = 1
ENGINE_CALCULATION_PATH = "/api/engine-calculations"
# ``/api/capabilities`` field listing the Engine functions the Gateway hosts.
ENGINE_CALCULATION_CAPABILITY_FIELD = "engine_calculation_functions"
MAX_ENGINE_CALCULATION_REQUEST_BYTES = 64 * 1024
# The Gateway waits at most this long for the Engine's output; the client's
# own request budget (``config.ENGINE_REQUEST_TIMEOUT_SEC``) is normally far
# shorter and is clamped into this range.
MIN_ENGINE_CALCULATION_WAIT_SECONDS = 0.1
MAX_ENGINE_CALCULATION_WAIT_SECONDS = 300.0
# The HTTP call may outlive the server-side wait by this much before the
# client stops waiting for an answer that has already been given up on.
ENGINE_CALCULATION_HTTP_TIMEOUT_MARGIN_SECONDS = 15.0

# Request keys the Gateway itself owns. A client naming one of these is
# refused: the server derives the output location and the acting user.
SERVER_OWNED_REQUEST_KEYS: frozenset[str] = frozenset(
    {"DataPath", "StatusPath", "RequestId", "UserName"}
)
# The legacy request-file key naming the Engine function.
ENGINE_FUNCTION_KEY = "Function"
# Where the executor places the CSV: the canonical dataset cache the pairs
# describe, or the reserving class's Temporary view cache beside it. The
# executor derives either location on its own host from the pairs.
OUTPUT_VARIANT_CANONICAL = "canonical"
OUTPUT_VARIANT_TEMPORARY_VIEW = "temporary_view"
OUTPUT_VARIANTS: tuple[str, ...] = (OUTPUT_VARIANT_CANONICAL, OUTPUT_VARIANT_TEMPORARY_VIEW)
# What the Gateway runs for the request. ``exchange`` is the bare
# publish-and-wait; the dataset operations run the whole canonical
# ``arcrho_runtime_service`` route on the server host — cache validation, the
# exchange itself, the sidecar write, the dependent enqueue, and the index
# refresh — so a Client PC pays one HTTP round trip instead of dozens of SMB
# operations around the Engine's work.
OPERATION_EXCHANGE = "exchange"
OPERATION_DATASET_RUN = "dataset_run"
OPERATION_DATASET_PRECHECK = "dataset_precheck"
OPERATIONS: tuple[str, ...] = (OPERATION_EXCHANGE, OPERATION_DATASET_RUN, OPERATION_DATASET_PRECHECK)
# ``/api/capabilities`` field listing the operations the Gateway hosts, so a
# client facing an older gateway that only knows ``exchange`` keeps the
# dataset route local.
ENGINE_CALCULATION_OPERATION_FIELD = "engine_calculation_operations"
# Options each operation accepts, with the type the canonical service takes.
# ``temporary_session_id`` is a UUID string or null; every other option is a
# boolean. Anything else is refused before the service is imported.
_BOOL = "bool"
_OPTIONAL_TEXT = "optional_text"
OPERATION_OPTIONS: dict[str, dict[str, str]] = {
    OPERATION_EXCHANGE: {},
    OPERATION_DATASET_RUN: {
        "force_refresh": _BOOL,
        "local_only": _BOOL,
        "allow_derived": _BOOL,
        "write_sidecar": _BOOL,
        "temporary_session_id": _OPTIONAL_TEXT,
    },
    OPERATION_DATASET_PRECHECK: {
        "local_only": _BOOL,
        "allow_derived": _BOOL,
        "temporary_session_id": _OPTIONAL_TEXT,
        "allow_runtime_cache_provenance": _BOOL,
    },
}
PROJECT_NAME_KEY = "ProjectName"
RESERVING_CLASS_KEY = "Path"


class EngineCalculationContractError(ValueError):
    """Raised when an engine-calculation payload violates this contract."""


@dataclass(frozen=True)
class EngineCalculationKind:
    """One Engine function a Client PC may run through the Gateway."""

    function: str
    # Exact request-file key spellings the Engine handler reads. The Engine
    # looks keys up verbatim (``arg['periodType']``), so a differently cased
    # key would reach it as a missing argument; the contract therefore
    # accepts only these spellings.
    keys: tuple[str, ...]
    # Whether the request names a reserving class (``Path``) whose logical
    # form is validated like every other hosted request.
    reserving_class: bool = True
    # Output variants this function's CSV may be placed in.
    output_variants: tuple[str, ...] = (OUTPUT_VARIANT_CANONICAL,)
    # Operations the Gateway may run for this function.
    operations: tuple[str, ...] = (OPERATION_EXCHANGE,)

    @property
    def allowed(self) -> frozenset[str]:
        return frozenset(self.keys)


_DATASET_KEYS = (
    "Function",
    "Path",
    "DatasetName",
    "TriangleName",
    "VectorName",
    "InstanceName",
    "Cumulative",
    "Transposed",
    "Calendar",
    "ProjectName",
    "OriginLength",
    "DevelopmentLength",
)

# Engine function -> hosted kind. Only a function registered here may run
# through the Gateway; every other legacy request stays a plain request file.
ENGINE_CALCULATION_KINDS: dict[str, EngineCalculationKind] = {
    "ArcRhoTri": EngineCalculationKind(
        "ArcRhoTri", _DATASET_KEYS, output_variants=OUTPUT_VARIANTS, operations=OPERATIONS
    ),
    "ArcRhoVec": EngineCalculationKind(
        "ArcRhoVec", _DATASET_KEYS, output_variants=OUTPUT_VARIANTS, operations=OPERATIONS
    ),
    "ArcRhoHeaders": EngineCalculationKind(
        "ArcRhoHeaders",
        (
            "Function",
            "periodType",
            "Transposed",
            "Calendar",
            "PeriodLength",
            "ProjectName",
            "StoredPeriodLength",
        ),
        reserving_class=False,
    ),
}

HTTP_ENGINE_CALCULATION_FUNCTIONS: tuple[str, ...] = tuple(sorted(ENGINE_CALCULATION_KINDS))
HTTP_ENGINE_CALCULATION_OPERATIONS: tuple[str, ...] = tuple(sorted(OPERATIONS))

_REQUEST_TEXT_FORBIDDEN = ("#", "\r", "\n")
_SERVER_OWNED_CASEFOLD = frozenset(name.casefold() for name in SERVER_OWNED_REQUEST_KEYS)


def _pair_text(value: Any, what: str) -> str:
    if not isinstance(value, str):
        raise EngineCalculationContractError(f"Engine-calculation {what} must be a string.")
    if any(character in value for character in _REQUEST_TEXT_FORBIDDEN):
        raise EngineCalculationContractError(
            f"Engine-calculation {what} must not contain '#' or a line break."
        )
    return value


def normalize_engine_calculation_pairs(pairs: Any) -> list[list[str]]:
    """Return ``pairs`` as an ordered ``[key, value]`` list of request-file text.

    Order is part of the request: for the header function the Engine output
    file name is derived from the pair values in the order they were sent.
    """

    if isinstance(pairs, Mapping) or not isinstance(pairs, Sequence) or isinstance(pairs, (str, bytes)):
        raise EngineCalculationContractError("Engine-calculation Pairs must be a list of key/value pairs.")
    normalized: list[list[str]] = []
    for item in pairs:
        if isinstance(item, (str, bytes)) or not isinstance(item, Sequence) or len(item) != 2:
            raise EngineCalculationContractError(
                "Each engine-calculation pair must be a two-item [key, value] list."
            )
        key = _pair_text(item[0], "key").strip()
        if not key:
            raise EngineCalculationContractError("Engine-calculation pair keys must not be empty.")
        normalized.append([key, _pair_text(item[1], "value").strip()])
    if not normalized:
        raise EngineCalculationContractError("Engine-calculation Pairs must not be empty.")
    return normalized


def engine_function_of(pairs: Sequence[Sequence[str]]) -> str:
    for key, value in pairs:
        if str(key).strip().casefold() == ENGINE_FUNCTION_KEY.casefold():
            return str(value).strip()
    return ""


def _pair_value(pairs: Sequence[Sequence[str]], key: str) -> str:
    wanted = key.casefold()
    for name, value in pairs:
        if str(name).strip().casefold() == wanted:
            return str(value).strip()
    return ""


def clamp_engine_calculation_wait(timeout_sec: Any) -> float:
    try:
        wait = float(timeout_sec)
    except (TypeError, ValueError) as exc:
        raise EngineCalculationContractError("TimeoutSeconds must be a number.") from exc
    if wait != wait:  # NaN
        raise EngineCalculationContractError("TimeoutSeconds must be a number.")
    return min(MAX_ENGINE_CALCULATION_WAIT_SECONDS, max(MIN_ENGINE_CALCULATION_WAIT_SECONDS, wait))


def normalize_operation_options(operation: str, options: Any) -> dict[str, Any]:
    """Return ``options`` validated against the operation's option table."""

    allowed = OPERATION_OPTIONS.get(operation)
    if allowed is None:
        raise EngineCalculationContractError(f"Unknown engine-calculation operation: {operation!r}")
    if options is None:
        options = {}
    if not isinstance(options, Mapping):
        raise EngineCalculationContractError("Engine-calculation Options must be an object.")
    normalized: dict[str, Any] = {}
    for name, value in options.items():
        kind = allowed.get(str(name))
        if kind is None:
            raise EngineCalculationContractError(
                f"Engine-calculation operation {operation!r} does not accept option {name!r}."
            )
        if kind == _BOOL:
            if not isinstance(value, bool):
                raise EngineCalculationContractError(
                    f"Engine-calculation option {name!r} must be true or false."
                )
            normalized[str(name)] = value
        else:
            if value is None:
                normalized[str(name)] = None
            elif isinstance(value, str):
                normalized[str(name)] = value.strip() or None
            else:
                raise EngineCalculationContractError(
                    f"Engine-calculation option {name!r} must be a string or null."
                )
    return normalized


def build_engine_calculation_request(
    *,
    request_id: str,
    pairs: Sequence[Sequence[str]],
    timeout_sec: float,
    user_name: str,
    user_display_name: str = "",
    output_variant: str = OUTPUT_VARIANT_CANONICAL,
    operation: str = OPERATION_EXCHANGE,
    options: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    return validate_engine_calculation_request(
        {
            "Function": ENGINE_CALCULATION_FUNCTION,
            "ContractVersion": ENGINE_CALCULATION_CONTRACT_VERSION,
            "RequestId": request_id,
            "Pairs": [list(pair) for pair in pairs],
            "TimeoutSeconds": timeout_sec,
            "OutputVariant": output_variant,
            "Operation": operation,
            "Options": dict(options or {}),
            "UserName": user_name,
            "UserDisplayName": user_display_name,
        }
    )


def validate_engine_calculation_request(payload: Mapping[str, Any]) -> dict[str, Any]:
    if not isinstance(payload, Mapping):
        raise EngineCalculationContractError("An engine-calculation request must be a JSON object.")
    if str(payload.get("Function") or "") != ENGINE_CALCULATION_FUNCTION:
        raise EngineCalculationContractError("Not an engine-calculation request.")
    version = payload.get("ContractVersion")
    if version != ENGINE_CALCULATION_CONTRACT_VERSION:
        raise EngineCalculationContractError(
            f"Unsupported engine-calculation contract version: {version!r}"
        )
    pairs = normalize_engine_calculation_pairs(payload.get("Pairs"))
    function = engine_function_of(pairs)
    spec = ENGINE_CALCULATION_KINDS.get(function)
    if spec is None:
        raise EngineCalculationContractError(f"Unknown engine-calculation function: {function!r}")
    seen: set[str] = set()
    for key, _value in pairs:
        if key.casefold() in _SERVER_OWNED_CASEFOLD:
            raise EngineCalculationContractError(
                f"Engine calculation {function!r} must not name the server-owned key {key!r}."
            )
        if key not in spec.allowed:
            raise EngineCalculationContractError(
                f"Engine calculation {function!r} does not accept: {key}."
            )
        if key in seen:
            raise EngineCalculationContractError(
                f"Engine calculation {function!r} names {key!r} more than once."
            )
        seen.add(key)
    output_variant = str(payload.get("OutputVariant") or OUTPUT_VARIANT_CANONICAL).strip()
    if output_variant not in spec.output_variants:
        raise EngineCalculationContractError(
            f"Engine calculation {function!r} does not support output variant {output_variant!r}."
        )
    operation = str(payload.get("Operation") or OPERATION_EXCHANGE).strip()
    if operation not in spec.operations:
        raise EngineCalculationContractError(
            f"Engine calculation {function!r} does not support operation {operation!r}."
        )
    if operation != OPERATION_EXCHANGE and output_variant != OUTPUT_VARIANT_CANONICAL:
        # The dataset operations place their own output (a Temporary view
        # request travels as the temporary_session_id option).
        raise EngineCalculationContractError(
            f"Engine-calculation operation {operation!r} takes no output variant."
        )
    options = normalize_operation_options(operation, payload.get("Options"))
    try:
        request_id = validate_request_id(payload.get("RequestId"))
        # Only logical identifiers travel; a machine-local project folder or a
        # drive-letter reserving-class path is refused before any lookup.
        validate_project_name(_pair_value(pairs, PROJECT_NAME_KEY), PROJECT_NAME_KEY)
        if spec.reserving_class:
            validate_reserving_class_path(_pair_value(pairs, RESERVING_CLASS_KEY))
    except DependentPropagationContractError as exc:
        raise EngineCalculationContractError(str(exc)) from exc
    return {
        "Function": ENGINE_CALCULATION_FUNCTION,
        "ContractVersion": ENGINE_CALCULATION_CONTRACT_VERSION,
        "RequestId": request_id,
        "EngineFunction": spec.function,
        "Pairs": pairs,
        "TimeoutSeconds": clamp_engine_calculation_wait(payload.get("TimeoutSeconds")),
        "OutputVariant": output_variant,
        "Operation": operation,
        "Options": options,
        "UserName": str(payload.get("UserName") or "").strip(),
        "UserDisplayName": str(payload.get("UserDisplayName") or "").strip(),
    }


# Response status values the Gateway returns for a request it ran.
ENGINE_CALCULATION_STATUS_COMPLETED = "completed"
ENGINE_CALCULATION_STATUS_TIMEOUT = "timeout"


def build_engine_calculation_response(
    *,
    ok: bool,
    data_path: str,
    request_file: str,
    wait_ms: float,
) -> dict[str, Any]:
    return {
        "ok": bool(ok),
        "status": ENGINE_CALCULATION_STATUS_COMPLETED if ok else ENGINE_CALCULATION_STATUS_TIMEOUT,
        "data_path": str(data_path),
        "request_file": str(request_file),
        "wait_ms": round(float(wait_ms), 3),
    }
