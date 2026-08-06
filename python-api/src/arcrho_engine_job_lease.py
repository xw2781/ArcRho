"""Shared filesystem lease primitives for durable ArcRho Engine jobs.

A lease is one exclusively created JSON file whose owner renews it by touching
the file's modification time. A cooperating worker may take over a lease only
after its modification time is older than the job's stale threshold. These
primitives were extracted from the project-duplication engine worker so every
durable Engine job (project duplication, dependent propagation) shares one
implementation instead of copying it.

Known residual gap, accepted for every consumer: a plain filesystem cannot
atomically fence the check-and-unlink race on a stale lease, so takeover uses
rename-to-a-private-name before unlink and generous staleness thresholds.

This module intentionally uses only the Python standard library so the frozen
ArcRho Engine, the frozen Bridge, the frontend app server, and the public
Python API can load the same source file.
"""

from __future__ import annotations

import json
import os
import time
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from threading import Event, Thread
from typing import Any, Callable, Mapping


@dataclass(frozen=True)
class EngineJobLease:
    """One held filesystem lease with a heartbeat-failure latch."""

    path: Path
    owner_token: str
    heartbeat_failed: Event


def acquire_engine_job_lease(
    path: str | os.PathLike[str],
    *,
    stale_seconds: float,
    payload_fields: Mapping[str, Any] | None = None,
) -> EngineJobLease | None:
    """Exclusively create ``path``, recovering only a genuinely stale lease.

    Returns ``None`` when another live owner holds the lease. ``payload_fields``
    are written before the generated ``owner_token`` and ``created_at`` so the
    lease file stays self-describing for operators.
    """

    lease_path = Path(path)
    owner_token = uuid.uuid4().hex
    payload: dict[str, Any] = dict(payload_fields or {})
    payload["owner_token"] = owner_token
    payload["created_at"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
    for attempt in range(2):
        try:
            with lease_path.open("x", encoding="utf-8", newline="\n") as stream:
                json.dump(payload, stream, ensure_ascii=False, separators=(",", ":"))
                stream.write("\n")
            return EngineJobLease(lease_path, owner_token, Event())
        except FileExistsError:
            try:
                age_seconds = max(0.0, time.time() - lease_path.stat().st_mtime)
            except FileNotFoundError:
                if attempt == 0:
                    continue
                return None
            if age_seconds <= stale_seconds:
                return None

            stale_path = lease_path.with_name(
                f".{lease_path.name}.{uuid.uuid4().hex}.stale"
            )
            try:
                os.rename(lease_path, stale_path)
            except FileNotFoundError:
                if attempt == 0:
                    continue
                return None
            except OSError:
                return None
            try:
                stale_path.unlink()
            except FileNotFoundError:
                pass
    return None


def engine_job_lease_owner(path: str | os.PathLike[str]) -> str | None:
    """Return the lease file's owner token, or ``None`` when unreadable."""

    try:
        payload = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError, TypeError):
        return None
    if not isinstance(payload, Mapping):
        return None
    owner = payload.get("owner_token")
    return owner if isinstance(owner, str) else None


def engine_job_lease_is_owned(lease: EngineJobLease) -> bool:
    return engine_job_lease_owner(lease.path) == lease.owner_token


def refresh_engine_job_lease(lease: EngineJobLease) -> bool:
    """Renew a still-owned lease's modification time; return whether it held."""

    if not engine_job_lease_is_owned(lease):
        return False
    try:
        os.utime(lease.path, None)
    except OSError:
        return False
    return True


def release_engine_job_lease(lease: EngineJobLease | None) -> None:
    # The owner-token read and unlink are not one filesystem primitive. A
    # worker whose renewal failed must therefore leave the path for the stale
    # takeover owner; strict fencing would require an OS-backed lock or an
    # owner-specific immutable claim artifact.
    if (
        lease is None
        or lease.heartbeat_failed.is_set()
        or not engine_job_lease_is_owned(lease)
    ):
        return
    try:
        lease.path.unlink()
    except FileNotFoundError:
        pass
    except OSError:
        pass


def run_engine_job_lease_heartbeat(
    lease: EngineJobLease,
    stop_event: Event,
    *,
    interval_seconds: float,
    refresh: Callable[[], bool] | None = None,
) -> None:
    """Renew until stopped; latch ``heartbeat_failed`` on the first miss."""

    renew = refresh if refresh is not None else (lambda: refresh_engine_job_lease(lease))
    while not stop_event.wait(interval_seconds):
        if not renew():
            lease.heartbeat_failed.set()
            return


def start_engine_job_lease_heartbeat(
    lease: EngineJobLease,
    *,
    interval_seconds: float,
    refresh: Callable[[], bool] | None = None,
    thread_name: str | None = None,
) -> tuple[Event, Thread]:
    stop_event = Event()
    thread = Thread(
        target=run_engine_job_lease_heartbeat,
        args=(lease, stop_event),
        kwargs={"interval_seconds": interval_seconds, "refresh": refresh},
        name=thread_name or f"arcrho-engine-job-lease-{lease.owner_token[:8]}",
        daemon=True,
    )
    thread.start()
    return stop_event, thread


def stop_engine_job_lease_heartbeat(
    stop_event: Event,
    thread: Thread,
    *,
    interval_seconds: float,
) -> None:
    stop_event.set()
    thread.join(timeout=interval_seconds + 1.0)
