"""Whether a ResQ-connected ArcRho Bridge worker is alive, as one shared rule.

The Bridge worker on the Server PC rewrites its heartbeat file every second and
touches the status file of the request it is running just as often. A macro
waiting on that worker has to decide when it has gone away, and two facts shape
the decision:

- Read over the mapped drive, a file's timestamp comes from a Windows client
  cache that can lag the server by about ten seconds, so one reading older than
  the six-second freshness window proves nothing. The look is therefore taken on
  the server host through the Gateway whenever the app can reach it, and the
  verdict needs a run of silent looks, never a single one.
- The status file the worker keeps touching is evidence of life for the very
  request being waited on, so it counts alongside the heartbeat.

``observe_bridge_liveness`` takes one look at both signals and
``BridgeSilenceTracker`` turns a sequence of looks into the verdict. The
``app_server`` service behind the hosted read and the ResQ macros all share
this module, so the rule is written once.
"""

from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any, Callable, Mapping


# Pinned to data-engine/src/arcrho_bridge/resq_reserving_class_import_contract.json
# by the macro tests; the Bridge cannot be imported from here.
BRIDGE_WORKER_DIR = Path("runtime") / "instances" / "arcrho_bridge_worker"
BRIDGE_WORKER_ROLE = "bridge_worker"
BRIDGE_WORKER_MAX_AGE_SEC = 6
# The worker renews both signals every second, so silence this long is a worker
# that is gone rather than a cache that is late. It matches the time a request
# is given to be claimed.
BRIDGE_SILENCE_LIMIT_SEC = 30.0
LIVENESS_READ_KIND = "bridge_worker_liveness"
QUEUE_STATUS_DIRS: dict[str, Path] = {
    "import": Path("requests") / "RPC bridge" / "resq_reserving_class_import" / "statuses",
    "sync": Path("requests") / "RPC bridge" / "resq_reserving_class_sync" / "statuses",
}


def _read_json(path: Path) -> dict[str, Any] | None:
    try:
        with path.open("r", encoding="utf-8-sig") as stream:
            payload = json.load(stream)
    except (OSError, UnicodeError, json.JSONDecodeError):
        return None
    return payload if isinstance(payload, dict) else None


def _is_true(value: object) -> bool:
    if isinstance(value, bool):
        return value
    return str(value or "").strip().casefold() in {"1", "true", "yes"}


def observe_bridge_liveness_on_disk(
    server_root: object,
    *,
    queue: str = "import",
    request_id: str = "",
    now: float | None = None,
) -> dict[str, Any]:
    """One look at every worker heartbeat and, when asked, one request's status file.

    The look is exact on the server host and only as good as the drive cache
    anywhere else; the tracker absorbs that difference.
    """

    root = Path(server_root)
    observed_at = time.time() if now is None else float(now)
    try:
        candidates = sorted(
            (root / BRIDGE_WORKER_DIR).glob("*.json"), key=lambda item: item.name.casefold()
        )
    except OSError:
        candidates = []
    workers: list[dict[str, Any]] = []
    for path in candidates:
        try:
            age = observed_at - path.stat().st_mtime
        except OSError:
            continue
        payload = _read_json(path) or {}
        role = str(payload.get("Role") or payload.get("role") or "").strip().casefold()
        workers.append({
            "name": path.name,
            "age_sec": round(age, 3),
            "live": (
                abs(age) <= BRIDGE_WORKER_MAX_AGE_SEC
                and role == BRIDGE_WORKER_ROLE
                and _is_true(payload.get("ResQGuiRunning"))
            ),
        })
    observation: dict[str, Any] = {"observed_at": observed_at, "workers": workers, "request": None}
    if request_id:
        status_path = root / QUEUE_STATUS_DIRS[queue] / f"{request_id}.json"
        request: dict[str, Any] = {
            "request_id": request_id,
            "found": False,
            "age_sec": None,
            "status": None,
        }
        try:
            request["age_sec"] = round(observed_at - status_path.stat().st_mtime, 3)
        except OSError:
            pass
        else:
            request["found"] = True
            request["status"] = _read_json(status_path)
        observation["request"] = request
    return observation


def observe_bridge_liveness(
    server_root: object,
    *,
    queue: str = "import",
    request_id: str = "",
) -> dict[str, Any]:
    """The same look, taken on the Server PC when the running app can reach the Gateway.

    Inside the ArcRho app the hosted read runs the on-disk look where the
    workspace is local disk, and the transport itself runs it here against the
    mapped drive when the Gateway cannot be reached. Outside the app there is no
    Gateway client at all, so the look runs on the drive directly.
    """

    kwargs = {"queue": queue, "request_id": request_id}
    try:
        from app_server.services import bridge_liveness_service, workspace_read_client
    except ImportError:
        return observe_bridge_liveness_on_disk(server_root, **kwargs)
    return workspace_read_client.run_workspace_read(
        LIVENESS_READ_KIND,
        kwargs,
        local=lambda: bridge_liveness_service.get_bridge_worker_liveness(**kwargs),
    )


def live_worker_names(observation: object) -> tuple[str, ...]:
    if not isinstance(observation, Mapping):
        return ()
    return tuple(
        str(worker.get("name"))
        for worker in observation.get("workers") or ()
        if isinstance(worker, Mapping) and worker.get("live")
    )


def observation_is_live(observation: object) -> bool:
    """A live heartbeat or a freshly touched status file both prove the worker is running."""

    if live_worker_names(observation):
        return True
    request = observation.get("request") if isinstance(observation, Mapping) else None
    if not isinstance(request, Mapping) or request.get("age_sec") is None:
        return False
    return abs(float(request["age_sec"])) <= BRIDGE_WORKER_MAX_AGE_SEC


def describe_observation(observation: object) -> str:
    if not isinstance(observation, Mapping):
        return "the liveness check itself failed"
    workers = [item for item in observation.get("workers") or () if isinstance(item, Mapping)]
    if workers:
        parts = [
            "heartbeat "
            + ", ".join(
                f"{worker.get('name')} {float(worker.get('age_sec') or 0):.1f} s old"
                + ("" if worker.get("live") else " (not usable)")
                for worker in workers
            )
        ]
    else:
        parts = ["no Bridge worker heartbeat file"]
    request = observation.get("request")
    if isinstance(request, Mapping):
        if request.get("found"):
            parts.append(f"status file {float(request.get('age_sec') or 0):.1f} s old")
        else:
            parts.append("no status file yet")
    return "; ".join(parts)


class BridgeSilenceTracker:
    """Turn a run of looks into the verdict: silent past the limit means gone."""

    def __init__(
        self,
        *,
        limit_sec: float = BRIDGE_SILENCE_LIMIT_SEC,
        clock: Callable[[], float] | None = None,
    ) -> None:
        self._limit_sec = float(limit_sec)
        self._clock = clock or time.monotonic
        self._last_signal_at = self._clock()
        self.silent_checks = 0
        self.last_detail = ""

    def record(self, observation: object) -> bool:
        """Note one look and return whether it carried a live signal."""

        if observation_is_live(observation):
            self._last_signal_at = self._clock()
            self.silent_checks = 0
            self.last_detail = ""
            return True
        self.silent_checks += 1
        self.last_detail = describe_observation(observation)
        return False

    @property
    def silent_for_sec(self) -> float:
        return max(0.0, self._clock() - self._last_signal_at)

    @property
    def exceeded(self) -> bool:
        return self.silent_checks > 0 and self.silent_for_sec >= self._limit_sec

    def describe(self) -> str:
        return (
            f"no sign of a live ArcRho Bridge worker for {self.silent_for_sec:.0f} seconds "
            f"({self.silent_checks} consecutive checks; last check: {self.last_detail})"
        )


def await_bridge_signal(
    observe: Callable[[], object],
    *,
    limit_sec: float = BRIDGE_SILENCE_LIMIT_SEC,
    poll_interval_sec: float = 1.0,
    sleep: Callable[[float], None] = time.sleep,
) -> tuple[object, BridgeSilenceTracker]:
    """Look until a live signal arrives or the silence limit passes."""

    tracker = BridgeSilenceTracker(limit_sec=limit_sec)
    while True:
        observation = observe()
        if tracker.record(observation) or tracker.exceeded:
            return observation, tracker
        sleep(poll_interval_sec)
