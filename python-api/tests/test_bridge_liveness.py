"""The shared Bridge liveness rule: one look, and a verdict only after real silence."""
from __future__ import annotations

import json
import os
import sys
import tempfile
import time
import types
import unittest
from pathlib import Path
from unittest.mock import patch

_SRC_DIR = Path(__file__).resolve().parents[1] / "src"
if str(_SRC_DIR) not in sys.path:
    sys.path.insert(0, str(_SRC_DIR))

from arcrho_api import bridge_liveness  # noqa: E402

# Every test temp directory lives under one gitignored folder at the
# repository root, so a suite that dies before teardown cannot scatter
# tmp folders beside the code.
TEST_TEMP_ROOT = Path(__file__).resolve().parents[2] / "test"
TEST_TEMP_ROOT.mkdir(parents=True, exist_ok=True)

_CONTRACT_PATH = (
    Path(__file__).resolve().parents[2]
    / "server-components"
    / "src"
    / "arcrho_bridge"
    / "resq_reserving_class_import_contract.json"
)
_REQUEST_ID = "a1b2c3d4e5f6478899aabbccddeeff00"


class _Clock:
    def __init__(self) -> None:
        self.now = 100.0

    def __call__(self) -> float:
        return self.now


class ObserveOnDiskTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory(dir=TEST_TEMP_ROOT)
        self.addCleanup(self.tempdir.cleanup)
        self.root = Path(self.tempdir.name)

    def _write_worker(self, name="worker.json", *, role="bridge_worker", gui=True, age_sec=0.0):
        path = self.root / bridge_liveness.BRIDGE_WORKER_DIR / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps({"Role": role, "ResQGuiRunning": gui}), encoding="utf-8")
        if age_sec:
            stamp = time.time() - age_sec
            os.utime(path, (stamp, stamp))
        return path

    def _write_status(self, payload, *, queue="import", age_sec=0.0):
        path = self.root / bridge_liveness.QUEUE_STATUS_DIRS[queue] / f"{_REQUEST_ID}.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(payload), encoding="utf-8")
        if age_sec:
            stamp = time.time() - age_sec
            os.utime(path, (stamp, stamp))
        return path

    def test_constants_match_the_bridge_contract(self):
        contract = json.loads(_CONTRACT_PATH.read_text(encoding="utf-8"))
        self.assertEqual(
            tuple(bridge_liveness.BRIDGE_WORKER_DIR.parts),
            tuple(contract["worker_heartbeat_relative_dir"]),
        )
        self.assertEqual(bridge_liveness.BRIDGE_WORKER_ROLE, contract["worker_role"])
        self.assertEqual(
            bridge_liveness.BRIDGE_WORKER_MAX_AGE_SEC,
            contract["worker_heartbeat_max_age_seconds"],
        )
        self.assertEqual(
            tuple(bridge_liveness.QUEUE_STATUS_DIRS["import"].parts),
            tuple(contract["status_relative_dir"]),
        )

    def test_only_a_fresh_resq_connected_worker_is_live(self):
        self._write_worker("fresh.json")
        self._write_worker("stale.json", age_sec=bridge_liveness.BRIDGE_WORKER_MAX_AGE_SEC + 1)
        self._write_worker("no-resq.json", gui=False)
        self._write_worker("supervisor.json", role="bridge")

        observation = bridge_liveness.observe_bridge_liveness_on_disk(self.root)

        by_name = {worker["name"]: worker for worker in observation["workers"]}
        self.assertEqual(set(by_name), {"fresh.json", "stale.json", "no-resq.json", "supervisor.json"})
        self.assertTrue(by_name["fresh.json"]["live"])
        self.assertFalse(by_name["stale.json"]["live"])
        self.assertFalse(by_name["no-resq.json"]["live"])
        self.assertFalse(by_name["supervisor.json"]["live"])
        self.assertEqual(bridge_liveness.live_worker_names(observation), ("fresh.json",))
        self.assertIsNone(observation["request"])

    def test_an_empty_or_missing_heartbeat_folder_reports_no_workers(self):
        observation = bridge_liveness.observe_bridge_liveness_on_disk(self.root)

        self.assertEqual(observation["workers"], [])
        self.assertFalse(bridge_liveness.observation_is_live(observation))

    def test_a_request_look_carries_the_status_file_and_its_age(self):
        status = {"contract_version": 1, "status": "processing", "request_id": _REQUEST_ID}
        self._write_status(status)

        observation = bridge_liveness.observe_bridge_liveness_on_disk(
            self.root, queue="import", request_id=_REQUEST_ID
        )

        request = observation["request"]
        self.assertTrue(request["found"])
        self.assertLess(abs(request["age_sec"]), 2.0)
        self.assertEqual(request["status"], status)
        self.assertEqual(request["request_id"], _REQUEST_ID)

    def test_a_missing_status_file_is_reported_as_not_found(self):
        observation = bridge_liveness.observe_bridge_liveness_on_disk(
            self.root, queue="sync", request_id=_REQUEST_ID
        )

        request = observation["request"]
        self.assertFalse(request["found"])
        self.assertIsNone(request["age_sec"])
        self.assertIsNone(request["status"])

    def test_a_freshly_touched_status_file_is_life_even_without_a_heartbeat(self):
        self._write_status({"status": "processing"})
        fresh = bridge_liveness.observe_bridge_liveness_on_disk(self.root, request_id=_REQUEST_ID)
        self.assertTrue(bridge_liveness.observation_is_live(fresh))

        self._write_status({"status": "processing"}, age_sec=bridge_liveness.BRIDGE_WORKER_MAX_AGE_SEC + 5)
        stale = bridge_liveness.observe_bridge_liveness_on_disk(self.root, request_id=_REQUEST_ID)
        self.assertFalse(bridge_liveness.observation_is_live(stale))
        self.assertIn("status file", bridge_liveness.describe_observation(stale))
        self.assertIn("no Bridge worker heartbeat file", bridge_liveness.describe_observation(stale))


class HostedObservationTests(unittest.TestCase):
    def test_inside_the_app_the_look_goes_through_the_hosted_read(self):
        calls = []

        def run_workspace_read(kind, kwargs, *, local):
            calls.append((kind, dict(kwargs)))
            return {"transport": "hosted", "local": local()}

        services = types.ModuleType("app_server.services")
        services.workspace_read_client = types.SimpleNamespace(run_workspace_read=run_workspace_read)
        services.bridge_liveness_service = types.SimpleNamespace(
            get_bridge_worker_liveness=lambda **kwargs: {"ok": True, "kwargs": kwargs}
        )
        modules = {
            "app_server": types.ModuleType("app_server"),
            "app_server.services": services,
        }
        modules["app_server"].services = services

        with patch.dict(sys.modules, modules):
            result = bridge_liveness.observe_bridge_liveness(
                r"Q:\absent", queue="import", request_id=_REQUEST_ID
            )

        self.assertEqual(calls, [(bridge_liveness.LIVENESS_READ_KIND, {"queue": "import", "request_id": _REQUEST_ID})])
        self.assertEqual(result["transport"], "hosted")
        self.assertEqual(result["local"]["kwargs"], {"queue": "import", "request_id": _REQUEST_ID})

    def test_outside_the_app_the_look_runs_on_the_drive(self):
        with patch.dict(sys.modules, {"app_server": None, "app_server.services": None}):
            observation = bridge_liveness.observe_bridge_liveness(r"Q:\absent")

        self.assertEqual(observation["workers"], [])
        self.assertIsNone(observation["request"])


def _look(*, live: bool, status_age: float | None = None):
    workers = [{"name": "worker.json", "age_sec": 0.4 if live else 9.6, "live": live}]
    request = None
    if status_age is not None:
        request = {"request_id": _REQUEST_ID, "found": True, "age_sec": status_age, "status": {}}
    return {"observed_at": 0.0, "workers": workers, "request": request}


class SilenceTrackerTests(unittest.TestCase):
    def test_silence_shorter_than_the_limit_is_not_a_verdict(self):
        clock = _Clock()
        tracker = bridge_liveness.BridgeSilenceTracker(limit_sec=30.0, clock=clock)

        for _ in range(3):
            clock.now += 9.0
            self.assertFalse(tracker.record(_look(live=False)))
            self.assertFalse(tracker.exceeded)
        self.assertEqual(tracker.silent_checks, 3)
        self.assertEqual(tracker.silent_for_sec, 27.0)

    def test_silence_past_the_limit_is_the_verdict_and_says_what_was_seen(self):
        clock = _Clock()
        tracker = bridge_liveness.BridgeSilenceTracker(limit_sec=30.0, clock=clock)

        for _ in range(4):
            clock.now += 8.0
            tracker.record(_look(live=False, status_age=12.5))
        self.assertTrue(tracker.exceeded)
        description = tracker.describe()
        self.assertIn("for 32 seconds", description)
        self.assertIn("4 consecutive checks", description)
        self.assertIn("worker.json 9.6 s old (not usable)", description)
        self.assertIn("status file 12.5 s old", description)

    def test_one_live_look_resets_the_silence(self):
        clock = _Clock()
        tracker = bridge_liveness.BridgeSilenceTracker(limit_sec=30.0, clock=clock)

        clock.now += 25.0
        tracker.record(_look(live=False))
        clock.now += 4.0
        self.assertTrue(tracker.record(_look(live=False, status_age=1.0)))
        clock.now += 20.0
        tracker.record(None)
        self.assertFalse(tracker.exceeded)
        self.assertEqual(tracker.silent_checks, 1)
        self.assertIn("the liveness check itself failed", tracker.describe())

    def test_a_tracker_that_never_saw_silence_has_not_exceeded_anything(self):
        clock = _Clock()
        tracker = bridge_liveness.BridgeSilenceTracker(limit_sec=1.0, clock=clock)
        clock.now += 60.0
        self.assertFalse(tracker.exceeded)


class AwaitBridgeSignalTests(unittest.TestCase):
    def test_returns_on_the_first_live_look(self):
        sleeps = []
        looks = iter([_look(live=False), _look(live=True)])

        observation, tracker = bridge_liveness.await_bridge_signal(
            lambda: next(looks), limit_sec=30.0, poll_interval_sec=0.25, sleep=sleeps.append
        )

        self.assertTrue(bridge_liveness.observation_is_live(observation))
        self.assertEqual(tracker.silent_checks, 0)
        self.assertEqual(sleeps, [0.25])

    def test_gives_up_once_the_silence_limit_passes(self):
        sleeps = []
        with patch.object(bridge_liveness.time, "monotonic", side_effect=[0.0, 0.0, 5.0, 10.0, 15.0]):
            observation, tracker = bridge_liveness.await_bridge_signal(
                lambda: _look(live=False), limit_sec=10.0, poll_interval_sec=1.0, sleep=sleeps.append
            )

        self.assertFalse(bridge_liveness.observation_is_live(observation))
        self.assertTrue(tracker.exceeded)
        self.assertEqual(sleeps, [1.0, 1.0])


if __name__ == "__main__":
    unittest.main()
