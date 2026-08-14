"""Contract for ArcRho Engine-hosted save jobs.

A save executed from a Client PC pays one SMB round trip per file touched
(~0.4 s each over the mapped drive), so the app server ships the save to the
Engine instead: it publishes a ``queued`` status, drops a request file in the
requests root (the watchdog observer sees root files instantly), and polls the
status until the Engine reports a terminal state. The Engine claims the
request with the legacy delete-to-claim rule, holds the reserving-class lease
while it runs the canonical service save plus the dependent walk inline, and
writes the service's full response payload to a result file the client
returns as its own HTTP response — so the save endpoints keep their exact
shapes while the file I/O happens on the server host's local disk.

Save jobs are interactive, not durable: a request lost to a mid-save crash
surfaces as a client timeout and the user simply saves again (the unsaved
work never left the editor). Only the allowlisted kinds below may execute.

A save runs in two steps. ``Mode: "plan"`` asks the Engine which dependent
objects the save can reach: it runs no save, changes no saved object, and
takes no reserving-class lease, and it answers with a plan carrying a
``fingerprint`` of the graph it read. ``Mode: "commit"`` is the save itself;
when the client passes that fingerprint back the Engine recomputes it *under*
the lease and refuses with 409 if the reserving class moved while the user was
reviewing. The lease is never held across the human pause — one user's open
dialog must not block every other save in the class.
"""

from __future__ import annotations

import json
import os
import time
from pathlib import Path
from typing import Any, Mapping

from arcrho_dependent_propagation_contract import (
    DependentPropagationContractError,
    validate_request_id,
)

SAVE_JOB_FUNCTION = "ArcRhoHostedSave"
SAVE_JOB_CONTRACT_VERSION = 1

# kind -> (app_server.services module name, save function name). The Engine
# resolves saves only through this table; a request naming anything else is
# rejected before any import happens.
SAVE_JOB_KINDS: dict[str, tuple[str, str]] = {
    "dfm_method": ("dfm_service", "save_dfm_method"),
    "result_selection_method": ("result_selection_service", "save_result_selection"),
    "bornhuetter_ferguson_method": (
        "bornhuetter_ferguson_service",
        "save_bornhuetter_ferguson_method",
    ),
    "cape_cod_method": ("cape_cod_service", "save_cape_cod_method"),
    "bootstrap_method": ("bootstrap_service", "save_bootstrap_method"),
    "dataset_sidecar": ("dataset_service", "save_dataset_sidecar"),
}

# Every kind's propagation roots are resolved by this function in the same
# module that owns the save, so a plan can never derive a root differently
# from the save it precedes. There is deliberately no second kind -> module
# table: the module always comes from ``SAVE_JOB_KINDS``.
SAVE_JOB_PLAN_ROOT_FUNCTION = "save_propagation_roots"

SAVE_JOB_MODE_COMMIT = "commit"
SAVE_JOB_MODE_PLAN = "plan"
SAVE_JOB_MODES = (SAVE_JOB_MODE_COMMIT, SAVE_JOB_MODE_PLAN)

# Refusal a commit publishes when the reserving class changed between the plan
# the user reviewed and the commit. The user re-saves, sees a fresh plan, and
# confirms against the graph that actually exists.
SAVE_PLAN_STALE_MESSAGE = (
    "This reserving class changed while the dependent updates were being "
    "reviewed. Nothing was saved. Save again to review the current list of "
    "dependent objects."
)

# The client gives up on a queued request nobody claimed (dead engines) much
# sooner than on a claimed save that is still working.
SAVE_JOB_QUEUED_TIMEOUT_SECONDS = 20.0
SAVE_JOB_PROCESSING_TIMEOUT_SECONDS = 180.0
# A plan writes nothing and takes no lease, so it never waits behind a walk;
# it only has to read the graph on local disk.
SAVE_JOB_PLAN_TIMEOUT_SECONDS = 60.0

_TERMINAL_STATUSES = {"success", "error"}


class SaveJobContractError(ValueError):
    """Raised when a hosted-save payload violates this contract."""


def _save_jobs_root(server_root: str | os.PathLike[str]) -> Path:
    return Path(os.fspath(server_root)) / "requests" / "save_jobs"


def save_job_request_path(server_root: str | os.PathLike[str], request_id: str) -> Path:
    # Request files live in the requests ROOT so the Engine's non-recursive
    # watchdog observer dispatches them instantly instead of on the 5 s
    # rescan cycle.
    return (
        Path(os.fspath(server_root))
        / "requests"
        / f"arcrho_hosted_save_{validate_request_id(request_id)}.json"
    )


def save_job_status_path(server_root: str | os.PathLike[str], request_id: str) -> Path:
    return _save_jobs_root(server_root) / "statuses" / f"{validate_request_id(request_id)}.json"


def save_job_result_path(server_root: str | os.PathLike[str], request_id: str) -> Path:
    return _save_jobs_root(server_root) / "results" / f"{validate_request_id(request_id)}.json"


def build_save_job_request(
    *,
    request_id: str,
    save_kind: str,
    project_name: str,
    path: str,
    args: list[Any],
    kwargs: Mapping[str, Any],
    user_name: str = "",
    mode: str = SAVE_JOB_MODE_COMMIT,
    plan_fingerprint: str = "",
) -> dict[str, Any]:
    kind = str(save_kind or "").strip()
    if kind not in SAVE_JOB_KINDS:
        raise SaveJobContractError(f"Unknown hosted-save kind: {kind!r}")
    job_mode = str(mode or SAVE_JOB_MODE_COMMIT).strip()
    if job_mode not in SAVE_JOB_MODES:
        raise SaveJobContractError(f"Unknown hosted-save mode: {job_mode!r}")
    fingerprint = str(plan_fingerprint or "").strip()
    if fingerprint and job_mode != SAVE_JOB_MODE_COMMIT:
        raise SaveJobContractError(
            "Only a commit may carry a reviewed plan fingerprint."
        )
    project = str(project_name or "").strip()
    reserving = str(path or "").strip()
    if not project or not reserving:
        raise SaveJobContractError(
            "Hosted saves require project_name and the reserving-class path."
        )
    return {
        "Function": SAVE_JOB_FUNCTION,
        "ContractVersion": SAVE_JOB_CONTRACT_VERSION,
        "RequestId": validate_request_id(request_id),
        "SaveKind": kind,
        "Mode": job_mode,
        "PlanFingerprint": fingerprint,
        "ProjectName": project,
        "Path": reserving,
        "Args": list(args or []),
        "Kwargs": dict(kwargs or {}),
        "UserName": str(user_name or "").strip(),
    }


def validate_save_job_request(payload: Mapping[str, Any]) -> dict[str, Any]:
    if not isinstance(payload, Mapping):
        raise SaveJobContractError("A hosted-save request must be a JSON object.")
    if str(payload.get("Function") or "") != SAVE_JOB_FUNCTION:
        raise SaveJobContractError("Not a hosted-save request.")
    version = payload.get("ContractVersion")
    if version != SAVE_JOB_CONTRACT_VERSION:
        raise SaveJobContractError(
            f"Unsupported hosted-save contract version: {version!r}"
        )
    try:
        request_id = validate_request_id(payload.get("RequestId"))
    except DependentPropagationContractError as exc:
        raise SaveJobContractError(str(exc)) from exc
    kind = str(payload.get("SaveKind") or "").strip()
    if kind not in SAVE_JOB_KINDS:
        raise SaveJobContractError(f"Unknown hosted-save kind: {kind!r}")
    # A request written before the two-step save existed carries no Mode and
    # is a commit, which is also what an omitted Mode must mean for any
    # producer that only ever saves.
    mode = str(payload.get("Mode") or SAVE_JOB_MODE_COMMIT).strip()
    if mode not in SAVE_JOB_MODES:
        raise SaveJobContractError(f"Unknown hosted-save mode: {mode!r}")
    fingerprint = str(payload.get("PlanFingerprint") or "").strip()
    if fingerprint and mode != SAVE_JOB_MODE_COMMIT:
        raise SaveJobContractError(
            "Only a commit may carry a reviewed plan fingerprint."
        )
    project = str(payload.get("ProjectName") or "").strip()
    reserving = str(payload.get("Path") or "").strip()
    if not project or not reserving:
        raise SaveJobContractError(
            "Hosted saves require ProjectName and the reserving-class Path."
        )
    args = payload.get("Args")
    kwargs = payload.get("Kwargs")
    if not isinstance(args, list):
        raise SaveJobContractError("Hosted-save Args must be a list.")
    if not isinstance(kwargs, Mapping):
        raise SaveJobContractError("Hosted-save Kwargs must be an object.")
    return {
        "Function": SAVE_JOB_FUNCTION,
        "ContractVersion": SAVE_JOB_CONTRACT_VERSION,
        "RequestId": request_id,
        "SaveKind": kind,
        "Mode": mode,
        "PlanFingerprint": fingerprint,
        "ProjectName": project,
        "Path": reserving,
        "Args": list(args),
        "Kwargs": dict(kwargs),
        "UserName": str(payload.get("UserName") or "").strip(),
    }


def _write_json_atomic(path: Path, payload: Mapping[str, Any]) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp_path = path.with_name(f"{path.name}.{os.getpid()}.{time.time_ns()}.tmp")
    try:
        temp_path.write_text(
            json.dumps(payload, ensure_ascii=False), encoding="utf-8"
        )
        # The client polls the status file over SMB while the Engine
        # replaces it, and a Windows reader without FILE_SHARE_DELETE makes
        # the replace fail with WinError 5 for the duration of the read.
        # Retrying through a few poll cycles always finds a gap; a lost
        # terminal status would otherwise strand the save at "processing".
        for attempt in range(10):
            try:
                os.replace(temp_path, path)
                break
            except PermissionError:
                if attempt == 9:
                    raise
                time.sleep(0.2)
    except Exception:
        try:
            temp_path.unlink(missing_ok=True)
        except OSError:
            pass
        raise
    return path


def write_save_job_status(
    server_root: str | os.PathLike[str],
    request_id: str,
    status: str,
    *,
    message: str = "",
    status_code: int | None = None,
) -> Path:
    payload: dict[str, Any] = {
        "request_id": validate_request_id(request_id),
        "status": str(status),
        "updated_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
    }
    if message:
        payload["message"] = str(message)
    if status_code is not None:
        payload["status_code"] = int(status_code)
    return _write_json_atomic(save_job_status_path(server_root, request_id), payload)


def read_save_job_status(
    server_root: str | os.PathLike[str], request_id: str
) -> dict[str, Any] | None:
    path = save_job_status_path(server_root, request_id)
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return None
    except (OSError, ValueError, TypeError):
        return None
    if not isinstance(payload, dict):
        return None
    if str(payload.get("request_id") or "") != validate_request_id(request_id):
        return None
    return payload


def save_job_status_is_terminal(status: Mapping[str, Any] | None) -> bool:
    return bool(status) and str(status.get("status") or "") in _TERMINAL_STATUSES


def write_save_job_result(
    server_root: str | os.PathLike[str],
    request_id: str,
    payload: Mapping[str, Any],
) -> Path:
    return _write_json_atomic(
        save_job_result_path(server_root, request_id),
        {"request_id": validate_request_id(request_id), "response": dict(payload)},
    )


def read_save_job_result(
    server_root: str | os.PathLike[str], request_id: str
) -> dict[str, Any] | None:
    path = save_job_result_path(server_root, request_id)
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError, TypeError):
        return None
    if not isinstance(payload, dict):
        return None
    if str(payload.get("request_id") or "") != validate_request_id(request_id):
        return None
    response = payload.get("response")
    return response if isinstance(response, dict) else None


def discard_save_job_artifacts(
    server_root: str | os.PathLike[str], request_id: str
) -> None:
    """Best-effort cleanup once the client has consumed a terminal outcome."""

    for path in (
        save_job_status_path(server_root, request_id),
        save_job_result_path(server_root, request_id),
        save_job_request_path(server_root, request_id),
    ):
        try:
            path.unlink(missing_ok=True)
        except OSError:
            pass


def prune_stale_save_job_artifacts(
    server_root: str | os.PathLike[str], *, max_age_seconds: float = 6 * 3600
) -> None:
    """Drop status/result files whose client died before cleaning up."""

    cutoff = time.time() - max(60.0, float(max_age_seconds))
    root = _save_jobs_root(server_root)
    for folder in ("statuses", "results"):
        try:
            entries = list((root / folder).iterdir())
        except (FileNotFoundError, NotADirectoryError, OSError):
            continue
        for entry in entries:
            try:
                if entry.is_file() and entry.stat().st_mtime < cutoff:
                    entry.unlink(missing_ok=True)
            except OSError:
                continue
