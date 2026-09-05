"""Engine worker for ArcRho data-processing-rules save jobs.

The save itself is the canonical ``data_processing_rules_service`` save, run
here on the machine hosting the workspace so the sidecar walk that follows the
write reads local disk instead of crossing a Client PC's mapped drive. The job
is durable (its queue file is retained until a validated terminal status
exists) and runs under the project-scope propagation lease, which is what lets
several Engine instances claim one request exactly once and what tells every
other writer the project is busy for the few seconds the save takes.

The service reports its stages through a callback; this module records the
latest one and republishes it on the contract heartbeat cadence, so the
status file's write rate is bounded by the contract rather than by the number
of sidecars in the project. The terminal success status embeds the service's
full response, and a refusal keeps the HTTP status the direct route would
have answered with (409 stale revision, 400 invalid rules, 423 locked).

A save that changed what the rules mean is followed by a refresh: every
engine-generated dataset instance whose type reads an affected source measure
is regenerated in place, class by class, and each class's dependents are
walked, exactly as the source-table refresh does after Import Data. Without
this the changed rule reached a dataset only when someone next opened it,
and the methods built on it kept the old values with nothing to say so. The
refresh is reported under ``refresh`` in the response; a dataset or class it
could not refresh is named there and in the status message, and the save
itself stays committed.
"""

from __future__ import annotations

import os
import threading
import time
from pathlib import Path
from typing import Any, Callable, Mapping

from arcrho_data_processing_rules_job_contract import (
    DATA_PROCESSING_RULES_JOB_STATUS_HEARTBEAT_SECONDS,
    DataProcessingRulesJobContractError,
    data_processing_rules_job_request_path,
    read_data_processing_rules_job_status,
    validate_data_processing_rules_job_request,
    validate_request_id,
    write_data_processing_rules_job_status,
)
from arcrho_dependent_propagation_contract import (
    DependentPropagationLeaseUnavailable,
    acquire_project_scope_lease,
    narrow_project_scope_lease,
    release_project_scope_lease,
    start_project_scope_lease_heartbeat,
    stop_project_scope_lease_heartbeat,
)
from arcrho_engine_job_lease import engine_job_lease_is_owned

# Path redaction and the canonical-runtime bootstrap are owned by the sibling
# durable-job modules; this job reuses them rather than growing second copies.
from arcrho_engine.dependent_propagation import configure_canonical_runtime
from arcrho_engine.project_duplication import _redact_machine_paths
from arcrho_engine.runtime_log import append_runtime_log

DATA_PROCESSING_RULES_JOB_LOG_FILENAME = "data_processing_rules_jobs.log"

Progress = dict[str, Any]


def _log(server_root: Any, message: str, *, exc: BaseException | None = None) -> None:
    append_runtime_log(server_root, DATA_PROCESSING_RULES_JOB_LOG_FILENAME, message, exc=exc)


class DataProcessingRulesJobLeaseLost(RuntimeError):
    """Raised when the project-scope lease is no longer owned mid-job."""


class DataProcessingRulesJobRefused(RuntimeError):
    """The canonical save refused; carries the direct route's HTTP status."""

    def __init__(self, status_code: int, message: str) -> None:
        super().__init__(message)
        self.status_code = int(status_code)


def _progress(stage: str, completed: int, total: int, label: str) -> Progress:
    return {
        "stage": str(stage or "").strip() or "processing",
        "completed": max(0, int(completed)),
        "total": max(0, int(total), int(completed)),
        "label": str(label or "").strip() or "Saving data processing rules",
    }


def _safe_status_message(exc: BaseException) -> str:
    message = _redact_machine_paths(exc)
    return message or "The data processing rules save failed."


def _empty_refresh() -> dict[str, Any]:
    return {
        "classes_total": 0,
        "classes_refreshed": 0,
        "datasets_regenerated": 0,
        "datasets_failed": 0,
        "methods_updated": 0,
        "failures": [],
    }


def _affected_dataset_types(response: Mapping[str, Any]) -> list[str]:
    """The dataset types the save reported as reading an affected measure.

    Only a save that changed the rules' meaning names any: an order-only save
    and a no-op save both leave the processing hash alone, so every generated
    cache is still current and there is nothing to rebuild.
    """

    if not response.get("changed"):
        return []
    impact = response.get("impact")
    if not isinstance(impact, Mapping):
        return []
    names: list[str] = []
    seen: set[str] = set()
    for value in impact.get("affected_dataset_types") or []:
        name = str(value or "").strip()
        if name and name.casefold() not in seen:
            seen.add(name.casefold())
            names.append(name)
    return names


def _refresh_affected_datasets(
    server_root: Path,
    project_name: str,
    dataset_types: list[str],
    *,
    notify: Callable[[str, int, int, str], None],
    narrow_lease: Callable[[list[str]], None] | None = None,
) -> dict[str, Any]:
    """Regenerate the engine datasets of the affected types and walk dependents.

    The class list is settled before anything is rebuilt so the progress bar
    knows its total and so the caller holding the project-scope lease can
    narrow it to exactly those classes; a class with no instance of an
    affected type is never held. Each class then runs the same
    regenerate-then-walk step Import Data uses, under the class's own lease.
    A class that cannot be refreshed is named in ``failures`` and the job
    moves on: the rules file is already saved, and the datasets left behind
    still rebuild on their own the next time they are opened.
    """

    result = _empty_refresh()
    if not dataset_types:
        return result

    from arcrho_engine import source_table_refresh

    notify("scanning", 0, 0, "Finding the datasets the rules affect")
    try:
        classes = [
            reserving_class
            for reserving_class in source_table_refresh._reserving_class_paths(project_name)
            if source_table_refresh._engine_dataset_instances(
                project_name, reserving_class, dataset_types
            )
        ]
    except Exception as exc:
        result["failures"].append(
            "The datasets the rules affect could not be listed: "
            + _redact_machine_paths(exc)
        )
        _log(server_root, "affected dataset scan failed", exc=exc)
        return result
    result["classes_total"] = len(classes)
    if not classes:
        return result

    if narrow_lease is not None:
        try:
            narrow_lease(classes)
        except DataProcessingRulesJobLeaseLost:
            raise
        except Exception as exc:
            # Without the narrowed hold the refresh could race a client save;
            # leave the datasets to rebuild on open rather than risk that.
            result["failures"].append(
                "The affected reserving classes could not be reserved for the refresh: "
                + _redact_machine_paths(exc)
            )
            _log(server_root, "project-scope lease narrowing failed", exc=exc)
            return result

    total = len(classes)
    for index, reserving_class in enumerate(classes, start=1):
        def on_dataset(dataset_name: str, _class=reserving_class, _done=index - 1) -> None:
            notify("classes", _done, total, f"Refreshing {_class}: {dataset_name}")

        notify(
            "classes",
            index - 1,
            total,
            f"Refreshing {reserving_class} ({index} of {total})",
        )
        class_started = time.monotonic()
        try:
            source_table_refresh._refresh_one_reserving_class(
                server_root,
                project_name,
                reserving_class,
                result,
                on_dataset=on_dataset,
                dataset_types=dataset_types,
            )
            result["classes_refreshed"] += 1
        except DependentPropagationLeaseUnavailable as exc:
            result["failures"].append(_redact_machine_paths(exc))
            _log(server_root, f"{reserving_class} skipped: {exc}")
        except Exception as exc:
            result["failures"].append(
                f"{reserving_class}: {_redact_machine_paths(exc)}"
            )
            _log(server_root, f"{reserving_class} refresh failed", exc=exc)
        finally:
            _log(
                server_root,
                f"{reserving_class} took {time.monotonic() - class_started:.2f}s",
            )
    notify(
        "classes",
        total,
        total,
        f"Refreshed {result['classes_refreshed']} of {total} reserving class(es)",
    )
    return result


def summarize_refresh_failures(refresh: Mapping[str, Any] | None) -> str:
    """One sentence for a saved rule set whose dataset refresh fell short.

    Empty when nothing failed. The rules are committed either way, so the
    sentence says so before it names what did not refresh; the first failure
    is spelled out because the client shows this message verbatim.
    """

    if not isinstance(refresh, Mapping):
        return ""
    failures = [str(item or "").strip() for item in refresh.get("failures") or []]
    failures = [item for item in failures if item]
    if not failures:
        return ""
    counts = []
    datasets_failed = int(refresh.get("datasets_failed") or 0)
    if datasets_failed:
        counts.append(f"{datasets_failed} dataset(s) could not be refreshed")
    unfinished = int(refresh.get("classes_total") or 0) - int(
        refresh.get("classes_refreshed") or 0
    )
    if unfinished > 0:
        counts.append(f"{unfinished} reserving class(es) were not refreshed")
    head = "; ".join(counts) if counts else "the dataset refresh reported problems"
    return f"The rules were saved, but {head}. First problem: {failures[0]}"


def execute_data_processing_rules_save(
    server_root: str | os.PathLike[str],
    request: Mapping[str, Any],
    *,
    progress_callback: Callable[[Progress], None] | None = None,
    narrow_lease: Callable[[list[str]], None] | None = None,
) -> dict[str, Any]:
    """Run one validated rules save and return the save route's response.

    A refusal the service raises is re-raised as
    :class:`DataProcessingRulesJobRefused` with the status code the direct
    route maps it to, so the terminal status can carry that code. A save that
    changed the rules' meaning is followed by the refresh of every dataset
    they affect; its summary rides along under ``refresh``. ``narrow_lease``
    is called with those datasets' reserving classes before the refresh, so
    the caller holding the project-scope lease can let every other class go.
    """

    normalized = validate_data_processing_rules_job_request(request)
    root = Path(os.fspath(server_root)).expanduser().resolve(strict=False)
    configure_canonical_runtime(root)

    from app_server.services import user_identity_service

    def notify(stage: str, completed: int, total: int, label: str) -> None:
        if progress_callback is not None:
            progress_callback(_progress(stage, completed, total, label))

    project_name = normalized["ProjectName"]
    _log(
        root,
        f"{normalized['RequestId']} start project={project_name!r} "
        f"revision={normalized['ExpectedRevision']} rules={len(normalized['Rules'])}",
    )
    # The job writes the rules file, the audit entry, and then every dataset
    # and method it refreshes: act as the user who asked for the save so each
    # stamp names them and not this service.
    with user_identity_service.acting_identity(normalized["UserName"]):
        response = _run_canonical_save(normalized, notify)
        dataset_types = _affected_dataset_types(response)
        _log(
            root,
            f"{normalized['RequestId']} saved changed={bool(response.get('changed'))} "
            f"affected_types={len(dataset_types)}",
        )
        response["refresh"] = _refresh_affected_datasets(
            root,
            project_name,
            dataset_types,
            notify=notify,
            narrow_lease=narrow_lease,
        )
    refresh = response["refresh"]
    _log(
        root,
        f"{normalized['RequestId']} refreshed "
        f"classes={refresh['classes_refreshed']}/{refresh['classes_total']} "
        f"datasets={refresh['datasets_regenerated']} "
        f"methods={refresh['methods_updated']} "
        f"failed={refresh['datasets_failed']}",
    )
    return response


def _run_canonical_save(
    normalized: Mapping[str, Any],
    notify: Callable[[str, int, int, str], None],
) -> dict[str, Any]:
    """The canonical save, with each refusal mapped to its direct-route code."""

    from app_server.services import (
        data_processing_rules_service,
        data_processing_values_service,
    )

    try:
        return data_processing_rules_service.save_data_processing_rules(
            normalized["ProjectName"],
            expected_revision=normalized["ExpectedRevision"],
            data={"rules": normalized["Rules"]},
            progress=notify,
        )
    except data_processing_rules_service.RulesRevisionConflictError as exc:
        raise DataProcessingRulesJobRefused(409, str(exc)) from exc
    except (
        data_processing_rules_service.RulesWriteLockedError,
        data_processing_values_service.DataProcessingValuesLockedError,
    ) as exc:
        raise DataProcessingRulesJobRefused(423, str(exc)) from exc
    except data_processing_rules_service.RulesValidationError as exc:
        raise DataProcessingRulesJobRefused(400, "; ".join(exc.errors) or str(exc)) from exc
    except PermissionError as exc:
        raise DataProcessingRulesJobRefused(
            423, "Data processing rules file is locked. Please retry."
        ) from exc
    except ValueError as exc:
        message = str(exc)
        code = 404 if "Project folder not found under projects:" in message else 400
        raise DataProcessingRulesJobRefused(code, message) from exc


def _require_lease(lease) -> None:
    if lease.heartbeat_failed.is_set() or not engine_job_lease_is_owned(lease):
        raise DataProcessingRulesJobLeaseLost(
            "Data processing rules job project ownership was lost."
        )


def _terminal_status_or_none(server_root: Path, request_id: str) -> dict[str, Any] | None:
    try:
        status = read_data_processing_rules_job_status(server_root, request_id)
    except (OSError, ValueError, TypeError, DataProcessingRulesJobContractError):
        return None
    if status is not None and status["status"] in {"success", "error"}:
        return status
    return None


def _remove_request_file(path: Path) -> None:
    try:
        path.unlink()
    except FileNotFoundError:
        pass
    except OSError as exc:
        print(f"(data processing rules job queue cleanup error: {exc})")


def process_durable_data_processing_rules_request(
    server_root: str | os.PathLike[str],
    request_file: str | os.PathLike[str],
    request: Mapping[str, Any],
) -> bool:
    """Process one retained queue file under the project-scope lease."""

    root = Path(os.fspath(server_root)).expanduser().resolve(strict=False)
    request_path = Path(os.fspath(request_file))
    raw_request_id = request.get("RequestId") if isinstance(request, Mapping) else None
    try:
        request_id = validate_request_id(raw_request_id)
    except DataProcessingRulesJobContractError as exc:
        # A request without a safe id can never publish status; drop it so the
        # queue rescan does not reprocess it forever.
        print(f"(data processing rules job request error: {_safe_status_message(exc)})")
        _remove_request_file(request_path)
        return False

    expected_path = data_processing_rules_job_request_path(root, request_id)
    try:
        if request_path.resolve(strict=False) != expected_path.resolve(strict=False):
            print("(data processing rules job request filename does not match RequestId)")
            return False
    except OSError:
        return False

    terminal = _terminal_status_or_none(root, request_id)
    if terminal is not None:
        _remove_request_file(request_path)
        return terminal["status"] == "success"

    try:
        normalized = validate_data_processing_rules_job_request(request)
    except DataProcessingRulesJobContractError as exc:
        message = _safe_status_message(exc)
        try:
            write_data_processing_rules_job_status(
                root,
                request_id,
                "error",
                progress=_progress("rejected", 0, 0, "Data processing rules save rejected"),
                message=message,
                status_code=400,
            )
        except Exception as status_exc:
            print(
                "(error: could not publish rejected data processing rules job status: "
                f"{_redact_machine_paths(status_exc)})"
            )
            return False
        print(f"(data processing rules job request error: {message})")
        _remove_request_file(request_path)
        return False

    lease = acquire_project_scope_lease(root, normalized["ProjectName"])
    if lease is None:
        _log(root, f"{request_id} claim missed (project busy)")
        return False
    claimed_at = time.monotonic()
    heartbeat_stop, heartbeat_thread = start_project_scope_lease_heartbeat(lease)
    try:
        # One lock serializes every status write: job progress and the status
        # heartbeat below republish the same file, and a stale heartbeat write
        # must never land after a newer progress write.
        status_write_lock = threading.Lock()
        current_progress = _progress("starting", 0, 0, "Preparing the rules save")

        def publish(
            status: str,
            progress: Progress,
            *,
            message: str = "",
            status_code: int | None = None,
            result: Mapping[str, Any] | None = None,
        ) -> None:
            _require_lease(lease)
            with status_write_lock:
                write_data_processing_rules_job_status(
                    root,
                    request_id,
                    status,
                    progress=progress,
                    message=message,
                    status_code=status_code,
                    result=result,
                )

        def record_progress(progress: Progress) -> None:
            # The sidecar check reports once per file. A new stage is published
            # at once so the window follows the save; ticks within that stage
            # are left to the heartbeat, which bounds the status file's write
            # rate by the contract cadence instead of by the size of the
            # project. Every other stage reports once per class or dataset,
            # a rate the file can carry, so those ticks are published as they
            # happen and the window names the class being refreshed.
            nonlocal current_progress
            stage_changed = progress["stage"] != current_progress["stage"]
            current_progress = progress
            if stage_changed or progress["stage"] != "checking":
                publish("processing", progress)

        def narrow_lease(reserving_classes: list[str]) -> None:
            # The rules file is written; from here only the classes being
            # refreshed need the hold, so every other class opens to saves.
            _require_lease(lease)
            narrow_project_scope_lease(lease, normalized["ProjectName"], reserving_classes)

        # Remote pollers treat a status whose updated_at stops moving as an
        # abandoned job, so republish the current progress on the contract
        # heartbeat cadence even while one slow stage is still running.
        heartbeat_stop_event = threading.Event()

        def status_heartbeat_loop() -> None:
            while not heartbeat_stop_event.wait(
                DATA_PROCESSING_RULES_JOB_STATUS_HEARTBEAT_SECONDS
            ):
                try:
                    publish("processing", current_progress)
                except Exception:
                    # Lease loss or filesystem trouble ends the heartbeat; the
                    # job thread surfaces the same condition on its next write.
                    return

        status_heartbeat_thread = threading.Thread(
            target=status_heartbeat_loop,
            name=f"arcrho-data-processing-rules-status-{request_id[:8]}",
            daemon=True,
        )

        terminal_result: dict[str, Any] | None = None
        terminal_code: int | None = None
        try:
            publish("processing", current_progress)
            status_heartbeat_thread.start()
            try:
                terminal_result = execute_data_processing_rules_save(
                    root,
                    normalized,
                    progress_callback=record_progress,
                    narrow_lease=narrow_lease,
                )
            finally:
                heartbeat_stop_event.set()
                status_heartbeat_thread.join(
                    timeout=DATA_PROCESSING_RULES_JOB_STATUS_HEARTBEAT_SECONDS * 2
                )
            # The rules are committed even when a dataset did not refresh, so
            # the job succeeds and the message says what was left behind; an
            # error here would read as a save that never happened.
            terminal_state = "success"
            terminal_message = summarize_refresh_failures(terminal_result.get("refresh"))
            terminal_progress = _progress(
                "complete",
                current_progress["total"],
                current_progress["total"],
                "Data processing rules saved",
            )
        except DataProcessingRulesJobLeaseLost:
            _log(root, f"{request_id} project ownership was lost")
            return False
        except DataProcessingRulesJobRefused as exc:
            terminal_state = "error"
            terminal_message = _safe_status_message(exc)
            terminal_code = exc.status_code
            terminal_progress = current_progress
            _log(root, f"{request_id} refused {terminal_code}: {terminal_message}")
        except Exception as exc:
            terminal_state = "error"
            terminal_message = _safe_status_message(exc)
            terminal_code = 500
            terminal_progress = current_progress
            # The status message is redacted for the client; the log keeps the
            # real exception and its traceback.
            _log(root, f"{request_id} raised: {terminal_message}", exc=exc)

        _log(
            root,
            f"{request_id} {terminal_state} after {time.monotonic() - claimed_at:.2f}s"
            + (f": {terminal_message}" if terminal_message else ""),
        )
        try:
            publish(
                terminal_state,
                terminal_progress,
                message=terminal_message,
                status_code=terminal_code,
                result=terminal_result,
            )
        except Exception as status_exc:
            _log(
                root,
                "could not publish data processing rules job status: "
                f"{_redact_machine_paths(status_exc)}",
                exc=status_exc,
            )
            return False
        if _terminal_status_or_none(root, request_id) is not None:
            _remove_request_file(request_path)
        return terminal_state == "success"
    except DataProcessingRulesJobLeaseLost:
        return False
    finally:
        stop_project_scope_lease_heartbeat(heartbeat_stop, heartbeat_thread)
        release_project_scope_lease(lease)
